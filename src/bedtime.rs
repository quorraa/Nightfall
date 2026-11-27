//! One pending "screens off at" timer plus the last thing that happened.

use std::io;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::json;
use crate::win::{monitors_off, monitors_on};

struct State {
    timer: u64, // bumped to cancel whichever timer thread is waiting
    fire_at: Option<f64>,
    total: f64,
    last: Option<(&'static str, f64)>,
}

pub struct Bedtime {
    state: Mutex<State>,
    changed: Condvar,
}

pub static BEDTIME: Bedtime = Bedtime {
    state: Mutex::new(State { timer: 0, fire_at: None, total: 0.0, last: None }),
    changed: Condvar::new(),
};

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

impl State {
    fn record(&mut self, action: &'static str) {
        self.last = Some((action, now()));
    }

    /// Stop the pending timer, if any. True if there was one.
    fn stop(&mut self, changed: &Condvar) -> bool {
        self.timer += 1;
        changed.notify_all();
        self.fire_at.take().is_some()
    }
}

impl Bedtime {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Turn the screens off now (delay 0) or after `delay` seconds.
    pub fn dim(&'static self, delay: f64) -> io::Result<()> {
        {
            let mut s = self.lock();
            s.stop(&self.changed);
            if delay > 0.0 {
                s.total = delay;
                s.fire_at = Some(now() + delay);
                let timer = s.timer;
                let deadline = Instant::now() + Duration::from_secs_f64(delay);
                std::thread::spawn(move || self.wait_and_fire(timer, deadline));
                s.record("scheduled");
                crate::info!("monitors off in {delay:.0}s");
                return Ok(());
            }
            s.record("dim");
        }
        monitors_off()
    }

    fn wait_and_fire(&'static self, timer: u64, deadline: Instant) {
        let mut s = self.lock();
        loop {
            if s.timer != timer {
                return; // cancelled or replaced
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            s = self.changed.wait_timeout(s, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        s.fire_at = None;
        s.record("dim");
        drop(s);
        if let Err(e) = monitors_off() {
            crate::error!("timer could not turn the monitors off: {e}");
        }
    }

    pub fn cancel(&self) {
        let mut s = self.lock();
        if s.stop(&self.changed) {
            crate::info!("timer cancelled");
        }
        s.record("cancelled");
    }

    pub fn wake(&self) {
        self.lock().record("wake");
        monitors_on();
    }

    /// The JSON the page polls: {host, now, pending, last, dry_run}.
    pub fn status(&self) -> String {
        let s = self.lock();
        let t = now();
        let pending = match s.fire_at {
            Some(at) => format!(
                "{{\"fire_at\": {}, \"total\": {}, \"remaining\": {}}}",
                json::number(at),
                json::number(s.total),
                json::number((at - t).max(0.0))
            ),
            None => "null".into(),
        };
        let last = match s.last {
            Some((action, at)) => format!("{{\"action\": {}, \"at\": {}}}", json::string(action), json::number(at)),
            None => "null".into(),
        };
        let cfg = crate::cfg();
        format!(
            "{{\"host\": {}, \"now\": {}, \"pending\": {pending}, \"last\": {last}, \"dry_run\": {}}}",
            json::string(&cfg.host),
            json::number(t),
            cfg.dry_run
        )
    }
}
