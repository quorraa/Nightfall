import * as THREE from '../../vendor/three.module.min.js';
import { seeded, fbm, smooth } from '../../gl/common.js';
import { GLSL_WORLD, deg } from '../../gl/world.js';
import { GLSL_CAMP } from './camplight.js';
import { heightAt, phaseAt, FC } from './field.js';

// ---------------------------------------------------------------------------------------------
// Rock: flat-topped mesas and buttes on the far horizon and a few weathered outcrops poking out
// of the nearer sand, all from one generator (a noisy outline lathed through a cap rock, a
// cliff and a talus skirt), flat-shaded so the cliffs read as faceted stone. Plus sparse dry
// shrubs, instanced.
// ---------------------------------------------------------------------------------------------

function butte(P, N, { x, z, y, R, H, seed, flat = 1, segs = 40 }) {
  const rnd = seeded(seed);
  const o1 = rnd() * 100, o2 = rnd() * 100;
  const outline = [];
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const r = 1 + (fbm(ca * 1.3 + o1, sa * 1.3 + o2, 3) - 0.5) * 1.1 + (rnd() - 0.5) * 0.08;
    outline.push([ca, sa, Math.max(0.35, r)]);
  }
  // Profile rings: [radius scale, height fraction, jitter].
  const prof = flat
    ? [[0, 1.0, 0], [0.92, 1.0, 0.01], [1.0, 0.95, 0.02], [1.03, 0.62, 0.05], [1.1, 0.42, 0.04], [1.35, 0.2, 0.05], [1.75, 0.04, 0.03], [2.0, -0.12, 0]]
    : [[0, 1.0, 0], [0.5, 0.94, 0.06], [0.85, 0.72, 0.08], [1.0, 0.45, 0.06], [1.2, 0.22, 0.05], [1.5, 0.05, 0.03], [1.7, -0.15, 0]];
  const rows = prof.map(([rs, hf, j]) => outline.map(([ca, sa, r]) => {
    const jr = 1 + (rnd() - 0.5) * j * 2;
    return [x + ca * r * rs * R * jr, y + H * hf + (rnd() - 0.5) * j * H * 0.5 * (hf > 0.99 ? 0 : 1), z + sa * r * rs * R * jr];
  }));
  const tri = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    const mx = (a[0] + b[0] + c[0]) / 3 - x, mz = (a[2] + b[2] + c[2]) / 3 - z;
    if (n[0] * mx + n[2] * mz + n[1] * 0.3 < 0) n = [-n[0], -n[1], -n[2]];
    P.push(...a, ...b, ...c); N.push(...n, ...n, ...n);
  };
  for (let j = 0; j + 1 < rows.length; j++) {
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs;
      const a = rows[j][k], b = rows[j][k1], c = rows[j + 1][k1], d = rows[j + 1][k];
      if (j === 0) { tri(a, c, d); continue; }
      tri(a, b, c); tri(a, c, d);
    }
  }
}

const ROCK_VERT = /* glsl */ `
${GLSL_WORLD}
varying vec3 vW, vN;
void main(){
  vW = position; vN = normal;
  gl_Position = mirrorProject(position);
}`;

const ROCK_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_CAMP}
varying vec3 vW, vN;
void main(){
  vec3 n = normalize(vN);
  float range = length(vW.xz - cameraPosition.xz);
  // Strata: horizontal bands of harder and softer rock, a little wavy.
  float y = vW.y + (vnoise(vW.xz * .02) - .5) * 6.;
  float band = vnoise(vec2(y * .22, 3.1)) * .6 + vnoise(vec2(y * .9, 7.7)) * .4 * (1. - smoothstep(600., 1500., range));
  vec3 alb = mix(vec3(.12, .085, .065), vec3(.2, .15, .11), band);
  float sandy = smoothstep(.55, .85, n.y);
  alb = mix(alb, vec3(.3, .25, .2), sandy * .7);
  float K = max(dot(n, uKeyDir), 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.55 + .45 * n.y) + uMoonCol * .03) + alb * campLight(vW, n);
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

// Bearing (deg from -z toward +x), distance, footprint radius, height, flat top?
const MESAS = [
  [-21, 2650, 330, 165, 1], [-9, 2900, 150, 120, 1], [-5.5, 2850, 70, 150, 0],
  [17, 2500, 260, 95, 1], [27, 2750, 120, 140, 0], [44, 2600, 420, 120, 1],
  [-42, 2450, 260, 110, 1], [62, 2300, 200, 80, 0], [-58, 2700, 380, 140, 1],
];
const OUTCROPS = [
  [-14, 420, 14, 9, 0], [-12.5, 445, 8, 6, 0], [31, 330, 11, 7, 0], [52, 700, 30, 22, 1], [-33, 640, 22, 14, 0],
];

export function buildRocks(shared, campU) {
  const P = [], N = [];
  let seed = 11;
  for (const [az, d, R, H, flat] of [...MESAS, ...OUTCROPS]) {
    const a = deg(az), x = Math.sin(a) * d, z = -Math.cos(a) * d;
    // Sink the base into the lowest sand under the footprint.
    let y = Infinity;
    for (let k = 0; k < 8; k++) {
      const b = (k / 8) * Math.PI * 2;
      y = Math.min(y, heightAt(x + Math.cos(b) * R, z + Math.sin(b) * R));
    }
    butte(P, N, { x, z, y: y - H * 0.08, R, H, seed: seed++, flat, segs: d > 1500 ? 44 : 28 });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  const mat = new THREE.ShaderMaterial({ uniforms: { ...shared, ...campU }, vertexShader: ROCK_VERT, fragmentShader: ROCK_FRAG });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return { mesh, tris: P.length / 9 };
}

// ---------- Dry shrubs ----------
function shrubGeometry(rnd) {
  const P = [], N = [], H = [];
  const blades = 16;
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2 + rnd() * 0.4;
    const tilt = 0.35 + rnd() * 0.75;
    const len = 0.6 + rnd() * 0.5;
    const tx = Math.sin(a) * Math.sin(tilt) * len, ty = Math.cos(tilt) * len, tz = Math.cos(a) * Math.sin(tilt) * len;
    const wx = Math.cos(a) * 0.05, wz = -Math.sin(a) * 0.05;
    const n = [Math.sin(a) * 0.5, 0.85, Math.cos(a) * 0.5];
    P.push(-wx, 0, -wz, wx, 0, wz, tx, ty, tz);
    N.push(...n, ...n, ...n);
    H.push(0, 0, 1);
    // A side twig.
    const m = 0.45 + rnd() * 0.3, b = a + (rnd() - 0.5) * 1.6;
    const sx = tx * m, sy = ty * m, sz = tz * m;
    P.push(sx - wx * 0.5, sy, sz - wz * 0.5, sx + wx * 0.5, sy, sz + wz * 0.5,
      sx + Math.sin(b) * 0.3, sy + 0.18, sz + Math.cos(b) * 0.3);
    N.push(...n, ...n, ...n);
    H.push(m, m, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(H, 1));
  return g;
}

const SHRUB_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aH;
varying vec3 vW, vN;
varying float vH;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(position, 1.);
  vW = w.xyz; vN = normalize(mat3(m) * normal); vH = aH;
  gl_Position = mirrorProject(w.xyz);
}`;

const SHRUB_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_CAMP}
varying vec3 vW, vN;
varying float vH;
void main(){
  vec3 n = normalize(vN);
  vec3 alb = mix(vec3(.09, .08, .065), vec3(.24, .21, .16), vH);
  float K = max((dot(n, uKeyDir) + .4) / 1.4, 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb + uMoonCol * .03) * (.5 + .5 * vH) + alb * campLight(vW, n);
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

export function buildShrubs(shared, campU, site, { count = 260, seed = 7 } = {}) {
  const rnd = seeded(seed * 17 + 3);
  const geo = shrubGeometry(seeded(5));
  const mats = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  let guard = 0;
  const place = (x, z, scale) => {
    p.set(x, heightAt(x, z) - 0.08 * scale, z);
    q.setFromAxisAngle(Y, rnd() * Math.PI * 2);
    s.set(scale, scale * (0.7 + rnd() * 0.5), scale);
    m.compose(p, q, s);
    mats.push(...m.elements);
  };
  // A few around the camp.
  for (const [dx, dz, sc] of [[-9.5, 3.5, 1.1], [7.5, -4, 0.8], [11, 5, 0.9], [-4, 9, 0.6], [-12, -6, 0.9]]) place(site.x + dx, site.z + dz, sc);
  while (mats.length / 16 < count && guard++ < 40000) {
    const az = deg(-70 + rnd() * 155);
    const d = 18 + Math.pow(rnd(), 1.6) * 700;
    const x = Math.sin(az) * d, z = -Math.cos(az) * d;
    const f = ((phaseAt(x, z) % 1) + 1) % 1;
    // Interdune flats and low windward slopes only; clumped.
    if (f > FC - 0.25 && f < 0.97) continue;
    if (fbm(x * 0.02 + 4.1, z * 0.02 - 2.2, 2) < 0.48 + rnd() * 0.12) continue;
    if (Math.hypot(x - site.x, z - site.z) < 9) continue;
    place(x, z, (0.5 + rnd() * 0.7) * (1 + smooth(100, 600, d) * 0.6));
  }
  const n = mats.length / 16;
  const mat = new THREE.ShaderMaterial({ uniforms: { ...shared, ...campU }, vertexShader: SHRUB_VERT, fragmentShader: SHRUB_FRAG, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.array.set(mats);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return { mesh, count: n };
}
