import { createScene } from './scene.js';

const $ = (s) => document.querySelector(s);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Home-screen app height ----------
// iOS standalone web apps can report a layout viewport shorter than the screen, which leaves
// a strip at the bottom. Size the page to the full screen there (screen.* never swaps on
// rotation, so landscape height is screen.width).
const standaloneMq = matchMedia('(display-mode: standalone)');
function syncAppHeight() {
  const root = document.documentElement;
  if (!(navigator.standalone || standaloneMq.matches)) return root.style.removeProperty('--app-h');
  const portrait = matchMedia('(orientation: portrait)').matches;
  const h = Math.max(window.innerHeight, portrait ? screen.height : screen.width);
  root.style.setProperty('--app-h', `${h}px`);
}
syncAppHeight();
for (const ev of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(ev, syncAppHeight);
window.visualViewport?.addEventListener('resize', syncAppHeight);
requestAnimationFrame(() => requestAnimationFrame(syncAppHeight));

let scene = null;
try {
  scene = createScene($('#sky'), { reducedMotion });
} catch (err) {
  console.warn('WebGL unavailable, using a flat sky', err);
  document.body.style.background = 'radial-gradient(120% 70% at 50% 100%, #1d1a3f, #05060f)';
}
const sceneDo = (fn) => scene && fn(scene);

const ui = {
  host: $('#host'), hostName: $('#hostName'), clock: $('#clock'), line: $('#line'),
  panel: $('#panel'), slider: $('#slider'), knob: $('#knob'), sliderLabel: $('#sliderLabel'),
  countdown: $('#countdown'), message: $('#message'), nightSub: $('#nightSub'),
};

const state = {
  mode: 'idle',           // idle | pending | night
  delay: 0,
  host: 'your PC',
  skew: 0,                // server clock minus ours, seconds
  pending: null,
  dryRun: false,
  busy: false,
};

// ---------- Clock ----------
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function renderClock() {
  const now = new Date();
  const parts = timeFmt.formatToParts(now);
  const main = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  const period = parts.find((p) => p.type === 'dayPeriod');
  ui.clock.innerHTML = period ? `${main}<small>${period.value}</small>` : main;
  const h = now.getHours();
  ui.line.textContent =
    h < 5 ? 'It’s late. Let the screens sleep.'
    : h < 18 ? 'Rest your eyes for a while.'
    : h < 21 ? 'Wind down when you’re ready.'
    : 'Let the screens sleep.';
}
renderClock();
setInterval(renderClock, 1000);

// ---------- Layout hook: the hills sit just above the controls ----------
// (A phone on its side puts the controls in a side column, so the land stays low.)
const phoneLandscape = matchMedia('(orientation: landscape) and (max-height: 520px)');
function syncGround() {
  if (phoneLandscape.matches) return sceneDo((s) => s.setGround(0.8));
  const top = ui.panel.getBoundingClientRect().top;
  const h = document.getElementById('sky').clientHeight || document.body.clientHeight || window.innerHeight;
  sceneDo((s) => s.setGround(Math.max(0.45, Math.min(0.85, top / h))));
}
phoneLandscape.addEventListener('change', syncGround);
new ResizeObserver(syncGround).observe(ui.panel);
window.addEventListener('resize', syncGround);

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The PC answered ${res.status}.`);
  return data;
}

function say(text, tone = '') {
  ui.message.textContent = text;
  ui.message.dataset.tone = tone;
}

function setOnline(ok) {
  ui.host.dataset.state = ok ? 'online' : 'offline';
  ui.hostName.textContent = ok ? state.host : `Can’t reach ${state.host}`;
}

// ---------- Modes ----------
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  sceneDo((s) => s.setNight(mode === 'night'));
  if (mode === 'idle') sceneDo((s) => s.setLamp(1));
  if (mode === 'night') {
    sceneDo((s) => s.setLamp(0));
    ui.nightSub.textContent = state.dryRun
      ? `Test mode: the screens on ${state.host} stayed on.`
      : `The screens on ${state.host} are off.`;
  }
  resetSlider(false);
}

function applyStatus(s) {
  state.host = s.host || state.host;
  state.dryRun = !!s.dry_run;
  state.skew = s.now - Date.now() / 1000;
  setOnline(true);
  if (s.pending) {
    state.pending = s.pending;
    if (state.mode !== 'night') setMode('pending');
  } else {
    const wasPending = state.mode === 'pending';
    state.pending = null;
    if (wasPending) setMode(s.last?.action === 'dim' ? 'night' : 'idle');
  }
  tickCountdown();
}

async function refresh() {
  try {
    applyStatus(await api('/api/status'));
  } catch {
    setOnline(false);
  }
}

async function run(path, body, after) {
  if (state.busy) return;
  state.busy = true;
  try {
    const s = await api(path, body);
    after?.(s);
    applyStatus(s);
  } catch (err) {
    setOnline(false);
    if (state.mode !== 'idle') setMode('idle');
    say(err instanceof TypeError ? `Can’t reach ${state.host}. Check that Nightfall is running on it.` : err.message, 'error');
    resetSlider(true);
  } finally {
    state.busy = false;
  }
}

function turnOff(delay) {
  if (delay === 0) {
    setMode('night');
    run('/api/dim', { delay: 0 });
  } else {
    run('/api/dim', { delay }, () => {
      const at = timeFmt.format(new Date(Date.now() + delay * 1000));
      say(`Screens turn off at ${at}.`);
    });
  }
}

const actions = {
  wake: () => run('/api/wake', {}, () => { setMode('idle'); say(state.dryRun ? 'Test mode: nothing changed.' : 'Screens woken.'); }),
  cancel: () => run('/api/cancel', {}, () => { setMode('idle'); say('Timer cancelled.'); }),
  now: () => turnOff(0),
  done: () => { setMode('idle'); say(''); },
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) actions[btn.dataset.action]?.();
});

// ---------- Countdown ----------
function tickCountdown() {
  if (state.mode !== 'pending' || !state.pending) return;
  const remaining = Math.max(0, state.pending.fire_at - (Date.now() / 1000 + state.skew));
  const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60);
  ui.countdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
  // The cabin lamp burns down with the timer.
  sceneDo((sc) => sc.setLamp(0.15 + 0.85 * (remaining / Math.max(1, state.pending.total))));
  if (remaining <= 0) {
    state.pending = null;
    setMode('night');
    setTimeout(refresh, 1500);
  }
}
setInterval(tickCountdown, 250);

// ---------- When ----------
const choices = [...document.querySelectorAll('.when [role="radio"]')];
function choose(btn) {
  choices.forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  state.delay = Number(btn.dataset.delay);
  ui.sliderLabel.textContent = state.delay === 0
    ? 'Slide to turn off the screens'
    : `Slide to turn off in ${btn.textContent.trim()}`;
  ui.knob.setAttribute('aria-label', state.delay === 0 ? 'Turn off the screens' : `Turn off the screens in ${btn.textContent.trim()}`);
}
choices.forEach((b, i) => {
  b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1;
  b.addEventListener('click', () => choose(b));
  b.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const next = choices[(i + step + choices.length) % choices.length];
    choices.forEach((c) => (c.tabIndex = c === next ? 0 : -1));
    next.focus();
    choose(next);
  });
});

// ---------- Slider ----------
let drag = null;
const maxX = () => ui.slider.clientWidth - ui.knob.offsetWidth - 12;

function setSlider(x) {
  const p = Math.max(0, Math.min(1, x / maxX()));
  ui.slider.style.setProperty('--x', `${p * maxX()}px`);
  ui.slider.style.setProperty('--p', p);
  if (state.mode === 'idle') sceneDo((s) => s.setLamp(1 - 0.75 * p));   // drag dims the lamp
  return p;
}

function resetSlider(animate) {
  ui.slider.classList.toggle('springing', animate);
  setSlider(0);
  if (animate) setTimeout(() => ui.slider.classList.remove('springing'), 500);
}

function complete() {
  ui.slider.classList.add('springing');
  setSlider(maxX());
  setTimeout(() => turnOff(state.delay), 220);
}

ui.knob.addEventListener('pointerdown', (e) => {
  if (state.busy) return;
  ui.slider.classList.remove('springing');
  ui.knob.setPointerCapture(e.pointerId);
  drag = { start: e.clientX, p: 0 };
});
ui.knob.addEventListener('pointermove', (e) => {
  if (drag) drag.p = setSlider(e.clientX - drag.start);
});
const release = () => {
  if (!drag) return;
  const done = drag.p > 0.9;
  drag = null;
  done ? complete() : resetSlider(true);
};
ui.knob.addEventListener('pointerup', release);
ui.knob.addEventListener('pointercancel', release);
ui.knob.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); complete(); }
});

// ---------- Parallax: drag the sky, or move the mouse ----------
let sky = null;
const canvas = $('#sky');
canvas.addEventListener('pointerdown', (e) => { sky = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { sky = null; });
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && !sky) {
    sceneDo((s) => s.setParallax((e.clientX / innerWidth - 0.5) * 1.2, (0.5 - e.clientY / innerHeight) * 0.6));
  } else if (sky) {
    sceneDo((s) => s.setParallax(((e.clientX - sky.x) / innerWidth) * 2.4, 0));
  }
});

// ---------- Keep in sync with other devices ----------
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
