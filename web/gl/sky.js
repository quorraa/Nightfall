import * as THREE from '../vendor/three.module.min.js';
import { GLSL_COMMON, FS_VERT, fullscreenTriangle } from './common.js';

// ---------------------------------------------------------------------------------------------
// Sky: a dome that follows the camera, a Milky Way baked once into an equirect texture in the
// celestial frame (so it rotates with the stars for the cost of one texture read), ~14k point
// stars, a crescent moon with earthshine, an aurora that only comes out after lights-out, and
// shooting stars built on the CPU as a 4-vertex ribbon (nothing in the shader can divide by 0).
// ---------------------------------------------------------------------------------------------

export const GLSL_MIRROR = /* glsl */ `
uniform float uMirror;
// Reflection pass: the whole world is mirrored in the lake plane y = 0 at projection time,
// so every shader keeps working in real world space and the lake samples it screen-aligned.
// A macro, so fragment shaders (which have no projectionMatrix) can include it untouched.
#define mirrorProject(w) (projectionMatrix * viewMatrix * vec4((w).x, (w).y * uMirror, (w).z, 1.))
`;

const GLSL_NOISE3 = /* glsl */ `
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*(3. - 2.*f);
  float a = mix(hash13(i), hash13(i + vec3(1,0,0)), f.x);
  float b = mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x);
  float c = mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x);
  float d = mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float fbm3d(vec3 p, int oct){
  float a = .5, s = 0.;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a*vnoise3(p); p = p*2.07 + 13.7; a *= .5; }
  return s;
}
`;

const EQUIRECT = /* glsl */ `
vec2 equirect(vec3 d){ return vec2(atan(d.x, -d.z) * (.5/PI) + .5, asin(clamp(d.y, -1., 1.)) / PI + .5); }
`;

// Galactic frame in the celestial (= world at t = 0) frame. The band rises from behind the
// mountains just right of centre and leans left as it climbs, away from the moon.
function galacticFrame() {
  const F = new THREE.Vector3(0, 0.08, -1).normalize();
  const U = new THREE.Vector3(-0.27, 0.96, 0).normalize();
  const N = new THREE.Vector3().crossVectors(F, U).normalize();
  const a = 0.12;
  const C = F.clone().multiplyScalar(Math.cos(a)).addScaledVector(U, -Math.sin(a)).normalize();
  return { N, C };
}

const BAKE_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_NOISE3}
uniform vec3 uGalN, uGalC;
varying vec2 vUv;
void main(){
  float lon = (vUv.x - .5) * 2. * PI, lat = (vUv.y - .5) * PI;
  vec3 c = vec3(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));
  float b = dot(c, uGalN);                                // sin(galactic latitude)
  vec3 inPlane = c - uGalN * b;
  float ip = length(inPlane);
  float l = acos(clamp(dot(inPlane / max(ip, 1e-4), uGalC), -1., 1.));   // 0 at the core
  float core = exp(-l*l / .32);
  float w = .075 + .10*core;
  float warp = (fbm3d(c*3.1, 4) - .5) * .085;
  float bw = (b + warp) / w;
  float band = exp(-bw*bw);
  float broad = exp(-pow(b / (w*2.6), 2.)) * .09;
  // Star clouds: knotty and contrasty, not a smooth smoke. Bright knots sit inside the band,
  // fine grain only shows where a knot already is.
  float clouds = fbm3d(c*8. + 3.7, 6);
  float knots = smoothstep(.36, .78, clouds);
  float fine = fbm3d(c*34. + 11., 4);
  float glow = (band * (.12 + 1.7*knots*knots + .6*fine*knots) + broad * (.3 + .7*knots))
             * (.3 + .85*core + .22*exp(-pow((l - 1.9) / .6, 2.)));
  // The great rift and smaller dust lanes, offset a little from the band's spine.
  float laneC = b - .014 - (fbm3d(c*4.2, 3) - .5) * .05;
  float lane = exp(-pow(laneC / (w*.36), 2.));
  float dust = smoothstep(.40, .66, fbm3d(c*7.3 + 21., 5));
  glow *= 1. - .88*lane*dust*(.55 + .45*core);
  glow *= 1. - .45*smoothstep(.52, .76, fbm3d(c*15. + 5., 4)) * band;
  // Blue-white arms, a peach core; the brightest knots warm up a little.
  vec3 tint = mix(vec3(.50, .64, 1.), vec3(1., .82, .66), clamp(core*.9 + knots*.15, 0., 1.));
  vec3 col = tint * glow;
  float hii = smoothstep(.76, .9, fbm3d(c*23. + 40., 4)) * band;
  col += vec3(.95, .38, .5) * hii * .22 * glow;
  col *= .05;
  gl_FragColor = vec4(sqrt(clamp(col * 8., 0., 1.)), 1.);     // sqrt-encoded: smooth darks in 8 bits
}`;

const SKY_VERT = /* glsl */ `
${GLSL_MIRROR}
varying vec3 vDir;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.);
  vDir = w.xyz - cameraPosition;
  gl_Position = mirrorProject(w.xyz);
}`;

const SKY_FRAG = /* glsl */ `
${GLSL_COMMON}
${EQUIRECT}
uniform sampler2D uMilky;
uniform mat3 uSkyInv;
uniform vec3 uMoonDir, uMoonSun, uHaze;
uniform float uMoonR, uMoonPhase, uMilkyGain, uAdapt, uAurora, uTime, uYaw;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float el = d.y, h = max(el, 0.);
  vec3 zen = vec3(.0026, .0034, .0098);
  vec3 col = zen + (uHaze - zen) * exp(-h * 6.5);
  // Airglow: the faint green band real night skies carry a little above the horizon.
  col += vec3(.0016, .0042, .0026) * exp(-pow((el - .16) / .09, 2.));

  // Moonlight scattered around the moon.
  // (Added after the disc: the glow is in the air in front of the moon, so its dark limb never
  // reads as a hole cut into a brighter halo.)
  float md = dot(d, uMoonDir), g = max(md, 0.);
  vec3 glow = vec3(.62, .70, .92) * (pow(g, 2200.) * .5 + pow(g, 110.) * .022 + pow(g, 9.) * .006) * uMoonPhase;

  // Milky Way, dimmed by the thicker air near the horizon; brighter once eyes adapt.
  vec3 mw = texture2D(uMilky, equirect(uSkyInv * d)).rgb;
  mw = mw*mw / 8.;
  col += mw * uMilkyGain * (1. + .9*uAdapt) * mix(.12, 1., smoothstep(0., .35, el));

  // Aurora curtains, low over the mountains, only after lights-out.
  if (uAurora > .001){
    float az = atan(d.x, -d.z) - uYaw;
    float span = exp(-pow((az + .12) / .55, 2.));
    float n = fbm3(vec2(az*5.5 + uTime*.012, uTime*.02));
    float base = .07 + n*.09;
    float hgt = el - base;
    float rays = .35 + 1.3*pow(vnoise(vec2(az*85. + n*9., uTime*.12)), 2.5);
    float curtain = smoothstep(0., .025, hgt) * exp(-max(hgt, 0.) * 7.);
    vec3 ac = mix(vec3(.10, 1., .48), vec3(.55, .22, 1.), smoothstep(.02, .2, hgt));
    col += ac * curtain * span * rays * uAurora * .07;
  }

  // Crescent moon with earthshine. Computed everywhere (no derivatives inside a branch).
  vec3 t1 = normalize(cross(uMoonDir, vec3(0., 1., 0.)));
  vec3 t2 = cross(t1, uMoonDir);
  vec2 p = vec2(dot(d, t1), dot(d, t2)) / uMoonR;
  float r = length(p);
  float aa = fwidth(r) * 1.25 + 1e-4;
  float disc = (1. - smoothstep(1. - aa, 1. + aa, r)) * step(0., md);
  vec3 n3 = vec3(p, sqrt(max(1. - r*r, 0.)));
  float lit = max(dot(n3, uMoonSun), 0.);
  lit = smoothstep(0., .22, lit) * (.55 + .45*lit);
  float maria = r < 1.1 ? fbm3(p*2.4 + 4.) : .5;     // derivatives were taken above, so a branch is safe
  float alb = .5 + .5*smoothstep(.34, .66, maria);
  // Earthshine: the unlit side is ashen, a touch brighter than the sky behind it.
  vec3 moon = vec3(1., .96, .88) * alb * lit * 4.2 + vec3(.011, .013, .020) * alb;
  col = mix(col, moon, disc) + glow * (1. - .85 * disc);

  gl_FragColor = vec4(col, 1.);
}`;

const STAR_VERT = /* glsl */ `
${GLSL_MIRROR}
attribute float aFlux;
attribute vec3 aCol;
attribute float aSeed;
uniform mat3 uSkyRot;
uniform vec3 uMoonDir;
uniform float uPx, uAdapt, uTime, uMoonR, uStarGain;
varying vec3 vC;
void main(){
  vec3 d = uSkyRot * position;
  gl_Position = mirrorProject(cameraPosition + d * 2850.);
  float el = d.y;
  float ext = smoothstep(-.02, .22, el);
  float cut = mix(.016, .0032, uAdapt);                 // faint stars appear as eyes adjust
  float vis = smoothstep(cut, cut * 2.2, aFlux);
  float tw = 1. + (.22 + .45*(1. - el)) * sin(uTime*(2.1 + aSeed*3.7) + aSeed*61.) * sin(uTime*(1.3 + aSeed*2.9) + aSeed*17.);
  float moonHide = step(dot(d, uMoonDir), cos(uMoonR * 1.1));
  float I = aFlux * 7. * (1. + 1.25*uAdapt) * uStarGain * tw * ext * vis * moonHide;
  gl_PointSize = I > .0004 ? (1.7 + 2.5*pow(aFlux, .4)) * uPx : 0.;
  vC = aCol * I;
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vC;
void main(){
  vec2 p = gl_PointCoord * 2. - 1.;
  gl_FragColor = vec4(vC * exp(-dot(p, p) * 4.6), 1.);
}`;

const METEOR_VERT = /* glsl */ `
${GLSL_MIRROR}
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = mirrorProject(position); }`;

const METEOR_FRAG = /* glsl */ `
uniform float uLife;
varying vec2 vUv;
void main(){
  float along = clamp(vUv.x, 0., 1.);                   // 0 = head, 1 = end of tail
  float across = vUv.y;                                 // -1 .. 1
  float core = exp(-across*across * 5.);
  float tail = (1. - along) * (1. - along);
  float head = exp(-along * 40.) * 1.5;
  vec3 c = mix(vec3(1., .96, .9), vec3(.55, .72, 1.), along);
  gl_FragColor = vec4(c * core * (tail + head) * uLife * 3.2, 1.);
}`;

function starColor(rnd) {
  const t = rnd();
  if (t < 0.25) return [0.74, 0.84, 1.0];
  if (t < 0.6) return [1.0, 1.0, 1.0];
  if (t < 0.82) return [1.0, 0.93, 0.76];
  if (t < 0.95) return [1.0, 0.78, 0.55];
  return [1.0, 0.62, 0.46];
}

function buildStars(n, rnd, gal) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const flux = new Float32Array(n), seed = new Float32Array(n);
  const { N, C } = gal;
  const B = new THREE.Vector3().crossVectors(N, C);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.6) {
      // Concentrated toward the galactic plane, like the real sky.
      const a = rnd() * Math.PI * 2;
      const g = (rnd() + rnd() + rnd() - 1.5) * 0.11;
      v.copy(C).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a)).addScaledVector(N, g).normalize();
    } else {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      v.set(s * Math.cos(a), z, s * Math.sin(a));
    }
    pos.set([v.x, v.y, v.z], i * 3);
    // Number brighter than f ~ f^-1.5: a few bright stars, many faint ones.
    const f = Math.min(1, 0.004 * Math.pow(Math.max(rnd(), 1e-6), -2 / 3));
    flux[i] = f;
    const c = starColor(rnd);
    const sat = Math.min(1, 0.35 + f * 4);
    col.set([1 + (c[0] - 1) * sat, 1 + (c[1] - 1) * sat, 1 + (c[2] - 1) * sat], i * 3);
    seed[i] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aFlux', new THREE.BufferAttribute(flux, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  return geo;
}

export function createSky(shared, rnd, { starCount = 14000 } = {}) {
  const gal = galacticFrame();
  const group = new THREE.Group();

  const milkyRT = new THREE.WebGLRenderTarget(2048, 1024, {
    type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping,
  });
  milkyRT.texture.wrapS = THREE.RepeatWrapping;

  const u = {
    uMilky: { value: milkyRT.texture },
    uSkyInv: { value: new THREE.Matrix3() },
    uSkyRot: { value: new THREE.Matrix3() },
    uMoonDir: shared.uMoonDir,
    uMoonSun: { value: new THREE.Vector3(0.78, -0.3, -0.55).normalize() },
    uMoonR: { value: 0.03 },
    uMoonPhase: { value: 0.4 },
    uMilkyGain: { value: 1.0 },
    uStarGain: { value: 1.0 },
    uAdapt: shared.uAdapt,
    uAurora: shared.uAurora,
    uTime: shared.uTime,
    uYaw: shared.uYaw,
    uHaze: shared.uHaze,
    uMirror: shared.uMirror,
    uPx: shared.uPx,
  };

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 48, 24),
    new THREE.ShaderMaterial({ uniforms: u, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.DoubleSide, depthWrite: false }),
  );
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  const stars = new THREE.Points(
    buildStars(starCount, rnd, gal),
    new THREE.ShaderMaterial({
      uniforms: u, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  stars.renderOrder = 1;
  stars.frustumCulled = false;
  group.add(stars);

  // Shooting star ribbon (positions rewritten on the CPU each frame it is alive).
  const mGeo = new THREE.BufferGeometry();
  const mPos = new THREE.BufferAttribute(new Float32Array(12), 3);
  mPos.setUsage(THREE.DynamicDrawUsage);
  mGeo.setAttribute('position', mPos);
  mGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2));
  mGeo.setIndex([0, 2, 1, 1, 2, 3]);
  const mU = { uLife: { value: 0 }, uMirror: shared.uMirror };
  const meteorMesh = new THREE.Mesh(mGeo, new THREE.ShaderMaterial({
    uniforms: mU, vertexShader: METEOR_VERT, fragmentShader: METEOR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  meteorMesh.renderOrder = 2;
  meteorMesh.frustumCulled = false;
  meteorMesh.visible = false;
  group.add(meteorMesh);

  let meteor = null;
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpV = new THREE.Vector3();

  function bake(renderer) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uGalN: { value: gal.N }, uGalC: { value: gal.C } },
      vertexShader: FS_VERT, fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(fullscreenTriangle(), mat);
    quad.frustumCulled = false;
    const s = new THREE.Scene(); s.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(milkyRT);
    renderer.render(s, cam);
    renderer.setRenderTarget(prev);
    mat.dispose();
  }

  // Shooting star: a short arc across the visible upper sky.
  // from/dir are world directions; the CPU keeps every value finite.
  function launch(camera, rndFn, { bright = 1 } = {}) {
    const fwd = camera.getWorldDirection(tmpA);
    const right = tmpB.crossVectors(fwd, camera.up).normalize();
    const up = tmpS.crossVectors(right, fwd).normalize();
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const sx = (rndFn() * 1.3 - 0.65) * Math.tan(hfov / 2);
    const sy = (0.25 + rndFn() * 0.6) * Math.tan(vfov / 2);
    const start = new THREE.Vector3().copy(fwd).addScaledVector(right, sx).addScaledVector(up, sy).normalize();
    if (start.y < 0.12) start.y = 0.12, start.normalize();
    const side = sx > 0 ? -1 : 1;                          // head toward the middle of the view
    const ang = THREE.MathUtils.degToRad(28 + rndFn() * 35);
    const vel = new THREE.Vector3().addScaledVector(right, side * Math.cos(ang)).addScaledVector(up, -Math.sin(ang)).normalize();
    meteor = {
      start, vel, age: 0,
      dur: 0.55 + rndFn() * 0.6,
      speed: THREE.MathUtils.degToRad(22 + rndFn() * 14),
      len: THREE.MathUtils.degToRad(7 + rndFn() * 6),
      width: THREE.MathUtils.degToRad(0.12),
      bright,
    };
  }

  function dirAt(m, ang, out) {
    // Rotate start toward vel by ang (great-circle step).
    return out.copy(m.start).multiplyScalar(Math.cos(ang)).addScaledVector(m.vel, Math.sin(ang)).normalize();
  }

  function updateMeteor(dt, camPos) {
    if (!meteor) { meteorMesh.visible = false; return; }
    meteor.age += dt;
    const k = meteor.age / meteor.dur;
    if (k >= 1) { meteor = null; meteorMesh.visible = false; return; }
    const head = meteor.speed * meteor.age;
    const tailLen = Math.min(meteor.len, head + 1e-3) * (0.4 + 0.6 * Math.min(1, k * 2));
    const h = dirAt(meteor, head, tmpA);
    const t = dirAt(meteor, Math.max(0, head - tailLen), tmpB);
    const across = tmpV.crossVectors(h, tmpS.subVectors(h, t)).normalize();
    const R = 2700;
    const w0 = R * meteor.width, w1 = w0 * 0.25;
    const a = mPos.array;
    const put = (i, dir, s) => {
      a[i * 3] = camPos.x + dir.x * R + across.x * s;
      a[i * 3 + 1] = camPos.y + dir.y * R + across.y * s;
      a[i * 3 + 2] = camPos.z + dir.z * R + across.z * s;
    };
    put(0, h, -w0); put(1, h, w0); put(2, t, -w1); put(3, t, w1);
    mPos.needsUpdate = true;
    // Quick flare-up, slower fade.
    mU.uLife.value = Math.sin(Math.PI * Math.pow(k, 0.6)) * meteor.bright;
    meteorMesh.visible = true;
  }

  // Sky rotation: celestial pole up in the north-west, behind the viewer's left shoulder.
  const pole = new THREE.Vector3();
  { const az = THREE.MathUtils.degToRad(-115), el = THREE.MathUtils.degToRad(46);
    pole.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)); }
  const qRot = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  const Y = new THREE.Vector3(0, 1, 0);

  function setRotation(angle, yaw) {
    qYaw.setFromAxisAngle(Y, -yaw);
    qRot.setFromAxisAngle(pole, angle).premultiply(qYaw);
    m4.makeRotationFromQuaternion(qRot);
    u.uSkyRot.value.setFromMatrix4(m4);
    u.uSkyInv.value.copy(u.uSkyRot.value).transpose();
  }
  setRotation(0, 0);

  return {
    group, dome, uniforms: u, bake, launch, setRotation,
    update(dt, camPos) {
      dome.position.copy(camPos);
      updateMeteor(dt, camPos);
    },
    get meteorActive() { return !!meteor; },
  };
}
