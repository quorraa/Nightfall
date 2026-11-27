//! Keeps the screens off until a person touches the keyboard or mouse.
//!
//! SC_MONITORPOWER turns the displays off, but any program that asks Windows for the
//! display (video, streaming, remote tools, some updaters) can switch them straight back
//! on, and so can a mouse that registers a bump to the desk. While armed, when the
//! display comes on:
//!
//! - with no new input, a program did it: turn the screens off again (MAX_RETURNS a night).
//! - after nothing but a tiny relative mouse movement (NUDGE_LIMIT counts, a few pixels):
//!   turn them off again, but at most MAX_NUDGES times a night and never within
//!   NUDGE_GRACE seconds of the last time, so someone moving the mouse twice always gets in.
//! - after anything else (a key, click, scroll, bigger movement, touch, pen, remote
//!   pointer, or input we could not see because raw input is unavailable): leave them on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub const MAX_RETURNS: u32 = 30; // per night; stop fighting a program that insists
pub const NUDGE_LIMIT: u64 = 10; // raw mouse counts, summed |dx|+|dy|; about pixels at slow speed
pub const MAX_NUDGES: u32 = 5;
pub const NUDGE_GRACE: f64 = 30.0; // seconds

/// What the guard needs from Windows (or from a test).
pub trait Env {
    fn turn_off(&self);
    /// Tick count of the last keyboard/mouse input anywhere in the session.
    fn input_tick(&self) -> u32;
    /// Start or stop raw input reporting to `input_seen`.
    fn listen(&self, on: bool);
    /// Monotonic seconds.
    fn now(&self) -> f64;
}

struct State {
    armed: bool,
    pending: bool,
    tick: u32,
    returns: u32,
    nudges: u32,
    nudged_at: Option<f64>,
    moves: u32,
    moved: u64,
    other: bool,
}

pub struct NightGuard<E> {
    env: E,
    state: Mutex<State>,
    /// Set by the display watcher once raw input is registered.
    pub raw_ok: AtomicBool,
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Idle,
    ReOff(u32),
    GaveUp,
    Nudge { moved: u64, nudges: u32 },
    Person(String),
}

impl<E: Env> NightGuard<E> {
    pub const fn new(env: E) -> Self {
        NightGuard {
            env,
            state: Mutex::new(State {
                armed: false,
                pending: false,
                tick: 0,
                returns: 0,
                nudges: 0,
                nudged_at: None,
                moves: 0,
                moved: 0,
                other: false,
            }),
            raw_ok: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn arm(&self) {
        {
            let mut s = self.lock();
            s.armed = true;
            s.tick = self.env.input_tick();
            s.returns = 0;
            s.nudges = 0;
            s.nudged_at = None;
            reset_input(&mut s);
        }
        self.env.listen(true);
    }

    pub fn disarm(&self) {
        self.lock().armed = false;
        self.env.listen(false);
    }

    /// One raw input event: a relative mouse move, or `other` for anything else.
    pub fn input_seen(&self, dx: i32, dy: i32, other: bool) {
        let mut s = self.lock();
        if !s.armed {
            return;
        }
        if other {
            s.other = true;
        } else {
            s.moves += 1;
            s.moved = s.moved.saturating_add(dx.unsigned_abs() as u64 + dy.unsigned_abs() as u64);
        }
    }

    /// state: 0 off, 1 on, 2 dimmed (GUID_CONSOLE_DISPLAY_STATE). Returns true when the
    /// caller should call `decide` after a short wait for queued raw input.
    pub fn display_changed(&self, state: u32) -> bool {
        match state {
            0 => crate::info!("display off"),
            1 => crate::info!("display on"),
            2 => crate::info!("display dimmed"),
            n => crate::info!("display {n}"),
        }
        if state != 1 {
            return false;
        }
        let mut s = self.lock();
        if !s.armed || s.pending {
            return false;
        }
        s.pending = true;
        true
    }

    /// Why this wake counts as a person, or None if it was only a nudge.
    fn person_reason(&self, s: &State) -> Option<String> {
        if s.other {
            return Some("a key, click or scroll".into());
        }
        if !self.raw_ok.load(Ordering::SeqCst) || s.moves == 0 {
            return Some("keyboard or mouse input".into());
        }
        if s.moved > NUDGE_LIMIT {
            return Some(format!("the mouse moving ({} counts)", s.moved));
        }
        if s.nudges >= MAX_NUDGES {
            return Some(format!("a small mouse movement ({} counts; {MAX_NUDGES} already ignored tonight)", s.moved));
        }
        if let Some(at) = s.nudged_at {
            if self.env.now() - at < NUDGE_GRACE {
                return Some(format!("a second small mouse movement ({} counts) soon after the last", s.moved));
            }
        }
        None
    }

    pub fn decide(&self) -> Decision {
        let decision = {
            let mut s = self.lock();
            s.pending = false;
            if !s.armed {
                return Decision::Idle;
            }
            let tick = self.env.input_tick();
            if tick == s.tick {
                if s.returns >= MAX_RETURNS {
                    s.armed = false;
                    Decision::GaveUp
                } else {
                    s.returns += 1;
                    Decision::ReOff(s.returns)
                }
            } else {
                match self.person_reason(&s) {
                    None => {
                        s.nudges += 1;
                        s.tick = tick;
                        s.nudged_at = Some(self.env.now());
                        let d = Decision::Nudge { moved: s.moved, nudges: s.nudges };
                        reset_input(&mut s);
                        d
                    }
                    Some(reason) => {
                        s.armed = false;
                        Decision::Person(reason)
                    }
                }
            }
        };
        match &decision {
            Decision::Idle => {}
            Decision::GaveUp => {
                crate::warning!("screens keep coming back on with no input; giving up for tonight");
                self.env.listen(false);
            }
            Decision::Person(reason) => {
                crate::info!("screens woken by {reason}; leaving them on");
                self.env.listen(false);
            }
            Decision::ReOff(n) => {
                crate::info!("screens came back on with no keyboard or mouse input; turning them off again ({n})");
                self.env.turn_off();
            }
            Decision::Nudge { moved, nudges } => {
                crate::info!(
                    "screens woken by a tiny mouse movement ({moved} counts); turning them off again ({nudges} of {MAX_NUDGES})"
                );
                self.env.turn_off();
            }
        }
        decision
    }

    #[cfg(test)]
    pub fn seen(&self) -> (u32, u64, bool) {
        let s = self.lock();
        (s.moves, s.moved, s.other)
    }
}

fn reset_input(s: &mut State) {
    s.moves = 0;
    s.moved = 0;
    s.other = false;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    #[derive(Default)]
    struct Fake {
        tick: AtomicU32,
        offs: AtomicU32,
        listening: Mutex<Vec<bool>>,
        clock: Mutex<f64>,
    }

    impl Env for &Fake {
        fn turn_off(&self) {
            self.offs.fetch_add(1, Ordering::SeqCst);
        }
        fn input_tick(&self) -> u32 {
            self.tick.load(Ordering::SeqCst)
        }
        fn listen(&self, on: bool) {
            self.listening.lock().unwrap().push(on);
        }
        fn now(&self) -> f64 {
            *self.clock.lock().unwrap()
        }
    }

    impl Fake {
        fn input(&self) {
            self.tick.fetch_add(7, Ordering::SeqCst);
        }
        fn later(&self, secs: f64) {
            *self.clock.lock().unwrap() += secs;
        }
        fn offs(&self) -> u32 {
            self.offs.load(Ordering::SeqCst)
        }
    }

    fn armed(fake: &Fake) -> NightGuard<&Fake> {
        let g = NightGuard::new(fake);
        g.raw_ok.store(true, Ordering::SeqCst);
        g.arm();
        g
    }

    fn wake(g: &NightGuard<&Fake>) -> Decision {
        assert!(g.display_changed(1));
        g.decide()
    }

    #[test]
    fn a_program_waking_the_screens_is_undone_until_it_gives_up() {
        let fake = Fake::default();
        let g = armed(&fake);
        for n in 1..=MAX_RETURNS {
            assert_eq!(wake(&g), Decision::ReOff(n));
        }
        assert_eq!(wake(&g), Decision::GaveUp);
        assert_eq!(fake.offs(), MAX_RETURNS);
        assert!(!g.display_changed(1), "disarmed after giving up");
        assert_eq!(*fake.listening.lock().unwrap(), vec![true, false]);
    }

    #[test]
    fn a_tiny_nudge_is_ignored_but_a_second_one_soon_after_gets_in() {
        let fake = Fake::default();
        let g = armed(&fake);
        fake.input();
        g.input_seen(2, -1, false);
        g.input_seen(1, 0, false);
        assert_eq!(wake(&g), Decision::Nudge { moved: 4, nudges: 1 });
        assert_eq!(fake.offs(), 1);
        fake.later(10.0);
        fake.input();
        g.input_seen(1, 1, false);
        assert!(matches!(wake(&g), Decision::Person(r) if r.contains("soon after the last")));
        assert_eq!(fake.offs(), 1);
    }

    #[test]
    fn nudges_far_apart_are_ignored_up_to_the_nightly_cap() {
        let fake = Fake::default();
        let g = armed(&fake);
        for n in 1..=MAX_NUDGES {
            fake.later(NUDGE_GRACE + 1.0);
            fake.input();
            g.input_seen(3, 0, false);
            assert_eq!(wake(&g), Decision::Nudge { moved: 3, nudges: n });
        }
        fake.later(NUDGE_GRACE + 1.0);
        fake.input();
        g.input_seen(3, 0, false);
        assert!(matches!(wake(&g), Decision::Person(r) if r.contains("already ignored tonight")));
    }

    #[test]
    fn real_input_leaves_the_screens_on() {
        let cases: [(&str, fn(&NightGuard<&Fake>)); 4] = [
            ("the mouse moving (11 counts)", |g| g.input_seen(6, -5, false)),
            ("a key, click or scroll", |g| {
                g.input_seen(1, 0, false);
                g.input_seen(0, 0, true)
            }),
            ("keyboard or mouse input", |_| {}), // input we did not see
            ("keyboard or mouse input", |g| {
                g.raw_ok.store(false, Ordering::SeqCst);
                g.input_seen(1, 0, false)
            }),
        ];
        for (want, act) in cases {
            let fake = Fake::default();
            let g = armed(&fake);
            fake.input();
            act(&g);
            assert_eq!(wake(&g), Decision::Person(want.into()));
            assert_eq!(fake.offs(), 0);
            assert_eq!(*fake.listening.lock().unwrap(), vec![true, false]);
        }
    }

    #[test]
    fn only_a_display_turning_on_while_armed_is_judged() {
        let fake = Fake::default();
        let g = NightGuard::new(&fake);
        assert!(!g.display_changed(1), "not armed");
        g.input_seen(0, 0, true);
        g.arm();
        assert_eq!(g.seen(), (0, 0, false), "input before arming is not counted");
        assert!(!g.display_changed(0));
        assert!(!g.display_changed(2));
        assert!(g.display_changed(1));
        assert!(!g.display_changed(1), "one decision at a time");
        g.disarm();
        assert_eq!(g.decide(), Decision::Idle);
        assert_eq!(fake.offs(), 0);
    }
}
