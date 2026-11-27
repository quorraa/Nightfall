import * as THREE from './vendor/three.module.min.js';
import { seeded, smooth } from './gl/common.js';
import { CAM, CABIN, createShared, deg } from './gl/world.js';
import { createSky } from './gl/sky.js';
import { createLand } from './gl/land.js';
import { createWater } from './gl/water.js';
import { createPost } from './gl/post.js';

// ---------------------------------------------------------------------------------------------
// Nightfall scene: a lake at night seen from the near bank. A log cabin across the water holds
// the lamp that stands for the PC's monitors; when they go dark the lamp goes out, the eyes
// adapt, more stars and the Milky Way come through, the lake stills and an aurora rises.
//
// API (used by app.js): setGround(frac), setLamp(v), setNight(bool), setParallax(x, y).
// Debug: ?debug=nopost|refl|bloom|water|forest  ?seed=N  ?freeze=T  ?night=1  ?q=low  ?fps
//        ?capture (no loop; call nightfall.step(dt) per frame, for recording)
// ---------------------------------------------------------------------------------------------

const clamp = THREE.MathUtils.clamp;
const SIDEREAL = (Math.PI * 2) / 86164;

export function createScene(canvas, { reducedMotion = false } = {}) {
  const q = new URLSearchParams(location.search);
  const seed = (+q.get('seed') || 7) >>> 0;
  const debug = q.get('debug') || '';
  const freezeAt = q.has('freeze') ? +q.get('freeze') || 0 : null;
  const low = q.get('q') === 'low';
  const forceNight = q.get('night') === '1';
  const msaa = q.get('msaa') === '0' || low ? 0 : 4;

  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: q.has('capture'),
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false, depth: false, stencil: false });
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 1);

  const shared = createShared();
  const rnd = seeded(seed);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3200);
  camera.rotation.order = 'YXZ';
  camera.position.set(CAM.x, CAM.y, CAM.z);

  const t0 = performance.now();
  const sky = createSky(shared, rnd, { starCount: low ? 11000 : 22000 });
  const land = createLand(shared, { seed, debug: { forest: debug === 'forest' } });
  const post = createPost(renderer, { msaa });
  const water = createWater(shared, post.reflRT.texture, { seed, fireflies: low ? 40 : 70, reducedMotion });
  if (debug === 'water') water.uniforms.uDebug.value = 1;
  scene.add(sky.group, land.group, water.group);
  sky.bake(renderer);
  const buildMs = Math.round(performance.now() - t0);

  // ---------- Framing ----------
  const cabinAz = Math.atan2(CABIN.x - CAM.x, -(CABIN.z - CAM.z));
  let groundFrac = 0.7, cssW = 1, cssH = 1, yawBase = 0, pitchBase = 0, layout = 'portrait';
  function frame() {
    const aspect = cssW / cssH;
    layout = aspect < 1 ? 'portrait' : cssH <= 520 && aspect >= 1.5 ? 'phone-landscape' : 'desktop';
    const vfov = clamp(2 * Math.atan(Math.tan(deg(37)) / aspect), deg(40), deg(62));
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    camera.fov = THREE.MathUtils.radToDeg(vfov);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const hTop = groundFrac - 0.16;
    pitchBase = Math.atan((2 * hTop - 1) * Math.tan(vfov / 2));
    const tx = layout === 'portrait' ? 0.6 : layout === 'phone-landscape' ? 0.27 : 0.56;
    yawBase = cabinAz - Math.atan((2 * tx - 1) * Math.tan(hfov / 2));
    shared.uYaw.value = yawBase;
    water.setDistort(vfov, aspect);
  }

  // ---------- Resolution ----------
  // Pixels per frame. A mouse means a desktop GPU, which can afford more on big monitors; the
  // adaptive step below lowers it again if frames get slow.
  const desktop = matchMedia('(pointer: fine)').matches && !matchMedia('(pointer: coarse)').matches;
  let budget = low ? 0.7e6 : desktop ? 2.4e6 : 1.3e6, dpr = 1, bufW = 1, bufH = 1;
  function resize() {
    cssW = Math.max(1, canvas.clientWidth);
    cssH = Math.max(1, canvas.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(budget / (cssW * cssH)));
    bufW = Math.max(1, Math.round(cssW * dpr));
    bufH = Math.max(1, Math.round(cssH * dpr));
    renderer.setPixelRatio(1);
    renderer.setSize(bufW, bufH, false);
    post.setSize(bufW, bufH);
    shared.uRes.value.set(bufW, bufH);
    frame();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---------- State ----------
  const st = {
    lamp: 1, lampTarget: 1, night: false, nightT: 0,
    adapt: 0, aurora: 0, fire: 1, tilt: 0,
    par: new THREE.Vector2(), parTarget: new THREE.Vector2(),
    nextMeteor: 18 + rnd() * 20, cued: false,
  };
  if (forceNight) Object.assign(st, { lamp: 0, lampTarget: 0, night: true, nightT: 60, adapt: 1, aurora: 0.5, fire: 0.25, tilt: 1, cued: true });

  const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  function choreograph(t, dt) {
    st.lamp = approach(st.lamp, st.lampTarget, st.lampTarget < st.lamp ? 2.2 : 4, dt);
    if (st.night) st.nightT += dt;
    st.adapt = approach(st.adapt, st.night ? 1 : 0, st.night ? 0.1 : 1, dt);
    const auroraOn = st.night && st.nightT > 12 && !reducedMotion;
    st.aurora = approach(st.aurora, auroraOn ? 0.5 : 0, auroraOn ? 0.075 : 0.6, dt);
    st.fire = approach(st.fire, st.night ? 0.25 : 1, 0.2, dt);
    st.tilt = approach(st.tilt, st.night ? 1 : 0, 0.3, dt);
    st.par.x = approach(st.par.x, st.parTarget.x, 3, dt);
    st.par.y = approach(st.par.y, st.parTarget.y, 3, dt);

    // The lamp breathes a little, like a real flame behind glass.
    const flick = 1 + 0.035 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.7) + 0.02 * Math.sin(t * 17.9);
    shared.uLamp.value = st.lamp * flick;
    shared.uAdapt.value = st.adapt;
    shared.uAurora.value = st.aurora;
    shared.uTime.value = t;
    shared.uMistDrift.value.set(t * 0.004, t * 0.0015);
    water.flyUniforms.uFire.value = st.fire;
    land.setSmoke(0.4 + 0.6 * smooth(0, 0.6, st.lamp));
    post.uniforms.uExposure.value = 1.25 * (1 + 0.3 * st.adapt);
    sky.uniforms.uMilkyGain.value = 1 + 0.35 * st.adapt;

    // The sky wheels at 1.5x sidereal speed (capped at three hours of turn).
    sky.setRotation(Math.min(t, 10800) * SIDEREAL * 1.5, yawBase);

    if (!reducedMotion) {
      if (st.night && !st.cued && st.nightT > 6) {
        st.cued = true;
        sky.launch(camera, rnd, { bright: 1.4 });
      }
      st.nextMeteor -= dt;
      if (st.nextMeteor <= 0 && !sky.meteorActive) {
        st.nextMeteor = (st.night ? 14 : 25) + rnd() * (st.night ? 26 : 45);
        sky.launch(camera, rnd, { bright: 0.7 + rnd() * 0.6 });
      }
    }

    const drift = reducedMotion ? 0 : 1;
    camera.rotation.y = -(yawBase + st.par.x * 0.06 + drift * 0.006 * Math.sin(t * 0.05));
    camera.rotation.x = pitchBase + deg(4) * smooth(0, 1, st.tilt) + st.par.y * 0.03 + drift * 0.003 * Math.sin(t * 0.037 + 1);
    camera.updateMatrixWorld();
    sky.update(dt, camera.position);
    water.update(t, dt, st.night ? 0.55 : 1);
  }

  // ---------- Render ----------
  const farTier = land.farTier;
  const mode = debug === 'nopost' ? 1 : debug === 'bloom' ? 2 : 0;
  function draw() {
    // Reflection: the same camera, the world mirrored in y = 0, at half resolution.
    shared.uMirror.value = -1;
    shared.uPx.value = dpr * 0.5;
    water.water.visible = false;
    for (const m of farTier) m.visible = false;
    renderer.setRenderTarget(post.reflRT);
    renderer.clear();
    renderer.render(scene, camera);
    water.water.visible = true;
    for (const m of farTier) m.visible = true;

    shared.uMirror.value = 1;
    shared.uPx.value = dpr;
    renderer.setRenderTarget(post.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

    if (debug === 'refl') post.render({ mode: 1, source: post.reflRT });
    else post.render({ mode });
  }

  // ---------- Loop ----------
  const stats = {
    build: buildMs, ...land.stats, float: post.info.float, msaa,
    fps: 0, ms: 0, dpr: 0, w: 0, h: 0, layout: '', downgrades: 0,
  };
  let raf = 0, last = performance.now(), lastDraw = 0, clock = freezeAt ?? 0, ema = 16.7, slow = 0, frames = 0, fpsT = last;
  let revealed = false;
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 1.4s ease';

  const fpsBox = q.has('fps') ? Object.assign(document.createElement('div'), {
    style: 'position:fixed;left:8px;top:calc(env(safe-area-inset-top) + 40px);font:11px/1.3 ui-monospace,monospace;color:#9fb;z-index:9;pointer-events:none;white-space:pre',
  }) : null;
  if (fpsBox) document.body.appendChild(fpsBox);

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // Once the lights are out the scene runs at 30 fps: it barely moves and the phone stays cool.
    if (st.night && st.adapt > 0.5 && now - lastDraw < 31) return;
    const fdt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : dt;
    if (lastDraw && !st.night) {
      ema += (now - lastDraw - ema) * 0.05;
      slow = ema > 22 ? slow + fdt : 0;
      if (slow > 2.5 && budget > 0.5e6) {
        budget *= 0.8; slow = 0; ema = 16.7; stats.downgrades++;
        resize();
      }
    }
    lastDraw = now;
    if (freezeAt === null) clock += fdt;
    choreograph(clock, freezeAt === null ? fdt : 0);
    draw();
    if (!revealed) { revealed = true; requestAnimationFrame(() => { canvas.style.opacity = '1'; }); }

    frames++;
    if (now - fpsT > 1000) {
      Object.assign(stats, { fps: Math.round((frames * 1000) / (now - fpsT)), ms: +ema.toFixed(1), dpr: +dpr.toFixed(2), w: bufW, h: bufH, layout });
      frames = 0; fpsT = now;
      if (fpsBox) fpsBox.textContent = `${stats.fps} fps  ${stats.ms} ms\n${bufW}x${bufH} @${stats.dpr}\ntrees ${stats.trees.join('/')}`;
    }
  }

  // Compile everything before the first visible frame so the fade-in never stutters.
  renderer.compile(scene, camera);
  choreograph(clock, 0);
  draw();

  // ?capture: no animation loop; a recorder calls nightfall.step(dt) once per frame it saves.
  const manual = q.has('capture');
  function step(dt) {
    clock += dt;
    choreograph(clock, dt);
    draw();
    canvas.style.transition = 'none';
    canvas.style.opacity = '1';
  }
  function start() { if (!raf && !manual) { last = performance.now(); lastDraw = 0; raf = requestAnimationFrame(tick); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', () => location.reload());
  start();

  const api = {
    setGround(f) { groundFrac = clamp(f, 0.3, 0.95); frame(); },
    setLamp(v) { st.lampTarget = clamp(v, 0, 1); },
    setNight(on) {
      if (on === st.night) return;
      st.night = on;
      st.nightT = 0;
      st.cued = false;
    },
    setParallax(x, y) { st.parTarget.set(clamp(x, -1, 1), clamp(y, -1, 1)); },
  };
  const view = () => ({ yaw: yawBase, pitch: pitchBase, layout, groundFrac });
  window.nightfall = { stats, renderer, scene, camera, shared, sky, land, water, post, state: st, view, step, ...api };
  return api;
}
