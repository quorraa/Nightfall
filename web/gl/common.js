import * as THREE from '../vendor/three.module.min.js';

// Shared GLSL helpers. Every smoothstep keeps edge0 < edge1 (reversed edges are undefined
// in GLSL ES and render garbage on some GPUs); every division is guarded.
export const GLSL_COMMON = /* glsl */ `
#define PI 3.14159265
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3. - 2.*f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= .5; } return s; }
float fbm3(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 3; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= .5; } return s; }
float fall(float e0, float e1, float x){ return 1. - smoothstep(e0, e1, x); }   // 1 below e0, 0 above e1
float luma(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
`;

// Height fog / aerial perspective shared by every lit surface. Night air: distant forms
// sink into a cold blue-violet haze that matches the sky just above the horizon.
export const GLSL_FOG = /* glsl */ `
uniform vec3 uHaze;
uniform float uHazeDensity;
vec3 applyHaze(vec3 col, vec3 wpos, vec3 cam){
  float d = length(wpos - cam);
  float h = max(wpos.y, 0.);
  float fog = 1. - exp(-d * uHazeDensity * exp(-h * .0035));
  return mix(col, uHaze, clamp(fog, 0., 1.));
}
`;

export function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same value noise on the CPU, so terrain heights, tree placement and the shaders agree.
function h2(x, y) {
  let p3x = (x * 0.1031) % 1, p3y = (y * 0.1031) % 1, p3z = (x * 0.1031) % 1;
  if (p3x < 0) p3x += 1; if (p3y < 0) p3y += 1; if (p3z < 0) p3z += 1;
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d; p3y += d; p3z += d;
  const r = ((p3x + p3y) * p3z) % 1;
  return r < 0 ? r + 1 : r;
}
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, oct = 5) {
  let a = 0.5, s = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); x = x * 2.03 + 17.1; y = y * 2.03 + 17.1; a *= 0.5; }
  return s;
}
export function ridged(x, y, oct = 5) {
  let a = 0.5, s = 0;
  for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vnoise(x, y) * 2 - 1); s += a * n * n; x = x * 2.03 + 17.1; y = y * 2.03 + 17.1; a *= 0.5; }
  return s;
}

export const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
export const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);

let triGeo = null;
export function fullscreenTriangle() {
  if (!triGeo) {
    triGeo = new THREE.BufferGeometry();
    triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  }
  return triGeo;
}
export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;
