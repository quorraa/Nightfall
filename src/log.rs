//! logs/nightfall.log: "2026-11-26 20:44:56,091 INFO message", rotated at 512 KB with two
//! old copies kept (nightfall.log.1, .2), like Python's RotatingFileHandler.
//!
//! The file is opened for each line instead of held open, so another copy of Nightfall
//! (a dry-run test server, say) can share it.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 512_000;
const BACKUPS: u32 = 2;

static PATH: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// Log to `<dir>/logs/nightfall.log`, or to %LOCALAPPDATA%\Nightfall\logs when `dir`
/// can't be written (the .exe sitting in Program Files, say).
pub fn init(dir: PathBuf) {
    let mut candidates = vec![dir.join("logs")];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Nightfall").join("logs"));
    }
    for logs in candidates {
        let path = logs.join("nightfall.log");
        if fs::create_dir_all(&logs).is_ok() && OpenOptions::new().create(true).append(true).open(&path).is_ok() {
            let _ = PATH.set(path);
            return;
        }
    }
}

pub fn write(level: &str, msg: &str) {
    let Some(path) = PATH.get() else { return };
    let line = format!("{} {level} {msg}\n", crate::win::local_timestamp());
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() + line.len() as u64 >= MAX_BYTES {
            rotate(path);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn rotate(path: &PathBuf) {
    let numbered = |n: u32| {
        let mut p = path.clone().into_os_string();
        p.push(format!(".{n}"));
        PathBuf::from(p)
    };
    let _ = fs::remove_file(numbered(BACKUPS));
    for n in (1..BACKUPS).rev() {
        let _ = fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = fs::rename(path, numbered(1));
}

#[macro_export]
macro_rules! info {
    ($($t:tt)*) => { $crate::log::write("INFO", &format!($($t)*)) };
}

#[macro_export]
macro_rules! warning {
    ($($t:tt)*) => { $crate::log::write("WARNING", &format!($($t)*)) };
}

#[macro_export]
macro_rules! error {
    ($($t:tt)*) => { $crate::log::write("ERROR", &format!($($t)*)) };
}
