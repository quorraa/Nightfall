//! Installing, updating, checking on and removing Nightfall, from the .exe itself.
//!
//!   nightfall.exe                  not installed, or a different version: offer to install it;
//!                                  installed: the manage window (where to open it, open it
//!                                  here, stop or start it, change the port, remove it)
//!   nightfall.exe --install [port] install (or reinstall) without asking which
//!   nightfall.exe --uninstall      what Settings › Apps runs
//!
//! Installing copies the .exe to Program Files\Nightfall, registers a Task Scheduler task that
//! starts it with --serve at sign-in, opens the port to the local subnet in Windows Firewall,
//! adds Nightfall to the Start menu (which opens the manage window) and to Settings › Apps.
//! That part runs elevated (one UAC prompt), in a second copy of this program started with
//! --do-install / --do-uninstall. Changing the port is a reinstall with the new port.
#![allow(non_snake_case, clippy::upper_case_acronyms)]

use std::ffi::c_void;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use crate::json;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 39847;
const TASK: &str = "Nightfall";
const APP_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Nightfall";
const ERROR_CANCELLED: i32 = 1223;

// --- Windows API ---------------------------------------------------------------------

type HWND = isize;
type HKEY = isize;
type BOOL = i32;
type DialogCallback = unsafe extern "system" fn(HWND, u32, usize, isize, isize) -> i32;
type TaskDialogIndirectFn =
    unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> i32;

#[repr(C, packed)]
struct TASKDIALOG_BUTTON {
    id: i32,
    text: *const u16,
}

#[repr(C, packed)]
struct TASKDIALOGCONFIG {
    cbSize: u32,
    hwndParent: HWND,
    hInstance: isize,
    dwFlags: u32,
    dwCommonButtons: u32,
    pszWindowTitle: *const u16,
    pszMainIcon: usize,
    pszMainInstruction: *const u16,
    pszContent: *const u16,
    cButtons: u32,
    pButtons: *const TASKDIALOG_BUTTON,
    nDefaultButton: i32,
    cRadioButtons: u32,
    pRadioButtons: *const TASKDIALOG_BUTTON,
    nDefaultRadioButton: i32,
    pszVerificationText: *const u16,
    pszExpandedInformation: *const u16,
    pszExpandedControlText: *const u16,
    pszCollapsedControlText: *const u16,
    pszFooterIcon: usize,
    pszFooter: *const u16,
    pfCallback: Option<DialogCallback>,
    lpCallbackData: isize,
    cxWidth: u32,
}

#[repr(C)]
struct SHELLEXECUTEINFOW {
    cbSize: u32,
    fMask: u32,
    hwnd: HWND,
    lpVerb: *const u16,
    lpFile: *const u16,
    lpParameters: *const u16,
    lpDirectory: *const u16,
    nShow: i32,
    hInstApp: isize,
    lpIDList: *mut c_void,
    lpClass: *const u16,
    hkeyClass: HKEY,
    dwHotKey: u32,
    hIcon: isize,
    hProcess: isize,
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: HWND, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn SendMessageW(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize;
    fn LoadImageW(instance: isize, name: *const u16, kind: u32, cx: i32, cy: i32, flags: u32) -> isize;
    fn GetSystemMetrics(index: i32) -> i32;
    fn DialogBoxIndirectParamW(instance: isize, template: *const c_void, parent: HWND, proc_: DialogProc, param: isize) -> isize;
    fn EndDialog(hwnd: HWND, result: isize) -> BOOL;
    fn GetDlgItem(hwnd: HWND, id: i32) -> HWND;
    fn GetDlgItemInt(hwnd: HWND, id: i32, ok: *mut BOOL, signed: BOOL) -> u32;
    fn SetDlgItemInt(hwnd: HWND, id: i32, value: u32, signed: BOOL) -> BOOL;
    fn SendDlgItemMessageW(hwnd: HWND, id: i32, msg: u32, w: usize, l: isize) -> isize;
    fn SetFocus(hwnd: HWND) -> HWND;
    fn MessageBeep(kind: u32) -> BOOL;
    fn FillRect(dc: isize, rect: *const RECT, brush: isize) -> i32;
    fn GetSysColorBrush(index: i32) -> isize;
}

type DialogProc = unsafe extern "system" fn(HWND, u32, usize, isize) -> isize;

#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(which: i32) -> isize;
}

#[repr(C)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct DRAWITEMSTRUCT {
    CtlType: u32,
    CtlID: u32,
    itemID: u32,
    itemAction: u32,
    itemState: u32,
    hwndItem: HWND,
    hDC: isize,
    rcItem: RECT,
    itemData: usize,
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *const c_void, coinit: u32) -> i32;
    fn CoCreateInstance(clsid: *const Guid, outer: *mut c_void, context: u32, iid: *const Guid, out: *mut *mut c_void) -> i32;
}

#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn WaitForSingleObject(handle: isize, ms: u32) -> u32;
    fn GetExitCodeProcess(handle: isize, code: *mut u32) -> BOOL;
    fn CloseHandle(handle: isize) -> BOOL;
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> BOOL;
    fn GetSystemDirectoryW(buf: *mut u16, size: u32) -> u32;
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut SHELLEXECUTEINFOW) -> BOOL;
    fn ShellExecuteW(hwnd: HWND, verb: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> isize;
    fn IsUserAnAdmin() -> BOOL;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        key: HKEY, sub: *const u16, reserved: u32, class: *const u16, options: u32, access: u32,
        security: *const c_void, result: *mut HKEY, disposition: *mut u32,
    ) -> i32;
    fn RegSetValueExW(key: HKEY, name: *const u16, reserved: u32, kind: u32, data: *const u8, len: u32) -> i32;
    fn RegCloseKey(key: HKEY) -> i32;
    fn RegGetValueW(key: HKEY, sub: *const u16, name: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, len: *mut u32) -> i32;
    fn RegDeleteTreeW(key: HKEY, sub: *const u16) -> i32;
}

const HKEY_LOCAL_MACHINE: HKEY = 0x8000_0002u32 as i32 as isize;
#[cfg(test)]
const HKEY_CURRENT_USER: HKEY = 0x8000_0001u32 as i32 as isize;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn wide_path(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}

// --- Registry ------------------------------------------------------------------------

enum RegValue<'a> {
    Text(&'a str),
    Number(u32),
}

fn reg_write(root: HKEY, sub: &str, values: &[(&str, RegValue)]) -> io::Result<()> {
    const KEY_WRITE: u32 = 0x20006;
    let mut key: HKEY = 0;
    let rc = unsafe { RegCreateKeyExW(root, wide(sub).as_ptr(), 0, null(), 0, KEY_WRITE, null(), &mut key, null_mut()) };
    if rc != 0 {
        return Err(io::Error::from_raw_os_error(rc));
    }
    let mut result = Ok(());
    for (name, value) in values {
        let rc = match value {
            RegValue::Text(t) => {
                let w = wide(t);
                unsafe { RegSetValueExW(key, wide(name).as_ptr(), 0, 1, w.as_ptr().cast(), (w.len() * 2) as u32) }
            }
            RegValue::Number(n) => unsafe { RegSetValueExW(key, wide(name).as_ptr(), 0, 4, (n as *const u32).cast(), 4) },
        };
        if rc != 0 {
            result = Err(io::Error::from_raw_os_error(rc));
            break;
        }
    }
    unsafe { RegCloseKey(key) };
    result
}

fn reg_text(root: HKEY, sub: &str, name: &str) -> Option<String> {
    const RRF_RT_REG_SZ: u32 = 0x2;
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(root, wide(sub).as_ptr(), wide(name).as_ptr(), RRF_RT_REG_SZ, null_mut(), buf.as_mut_ptr().cast(), &mut len)
    };
    (rc == 0).then(|| String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
}

fn reg_number(root: HKEY, sub: &str, name: &str) -> Option<u32> {
    const RRF_RT_REG_DWORD: u32 = 0x10;
    let mut n: u32 = 0;
    let mut len = 4u32;
    let rc = unsafe {
        RegGetValueW(root, wide(sub).as_ptr(), wide(name).as_ptr(), RRF_RT_REG_DWORD, null_mut(), (&mut n as *mut u32).cast(), &mut len)
    };
    (rc == 0).then_some(n)
}

fn reg_delete(root: HKEY, sub: &str) {
    unsafe { RegDeleteTreeW(root, wide(sub).as_ptr()) };
}

// --- Dialogs -------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Icon {
    App,
    Info,
    Error,
}

struct Dialog<'a> {
    instruction: &'a str,
    content: &'a str,
    footer: Option<&'a str>,
    icon: Icon,
    /// Custom buttons, in order; the first is the default. When any label has a second line
    /// (after \n), they're shown as command links, with that line as the note.
    buttons: &'a [(i32, &'a str)],
    /// Custom buttons that get the UAC shield.
    shield: &'a [i32],
    /// Common buttons: CANCEL or CLOSE.
    common: u32,
}

const TDCBF_CANCEL_BUTTON: u32 = 0x08;
const TDCBF_CLOSE_BUTTON: u32 = 0x20;
const IDCANCEL: i32 = 2;
const IDCLOSE: i32 = 8;

struct CallbackData {
    shield: Vec<i32>,
}

/// Show Nightfall's icon in a window's title bar and taskbar button.
unsafe fn set_window_icons(hwnd: HWND) {
    const WM_SETICON: u32 = 0x80;
    let instance = GetModuleHandleW(null());
    for (which, metric) in [(0usize, 49), (1usize, 11)] {
        // ICON_SMALL with SM_CXSMICON, ICON_BIG with SM_CXICON
        let size = GetSystemMetrics(metric);
        let icon = LoadImageW(instance, 1 as *const u16, 1, size, size, 0);
        if icon != 0 {
            SendMessageW(hwnd, WM_SETICON, which, icon);
        }
    }
}

unsafe extern "system" fn dialog_callback(hwnd: HWND, msg: u32, _w: usize, l: isize, data: isize) -> i32 {
    const TDN_CREATED: u32 = 0;
    const TDN_HYPERLINK_CLICKED: u32 = 3;
    const TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE: u32 = 0x400 + 115;
    match msg {
        TDN_CREATED => {
            let data = &*(data as *const CallbackData);
            for id in &data.shield {
                SendMessageW(hwnd, TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE, *id as usize, 1);
            }
            set_window_icons(hwnd);
        }
        TDN_HYPERLINK_CLICKED => {
            ShellExecuteW(hwnd, wide("open").as_ptr(), l as *const u16, null(), null(), 1);
        }
        _ => {}
    }
    0
}

fn task_dialog() -> Option<TaskDialogIndirectFn> {
    // Looked up at run time: with the manifest this is Common Controls 6, which has it.
    unsafe {
        let module = LoadLibraryW(wide("comctl32.dll").as_ptr());
        if module == 0 {
            return None;
        }
        let f = GetProcAddress(module, c"TaskDialogIndirect".as_ptr().cast());
        (!f.is_null()).then(|| std::mem::transmute::<*const c_void, TaskDialogIndirectFn>(f))
    }
}

/// Show a dialog; returns the id of the button pressed.
fn show(d: &Dialog) -> i32 {
    let title = wide("Nightfall");
    let instruction = wide(d.instruction);
    let content = wide(d.content);
    let footer = d.footer.map(wide);
    let labels: Vec<Vec<u16>> = d.buttons.iter().map(|(_, t)| wide(t)).collect();
    let buttons: Vec<TASKDIALOG_BUTTON> =
        d.buttons.iter().zip(&labels).map(|((id, _), l)| TASKDIALOG_BUTTON { id: *id, text: l.as_ptr() }).collect();
    let data = CallbackData { shield: d.shield.to_vec() };
    let command_links = d.buttons.iter().any(|(_, t)| t.contains('\n'));
    let (instance, icon) = match d.icon {
        Icon::App => (unsafe { GetModuleHandleW(null()) }, 1usize),
        Icon::Info => (0, 0xFFFD), // TD_INFORMATION_ICON
        Icon::Error => (0, 0xFFFE), // TD_ERROR_ICON
    };
    let config = TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: 0,
        hInstance: instance,
        dwFlags: 0x01 | 0x08 | if command_links { 0x10 } else { 0 }, // hyperlinks, Esc closes, command links
        dwCommonButtons: d.common,
        pszWindowTitle: title.as_ptr(),
        pszMainIcon: icon,
        pszMainInstruction: instruction.as_ptr(),
        pszContent: content.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: d.buttons.first().map_or(0, |b| b.0),
        cRadioButtons: 0,
        pRadioButtons: null(),
        nDefaultRadioButton: 0,
        pszVerificationText: null(),
        pszExpandedInformation: null(),
        pszExpandedControlText: null(),
        pszCollapsedControlText: null(),
        pszFooterIcon: if footer.is_some() { 0xFFFD } else { 0 },
        pszFooter: footer.as_ref().map_or(null(), |f| f.as_ptr()),
        pfCallback: Some(dialog_callback),
        lpCallbackData: &data as *const CallbackData as isize,
        cxWidth: 0,
    };
    let mut pressed = IDCANCEL;
    if let Some(f) = task_dialog() {
        if unsafe { f(&config, &mut pressed, null_mut(), null_mut()) } == 0 {
            return pressed;
        }
    }
    // No task dialogs (shouldn't happen on Windows 10/11): a plain message box.
    let text = format!("{}\n\n{}", d.instruction, strip_links(d.content));
    let (kind, ok) = if d.buttons.is_empty() { (0x40, IDCLOSE) } else { (0x41, d.buttons[0].0) }; // MB_OK / MB_OKCANCEL, info icon
    match unsafe { MessageBoxW(0, wide(&text).as_ptr(), title.as_ptr(), kind) } {
        1 => ok,
        _ => IDCANCEL,
    }
}

fn strip_links(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        match rest[i..].find('>') {
            Some(j) => rest = &rest[i + j + 1..],
            None => {
                rest = &rest[i..];
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn link(url: &str) -> String {
    format!("<a href=\"{url}\">{url}</a>")
}

fn error_dialog(instruction: &str, e: &dyn std::fmt::Display) -> i32 {
    show(&Dialog {
        instruction,
        content: &e.to_string(),
        footer: None,
        icon: Icon::Error,
        buttons: &[],
        shield: &[],
        common: TDCBF_CLOSE_BUTTON,
    });
    1
}

// --- Asking for a port ---------------------------------------------------------------

const PORT_EDIT: i32 = 1000;

/// An in-memory dialog template (DLGTEMPLATE and its items), built as 16-bit words.
struct Template(Vec<u16>);

impl Template {
    fn u32(&mut self, v: u32) {
        self.0.extend([v as u16, (v >> 16) as u16]);
    }
    fn text(&mut self, s: &str) {
        self.0.extend(s.encode_utf16().chain(Some(0)));
    }
    fn new(title: &str, items: u16, (cx, cy): (i16, i16)) -> Template {
        const STYLE: u32 = 0x8000_0000 | 0x00C0_0000 | 0x0008_0000 | 0x80 | 0x40 | 0x800; // popup, caption, system menu, modal frame, font, centred
        let mut t = Template(Vec::new());
        t.u32(STYLE);
        t.u32(0);
        t.0.extend([items, 0, 0, cx as u16, cy as u16, 0, 0]); // count, x, y, cx, cy, no menu, default class
        t.text(title);
        t.0.push(9);
        t.text("Segoe UI");
        t
    }
    /// One control of a predefined class: 0x80 button, 0x81 edit, 0x82 static.
    fn item(&mut self, class: u16, id: u16, style: u32, (x, y, cx, cy): (i16, i16, i16, i16), text: &str) {
        if self.0.len() % 2 == 1 {
            self.0.push(0); // items start on 4-byte boundaries
        }
        self.u32(0x5000_0000 | style); // child, visible
        self.u32(0);
        self.0.extend([x as u16, y as u16, cx as u16, cy as u16, id, 0xFFFF, class]);
        self.text(text);
        self.0.push(0); // no creation data
    }
    /// The words, in a buffer the template can start on a 4-byte boundary in.
    fn aligned(&self) -> Vec<u32> {
        let mut out = vec![0u32; self.0.len().div_ceil(2)];
        unsafe { std::ptr::copy_nonoverlapping(self.0.as_ptr(), out.as_mut_ptr().cast::<u16>(), self.0.len()) };
        out
    }
}

fn port_template() -> Template {
    const TABSTOP: u32 = 0x0001_0000;
    let mut t = Template::new("Nightfall", 5, (210, 86));
    t.item(0x82, 0xFFFF, 0, (8, 8, 194, 9), "New port (1024 to 65535):");
    t.item(0x81, PORT_EDIT as u16, 0x0080_0000 | TABSTOP | 0x2000 | 0x80, (8, 20, 60, 13), ""); // border, numbers only
    t.item(0x82, 0xFFFF, 0, (8, 40, 194, 18), "Phones and Tailscale will need the new address, which Nightfall shows next.");
    t.item(0x80, 1, TABSTOP | 0x1, (98, 64, 50, 14), "Change"); // IDOK, default button
    t.item(0x80, 2, TABSTOP, (152, 64, 50, 14), "Cancel");
    t
}

unsafe extern "system" fn port_dialog_proc(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize {
    const WM_INITDIALOG: u32 = 0x110;
    const WM_COMMAND: u32 = 0x111;
    const EM_SETSEL: u32 = 0xB1;
    const EM_LIMITTEXT: u32 = 0xC5;
    match msg {
        WM_INITDIALOG => {
            set_window_icons(hwnd);
            SetDlgItemInt(hwnd, PORT_EDIT, l as u32, 0);
            SendDlgItemMessageW(hwnd, PORT_EDIT, EM_LIMITTEXT, 5, 0);
            1
        }
        WM_COMMAND => match (w & 0xFFFF) as i32 {
            1 => {
                let mut ok = 0;
                let port = GetDlgItemInt(hwnd, PORT_EDIT, &mut ok, 0);
                if ok != 0 && (1024..=65535).contains(&port) {
                    EndDialog(hwnd, port as isize);
                } else {
                    MessageBeep(0x30);
                    SetFocus(GetDlgItem(hwnd, PORT_EDIT));
                    SendDlgItemMessageW(hwnd, PORT_EDIT, EM_SETSEL, 0, -1);
                }
                1
            }
            2 => {
                EndDialog(hwnd, 0);
                1
            }
            _ => 0,
        },
        _ => 0,
    }
}

/// Ask for a port number, starting from `current`. None if cancelled.
fn ask_port(current: u16) -> Option<u16> {
    let template = port_template().aligned();
    let r = unsafe {
        DialogBoxIndirectParamW(GetModuleHandleW(null()), template.as_ptr().cast(), 0, port_dialog_proc, current as isize)
    };
    u16::try_from(r).ok().filter(|p| *p >= 1024)
}

const TAILSCALE_WINDOWS: &str = "https://tailscale.com/download/windows";
const GET_WINDOWS: u16 = 120;
const CODE_IPHONE: u16 = 121;
const CODE_ANDROID: u16 = 122;

fn tailscale_template() -> Template {
    const TABSTOP: u32 = 0x0001_0000;
    const SS_CENTER: u32 = 0x1;
    const SS_OWNERDRAW: u32 = 0xD;
    let mut t = Template::new("Nightfall", 8, (260, 218));
    t.item(
        0x82,
        0xFFFF,
        0,
        (8, 8, 244, 26),
        "Tailscale lets your phone reach this PC from anywhere, not just at home. Put it on both, and \
         sign in with the same account on each.",
    );
    t.item(0x80, GET_WINDOWS, TABSTOP, (8, 38, 110, 14), "Get Tailscale for Windows");
    t.item(0x82, 0xFFFF, 0, (8, 62, 244, 9), "On your phone, scan one with the camera:");
    t.item(0x82, CODE_IPHONE, SS_OWNERDRAW, (14, 76, 110, 100), "");
    t.item(0x82, CODE_ANDROID, SS_OWNERDRAW, (136, 76, 110, 100), "");
    t.item(0x82, 0xFFFF, SS_CENTER, (14, 178, 110, 9), "iPhone: App Store");
    t.item(0x82, 0xFFFF, SS_CENTER, (136, 178, 110, 9), "Android: Google Play");
    t.item(0x80, 2, TABSTOP | 0x1, (202, 198, 50, 14), "Back"); // IDCANCEL, default button
    t
}

/// Draw a QR code as square modules on white, with its 4-module quiet zone, centred in `r`.
unsafe fn draw_code(dc: isize, r: &RECT, code: &[&str]) {
    const COLOR_BTNFACE: i32 = 15;
    const WHITE_BRUSH: i32 = 0;
    const BLACK_BRUSH: i32 = 4;
    FillRect(dc, r, GetSysColorBrush(COLOR_BTNFACE));
    let n = code.len() as i32;
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    let module = (w.min(h) / (n + 8)).max(1);
    let side = module * (n + 8);
    let (x0, y0) = (r.left + (w - side) / 2, r.top + (h - side) / 2);
    FillRect(dc, &RECT { left: x0, top: y0, right: x0 + side, bottom: y0 + side }, GetStockObject(WHITE_BRUSH));
    let black = GetStockObject(BLACK_BRUSH);
    for (y, row) in code.iter().enumerate() {
        for (x, c) in row.bytes().enumerate() {
            if c == b'#' {
                let left = x0 + (x as i32 + 4) * module;
                let top = y0 + (y as i32 + 4) * module;
                FillRect(dc, &RECT { left, top, right: left + module, bottom: top + module }, black);
            }
        }
    }
}

unsafe extern "system" fn tailscale_dialog_proc(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize {
    const WM_INITDIALOG: u32 = 0x110;
    const WM_COMMAND: u32 = 0x111;
    const WM_DRAWITEM: u32 = 0x2B;
    match msg {
        WM_INITDIALOG => {
            set_window_icons(hwnd);
            1
        }
        WM_COMMAND => match (w & 0xFFFF) as u16 {
            GET_WINDOWS => {
                ShellExecuteW(hwnd, wide("open").as_ptr(), wide(TAILSCALE_WINDOWS).as_ptr(), null(), null(), 1);
                1
            }
            2 => {
                EndDialog(hwnd, 0);
                1
            }
            _ => 0,
        },
        WM_DRAWITEM => {
            let item = &*(l as *const DRAWITEMSTRUCT);
            let code = match item.CtlID as u16 {
                CODE_IPHONE => crate::qr::APP_STORE,
                CODE_ANDROID => crate::qr::GOOGLE_PLAY,
                _ => return 0,
            };
            draw_code(item.hDC, &item.rcItem, code);
            1
        }
        _ => 0,
    }
}

/// The Get Tailscale window: a download button for this PC and store codes for the phone.
fn get_tailscale() {
    let template = tailscale_template().aligned();
    unsafe { DialogBoxIndirectParamW(GetModuleHandleW(null()), template.as_ptr().cast(), 0, tailscale_dialog_proc, 0) };
}

// --- Where things are ----------------------------------------------------------------

struct Installed {
    dir: PathBuf,
    version: String,
    port: u16,
}

impl Installed {
    fn exe(&self) -> PathBuf {
        self.dir.join("nightfall.exe")
    }
}

fn installed() -> Option<Installed> {
    let dir = PathBuf::from(reg_text(HKEY_LOCAL_MACHINE, APP_KEY, "InstallLocation")?);
    Some(Installed {
        version: reg_text(HKEY_LOCAL_MACHINE, APP_KEY, "DisplayVersion").unwrap_or_default(),
        port: reg_number(HKEY_LOCAL_MACHINE, APP_KEY, "Port").and_then(|p| u16::try_from(p).ok()).unwrap_or(DEFAULT_PORT),
        dir,
    })
}

fn install_dir() -> PathBuf {
    let program_files = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);
    program_files.join("Nightfall")
}

fn system_tool(name: &str) -> PathBuf {
    let mut buf = [0u16; 260];
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    let dir = if n > 0 && n < buf.len() { String::from_utf16_lossy(&buf[..n]) } else { r"C:\Windows\System32".into() };
    PathBuf::from(dir).join(name)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}

fn this_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("nightfall.exe"))
}

/// Is Nightfall answering on this port (and not some other program)?
fn is_running(port: u16) -> bool {
    let ask = || -> io::Result<String> {
        let mut s = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300))?;
        s.set_read_timeout(Some(Duration::from_secs(1)))?;
        s.write_all(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
        let mut reply = String::new();
        s.take(64 * 1024).read_to_string(&mut reply)?;
        Ok(reply)
    };
    ask().is_ok_and(|r| r.starts_with("HTTP/1.1 200") && r.contains("\"dry_run\""))
}

fn wait_until_stopped(port: u16, within: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < within {
        if !is_running(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn current_user() -> String {
    format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    )
}

/// The Start menu entry, for everyone on this PC.
fn shortcut_path() -> PathBuf {
    let data = std::env::var_os("ProgramData").map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from);
    data.join(r"Microsoft\Windows\Start Menu\Programs\Nightfall.lnk")
}

fn wait_for_server(port: u16, within: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < within {
        if is_running(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// This PC's address on the home network, if it has one.
fn lan_address() -> Option<IpAddr> {
    // Connecting a UDP socket sends nothing; it only picks the route, and so the address.
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").or_else(|_| s.connect("8.8.8.8:53")).ok()?;
    let ip = s.local_addr().ok()?.ip();
    match ip {
        IpAddr::V4(v4) if v4.is_private() => Some(ip),
        _ => None,
    }
}

enum Tailscale {
    Absent,
    Ready(String),
    NeedsServe,
}

fn tailscale(port: u16) -> Tailscale {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let run = |args: &[&str]| -> Option<String> {
        for exe in ["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"] {
            if let Ok(out) = Command::new(exe).args(args).creation_flags(CREATE_NO_WINDOW).output() {
                return out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned());
            }
        }
        None
    };
    let Some(status) = run(&["status", "--json"]) else { return Tailscale::Absent };
    let dns = json::parse(&status)
        .and_then(|v| match v.get("Self")?.get("DNSName")? {
            json::Value::Str(s) => Some(s.trim_end_matches('.').to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty());
    let Some(dns) = dns else { return Tailscale::Absent };
    let served = run(&["serve", "status", "--json"])
        .is_some_and(|s| s.contains(&format!(":{port}\"")) || s.contains(&format!("\"{port}\"")));
    if served {
        Tailscale::Ready(format!("https://{dns}:{port}"))
    } else {
        Tailscale::NeedsServe
    }
}

/// Where to open Nightfall on the phone, as dialog text with links.
fn where_to_open(port: u16, ts: &Tailscale) -> String {
    let lan = lan_address();
    let mut text = match lan {
        Some(ip) => format!("On your phone, open\n{}", link(&format!("http://{ip}:{port}"))),
        None => "This PC doesn't seem to be on a home network right now.".to_string(),
    };
    match ts {
        Tailscale::Ready(url) => text += &format!("\n\nAway from home, with Tailscale:\n{}", link(url)),
        Tailscale::NeedsServe => {
            text += &format!(
                "\n\nTo reach it away from home over Tailscale, run this once in a terminal:\ntailscale serve --bg --https={port} http://127.0.0.1:{port}"
            )
        }
        Tailscale::Absent => {}
    }
    text += "\n\nTo keep it on your Home Screen: on an iPhone, Safari's Share menu › Add to Home Screen.";
    if let Some(ip) = lan {
        text += &format!(
            " Chrome on Android only installs it from an https:// address, so on Android open {} once: it \
             has the phone trust this PC, then Chrome's menu › Add to Home screen › Install.",
            link(&format!("http://{ip}:{port}/setup"))
        );
    }
    text
}

// --- Running things ------------------------------------------------------------------

/// Run a Windows tool with its command line given as is (netsh wants name="..." quoting).
fn tool(name: &str, args: &str) -> io::Result<String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new(system_tool(name))
        .raw_arg(args)
        .current_dir(system_tool(""))
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(io::Error::other(format!("{name} {args}\n{}", text.trim())))
    }
}

/// Run this program again, elevated, with `args`; returns its exit code (ERROR_CANCELLED if
/// the UAC prompt was declined). Already elevated: no second copy is needed.
fn elevated(args: &[String], here: impl FnOnce() -> i32) -> i32 {
    if unsafe { IsUserAnAdmin() } != 0 {
        return here();
    }
    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x40;
    const SEE_MASK_NOASYNC: u32 = 0x100;
    const SEE_MASK_FLAG_NO_UI: u32 = 0x400;
    let file = wide_path(&this_exe());
    let params = wide(&args.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" "));
    let verb = wide("runas");
    let dir = wide_path(&system_tool(""));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.lpDirectory = dir.as_ptr();
    info.nShow = 1;
    unsafe {
        if ShellExecuteExW(&mut info) == 0 {
            return io::Error::last_os_error().raw_os_error().unwrap_or(1);
        }
        WaitForSingleObject(info.hProcess, u32::MAX);
        let mut code = 1u32;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        code as i32
    }
}

/// Write a .lnk file with the shell's ShellLink object (IShellLinkW, then IPersistFile::Save).
fn create_shortcut(lnk: &Path, target: &Path, description: &str) -> io::Result<()> {
    const CLSID_SHELL_LINK: Guid = Guid(0x0002_1401, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);
    const IID_SHELL_LINK_W: Guid = Guid(0x0002_14F9, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);
    const IID_PERSIST_FILE: Guid = Guid(0x0000_010B, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);
    type QueryInterface = unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32;
    type Release = unsafe extern "system" fn(*mut c_void) -> u32;
    type SetText = unsafe extern "system" fn(*mut c_void, *const u16) -> i32;
    type SetIcon = unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32;
    type Save = unsafe extern "system" fn(*mut c_void, *const u16, BOOL) -> i32;
    /// The `index`th method in a COM object's table.
    unsafe fn method<F: Copy>(object: *mut c_void, index: usize) -> F {
        let table = *(object as *const *const usize);
        std::mem::transmute_copy(&*table.add(index))
    }
    let check = |hr: i32, what: &str| {
        if hr < 0 {
            Err(io::Error::other(format!("Couldn't make the Start menu shortcut ({what}: 0x{hr:08X})")))
        } else {
            Ok(())
        }
    };
    unsafe {
        CoInitializeEx(null(), 0x2); // apartment-threaded; already initialised is fine too
        let mut link: *mut c_void = null_mut();
        check(CoCreateInstance(&CLSID_SHELL_LINK, null_mut(), 0x1, &IID_SHELL_LINK_W, &mut link), "ShellLink")?;
        let result = (|| {
            let target_w = wide_path(target);
            check(method::<SetText>(link, 20)(link, target_w.as_ptr()), "SetPath")?;
            let dir = wide_path(target.parent().unwrap_or(Path::new("")));
            check(method::<SetText>(link, 9)(link, dir.as_ptr()), "SetWorkingDirectory")?;
            check(method::<SetText>(link, 7)(link, wide(description).as_ptr()), "SetDescription")?;
            check(method::<SetIcon>(link, 17)(link, target_w.as_ptr(), 0), "SetIconLocation")?;
            let mut file: *mut c_void = null_mut();
            check(method::<QueryInterface>(link, 0)(link, &IID_PERSIST_FILE, &mut file), "IPersistFile")?;
            let saved = check(method::<Save>(file, 6)(file, wide_path(lnk).as_ptr(), 1), "Save");
            method::<Release>(file, 2)(file);
            saved
        })();
        method::<Release>(link, 2)(link);
        result
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The Task Scheduler task: start at sign-in on the user's desktop, without admin rights,
/// restart if it dies, never time out.
fn task_xml(exe: &Path, port: u16, user: &str) -> String {
    let user = xml_escape(user);
    let exe_text = xml_escape(&exe.to_string_lossy());
    let dir = xml_escape(&exe.parent().unwrap_or(Path::new("")).to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Nightfall: turn the monitors off from your phone (port {port}).</Description>
    <URI>\{TASK}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>"{exe_text}"</Command><Arguments>--serve --port {port}</Arguments><WorkingDirectory>{dir}</WorkingDirectory></Exec>
  </Actions>
</Task>
"#
    )
}

fn register_task(exe: &Path, port: u16, user: &str) -> io::Result<()> {
    let path = std::env::temp_dir().join(format!("nightfall-task-{}.xml", std::process::id()));
    let mut bytes = vec![0xFF, 0xFE]; // UTF-16 LE, as Task Scheduler writes them
    bytes.extend(task_xml(exe, port, user).encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(&path, bytes)?;
    let result = tool("schtasks.exe", &format!("/Create /TN \"{TASK}\" /XML \"{}\" /F", path.display()));
    let _ = fs::remove_file(&path);
    result.map(drop)
}

fn firewall_rule(port: u16) -> String {
    format!("Nightfall (TCP {port})")
}

// --- Install -------------------------------------------------------------------------

fn install_ui(port: Option<u16>) -> i32 {
    let before = installed();
    let port = port.or(before.as_ref().map(|i| i.port)).unwrap_or(DEFAULT_PORT);
    let instruction = match &before {
        None => "Install Nightfall?".to_string(),
        Some(i) if i.version == VERSION => format!("Reinstall Nightfall {VERSION}?"),
        Some(i) => format!("Update Nightfall from {} to {VERSION}?", i.version),
    };
    let content = format!(
        "Nightfall lets your phone turn this PC's screens off, over your home network or Tailscale.\n\n\
         Installing it will:\n\
         • put Nightfall in {}\n\
         • start it in the background each time you sign in\n\
         • let devices on your home network reach it through Windows Firewall, on port {port}\n\
         • add it to the Start menu, where you can check on it, stop it or change the port\n\n\
         Windows will ask for permission once.",
        install_dir().display()
    );
    let choice = show(&Dialog {
        instruction: &instruction,
        content: &content,
        footer: Some("You can remove it any time from Settings › Apps."),
        icon: Icon::App,
        buttons: &[(100, if before.is_some() { "Update" } else { "Install" })],
        shield: &[100],
        common: TDCBF_CANCEL_BUTTON,
    });
    if choice != 100 {
        return 0;
    }
    match install_elevated(port) {
        0 => {}
        ERROR_CANCELLED => return 0,
        code => return code, // the elevated copy already said what went wrong
    }
    wait_for_server(port, Duration::from_secs(10));
    manage(port, true)
}

/// Install (or reinstall on another port) in an elevated copy; returns its exit code.
fn install_elevated(port: u16) -> i32 {
    let user = current_user();
    let args = vec!["--do-install".to_string(), port.to_string(), user.clone()];
    elevated(&args, || do_install(port, &user))
}

fn do_install(port: u16, user: &str) -> i32 {
    match install(port, user) {
        Ok(()) => 0,
        Err(e) => error_dialog("Nightfall couldn't be installed", &e),
    }
}

fn install(port: u16, user: &str) -> io::Result<()> {
    if user.trim_matches('\\').is_empty() {
        return Err(io::Error::other("Couldn't tell which Windows account to start Nightfall for."));
    }
    let before = installed();
    let dir = install_dir();
    let exe = dir.join("nightfall.exe");

    // Stop the running copy (an older version, or the old script-based setup) so the file
    // can be replaced and the port is free.
    let _ = tool("schtasks.exe", &format!("/End /TN \"{TASK}\""));
    for old in [before.as_ref().map(|i| i.port), Some(port)].into_iter().flatten() {
        wait_until_stopped(old, Duration::from_secs(10)); // the port frees a moment after /End
    }
    fs::create_dir_all(&dir)?;
    let me = this_exe();
    if !same_file(&me, &exe) {
        let mut tries = 0;
        loop {
            match fs::copy(&me, &exe) {
                Ok(_) => break,
                Err(e) if tries < 40 => {
                    let _ = e;
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(e) => return Err(io::Error::other(format!("Couldn't copy Nightfall to {}: {e}", exe.display()))),
            }
        }
    }

    for old in [before.as_ref().map(|i| i.port), Some(port)].into_iter().flatten() {
        let _ = tool("netsh.exe", &format!("advfirewall firewall delete rule name=\"{}\"", firewall_rule(old)));
    }
    tool(
        "netsh.exe",
        &format!(
            "advfirewall firewall add rule name=\"{}\" dir=in action=allow protocol=TCP localport={port} \
             remoteip=localsubnet profile=any program=\"{}\" description=\"Lets your phone reach Nightfall on your home network.\"",
            firewall_rule(port),
            exe.display()
        ),
    )?;

    register_task(&exe, port, user)?;

    let exe_text = exe.to_string_lossy();
    let size_kb = fs::metadata(&exe).map_or(0, |m| (m.len() / 1024) as u32);
    reg_write(
        HKEY_LOCAL_MACHINE,
        APP_KEY,
        &[
            ("DisplayName", RegValue::Text("Nightfall")),
            ("DisplayVersion", RegValue::Text(VERSION)),
            ("Publisher", RegValue::Text("quorraa")),
            ("DisplayIcon", RegValue::Text(&exe_text)),
            ("InstallLocation", RegValue::Text(&dir.to_string_lossy())),
            ("UninstallString", RegValue::Text(&format!("\"{exe_text}\" --uninstall"))),
            ("URLInfoAbout", RegValue::Text("https://github.com/quorraa/Nightfall")),
            ("NoModify", RegValue::Number(1)),
            ("NoRepair", RegValue::Number(1)),
            ("EstimatedSize", RegValue::Number(size_kb)),
            ("Port", RegValue::Number(port as u32)),
        ],
    )?;
    create_shortcut(&shortcut_path(), &exe, "Check on Nightfall, stop it or change its port")?;

    tool("schtasks.exe", &format!("/Run /TN \"{TASK}\"")).map(drop)
}

// --- Status --------------------------------------------------------------------------

const OPEN: i32 = 110;
const STOP: i32 = 111;
const START: i32 = 112;
const CHANGE_PORT: i32 = 113;
const REMOVE: i32 = 114;
const AWAY: i32 = 115;

/// The manage window's buttons; Get Tailscale only when this PC doesn't have it.
fn manage_buttons<'a>(running: bool, ts: &Tailscale, port_button: &'a str) -> Vec<(i32, &'a str)> {
    let mut buttons = Vec::new();
    if running {
        buttons.push((OPEN, "Open Nightfall here\nIn this PC's browser"));
        buttons.push((STOP, "Stop Nightfall\nUntil you start it here, or sign in again"));
    } else {
        buttons.push((START, "Start Nightfall"));
    }
    if matches!(ts, Tailscale::Absent) {
        buttons.push((AWAY, "Use it away from home\nGet Tailscale on this PC and your phone"));
    }
    buttons.push((CHANGE_PORT, port_button));
    buttons.push((REMOVE, "Remove Nightfall\nThe program, its sign-in task and firewall rule"));
    buttons
}

/// The manage window: is it running, where to open it, and what you can do with it. It comes
/// back after each action until it's closed.
fn manage(mut port: u16, mut just_installed: bool) -> i32 {
    loop {
        let running = is_running(port);
        let instruction = match (running, just_installed) {
            (true, true) => "Nightfall is installed and running",
            (true, false) => "Nightfall is running",
            (false, _) => "Nightfall isn't running",
        };
        just_installed = false;
        let ts = tailscale(port);
        let content = if running {
            where_to_open(port, &ts)
        } else {
            let logs = std::env::var("LOCALAPPDATA").map(|d| format!("{d}\\Nightfall\\logs")).unwrap_or_default();
            format!(
                "Your phone can't reach it until it's started again. It also starts by itself each \
                 time you sign in; if it doesn't, the log may say why:\n{}",
                link(&logs)
            )
        };
        let port_button = format!("Change the port\nIt's {port} now");
        let buttons = manage_buttons(running, &ts, &port_button);
        let choice = show(&Dialog {
            instruction,
            content: &content,
            footer: None,
            icon: Icon::App,
            buttons: &buttons,
            shield: &[CHANGE_PORT, REMOVE],
            common: TDCBF_CLOSE_BUTTON,
        });
        match choice {
            OPEN => {
                let url = wide(&format!("http://127.0.0.1:{port}"));
                unsafe { ShellExecuteW(0, wide("open").as_ptr(), url.as_ptr(), null(), null(), 1) };
                return 0;
            }
            STOP => {
                if let Err(e) = tool("schtasks.exe", &format!("/End /TN \"{TASK}\"")) {
                    return error_dialog("Nightfall couldn't be stopped", &e);
                }
                wait_until_stopped(port, Duration::from_secs(5));
            }
            START => {
                if let Err(e) = tool("schtasks.exe", &format!("/Run /TN \"{TASK}\"")) {
                    return error_dialog("Nightfall couldn't be started", &e);
                }
                wait_for_server(port, Duration::from_secs(10));
            }
            AWAY => get_tailscale(),
            CHANGE_PORT => {
                if let Some(new) = change_port(port) {
                    port = new;
                }
            }
            REMOVE => {
                uninstall_ui();
                if installed().is_none() {
                    return 0;
                }
            }
            _ => return 0,
        }
    }
}

/// Ask for a new port and reinstall on it. Returns the new port once it's in place.
fn change_port(current: u16) -> Option<u16> {
    let mut suggestion = current;
    loop {
        let new = ask_port(suggestion)?;
        if new == current {
            return None;
        }
        if TcpListener::bind(("0.0.0.0", new)).is_err() {
            show(&Dialog {
                instruction: &format!("Port {new} is in use"),
                content: "Another program on this PC is using it. Pick a different port.",
                footer: None,
                icon: Icon::Error,
                buttons: &[],
                shield: &[],
                common: TDCBF_CLOSE_BUTTON,
            });
            suggestion = new;
            continue;
        }
        return match install_elevated(new) {
            0 => {
                wait_for_server(new, Duration::from_secs(10));
                Some(new)
            }
            _ => None,
        };
    }
}

// --- Uninstall -----------------------------------------------------------------------

fn uninstall_ui() -> i32 {
    if installed().is_none() {
        show(&Dialog {
            instruction: "Nightfall isn't installed",
            content: "There's nothing to remove.",
            footer: None,
            icon: Icon::Info,
            buttons: &[],
            shield: &[],
            common: TDCBF_CLOSE_BUTTON,
        });
        return 0;
    }
    let choice = show(&Dialog {
        instruction: "Remove Nightfall?",
        content: "Your phone won't be able to turn this PC's screens off any more. This removes the \
                  program, its sign-in task and its firewall rule.",
        footer: None,
        icon: Icon::App,
        buttons: &[(100, "Remove")],
        shield: &[100],
        common: TDCBF_CANCEL_BUTTON,
    });
    if choice != 100 {
        return 0;
    }
    match elevated(&["--do-uninstall".to_string()], do_uninstall) {
        0 => {}
        ERROR_CANCELLED => return 0,
        code => return code,
    }
    show(&Dialog {
        instruction: "Nightfall was removed",
        content: "",
        footer: None,
        icon: Icon::Info,
        buttons: &[],
        shield: &[],
        common: TDCBF_CLOSE_BUTTON,
    });
    0
}

fn do_uninstall() -> i32 {
    match uninstall() {
        Ok(()) => 0,
        Err(e) => error_dialog("Nightfall couldn't be removed", &e),
    }
}

fn uninstall() -> io::Result<()> {
    let Some(i) = installed() else { return Ok(()) };
    let _ = tool("schtasks.exe", &format!("/End /TN \"{TASK}\""));
    let _ = tool("schtasks.exe", &format!("/Delete /TN \"{TASK}\" /F"));
    let _ = tool("netsh.exe", &format!("advfirewall firewall delete rule name=\"{}\"", firewall_rule(i.port)));
    let _ = fs::remove_file(shortcut_path());
    reg_delete(HKEY_LOCAL_MACHINE, APP_KEY);
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let _ = fs::remove_dir_all(PathBuf::from(local).join("Nightfall"));
    }
    crate::cert::delete_keys(); // the https certificate authority's and server's keys
    // The program can't delete itself while it (or the window that asked) is running, so a
    // hidden helper keeps trying for a few minutes, and Windows finishes the job at the next
    // restart if it still has to. Only ever touch our own folder and file.
    let exe = i.exe();
    if i.dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Nightfall")) && exe.exists() {
        unsafe {
            MoveFileExW(wide_path(&exe).as_ptr(), null(), 4); // MOVEFILE_DELAY_UNTIL_REBOOT
            MoveFileExW(wide_path(&i.dir).as_ptr(), null(), 4);
        }
        let script = format!(
            "/d /c for /l %i in (1,1,300) do @(ping -n 2 127.0.0.1 >nul & del /f /q \"{exe}\" >nul 2>&1 & \
             if not exist \"{exe}\" (rmdir \"{dir}\" >nul 2>&1 & exit))",
            exe = exe.display(),
            dir = i.dir.display()
        );
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new(system_tool("cmd.exe"))
            .raw_arg(script)
            .current_dir(system_tool(""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    Ok(())
}

// --- Entry ---------------------------------------------------------------------------

/// Everything but serving: returns the process exit code.
pub fn main(args: &[String]) -> i32 {
    let arg = |i: usize| args.get(i).map(String::as_str);
    match arg(0) {
        Some("--do-install") => {
            let port = arg(1).and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
            do_install(port, arg(2).unwrap_or(""))
        }
        Some("--do-uninstall") => do_uninstall(),
        Some("--uninstall") => uninstall_ui(),
        Some("--install") => install_ui(arg(1).and_then(|p| p.parse().ok())),
        _ => match installed() {
            Some(i) if same_file(&this_exe(), &i.exe()) || i.version == VERSION => manage(i.port, false),
            _ => install_ui(None),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_structs_match_windows() {
        assert_eq!(size_of::<TASKDIALOGCONFIG>(), 160);
        assert_eq!(size_of::<TASKDIALOG_BUTTON>(), 12);
        assert_eq!(size_of::<SHELLEXECUTEINFOW>(), 112);
        assert_eq!(size_of::<Guid>(), 16);
    }

    #[test]
    fn port_dialog_template_is_laid_out_for_windows() {
        let t = port_template();
        assert_eq!(t.0[4], 5, "item count");
        // Every item starts on a 4-byte boundary: find each child style (0x5000_0000's high word).
        let starts: Vec<usize> = (0..t.0.len() - 1).filter(|&i| t.0[i + 1] & 0xF000 == 0x5000 && t.0[i + 1] >> 12 == 5).collect();
        assert_eq!(starts.len(), 5);
        assert!(starts.iter().all(|i| i % 2 == 0));
        assert_eq!(t.aligned().len() * 2, t.0.len().div_ceil(2) * 2);
    }

    #[test]
    fn tailscale_dialog_template_is_laid_out_for_windows() {
        let t = tailscale_template();
        assert_eq!(t.0[4], 8, "item count");
        let starts: Vec<usize> = (0..t.0.len() - 1).filter(|&i| t.0[i + 1] >> 12 == 5).collect();
        assert_eq!(starts.len(), 8);
        assert!(starts.iter().all(|i| i % 2 == 0));
    }

    /// Writes a Start menu style shortcut to the temp folder and checks it's a .lnk file.
    #[test]
    fn shortcut_is_written() {
        let lnk = std::env::temp_dir().join("nightfall-test.lnk");
        create_shortcut(&lnk, &this_exe(), "test").unwrap();
        let bytes = fs::read(&lnk).unwrap();
        let _ = fs::remove_file(&lnk);
        assert_eq!(&bytes[..4], &[0x4C, 0, 0, 0], "ShellLink header");
    }

    #[test]
    fn registry_round_trip() {
        let key = r"Software\NightfallTest";
        reg_write(HKEY_CURRENT_USER, key, &[("Text", RegValue::Text("Program Files\\Nightfall")), ("Port", RegValue::Number(39847))])
            .unwrap();
        assert_eq!(reg_text(HKEY_CURRENT_USER, key, "Text").as_deref(), Some("Program Files\\Nightfall"));
        assert_eq!(reg_number(HKEY_CURRENT_USER, key, "Port"), Some(39847));
        assert_eq!(reg_text(HKEY_CURRENT_USER, key, "Missing"), None);
        reg_delete(HKEY_CURRENT_USER, key);
        assert_eq!(reg_number(HKEY_CURRENT_USER, key, "Port"), None);
    }

    #[test]
    fn task_xml_escapes_and_quotes() {
        let xml = task_xml(Path::new(r"C:\Program Files\Nightfall\nightfall.exe"), 39847, r"PC\A&B");
        assert!(xml.contains(r#"<Command>"C:\Program Files\Nightfall\nightfall.exe"</Command>"#));
        assert!(xml.contains("<UserId>PC\\A&amp;B</UserId>"));
        assert!(xml.contains("<Arguments>--serve --port 39847</Arguments>"));
        assert!(xml.contains(r"<WorkingDirectory>C:\Program Files\Nightfall</WorkingDirectory>"));
    }

    /// Registers (never runs) a throwaway task from task_xml, reads it back and deletes it.
    /// Run with `cargo test -- --ignored task_scheduler`.
    #[test]
    #[ignore]
    fn task_scheduler_accepts_the_task() {
        let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap(), std::env::var("USERNAME").unwrap());
        let path = std::env::temp_dir().join("nightfall-test-task.xml");
        let mut bytes = vec![0xFF, 0xFE];
        let xml = task_xml(Path::new(r"C:\Program Files\Nightfall\nightfall.exe"), 39999, &user).replace(r"<URI>\Nightfall<", r"<URI>\NightfallTest<");
        bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&path, bytes).unwrap();
        let created = tool("schtasks.exe", &format!("/Create /TN NightfallTest /XML \"{}\" /F", path.display()));
        let shown = tool("schtasks.exe", "/Query /TN NightfallTest /XML");
        let _ = tool("schtasks.exe", "/Delete /TN NightfallTest /F");
        let _ = fs::remove_file(&path);
        created.unwrap();
        let shown = shown.unwrap();
        // (LeastPrivilege is the default, so Windows leaves it out when it shows the task.)
        assert!(!shown.contains("HighestAvailable"));
        for want in ["--serve --port 39999", "InteractiveToken", "PT0S", "<Count>10</Count>", "IgnoreNew"] {
            assert!(shown.contains(want), "{want} missing from\n{shown}");
        }
    }

    /// Shows the manage window for the installed port, to look at. `cargo test -- --ignored manage_window`
    #[test]
    #[ignore]
    fn manage_window() {
        manage(installed().map_or(DEFAULT_PORT, |i| i.port), false);
    }

    #[test]
    fn away_from_home_is_offered_only_without_tailscale() {
        for running in [true, false] {
            let ids = |ts: Tailscale| manage_buttons(running, &ts, "port").iter().map(|b| b.0).collect::<Vec<_>>();
            let absent = ids(Tailscale::Absent);
            let at = absent.iter().position(|&id| id == AWAY).expect("offered without Tailscale");
            assert_eq!(absent[at + 1], CHANGE_PORT);
            assert!(!ids(Tailscale::NeedsServe).contains(&AWAY));
            assert!(!ids(Tailscale::Ready("https://pc.example.ts.net:39847".into())).contains(&AWAY));
        }
    }

    /// Shows the Get Tailscale window, to look at. `cargo test -- --ignored tailscale_window`
    #[test]
    #[ignore]
    fn tailscale_window() {
        get_tailscale();
    }

    /// Shows the port window, to look at. `cargo test -- --ignored port_window`
    #[test]
    #[ignore]
    fn port_window() {
        ask_port(DEFAULT_PORT);
    }

    #[test]
    fn links_are_stripped_for_plain_message_boxes() {
        assert_eq!(strip_links("open\n<a href=\"http://x\">http://x</a> now"), "open\nhttp://x now");
    }
}
