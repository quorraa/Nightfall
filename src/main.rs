//! Nightfall: turn this PC's monitors off from a phone, over the LAN or Tailscale.
//!
//! Monitors are put to sleep with SC_MONITORPOWER, the same message Windows sends when
//! "Turn off the display after N minutes" runs out. The displays stay connected and wake
//! on any mouse or keyboard input (or the page's "Wake screens" button).
//!
//! Runs in the logged-in user's session (Task Scheduler, at log on). A Windows service
//! would live in session 0 and could not reach the desktop's monitors.
//!
//! Options: --port N (or NIGHTFALL_PORT; default 39847), --dry-run (or NIGHTFALL_DRY_RUN=1:
//! log instead of acting), NIGHTFALL_WEB (serve the page from this folder instead of web\
//! next to the .exe or the copy built into it). Logs go to logs\nightfall.log next to the .exe.
#![cfg_attr(not(test), windows_subsystem = "windows")]

mod bedtime;
mod guard;
mod http;
mod json;
mod log;
mod setup;
mod win;

use std::path::PathBuf;
use std::sync::OnceLock;

pub struct Config {
    pub port: u16,
    pub dry_run: bool,
    pub host: String,
    /// Where the page comes from: a folder on disk, or None for the copy in the .exe.
    pub web: Option<PathBuf>,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

pub fn cfg() -> &'static Config {
    CONFIG.get_or_init(|| Config { port: 39847, dry_run: true, host: "test".into(), web: None })
}

fn main() {
    // Serving is what the sign-in task (and a test copy) asks for; anything else is the
    // installer: double-clicking the .exe, or Settings › Apps removing it.
    let serve = std::env::args().skip(1).any(|a| matches!(a.as_str(), "--serve" | "--port" | "--dry-run"));
    if !serve {
        let args: Vec<String> = std::env::args().skip(1).collect();
        std::process::exit(setup::main(&args));
    }
    let here = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    log::init(here.clone());
    std::panic::set_hook(Box::new(|info| error!("panic: {info}")));

    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let port = match flag("--port").or_else(|| std::env::var("NIGHTFALL_PORT").ok()) {
        None => 39847,
        Some(v) => match v.trim().parse::<u16>() {
            Ok(p) if p > 0 => p,
            _ => {
                error!("NIGHTFALL_PORT must be a port number, not {v:?}");
                std::process::exit(2);
            }
        },
    };
    let web = std::env::var_os("NIGHTFALL_WEB")
        .map(PathBuf::from)
        .or_else(|| Some(here.join("web")))
        .filter(|d| d.join("index.html").is_file());
    let config = Config {
        port,
        dry_run: args.iter().any(|a| a == "--dry-run") || std::env::var("NIGHTFALL_DRY_RUN").as_deref() == Ok("1"),
        host: win::host_name(),
        web,
    };
    let config = CONFIG.get_or_init(|| config);

    let listener = match win::bind_dual_stack(port) {
        Ok(l) => l,
        Err(e) => {
            error!("port {port} is busy ({e}); is Nightfall already running?");
            std::process::exit(1);
        }
    };
    info!(
        "Nightfall {} on {}, port {port}{}",
        env!("CARGO_PKG_VERSION"),
        config.host,
        if config.dry_run { " (dry run)" } else { "" }
    );
    match &config.web {
        Some(dir) => info!("serving the page from {}", dir.display()),
        None => info!("serving the built-in page"),
    }
    win::start_display_watcher();
    http::serve(listener);
}
