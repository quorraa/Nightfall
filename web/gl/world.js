import * as THREE from '../vendor/three.module.min.js';
import { GLSL_COMMON, fbm, ridged, smooth } from './common.js';
import { GLSL_MIRROR } from './sky.js';

// ---------------------------------------------------------------------------------------------
// World layout and the one height field every system shares (terrain mesh, tree roots, cabin
// pad, fireflies). The camera stands on the near bank looking north (-z) across a small lake to
// a log cabin; forested hills open into a valley with snowy mountains behind, the moon above.
// ---------------------------------------------------------------------------------------------

export const CAM = { x: 0, y: 3.2, z: 0 };
export const LAKE = { cx: 0, cz: -50, rx: 120, rz: 46 };
export const ISLET = { x: -26, z: -63, r: 6.5 };

export const deg = THREE.MathUtils.degToRad;
// Azimuth measured from -z toward +x, elevation above the horizon.
export function dirAzEl(az, el, out = new THREE.Vector3()) {
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

// Signed distance-ish to the shore in metres: negative is water.
export function lakeSigned(x, z) {
  const dx = (x - LAKE.cx) / LAKE.rx, dz = (z - LAKE.cz) / LAKE.rz;
  const r = Math.hypot(dx, dz);
  const wob = (fbm(x * 0.021 + 3.1, z * 0.021 - 7.3, 3) - 0.5) * smooth(8, 40, Math.hypot(x, z));
  let s = (r - 1 - wob * 0.22) * 48;
  const di = Math.hypot(x - ISLET.x, (z - ISLET.z) * 1.4);
  s = Math.max(s, (ISLET.r - di) * (0.8 + 0.5 * fbm(x * 0.3, z * 0.3, 2)));
  return s;
}

function rawHeight(x, z) {
  const s = lakeSigned(x, z);
  if (s < 0) return Math.max(-3.5, s * 0.1) - 0.3;
  const d = Math.hypot(x, z);
  const bank = 1.25 * smooth(0, 9, s) - 0.3 + 0.3 * smooth(0, 1.5, s);
  // A valley opens behind the cabin so the mountains show between the hills.
  const az = Math.abs(Math.atan2(x - 20, -z));
  const valley = 0.35 + 0.65 * smooth(0.05, 0.5, az);
  const hills = Math.pow(fbm(x * 0.0048 + 11.3, z * 0.0048 - 4.2, 5), 1.5) * 120 * smooth(4, 320, s) * valley;
  const mount = Math.pow(ridged(x * 0.0013 + 5.1, z * 0.0013 + 9.7, 5), 1.8) * 640 * smooth(650, 1500, d);
  const detail = (fbm(x * 0.06, z * 0.06, 3) - 0.5) * 1.6 * smooth(0, 6, s);
  return bank + hills + mount + detail;
}

// The cabin sits a few metres back from the far shore, a little right of centre.
export const CABIN = (() => {
  const x = 10;
  let z = LAKE.cz;
  while (lakeSigned(x, z) < 7.5 && z > -400) z -= 0.25;
  const y = rawHeight(x, z) + 0.15;
  // Turned so the camera sees the front gable and the right-hand wall.
  const toCam = Math.atan2(CAM.x - x, CAM.z - z);
  return { x, y, z, yaw: toCam - 0.5 };
})();

export function heightAt(x, z) {
  const h = rawHeight(x, z);
  const dc = Math.hypot(x - CABIN.x, z - CABIN.z);
  const w = (1 - smooth(6, 15, dc)) * smooth(0, 3, lakeSigned(x, z));
  return h + (CABIN.y - 0.15 - h) * w;
}

// Forest density on the ground (also darkens the far terrain into a canopy).
export function forestDensity(x, z, y, slope) {
  const patch = smooth(0.36, 0.66, fbm(x * 0.0055 + 30.7, z * 0.0055 + 2.4, 4) * 0.8 + fbm(x * 0.02, z * 0.02, 2) * 0.2);
  const treeline = 150 + (fbm(x * 0.003, z * 0.003, 2) - 0.5) * 90;
  const s = lakeSigned(x, z);
  return (0.25 + 0.75 * patch)
    * (1 - smooth(treeline - 40, treeline, y))
    * smooth(1.5, 6, s)
    * (1 - smooth(0.75, 1.2, slope))
    * smooth(8, 20, Math.hypot(x - CABIN.x, z - CABIN.z));
}

export function slopeAt(x, z, e = 2) {
  return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
}

// Shared uniforms. Every world material spreads these so one value object drives all of them.
export function createShared() {
  return {
    uTime: { value: 0 },
    uMirror: { value: 1 },
    uPx: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uMoonDir: { value: dirAzEl(deg(8), deg(19)) },
    uKeyDir: { value: dirAzEl(deg(58), deg(30)) },
    uMoonCol: { value: new THREE.Vector3(0.15, 0.17, 0.23) },
    uSkyAmb: { value: new THREE.Vector3(0.010, 0.014, 0.027) },
    uHaze: { value: new THREE.Vector3(0.014, 0.019, 0.042) },
    uHazeDensity: { value: 0.0006 },
    uMist: { value: 0.0035 },
    uMistCol: { value: new THREE.Vector3(0.026, 0.032, 0.056) },
    uMistDrift: { value: new THREE.Vector2() },
    uLamp: { value: 1 },
    uLampPos: { value: new THREE.Vector3() },
    uLampDir: { value: new THREE.Vector3(0, 0, 1) },
    uLampCol: { value: new THREE.Vector3(1.0, 0.56, 0.24) },
    uAdapt: { value: 0 },
    uAurora: { value: 0 },
    uYaw: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  };
}

// Prelude for every world shader: one declaration of each shared uniform, lighting and haze.
export const GLSL_WORLD = /* glsl */ `
${GLSL_COMMON}
${GLSL_MIRROR}
uniform float uTime, uLamp, uHazeDensity, uMist;
uniform vec3 uHaze, uMistCol, uMoonDir, uKeyDir, uMoonCol, uSkyAmb, uLampPos, uLampDir, uLampCol;
uniform vec2 uMistDrift, uWindDir;

// Warm light spilling out of the cabin's front windows.
vec3 lampLight(vec3 wp, vec3 n){
  vec3 v = uLampPos - wp;
  float d2 = dot(v, v);
  vec3 L = v * inversesqrt(max(d2, 1e-4));
  float through = smoothstep(-.3, .35, dot(-L, uLampDir));
  return uLampCol * (uLamp * through * max(dot(n, L), 0.) * 7. / (1. + d2 * .55));
}

// Path-averaged density of an exponential layer with scale height H between two heights.
float avgDensity(float y0, float y1, float H){
  float dy = y1 - y0, e0 = exp(-y0 / H);
  return abs(dy) > .05 ? (e0 - exp(-y1 / H)) * H / dy : e0;
}

// Aerial perspective (blue haze matching the sky at the horizon) plus a low, patchy mist
// layer a few metres deep that pools over the lake and brightens toward the moon.
vec3 applyHaze(vec3 col, vec3 wp){
  vec3 c = cameraPosition;
  vec3 v = wp - c;
  float d = length(v);
  vec3 dir = v / max(d, 1e-3);
  float y0 = max(c.y, 0.), y1 = max(wp.y, 0.);
  float fwd = pow(max(dot(dir, uMoonDir), 0.), 8.);
  float haze = 1. - exp(-d * uHazeDensity * avgDensity(y0, y1, 285.));
  col = mix(col, uHaze * (1. + 1.3 * fwd), haze);
  float patchy = .3 + 1.4 * fbm3(wp.xz * .013 + uMistDrift);
  float mist = 1. - exp(-uMist * d * avgDensity(y0, y1, 4.5) * patchy);
  return mix(col, uMistCol * (1. + 2.5 * fwd), mist);
}
`;
