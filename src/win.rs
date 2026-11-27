//! Windows: turning the monitors off and on, watching the display state and raw input,
//! the host name, local time and a dual-stack listening socket.
#![allow(non_snake_case, clippy::upper_case_acronyms)]

use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::net::TcpListener;
use std::os::windows::io::FromRawSocket;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::guard::{Env, NightGuard};

type HWND = isize;
type BOOL = i32;
type WndProc = unsafe extern "system" fn(HWND, u32, usize, isize) -> isize;

#[repr(C)]
#[derive(PartialEq)]
struct GUID {
    d1: u32,
    d2: u16,
    d3: u16,
    d4: [u8; 8],
}

#[repr(C)]
struct LASTINPUTINFO {
    cbSize: u32,
    dwTime: u32,
}

#[repr(C)]
struct MOUSEINPUT {
    dx: i32,
    dy: i32,
    mouseData: u32,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}

#[repr(C)]
struct INPUT {
    kind: u32,
    mi: MOUSEINPUT, // the largest member of the union
}

#[repr(C)]
struct WNDCLASSW {
    style: u32,
    lpfnWndProc: WndProc,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: isize,
    hIcon: isize,
    hCursor: isize,
    hbrBackground: isize,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
}

#[repr(C)]
struct MSG {
    hwnd: HWND,
    message: u32,
    wParam: usize,
    lParam: isize,
    time: u32,
    pt: [i32; 2],
    lPrivate: u32,
}

#[repr(C)]
struct RAWINPUTDEVICE {
    usUsagePage: u16,
    usUsage: u16,
    dwFlags: u32,
    hwndTarget: HWND,
}

#[repr(C)]
#[derive(Default)]
struct SYSTEMTIME {
    year: u16,
    month: u16,
    weekday: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    ms: u16,
}

#[link(name = "user32")]
extern "system" {
    fn PostMessageW(hwnd: HWND, msg: u32, w: usize, l: isize) -> BOOL;
    fn SendInput(n: u32, inputs: *const INPUT, size: i32) -> u32;
    fn GetLastInputInfo(info: *mut LASTINPUTINFO) -> BOOL;
    fn DefWindowProcW(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize;
    fn RegisterClassW(wc: *const WNDCLASSW) -> u16;
    fn CreateWindowExW(
        ex_style: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32,
        parent: HWND, menu: isize, instance: isize, param: *mut c_void,
    ) -> HWND;
    fn RegisterPowerSettingNotification(recipient: isize, setting: *const GUID, flags: u32) -> isize;
    fn RegisterRawInputDevices(devices: *const RAWINPUTDEVICE, n: u32, size: u32) -> BOOL;
    fn GetRawInputData(raw: isize, command: u32, data: *mut c_void, size: *mut u32, header_size: u32) -> u32;
    fn GetMessageW(msg: *mut MSG, hwnd: HWND, min: u32, max: u32) -> BOOL;
    fn TranslateMessage(msg: *const MSG) -> BOOL;
    fn DispatchMessageW(msg: *const MSG) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetLastError() -> u32;
    fn GetLocalTime(time: *mut SYSTEMTIME);
    fn GetComputerNameExW(kind: i32, buf: *mut u16, size: *mut u32) -> BOOL;
}

#[link(name = "ws2_32")]
extern "system" {
    fn WSAStartup(version: u16, data: *mut u8) -> i32;
    fn WSASocketW(af: i32, kind: i32, protocol: i32, info: *mut c_void, group: u32, flags: u32) -> usize;
    fn setsockopt(s: usize, level: i32, name: i32, value: *const u8, len: i32) -> i32;
    fn bind(s: usize, addr: *const u8, len: i32) -> i32;
    fn listen(s: usize, backlog: i32) -> i32;
    fn closesocket(s: usize) -> i32;
    fn WSAGetLastError() -> i32;
}

const HWND_BROADCAST: HWND = 0xFFFF;
const WM_SYSCOMMAND: u32 = 0x0112;
const SC_MONITORPOWER: usize = 0xF170;
const MONITOR_OFF: isize = 2;
const MONITOR_ON: isize = -1;
const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
const INPUT_MOUSE: u32 = 0;
const MOUSEEVENTF_MOVE: u32 = 0x0001;

const WM_POWERBROADCAST: u32 = 0x0218;
const PBT_POWERSETTINGCHANGE: usize = 0x8013;
const WM_INPUT: u32 = 0x00FF;
const WM_APP_LISTEN: u32 = 0x8000 + 1; // WM_APP + 1: wparam 1 starts raw input, 0 stops it
const RID_INPUT: u32 = 0x1000_0003;
const RIM_TYPEMOUSE: u32 = 0;
const RIDEV_REMOVE: u32 = 0x0000_0001;
const RIDEV_INPUTSINK: u32 = 0x0000_0100;
const MOUSE_MOVE_ABSOLUTE: u16 = 0x01;
const RAWINPUTHEADER_SIZE: usize = 4 + 4 + 2 * size_of::<usize>(); // dwType, dwSize, hDevice, wParam

const GUID_CONSOLE_DISPLAY_STATE: GUID =
    GUID { d1: 0x6FE6_9556, d2: 0x704A, d3: 0x47A0, d4: [0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F, 0xDA, 0x47] };

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn last_error(what: &str) -> io::Error {
    let code = unsafe { GetLastError() };
    io::Error::other(format!("{what} failed: {}", io::Error::from_raw_os_error(code as i32)))
}

// --- Monitors ---------------------------------------------------------------------

pub fn last_input_tick() -> u32 {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe { GetLastInputInfo(&mut info) };
    info.dwTime
}

/// Where to send SC_MONITORPOWER: our own hidden window, whose default handling asks Windows
/// once. Broadcasting it to every window (the usual recipe) also works, but each window acts
/// on its copy whenever it gets round to it, so a busy or throttled one can turn the screens
/// off again seconds (or longer) after someone has woken them.
fn power_target() -> HWND {
    match WATCHER_HWND.load(Ordering::SeqCst) {
        0 => HWND_BROADCAST, // the watcher isn't up (yet): better late copies than nothing
        hwnd => hwnd,
    }
}

pub fn post_monitors_off() -> io::Result<()> {
    if unsafe { PostMessageW(power_target(), WM_SYSCOMMAND, SC_MONITORPOWER, MONITOR_OFF) } == 0 {
        return Err(last_error("PostMessageW(SC_MONITORPOWER)"));
    }
    Ok(())
}

pub fn monitors_off() -> io::Result<()> {
    if crate::cfg().dry_run {
        crate::info!("dry run: would turn monitors off");
        return Ok(());
    }
    GUARD.arm();
    post_monitors_off()?;
    crate::info!("monitors off");
    Ok(())
}

pub fn monitors_on() {
    GUARD.disarm();
    if crate::cfg().dry_run {
        crate::info!("dry run: would wake monitors");
        return;
    }
    // SC_MONITORPOWER -1 alone is unreliable on modern drivers; a 1px nudge and back
    // counts as real input and wakes every display.
    unsafe {
        PostMessageW(power_target(), WM_SYSCOMMAND, SC_MONITORPOWER, MONITOR_ON);
        SetThreadExecutionState(ES_DISPLAY_REQUIRED);
    }
    send_mouse_moves(&[1, -1]);
    crate::info!("monitors woken");
}

fn send_mouse_moves(dxs: &[i32]) {
    let inputs: Vec<INPUT> = dxs
        .iter()
        .map(|&dx| INPUT {
            kind: INPUT_MOUSE,
            mi: MOUSEINPUT { dx, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 },
        })
        .collect();
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
}

// --- The guard, wired to Windows ---------------------------------------------------

pub struct Win;

static WATCHER_HWND: AtomicIsize = AtomicIsize::new(0);
static START: OnceLock<Instant> = OnceLock::new();

impl Env for Win {
    fn turn_off(&self) {
        if let Err(e) = post_monitors_off() {
            crate::error!("could not turn the screens off again: {e}");
        }
    }
    fn input_tick(&self) -> u32 {
        last_input_tick()
    }
    fn listen(&self, on: bool) {
        let hwnd = WATCHER_HWND.load(Ordering::SeqCst);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_LISTEN, on as usize, 0) };
        }
    }
    fn now(&self) -> f64 {
        START.get_or_init(Instant::now).elapsed().as_secs_f64()
    }
}

pub static GUARD: NightGuard<Win> = NightGuard::new(Win);

/// Wait for raw input that is still queued, then judge a wake.
const SETTLE: Duration = Duration::from_millis(500);

// --- Display state watcher -----------------------------------------------------------
// A hidden window subscribed to GUID_CONSOLE_DISPLAY_STATE: Windows tells it whenever the
// displays go off, dim or come on, whoever caused it.

fn set_raw_input(hwnd: HWND, on: bool) -> Result<(), u32> {
    let device = |usage| RAWINPUTDEVICE {
        usUsagePage: 1, // generic desktop
        usUsage: usage,
        dwFlags: if on { RIDEV_INPUTSINK } else { RIDEV_REMOVE },
        hwndTarget: if on { hwnd } else { 0 },
    };
    let devices = [device(2), device(6)]; // mouse, keyboard
    if unsafe { RegisterRawInputDevices(devices.as_ptr(), 2, size_of::<RAWINPUTDEVICE>() as u32) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    Ok(())
}

fn read_raw_input(handle: isize) {
    let mut buf = [0u64; 16];
    let mut size = size_of_val(&buf) as u32;
    let got = unsafe {
        GetRawInputData(handle, RID_INPUT, buf.as_mut_ptr().cast(), &mut size, RAWINPUTHEADER_SIZE as u32)
    };
    if got == 0 || got == u32::MAX {
        return;
    }
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast(), size_of_val(&buf)) };
    let u16_at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let i32_at = |o: usize| i32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    if u32::from_le_bytes(bytes[0..4].try_into().unwrap()) != RIM_TYPEMOUSE {
        GUARD.input_seen(0, 0, true); // keyboard
        return;
    }
    // RAWMOUSE: usFlags, pad, usButtonFlags, usButtonData, ulRawButtons, lLastX, lLastY
    let m = RAWINPUTHEADER_SIZE;
    let (flags, buttons) = (u16_at(m), u16_at(m + 4));
    #[cfg(test)]
    if buf[1] == 0 && buttons == 0 {
        // hDevice is null for SendInput's events: count only those, whatever the real mouse does.
        let mut s = tests::INJECTED.lock().unwrap();
        s.0 += 1;
        s.1 += i32_at(m + 12).unsigned_abs() as u64 + i32_at(m + 16).unsigned_abs() as u64;
    }
    if buttons != 0 || flags & MOUSE_MOVE_ABSOLUTE != 0 || (got as usize) < m + 20 {
        GUARD.input_seen(0, 0, true); // click, wheel, tablet, remote pointer
    } else {
        GUARD.input_seen(i32_at(m + 12), i32_at(m + 16), false);
    }
}

/// Some(result) when the message is handled here, None to pass it to DefWindowProc.
fn on_message(hwnd: HWND, msg: u32, w: usize, l: isize) -> Option<isize> {
    match msg {
        WM_POWERBROADCAST if w == PBT_POWERSETTINGCHANGE && l != 0 => {
            // POWERBROADCAST_SETTING: GUID, DataLength, Data
            let setting = l as *const u8;
            let guid = unsafe { setting.cast::<GUID>().read_unaligned() };
            if guid == GUID_CONSOLE_DISPLAY_STATE {
                let state = unsafe { setting.add(20).read() } as u32;
                if GUARD.display_changed(state) {
                    std::thread::spawn(|| {
                        std::thread::sleep(SETTLE);
                        GUARD.decide();
                    });
                }
            }
            Some(1)
        }
        WM_INPUT => {
            read_raw_input(l);
            None
        }
        WM_APP_LISTEN => {
            let result = set_raw_input(hwnd, w != 0);
            if w != 0 {
                GUARD.raw_ok.store(result.is_ok(), Ordering::SeqCst);
                if let Err(code) = result {
                    crate::warning!("raw input unavailable ({code}); any input will keep the screens on");
                }
            }
            Some(0)
        }
        _ => None,
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize {
    // Never let a bug kill the message loop (or unwind into Windows).
    match std::panic::catch_unwind(|| on_message(hwnd, msg, w, l)) {
        Ok(Some(result)) => result,
        Ok(None) => DefWindowProcW(hwnd, msg, w, l),
        Err(_) => {
            crate::error!("display watcher: a message handler panicked");
            DefWindowProcW(hwnd, msg, w, l)
        }
    }
}

/// Run a message loop that reports display state changes and, while the guard has asked
/// for it, raw keyboard and mouse input to GUARD. Blocks. Windows sends the current state
/// right after registering, so the first report is the state at startup.
fn watch_display() -> io::Result<()> {
    let class = wide("NightfallDisplayWatcher");
    let title = wide("Nightfall");
    unsafe {
        let instance = GetModuleHandleW(null());
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: wndproc,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: 0,
            hCursor: 0,
            hbrBackground: 0,
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        if RegisterClassW(&wc) == 0 {
            return Err(last_error("RegisterClassW"));
        }
        // A real (never shown) top-level window: message-only windows miss some power broadcasts.
        let hwnd = CreateWindowExW(0, class.as_ptr(), title.as_ptr(), 0, 0, 0, 0, 0, 0, 0, instance, null_mut());
        if hwnd == 0 {
            return Err(last_error("CreateWindowExW"));
        }
        if RegisterPowerSettingNotification(hwnd, &GUID_CONSOLE_DISPLAY_STATE, 0) == 0 {
            return Err(last_error("RegisterPowerSettingNotification"));
        }
        WATCHER_HWND.store(hwnd, Ordering::SeqCst);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

pub fn start_display_watcher() {
    START.get_or_init(Instant::now);
    std::thread::Builder::new()
        .name("display-watcher".into())
        .spawn(|| {
            if let Err(e) = watch_display() {
                crate::error!("display watcher could not start; screens may be woken by other programs ({e})");
            }
        })
        .expect("start the display watcher thread");
}

// --- Odds and ends -------------------------------------------------------------------

/// This PC's name, as Python's socket.gethostname() gives it.
pub fn host_name() -> String {
    const COMPUTER_NAME_PHYSICAL_DNS_HOSTNAME: i32 = 5;
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    if unsafe { GetComputerNameExW(COMPUTER_NAME_PHYSICAL_DNS_HOSTNAME, buf.as_mut_ptr(), &mut len) } == 0 {
        return std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into());
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// "2026-11-26 20:44:56,091" in local time.
pub fn local_timestamp() -> String {
    let mut t = SYSTEMTIME::default();
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02},{:03}",
        t.year, t.month, t.day, t.hour, t.minute, t.second, t.ms
    )
}

/// Listen on [::]:port for IPv6 and IPv4 (IPV6_V6ONLY off), as the Python server did.
pub fn bind_dual_stack(port: u16) -> io::Result<TcpListener> {
    const AF_INET6: i32 = 23;
    const SOCK_STREAM: i32 = 1;
    const IPPROTO_TCP: i32 = 6;
    const IPPROTO_IPV6: i32 = 41;
    const IPV6_V6ONLY: i32 = 27;
    const WSA_FLAG_OVERLAPPED: u32 = 0x01;
    const WSA_FLAG_NO_HANDLE_INHERIT: u32 = 0x80;
    const INVALID_SOCKET: usize = usize::MAX;
    let wsa_error = || io::Error::from_raw_os_error(unsafe { WSAGetLastError() });
    unsafe {
        let mut data = [0u8; 512];
        WSAStartup(0x0202, data.as_mut_ptr());
        let s = WSASocketW(AF_INET6, SOCK_STREAM, IPPROTO_TCP, null_mut(), 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
        if s == INVALID_SOCKET {
            return Err(wsa_error());
        }
        let fail = |s| {
            let e = wsa_error();
            closesocket(s);
            Err(e)
        };
        let off: u32 = 0;
        if setsockopt(s, IPPROTO_IPV6, IPV6_V6ONLY, (&off as *const u32).cast(), 4) != 0 {
            return fail(s);
        }
        // sockaddr_in6 for [::]:port
        let mut addr = [0u8; 28];
        addr[0..2].copy_from_slice(&(AF_INET6 as u16).to_le_bytes());
        addr[2..4].copy_from_slice(&port.to_be_bytes());
        if bind(s, addr.as_ptr(), addr.len() as i32) != 0 || listen(s, 128) != 0 {
            return fail(s);
        }
        Ok(TcpListener::from_raw_socket(s as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub static INJECTED: std::sync::Mutex<(u32, u64)> = std::sync::Mutex::new((0, 0));

    #[test]
    fn struct_layouts_match_windows() {
        assert_eq!(size_of::<INPUT>(), 40);
        assert_eq!(size_of::<MSG>(), 48);
        assert_eq!(size_of::<RAWINPUTDEVICE>(), 16);
        assert_eq!(RAWINPUTHEADER_SIZE, 24);
        assert_eq!(size_of::<GUID>(), 16);
    }

    /// Moves the real mouse 3 px right and back, and checks the watcher saw it as raw
    /// relative movement. Run with `cargo test -- --ignored raw_input`.
    #[test]
    #[ignore]
    fn raw_input_sees_a_small_mouse_movement() {
        start_display_watcher();
        let t = Instant::now();
        while WATCHER_HWND.load(Ordering::SeqCst) == 0 {
            assert!(t.elapsed() < Duration::from_secs(5), "watcher window never appeared");
            std::thread::sleep(Duration::from_millis(20));
        }
        GUARD.arm(); // only starts listening; nothing turns the screens off
        std::thread::sleep(Duration::from_millis(300));
        send_mouse_moves(&[3, -3]);
        std::thread::sleep(Duration::from_millis(300));
        let seen = GUARD.seen();
        GUARD.disarm();
        assert!(GUARD.raw_ok.load(Ordering::SeqCst), "raw input registered");
        // The guard counts everything (a person using the PC too); the injected moves must
        // be among it, parsed as two relative moves of 3.
        assert_eq!(*INJECTED.lock().unwrap(), (2, 6), "guard saw {seen:?}");
        assert!(seen.0 >= 2 && seen.1 >= 6, "guard saw {seen:?}");
    }
}
