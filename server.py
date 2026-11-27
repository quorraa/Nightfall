"""Nightfall: turn this PC's monitors off from a phone, over the LAN or Tailscale.

Monitors are put to sleep with SC_MONITORPOWER, the same message Windows sends when
"Turn off the display after N minutes" runs out. The displays stay connected and wake
on any mouse or keyboard input (or the page's "Wake screens" button).

Runs in the logged-in user's session (Task Scheduler, at log on). A Windows service
would live in session 0 and could not reach the desktop's monitors.

Env: NIGHTFALL_PORT (default 39847), NIGHTFALL_DRY_RUN=1 (log instead of acting).
"""

from __future__ import annotations

import ctypes
import ipaddress
import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
from ctypes import wintypes
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PORT = int(os.environ.get("NIGHTFALL_PORT", "39847"))
DRY_RUN = os.environ.get("NIGHTFALL_DRY_RUN") == "1"
MAX_DELAY = 6 * 60 * 60
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
HOST_NAME = socket.gethostname()

log = logging.getLogger("nightfall")


def setup_logging() -> None:
    (ROOT / "logs").mkdir(exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        ROOT / "logs" / "nightfall.log", maxBytes=512_000, backupCount=2, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    if sys.stderr is not None:  # pythonw has no console
        log.addHandler(logging.StreamHandler())
    log.setLevel(logging.INFO)


# --- Win32 -----------------------------------------------------------------------

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

HWND_BROADCAST = wintypes.HWND(0xFFFF)
WM_SYSCOMMAND = 0x0112
SC_MONITORPOWER = 0xF170
MONITOR_OFF = 2
MONITOR_ON = -1
ES_DISPLAY_REQUIRED = 0x00000002
INPUT_MOUSE = 0
MOUSEEVENTF_MOVE = 0x0001

user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL
kernel32.SetThreadExecutionState.argtypes = [wintypes.DWORD]
kernel32.SetThreadExecutionState.restype = wintypes.DWORD


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("_pad", ctypes.c_byte * 32)]

    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
user32.GetLastInputInfo.restype = wintypes.BOOL


def last_input_tick() -> int:
    """Tick count of the last keyboard/mouse input anywhere in the session."""
    info = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
    user32.GetLastInputInfo(ctypes.byref(info))
    return info.dwTime


def post_monitors_off() -> None:
    ok = user32.PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, MONITOR_OFF)
    if not ok:
        raise OSError(ctypes.get_last_error(), "PostMessageW(SC_MONITORPOWER) failed")


class NightGuard:
    """Keeps the screens off until a person touches the keyboard or mouse.

    SC_MONITORPOWER turns the displays off, but any program that asks Windows for the
    display (video, streaming, remote tools, some updaters) can switch them straight back
    on, and so can a mouse that registers a bump to the desk. While armed, when the
    display comes on:

    - with no new input, a program did it: turn the screens off again (MAX_RETURNS a night).
    - after nothing but a tiny relative mouse movement (NUDGE_LIMIT counts, a few pixels):
      turn them off again, but at most MAX_NUDGES times a night and never within
      NUDGE_GRACE seconds of the last time, so someone moving the mouse twice always gets in.
    - after anything else (a key, click, scroll, bigger movement, touch, pen, remote
      pointer, or input we could not see because raw input is unavailable): leave them on.
    """

    MAX_RETURNS = 30  # per night; stop fighting a program that insists
    NUDGE_LIMIT = 10  # raw mouse counts, summed |dx|+|dy|; about pixels at slow speed
    MAX_NUDGES = 5
    NUDGE_GRACE = 30.0  # seconds

    def __init__(self, turn_off, input_tick, listen=lambda on: None, settle=0.5,
                 clock=time.monotonic) -> None:
        self._turn_off = turn_off
        self._input_tick = input_tick
        self._listen = listen  # starts/stops raw input reporting to input_seen
        self._settle = settle  # wait for queued raw input before judging a wake
        self._clock = clock
        self._lock = threading.Lock()
        self._armed = False
        self._pending = False
        self._tick = 0
        self._returns = 0
        self._nudges = 0
        self._nudged_at = None
        self.raw_ok = False  # set by the watcher once raw input is registered
        self._reset_input()

    @property
    def armed(self) -> bool:
        return self._armed

    def _reset_input(self) -> None:
        self._moves = 0
        self._moved = 0
        self._other = False

    def arm(self) -> None:
        with self._lock:
            self._armed = True
            self._tick = self._input_tick()
            self._returns = 0
            self._nudges = 0
            self._nudged_at = None
            self._reset_input()
        self._listen(True)

    def disarm(self) -> None:
        with self._lock:
            self._armed = False
        self._listen(False)

    def input_seen(self, dx: int = 0, dy: int = 0, other: bool = False) -> None:
        """One raw input event: a relative mouse move, or other=True for anything else."""
        with self._lock:
            if not self._armed:
                return
            if other:
                self._other = True
            else:
                self._moves += 1
                self._moved += abs(dx) + abs(dy)

    def display_changed(self, state: int) -> None:
        """state: 0 off, 1 on, 2 dimmed (GUID_CONSOLE_DISPLAY_STATE)."""
        log.info("display %s", {0: "off", 1: "on", 2: "dimmed"}.get(state, state))
        if state != 1:
            return
        with self._lock:
            if not self._armed or self._pending:
                return
            self._pending = True
        if self._settle:
            threading.Timer(self._settle, self._decide).start()
        else:
            self._decide()

    def _person_reason(self) -> str | None:
        """Why this wake counts as a person, or None if it was only a nudge."""
        if self._other:
            return "a key, click or scroll"
        if not self.raw_ok or self._moves == 0:
            return "keyboard or mouse input"
        if self._moved > self.NUDGE_LIMIT:
            return f"the mouse moving ({self._moved} counts)"
        if self._nudges >= self.MAX_NUDGES:
            return f"a small mouse movement ({self._moved} counts; {self.MAX_NUDGES} already ignored tonight)"
        if self._nudged_at is not None and self._clock() - self._nudged_at < self.NUDGE_GRACE:
            return f"a second small mouse movement ({self._moved} counts) soon after the last"
        return None

    def _decide(self) -> None:
        with self._lock:
            self._pending = False
            if not self._armed:
                return
            tick = self._input_tick()
            if tick == self._tick:
                if self._returns >= self.MAX_RETURNS:
                    self._armed = False
                    note = None
                    log.warning("screens keep coming back on with no input; giving up for tonight")
                else:
                    self._returns += 1
                    note = ("screens came back on with no keyboard or mouse input; "
                            f"turning them off again ({self._returns})")
            else:
                reason = self._person_reason()
                if reason is None:
                    self._nudges += 1
                    self._tick = tick
                    self._nudged_at = self._clock()
                    note = (f"screens woken by a tiny mouse movement ({self._moved} counts); "
                            f"turning them off again ({self._nudges} of {self.MAX_NUDGES})")
                    self._reset_input()
                else:
                    self._armed = False
                    note = None
                    log.info("screens woken by %s; leaving them on", reason)
        if note is None:
            self._listen(False)
            return
        log.info(note)
        self._turn_off()


def listen_raw_input(on: bool) -> None:
    """Ask the display watcher thread to start or stop raw keyboard/mouse reporting."""
    if _watcher_hwnd:
        user32.PostMessageW(_watcher_hwnd, WM_APP_LISTEN, 1 if on else 0, 0)


guard = NightGuard(post_monitors_off, last_input_tick, listen=listen_raw_input)


def monitors_off() -> None:
    if DRY_RUN:
        log.info("dry run: would turn monitors off")
        return
    guard.arm()
    post_monitors_off()
    log.info("monitors off")


def monitors_on() -> None:
    guard.disarm()
    if DRY_RUN:
        log.info("dry run: would wake monitors")
        return
    # SC_MONITORPOWER -1 alone is unreliable on modern drivers; a 1px nudge and back
    # counts as real input and wakes every display.
    user32.PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, MONITOR_ON)
    kernel32.SetThreadExecutionState(ES_DISPLAY_REQUIRED)
    nudge = (INPUT * 2)()
    for i, dx in enumerate((1, -1)):
        nudge[i].type = INPUT_MOUSE
        nudge[i].mi = MOUSEINPUT(dx, 0, 0, MOUSEEVENTF_MOVE, 0, 0)
    user32.SendInput(2, nudge, ctypes.sizeof(INPUT))
    log.info("monitors woken")


# --- Display state watcher -----------------------------------------------------------
# A hidden window subscribed to GUID_CONSOLE_DISPLAY_STATE: Windows tells it whenever the
# displays go off, dim or come on, whoever caused it.

WM_POWERBROADCAST = 0x0218
PBT_POWERSETTINGCHANGE = 0x8013
LRESULT = wintypes.LPARAM
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8)]


GUID_CONSOLE_DISPLAY_STATE = GUID(0x6FE69556, 0x704A, 0x47A0,
                                  (ctypes.c_ubyte * 8)(0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F, 0xDA, 0x47))


class POWERBROADCAST_SETTING(ctypes.Structure):
    _fields_ = [("PowerSetting", GUID), ("DataLength", wintypes.DWORD), ("Data", ctypes.c_ubyte * 4)]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]


user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
user32.RegisterClassW.restype = wintypes.ATOM
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.CreateWindowExW.restype = wintypes.HWND
user32.RegisterPowerSettingNotification.argtypes = [wintypes.HANDLE, ctypes.POINTER(GUID), wintypes.DWORD]
user32.RegisterPowerSettingNotification.restype = wintypes.HANDLE
class RAWINPUTDEVICE(ctypes.Structure):
    _fields_ = [("usUsagePage", wintypes.USHORT), ("usUsage", wintypes.USHORT),
                ("dwFlags", wintypes.DWORD), ("hwndTarget", wintypes.HWND)]


class RAWINPUTHEADER(ctypes.Structure):
    _fields_ = [("dwType", wintypes.DWORD), ("dwSize", wintypes.DWORD),
                ("hDevice", wintypes.HANDLE), ("wParam", wintypes.WPARAM)]


class RAWMOUSE(ctypes.Structure):
    _fields_ = [("usFlags", wintypes.USHORT), ("_pad", wintypes.USHORT),
                ("usButtonFlags", wintypes.USHORT), ("usButtonData", wintypes.USHORT),
                ("ulRawButtons", wintypes.ULONG), ("lLastX", wintypes.LONG), ("lLastY", wintypes.LONG),
                ("ulExtraInformation", wintypes.ULONG)]


WM_INPUT = 0x00FF
WM_APP_LISTEN = 0x8000 + 1  # WM_APP + 1: wparam 1 starts raw input, 0 stops it
RID_INPUT = 0x10000003
RIM_TYPEMOUSE = 0
RIDEV_REMOVE = 0x00000001
RIDEV_INPUTSINK = 0x00000100
MOUSE_MOVE_ABSOLUTE = 0x01
_watcher_hwnd = None

user32.RegisterRawInputDevices.argtypes = [ctypes.POINTER(RAWINPUTDEVICE), wintypes.UINT, wintypes.UINT]
user32.RegisterRawInputDevices.restype = wintypes.BOOL
user32.GetRawInputData.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPVOID,
                                   ctypes.POINTER(wintypes.UINT), wintypes.UINT]
user32.GetRawInputData.restype = wintypes.UINT
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.GetMessageW.restype = wintypes.BOOL
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE


def _set_raw_input(hwnd, on: bool) -> bool:
    devices = (RAWINPUTDEVICE * 2)()
    for d, usage in zip(devices, (2, 6)):  # generic desktop: mouse, keyboard
        d.usUsagePage, d.usUsage = 1, usage
        d.dwFlags, d.hwndTarget = (RIDEV_INPUTSINK, hwnd) if on else (RIDEV_REMOVE, None)
    return bool(user32.RegisterRawInputDevices(devices, 2, ctypes.sizeof(RAWINPUTDEVICE)))


def _read_raw_input(handle, sink) -> None:
    buf = ctypes.create_string_buffer(128)
    size = wintypes.UINT(len(buf))
    got = user32.GetRawInputData(handle, RID_INPUT, buf, ctypes.byref(size), ctypes.sizeof(RAWINPUTHEADER))
    if got in (0, 0xFFFFFFFF):
        return
    header = RAWINPUTHEADER.from_buffer(buf)
    if header.dwType != RIM_TYPEMOUSE:
        sink.input_seen(other=True)  # keyboard
        return
    m = RAWMOUSE.from_buffer(buf, ctypes.sizeof(RAWINPUTHEADER))
    if m.usButtonFlags or m.usFlags & MOUSE_MOVE_ABSOLUTE:  # click, wheel, tablet, remote pointer
        sink.input_seen(other=True)
    else:
        sink.input_seen(m.lLastX, m.lLastY)


def watch_display(sink) -> None:
    """Run a message loop that reports display state changes to sink.display_changed(state)
    and, while sink has asked for it through listen_raw_input, raw keyboard and mouse
    input to sink.input_seen.

    Blocks; run it on a daemon thread. Windows sends the current state right after
    registering, so the first call reports the state at startup.
    """
    global _watcher_hwnd

    def wndproc(hwnd, msg, wparam, lparam):
        try:  # never let a bug kill the message loop
            if msg == WM_POWERBROADCAST and wparam == PBT_POWERSETTINGCHANGE and lparam:
                setting = ctypes.cast(lparam, ctypes.POINTER(POWERBROADCAST_SETTING)).contents
                if bytes(setting.PowerSetting) == bytes(GUID_CONSOLE_DISPLAY_STATE):
                    sink.display_changed(setting.Data[0])
                return 1
            if msg == WM_INPUT:
                _read_raw_input(lparam, sink)
            elif msg == WM_APP_LISTEN:
                ok = _set_raw_input(hwnd, bool(wparam))
                if wparam:
                    sink.raw_ok = ok
                    if not ok:
                        log.warning("raw input unavailable (%d); any input will keep the screens on",
                                    ctypes.get_last_error())
                return 0
        except Exception:
            log.exception("display watcher")
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    proc = WNDPROC(wndproc)  # keep a reference for the life of the loop
    hinst = kernel32.GetModuleHandleW(None)
    wc = WNDCLASSW(lpfnWndProc=proc, hInstance=hinst, lpszClassName="NightfallDisplayWatcher")
    if not user32.RegisterClassW(ctypes.byref(wc)):
        raise OSError(ctypes.get_last_error(), "RegisterClassW failed")
    # A real (never shown) top-level window: message-only windows miss some power broadcasts.
    hwnd = user32.CreateWindowExW(0, wc.lpszClassName, "Nightfall", 0, 0, 0, 0, 0, None, None, hinst, None)
    if not hwnd:
        raise OSError(ctypes.get_last_error(), "CreateWindowExW failed")
    if not user32.RegisterPowerSettingNotification(hwnd, ctypes.byref(GUID_CONSOLE_DISPLAY_STATE), 0):
        raise OSError(ctypes.get_last_error(), "RegisterPowerSettingNotification failed")
    _watcher_hwnd = hwnd
    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def start_display_watcher() -> None:
    def run():
        try:
            watch_display(guard)
        except OSError:
            log.exception("display watcher could not start; screens may be woken by other programs")

    threading.Thread(target=run, name="display-watcher", daemon=True).start()


# --- Schedule ----------------------------------------------------------------------


class Bedtime:
    """One pending "dim at" timer plus the last thing that happened."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._fire_at: float | None = None
        self._total = 0.0
        self._last: dict | None = None

    def _record(self, action: str) -> None:
        self._last = {"action": action, "at": time.time()}

    def _fire(self) -> None:
        with self._lock:
            self._timer = None
            self._fire_at = None
            self._record("dim")
        monitors_off()

    def dim(self, delay: float) -> None:
        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None
                self._fire_at = None
            if delay <= 0:
                self._record("dim")
            else:
                self._total = delay
                self._fire_at = time.time() + delay
                self._timer = threading.Timer(delay, self._fire)
                self._timer.daemon = True
                self._timer.start()
                self._record("scheduled")
                log.info("monitors off in %.0fs", delay)
                return
        monitors_off()

    def cancel(self) -> None:
        with self._lock:
            if self._timer:
                self._timer.cancel()
                log.info("timer cancelled")
            self._timer = None
            self._fire_at = None
            self._record("cancelled")

    def wake(self) -> None:
        with self._lock:
            self._record("wake")
        monitors_on()

    def status(self) -> dict:
        with self._lock:
            pending = None
            if self._fire_at is not None:
                pending = {
                    "fire_at": self._fire_at,
                    "total": self._total,
                    "remaining": max(0.0, self._fire_at - time.time()),
                }
            return {
                "host": HOST_NAME,
                "now": time.time(),
                "pending": pending,
                "last": self._last,
                "dry_run": DRY_RUN,
            }


bedtime = Bedtime()

# --- HTTP --------------------------------------------------------------------------

TAILSCALE_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILSCALE_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def client_allowed(addr: str) -> bool:
    """Loopback, private LAN ranges and Tailscale only."""
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_link_local:
        return True
    if ip in TAILSCALE_V4 or ip in TAILSCALE_V6:
        return True
    return ip.is_private


class Handler(SimpleHTTPRequestHandler):
    server_version = "Nightfall/1.0"
    extensions_map = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        "": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):  # default writes to stderr, absent under pythonw
        log.debug("%s %s", self.client_address[0], fmt % args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "public, max-age=604800, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _gate(self) -> bool:
        if not client_allowed(self.client_address[0]):
            log.warning("refused %s", self.client_address[0])
            self.send_error(HTTPStatus.FORBIDDEN)
            return False
        return True

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._gate():
            return
        if self.path.split("?")[0] == "/api/status":
            self._json(200, bedtime.status())
            return
        if self.path.startswith("/api/"):
            self._json(404, {"error": "Unknown endpoint."})
            return
        super().do_GET()

    def do_HEAD(self):
        if self._gate():
            super().do_HEAD()

    def do_POST(self):
        if not self._gate():
            return
        # A JSON content type forces a CORS preflight, which we never answer, so other
        # websites open in a browser on the LAN can't fire these endpoints.
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self._json(415, {"error": "Send JSON."})
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self._json(403, {"error": "Cross-origin request refused."})
            return
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 4096)
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "Body is not valid JSON."})
            return

        route = self.path.split("?")[0]
        try:
            if route == "/api/dim":
                delay = float(data.get("delay", 0))
                if not 0 <= delay <= MAX_DELAY:
                    self._json(400, {"error": f"Delay must be 0 to {MAX_DELAY} seconds."})
                    return
                bedtime.dim(delay)
            elif route == "/api/cancel":
                bedtime.cancel()
            elif route == "/api/wake":
                bedtime.wake()
            else:
                self._json(404, {"error": "Unknown endpoint."})
                return
        except OSError as exc:
            log.exception("action failed")
            self._json(500, {"error": f"Windows refused the request: {exc}"})
            return
        self._json(200, bedtime.status())


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main() -> None:
    setup_logging()
    try:
        server = DualStackServer(("::", PORT), Handler)
    except OSError as exc:
        log.error("port %d is busy (%s); is Nightfall already running?", PORT, exc)
        sys.exit(1)
    log.info("Nightfall on %s, port %d%s", HOST_NAME, PORT, " (dry run)" if DRY_RUN else "")
    start_display_watcher()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
