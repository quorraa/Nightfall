//! Installing, updating, checking on and removing Nightfall, from the .exe itself.
//!
//!   nightfall.exe                  not installed, or a different version: offer to install it;
//!                                  installed: say whether it's running and where to open it
//!   nightfall.exe --install [port] install (or reinstall) without asking which
//!   nightfall.exe --uninstall      what Settings › Apps runs
//!
//! Installing copies the .exe to Program Files\Nightfall, registers a Task Scheduler task that
//! starts it with --serve at sign-in, opens the port to the local subnet in Windows Firewall
//! and adds an entry to Settings › Apps. That part runs elevated (one UAC prompt), in a second
//! copy of this program started with --do-install / --do-uninstall.
#![allow(non_snake_case, clippy::upper_case_acronyms)]

use std::ffi::c_void;
use std::fs;
use std::io;
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
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
}

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
    /// Custom buttons, in order; the first is the default.
    buttons: &'a [(i32, &'a str)],
    /// A custom button that gets the UAC shield.
    shield: Option<i32>,
    /// Common buttons: CANCEL or CLOSE.
    common: u32,
}

const TDCBF_CANCEL_BUTTON: u32 = 0x08;
const TDCBF_CLOSE_BUTTON: u32 = 0x20;
const IDCANCEL: i32 = 2;
const IDCLOSE: i32 = 8;

struct CallbackData {
    shield: i32,
}

unsafe extern "system" fn dialog_callback(hwnd: HWND, msg: u32, _w: usize, l: isize, data: isize) -> i32 {
    const TDN_CREATED: u32 = 0;
    const TDN_HYPERLINK_CLICKED: u32 = 3;
    const TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE: u32 = 0x400 + 115;
    const WM_SETICON: u32 = 0x80;
    match msg {
        TDN_CREATED => {
            let data = &*(data as *const CallbackData);
            if data.shield != 0 {
                SendMessageW(hwnd, TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE, data.shield as usize, 1);
            }
            // The title bar and taskbar show Nightfall's icon too.
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
    let data = CallbackData { shield: d.shield.unwrap_or(0) };
    let (instance, icon) = match d.icon {
        Icon::App => (unsafe { GetModuleHandleW(null()) }, 1usize),
        Icon::Info => (0, 0xFFFD), // TD_INFORMATION_ICON
        Icon::Error => (0, 0xFFFE), // TD_ERROR_ICON
    };
    let config = TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: 0,
        hInstance: instance,
        dwFlags: 0x01 | 0x08, // hyperlinks, Esc closes
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
        shield: None,
        common: TDCBF_CLOSE_BUTTON,
    });
    1
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

fn is_running(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
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
fn where_to_open(port: u16) -> String {
    let mut text = match lan_address() {
        Some(ip) => format!("On your phone, open\n{}", link(&format!("http://{ip}:{port}"))),
        None => "This PC doesn't seem to be on a home network right now.".to_string(),
    };
    match tailscale(port) {
        Tailscale::Ready(url) => text += &format!("\n\nAway from home, with Tailscale:\n{}", link(&url)),
        Tailscale::NeedsServe => {
            text += &format!(
                "\n\nTo reach it away from home over Tailscale, run this once in a terminal:\ntailscale serve --bg --https={port} http://127.0.0.1:{port}"
            )
        }
        Tailscale::Absent => {}
    }
    text + "\n\nOn an iPhone, add it to your Home Screen from Safari's Share menu."
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
         • let devices on your home network reach it through Windows Firewall, on port {port}\n\n\
         Windows will ask for permission once.",
        install_dir().display()
    );
    let choice = show(&Dialog {
        instruction: &instruction,
        content: &content,
        footer: Some("You can remove it any time from Settings › Apps."),
        icon: Icon::App,
        buttons: &[(100, if before.is_some() { "Update" } else { "Install" })],
        shield: Some(100),
        common: TDCBF_CANCEL_BUTTON,
    });
    if choice != 100 {
        return 0;
    }
    let user = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    );
    let args = vec!["--do-install".to_string(), port.to_string(), user.clone()];
    match elevated(&args, || do_install(port, &user)) {
        0 => {}
        ERROR_CANCELLED => return 0,
        code => return code, // the elevated copy already said what went wrong
    }
    let running = wait_for_server(port, Duration::from_secs(10));
    status_ui_for(port, running, true)
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

    tool("schtasks.exe", &format!("/Run /TN \"{TASK}\"")).map(drop)
}

// --- Status --------------------------------------------------------------------------

fn status_ui(i: &Installed) -> i32 {
    status_ui_for(i.port, is_running(i.port), false)
}

fn status_ui_for(port: u16, running: bool, just_installed: bool) -> i32 {
    let instruction = match (running, just_installed) {
        (true, true) => "Nightfall is installed and running",
        (true, false) => "Nightfall is running",
        (false, _) => "Nightfall isn't running",
    };
    let content = if running {
        where_to_open(port)
    } else {
        let logs = std::env::var("LOCALAPPDATA").map(|d| format!("{d}\\Nightfall\\logs")).unwrap_or_default();
        format!(
            "It starts by itself when you sign in. If it doesn't, the log may say why:\n{}",
            link(&logs)
        )
    };
    let start = [(101, "Start it")];
    let choice = show(&Dialog {
        instruction,
        content: &content,
        footer: Some("To remove Nightfall, go to Settings › Apps › Installed apps."),
        icon: Icon::App,
        buttons: if running { &[] } else { &start },
        shield: None,
        common: TDCBF_CLOSE_BUTTON,
    });
    if choice == 101 {
        if let Err(e) = tool("schtasks.exe", &format!("/Run /TN \"{TASK}\"")) {
            return error_dialog("Nightfall couldn't be started", &e);
        }
        let running = wait_for_server(port, Duration::from_secs(10));
        return status_ui_for(port, running, false);
    }
    0
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
            shield: None,
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
        shield: Some(100),
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
        shield: None,
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
    reg_delete(HKEY_LOCAL_MACHINE, APP_KEY);
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let _ = fs::remove_dir_all(PathBuf::from(local).join("Nightfall"));
    }

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
            Some(i) if same_file(&this_exe(), &i.exe()) || i.version == VERSION => status_ui(&i),
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

    #[test]
    fn links_are_stripped_for_plain_message_boxes() {
        assert_eq!(strip_links("open\n<a href=\"http://x\">http://x</a> now"), "open\nhttp://x now");
    }
}
