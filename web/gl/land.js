import * as THREE from '../vendor/three.module.min.js';
import { fbm, smooth, seeded } from './common.js';
import { GLSL_WORLD, CAM, CABIN, heightAt, lakeSigned, forestDensity, slopeAt, deg } from './world.js';

// ---------------------------------------------------------------------------------------------
// Land: a polar terrain grid centred on the camera, instanced conifers in three distance tiers,
// a log cabin written as one slot-tagged mesh, and chimney smoke. Every shader works in world
// space and projects through mirrorProject, so the reflection pass is just uMirror = -1.
// ---------------------------------------------------------------------------------------------

// ---------- Terrain ----------
const TERRAIN_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aForest;
varying vec3 vW, vN;
varying float vF;
void main(){
  vW = position; vN = normal; vF = aForest;
  gl_Position = mirrorProject(position);
}`;

const TERRAIN_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform float uDebug;
varying vec3 vW, vN;
varying float vF;
void main(){
  if (uMirror < 0. && vW.y < -.05) discard;              // lake bed never shows in the mirror
  if (vW.y < -.3){ gl_FragColor = vec4(0., 0., 0., 1.); return; }   // under the opaque lake: skip shading
  vec3 n = normalize(vN);
  // Far peaks: the mesh is ~7 x 75 m per cell there, so ridges, gullies and buttresses come
  // from a shading-only normal (fbm gradient), strongest where the slope is already steep.
  float range = length(vW.xz - cameraPosition.xz);
  float farW = smoothstep(350., 900., range) * smoothstep(.12, .4, 1. - n.y);
  if (farW > .001){
    vec2 q = vW.xz * .016;
    float h0 = fbm3(q);
    vec2 gr = vec2(fbm3(q + vec2(.04, 0.)) - h0, fbm3(q + vec2(0., .04)) - h0) / .04;
    n = normalize(n + vec3(-gr.x, 0., -gr.y) * .55 * farW);
  }
  float slope = 1. - n.y;
  float nz = fbm(vW.xz * .045);
  float nz2 = vnoise(vW.xz * .55);
  vec3 grass = mix(vec3(.040, .052, .036), vec3(.075, .078, .055), nz);
  vec3 rock = mix(vec3(.050, .052, .062), vec3(.10, .098, .10), nz2);
  float rk = smoothstep(.22, .48, slope + (nz - .5) * .3);
  vec3 alb = mix(grass, rock, rk);
  alb = mix(alb, vec3(.011, .019, .017) * (.8 + .5 * nz2), vF * (1. - rk * .6));
  float wet = 1. - smoothstep(.05, .9, vW.y);
  alb *= 1. - .6 * wet;
  float snowLine = 165. + (fbm3(vW.xz * .004) - .5) * 120.;
  float snow = smoothstep(snowLine - 30., snowLine + 30., vW.y + (nz2 - .5) * 26.) * smoothstep(.42, .66, n.y);
  alb = mix(alb, vec3(.80, .84, .94), snow);
  float K = max(dot(n, uKeyDir), 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.5 + .5 * n.y)) + alb * lampLight(vW, n);
  // A little moon sheen on the wet stones at the waterline.
  vec3 V = normalize(cameraPosition - vW);
  col += wet * uMoonCol * .6 * pow(max(dot(reflect(-V, n), uMoonDir), 0.), 18.);
  if (uDebug > .5) col = vec3(vF, snow, rk) * .2;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

function buildTerrain() {
  const NA = 640, NR = 172;
  const az0 = deg(-62), az1 = deg(88);
  const radii = new Float64Array(NR + 1);
  for (let j = 0; j < NR; j++) radii[j] = 2 * Math.pow(2100 / 2, j / (NR - 1));
  radii[NR] = 2700;
  const W = NA + 1, nv = W * (NR + 1);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i <= NA; i++) {
    const a = az0 + (az1 - az0) * i / NA, sx = Math.sin(a), sz = -Math.cos(a);
    for (let j = 0; j <= NR; j++) {
      const x = CAM.x + sx * radii[j], z = CAM.z + sz * radii[j];
      const k = (j * W + i) * 3;
      pos[k] = x; pos[k + 1] = heightAt(x, z); pos[k + 2] = z;
    }
  }
  const nor = new Float32Array(nv * 3), forest = new Float32Array(nv);
  for (let j = 0; j <= NR; j++) {
    const jd = Math.max(j - 1, 0), ju = Math.min(j + 1, NR);
    for (let i = 0; i <= NA; i++) {
      const il = Math.max(i - 1, 0), ir = Math.min(i + 1, NA);
      const L = (j * W + il) * 3, R = (j * W + ir) * 3, D = (jd * W + i) * 3, U = (ju * W + i) * 3;
      const ax = pos[R] - pos[L], ay = pos[R + 1] - pos[L + 1], az = pos[R + 2] - pos[L + 2];
      const rx = pos[U] - pos[D], ry = pos[U + 1] - pos[D + 1], rz = pos[U + 2] - pos[D + 2];
      // (along azimuth) x (outward) points up.
      let nx = ay * rz - az * ry, ny = az * rx - ax * rz, nz = ax * ry - ay * rx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const k = (j * W + i) * 3;
      nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
      const grad = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 0.05);
      forest[j * W + i] = forestDensity(pos[k], pos[k + 2], pos[k + 1], grad) * (0.6 + 0.4 * smooth(200, 800, radii[j]));
    }
  }
  const idx = new Uint32Array(NA * NR * 6);
  let o = 0;
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aForest', new THREE.BufferAttribute(forest, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// ---------- Conifers ----------
// Each whorl is an opaque star-edged skirt hanging from the trunk; normals are bent outward
// like a rounded crown so the moon models the whole tree instead of each flat skirt.
const SPECIES = [
  { cb: 0.07, width: 0.30, whorls: 11, points: 7, shape: 1.0, overlap: 1.8, droop: 0.35, trunkR: 0.016, jitter: 0.12, hMul: 1.0 },  // spruce
  { cb: 0.10, width: 0.21, whorls: 10, points: 6, shape: 0.85, overlap: 1.7, droop: 0.12, trunkR: 0.014, jitter: 0.08, hMul: 0.9 }, // fir
  { cb: 0.48, width: 0.25, whorls: 6, points: 7, shape: 0.5, overlap: 2.1, droop: 0.06, trunkR: 0.02, jitter: 0.3, hMul: 1.15 },    // pine
];
const TIER_WHORLS = [1, 0.6, 0.35];
const TIER_NEAR = 250, TIER_MID = 650;

function conifer(sp, tier, rnd) {
  const P = [], N = [], S = [], I = [];
  const v = (x, y, z, nx, ny, nz, h, f, r) => { P.push(x, y, z); N.push(nx, ny, nz); S.push(h, f, r); return P.length / 3 - 1; };
  const sides = tier === 0 ? 6 : 4;
  const tTop = tier === 2 ? Math.min(0.9, sp.cb + 0.25) : 0.96;
  const b0 = P.length / 3;
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    v(c * sp.trunkR, -0.05, s * sp.trunkR, c, 0, s, 0, 0, 0.6);
    v(c * sp.trunkR * 0.3, tTop, s * sp.trunkR * 0.3, c, 0, s, tTop, 0, 0.6);
  }
  for (let k = 0; k < sides; k++) {
    const a = b0 + 2 * k, b = b0 + 2 * ((k + 1) % sides);
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const nW = Math.max(2, Math.round(sp.whorls * TIER_WHORLS[tier]));
  const k = tier === 0 ? sp.points : tier === 1 ? Math.min(sp.points, 6) : 5;
  const mid = tier === 0;
  const span = 1 - sp.cb, drop = (span / nW) * sp.overlap;
  const env = (y) => sp.width * Math.pow(Math.max(0, (1 - y) / span), sp.shape);
  const midFrac = 0.5 - sp.droop * 0.5;
  for (let w = 0; w < nW; w++) {
    const yTop = sp.cb + (span * (w + 1)) / nW;
    const yBot = Math.max(yTop - drop, sp.cb * 0.6);
    const Rt = Math.max(0.012, env(yBot) * (1 + (rnd() - 0.5) * sp.jitter * 2));
    const rot = rnd() * Math.PI * 2;
    const c0 = v(0, yTop, 0, 0, 1, 0, yTop, 1, 0.15);
    const ring = [], mids = [];
    for (let m = 0; m < 2 * k; m++) {
      const tip = m % 2 === 0;
      const a = rot + (m * Math.PI) / k + (rnd() - 0.5) * 0.25;
      const ca = Math.cos(a), sa = Math.sin(a);
      const r = tip ? Rt * (0.85 + 0.3 * rnd()) : Rt * 0.5;
      const y = tip ? yBot - drop * 0.15 * rnd() : yBot + drop * 0.38;
      const nl = Math.hypot(ca, 0.55, sa);
      ring.push(v(ca * r, y, sa * r, ca / nl, 0.55 / nl, sa / nl, y, 1, tip ? 1 : 0.6));
      if (mid) {
        const ym = yTop - (yTop - y) * midFrac, ml = Math.hypot(ca * 0.7, 0.85, sa * 0.7);
        mids.push(v(ca * r * 0.5, ym, sa * r * 0.5, (ca * 0.7) / ml, 0.85 / ml, (sa * 0.7) / ml, ym, 1, 0.45));
      }
    }
    const n = 2 * k;
    for (let m = 0; m < n; m++) {
      const m1 = (m + 1) % n;
      if (mid) {
        I.push(c0, mids[m], mids[m1]);
        I.push(mids[m], ring[m], ring[m1], mids[m], ring[m1], mids[m1]);
      } else {
        I.push(c0, ring[m], ring[m1]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aShape', new THREE.Float32BufferAttribute(S, 3));
  g.setIndex(I);
  return g;
}

const TREE_VERT = /* glsl */ `
${GLSL_WORLD}
attribute vec3 aShape;
attribute float aSeed, aSnow;
uniform float uSway;
varying vec3 vW, vN, vS;
varying float vSeed, vSnow;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vec3 c0 = m[0].xyz, c1 = m[1].xyz, c2 = m[2].xyz;
  vec3 s2 = vec3(dot(c0, c0), dot(c1, c1), dot(c2, c2));
  vN = normalize(mat3(m) * (normal / s2));
  vec4 w = m * vec4(position, 1.);
  vec3 root = m[3].xyz;
  float fade = 1. - smoothstep(150., 400., length(root.xz - cameraPosition.xz));
  float ph = aSeed * 6.2831;
  float gust = .55 + .45 * sin(uTime * .21 + root.x * .02 + root.z * .015);
  float sw = (sin(uTime * .55 + ph) * .7 + sin(uTime * .35 + ph * 2.3) * .3) * gust + .3;
  float h = aShape.x;
  w.xz += uWindDir * sw * uSway * sqrt(s2.y) * h * h * fade;
  vW = w.xyz; vS = aShape; vSeed = aSeed; vSnow = aSnow;
  gl_Position = mirrorProject(w.xyz);
}`;

const TREE_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform float uRim;
varying vec3 vW, vN, vS;
varying float vSeed, vSnow;
void main(){
  vec3 n = normalize(vN);
  vec3 V = cameraPosition - vW;
  float dist = length(V);
  V /= max(dist, 1e-3);
  float h = vS.x, fol = vS.y, rad = vS.z;
  vec3 needles = vec3(.016, .030, .026) * (.75 + .5 * vSeed);
  vec3 alb = mix(vec3(.030, .022, .016), needles, fol);
  float snow = vSnow * smoothstep(.25, .75, n.y) * fol * smoothstep(.35, .9, rad);
  alb = mix(alb, vec3(.50, .53, .60), snow * .75);
  float ao = mix(.35, 1., rad) * mix(.55, 1., h);
  float K = max((dot(n, uKeyDir) + .35) / 1.35, 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.6 + .4 * n.y)) * ao;
  // Silver edges where the tree stands between us and the moon.
  float back = smoothstep(.3, .95, dot(-V, uMoonDir));
  float rim = pow(1. - abs(dot(n, V)), 3.) * back * fol * rad * (1. - smoothstep(300., 900., dist));
  col += uMoonCol * rim * uRim;
  col += alb * lampLight(vW, n) * ao;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

function lowbias32(x) {
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function scatterTrees(seed) {
  const hash = (i, j, k) => lowbias32(lowbias32(i * 73856093 ^ j * 19349663) ^ (k * 83492791) ^ seed) / 4294967296;
  const S = 7;
  const azMin = deg(-48), azMax = deg(75);
  const groups = new Map();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  for (let gz = Math.floor(-1400 / S); gz <= 6; gz++) {
    for (let gx = -200; gx <= 200; gx++) {
      const x = (gx + 0.5 + (hash(gx, gz, 2) - 0.5) * 0.9) * S;
      const z = (gz + 0.5 + (hash(gx, gz, 3) - 0.5) * 0.9) * S;
      const d = Math.hypot(x - CAM.x, z - CAM.z);
      if (d < 12 || d > 1400) continue;
      const az = Math.atan2(x - CAM.x, -(z - CAM.z));
      if (az < azMin || az > azMax) continue;
      const thin = smooth(250, 1400, d);
      const keepMax = 1 - 0.75 * thin;
      const h0 = hash(gx, gz, 1);
      if (h0 > keepMax) continue;
      if (lakeSigned(x, z) < 1.5) continue;
      const y = heightAt(x, z);
      const dens = forestDensity(x, z, y, slopeAt(x, z, 2));
      if (h0 > dens * keepMax) continue;
      const sf = fbm(x * 0.008 + 50.2, z * 0.008 - 13.1, 2);
      const sp = sf > 0.56 && y > 6 ? 2 : hash(gx, gz, 4) < 0.3 ? 1 : 0;
      const H = (8 + 12 * hash(gx, gz, 5)) * SPECIES[sp].hMul * (1 - 0.45 * smooth(60, 160, y));
      const wm = (0.85 + 0.3 * hash(gx, gz, 6)) * (1 + 0.7 * thin);
      const tier = d < TIER_NEAR ? 0 : d < TIER_MID ? 1 : 2;
      const variant = hash(gx, gz, 7) < 0.5 ? 0 : 1;
      p.set(x, y - (0.3 + d * 0.004), z);
      q.setFromAxisAngle(Y, hash(gx, gz, 8) * Math.PI * 2);
      sc.set(H * wm, H, H * wm);
      m.compose(p, q, sc);
      const key = `${sp}.${variant}.${tier}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { sp, variant, tier, mats: [], seeds: [], snow: [] }));
      g.mats.push(...m.elements);
      g.seeds.push(hash(gx, gz, 9));
      g.snow.push(smooth(100, 160, y));
    }
  }
  return groups;
}

// ---------- Cabin ----------
// Local frame: the front wall lies in z = 0 and +z faces the lake; y = 0 is the floor pad.
export const CABIN_LOCAL = {
  lamp: new THREE.Vector3(0, 1.5, 0.6),
  smoke: new THREE.Vector3(1.95, 6.1, -2.85),
};

function cabinGeometry() {
  const P = [], N = [], U = [], S = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const push = (p, n, uv, slot) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); U.push(uv[0], uv[1]); S.push(slot); };
  const planarUV = (p, n) => (Math.abs(n[1]) > 0.7 ? [p[0], p[2]] : Math.abs(n[0]) > 0.7 ? [p[2], p[1]] : [p[0], p[1]]);

  // Polygon (3 or 4 points) facing away from `inside`.
  function face(pts, slot, inside, uvs) {
    let n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
    if (inside && dot(n, sub(c, inside)) < 0) n = [-n[0], -n[1], -n[2]];
    const uv = (i) => (uvs ? uvs[i] : planarUV(pts[i], n));
    for (let i = 1; i + 1 < pts.length; i++) {
      push(pts[0], n, uv(0), slot); push(pts[i], n, uv(i), slot); push(pts[i + 1], n, uv(i + 1), slot);
    }
  }
  // Hexahedron from a bottom quad and an offset.
  function prism(b, off, slot) {
    const t = b.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
    const c = [0, 1, 2].map((k) => (b.reduce((s, p) => s + p[k], 0) + t.reduce((s, p) => s + p[k], 0)) / 8);
    face(b, slot, c); face(t, slot, c);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face([b[i], b[j], t[j], t[i]], slot, c); }
  }
  const box = (x0, y0, z0, x1, y1, z1, slot) => prism([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, y1 - y0, 0], slot);
  // Cylinder along x or z, with end-grain caps.
  function cyl(axis, cx, cy, cz, len, r, slot, capSlot, sides = 7) {
    const ring = (t) => {
      const out = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2, u = Math.cos(a) * r, w = Math.sin(a) * r;
        out.push(axis === 'x' ? [cx + t, cy + w, cz + u] : [cx + u, cy + w, cz + t]);
      }
      return out;
    };
    const A = ring(-len / 2), B = ring(len / 2);
    const rn = (p) => norm(axis === 'x' ? [0, p[1] - cy, p[2] - cz] : [p[0] - cx, p[1] - cy, 0]);
    for (let k = 0; k < sides; k++) {
      const j = (k + 1) % sides;
      const q = [A[k], B[k], B[j], A[j]];
      const uv = q.map((p, i) => [i === 1 || i === 2 ? len : 0, (i < 2 ? k : k + 1) / sides]);
      for (const tri of [[0, 1, 2], [0, 2, 3]]) for (const i of tri) push(q[i], rn(q[i]), uv[i], slot);
    }
    const ca = axis === 'x' ? [cx - len, cy, cz] : [cx, cy, cz - len];
    const cb = axis === 'x' ? [cx + len, cy, cz] : [cx, cy, cz + len];
    for (let k = 1; k + 1 < sides; k++) {
      face([A[0], A[k], A[k + 1]], capSlot, cb);
      face([B[0], B[k], B[k + 1]], capSlot, ca);
    }
  }

  const W2 = 3.2, D = 5, TOP = 2.75, RIDGE = 5.25, FLOOR = 0.35;
  const pitch = Math.atan2(RIDGE - TOP, W2);
  const inside = [0, 1.5, -2.5];

  box(-3.28, -0.5, -D - 0.08, 3.28, FLOOR, 0.08, 4);                 // stone foundation
  box(-W2, FLOOR, -D, W2, TOP, 0, 0);                                // log walls
  for (const z of [0, -D]) face([[-W2, TOP, z], [W2, TOP, z], [0, RIDGE, z]], 0, inside);   // gables

  // Corner log ends: front/back wall logs stick out along x, side wall logs along z.
  for (let i = 0; i < 9; i++) {
    const yA = FLOOR + 0.13 + i * 0.26, yB = FLOOR + 0.26 + i * 0.26;
    for (const sx of [-1, 1]) {
      for (const [z, sz] of [[-0.12, 1], [-D + 0.12, -1]]) {
        cyl('x', sx * (W2 + 0.11), yA, z, 0.42, 0.125, 0, 6);
        cyl('z', sx * (W2 - 0.12), yB, z + sz * 0.23, 0.42, 0.125, 0, 6);
      }
    }
  }

  // Roof: two slabs on the gable edges, overhanging at the eaves and rakes.
  const eave = 0.45, rake = 0.32, thick = 0.2;
  const nx = Math.sin(pitch), ny = Math.cos(pitch);
  for (const s of [-1, 1]) {
    const ex = s * (W2 + eave), ey = TOP - eave * Math.tan(pitch);
    const b = [[0, RIDGE, -D - rake], [ex, ey, -D - rake], [ex, ey, rake], [0, RIDGE, rake]];
    prism(b, [s * nx * thick, ny * thick, 0], 1);
    // Barge boards under the front and back rake.
    for (const z of [rake - 0.03, -D - rake + 0.03]) {
      prism([[0, RIDGE - 0.02, z], [ex, ey - 0.02, z], [ex, ey - 0.26, z], [0, RIDGE - 0.26, z]], [0, 0, z > 0 ? -0.06 : 0.06], 2);
    }
  }
  box(-0.17, RIDGE + 0.05, -D - rake, 0.17, RIDGE + 0.3, rake, 2);   // ridge cap

  // Chimney through the right roof slope.
  box(1.6, 2.5, -3.2, 2.3, 6.0, -2.5, 4);
  box(1.52, 6.0, -3.28, 2.38, 6.12, -2.42, 4);

  // Door and its frame.
  face([[-0.5, FLOOR, 0.015], [0.5, FLOOR, 0.015], [0.5, 2.25, 0.015], [-0.5, 2.25, 0.015]], 2, inside);
  box(-0.6, FLOOR, 0, -0.5, 2.33, 0.07, 2); box(0.5, FLOOR, 0, 0.6, 2.33, 0.07, 2); box(-0.6, 2.25, 0, 0.6, 2.35, 0.07, 2);

  // Windows: emissive glass with a frame and a sill.
  const GLASS_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
  function frontWindow(x0, x1, y0, y1, z = 0) {
    face([[x0, y0, z + 0.025], [x1, y0, z + 0.025], [x1, y1, z + 0.025], [x0, y1, z + 0.025]], 3, inside, GLASS_UV);
    const f = 0.09;
    box(x0 - f, y0 - f, z, x0, y1 + f, z + 0.07, 2); box(x1, y0 - f, z, x1 + f, y1 + f, z + 0.07, 2);
    box(x0, y1, z, x1, y1 + f, z + 0.07, 2); box(x0 - f - 0.04, y0 - f - 0.06, z, x1 + f + 0.04, y0 - f, z + 0.14, 2);
  }
  frontWindow(-2.4, -1.2, 1.0, 2.1);
  frontWindow(1.2, 2.4, 1.0, 2.1);
  frontWindow(-0.4, 0.4, 3.25, 4.05);
  {
    const x = W2, z0 = -1.9, z1 = -0.8, y0 = 1.0, y1 = 2.0, f = 0.09;
    face([[x + 0.025, y0, z1], [x + 0.025, y0, z0], [x + 0.025, y1, z0], [x + 0.025, y1, z1]], 3, inside, GLASS_UV);
    box(x, y0 - f, z1, x + 0.07, y1 + f, z1 + f, 2); box(x, y0 - f, z0 - f, x + 0.07, y1 + f, z0, 2);
    box(x, y1, z0, x + 0.07, y1 + f, z1, 2); box(x, y0 - f - 0.06, z0 - f - 0.04, x + 0.14, y0 - f, z1 + f + 0.04, 2);
  }

  // Porch: deck, posts, beam, a shallow roof, steps, and a lantern on the right post.
  box(-3.3, 0.25, 0, 3.3, FLOOR, 1.8, 2);
  for (const sx of [-1, 1]) box(sx * 3.05 - 0.07, FLOOR, 1.58, sx * 3.05 + 0.07, 2.45, 1.72, 2);
  box(-3.15, 2.3, 1.57, 3.15, 2.44, 1.73, 2);
  prism([[-3.4, 2.62, 0], [3.4, 2.62, 0], [3.4, 2.38, 2.0], [-3.4, 2.38, 2.0]], [0, 0.09, 0], 1);
  box(-0.65, 0, 1.8, 0.65, 0.18, 2.3, 2);
  box(2.62, 1.78, 1.58, 2.78, 2.0, 1.74, 5);
  box(2.6, 2.0, 1.56, 2.8, 2.05, 1.76, 2);
  box(2.68, 2.05, 1.64, 2.72, 2.3, 1.68, 2);

  // Firewood stacked against the right wall, cut ends toward the lake side.
  const wood = seeded(77);
  for (let row = 0; row < 4; row++) {
    for (let c = 0; c < 9; c++) {
      const z = -4.3 + c * 0.21 + (row % 2) * 0.1;
      if (z > -2.35) continue;
      cyl('x', W2 + 0.3 + (wood() - 0.5) * 0.04, FLOOR + 0.1 + row * 0.19, z, 0.42 + wood() * 0.06, 0.095 + wood() * 0.015, 2, 6, 6);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('aSlot', new THREE.Float32BufferAttribute(S, 1));
  return g;
}

const CABIN_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aSlot;
varying vec3 vW, vN, vL, vNL;
varying vec2 vUv;
varying float vSlot;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz; vL = position; vNL = normal;
  vN = mat3(modelMatrix) * normal;
  vUv = uv; vSlot = aSlot;
  gl_Position = mirrorProject(w.xyz);
}`;

const CABIN_FRAG = /* glsl */ `
${GLSL_WORLD}
varying vec3 vW, vN, vL, vNL;
varying vec2 vUv;
varying float vSlot;
void main(){
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  int slot = int(vSlot + .5);
  vec3 alb = vec3(.1), emit = vec3(0.);
  float spec = 0., ao = 1.;
  if (slot == 0) {                                   // logs
    float phase = abs(vNL.x) > .5 ? .13 : 0.;
    float t = (vL.y - .35 - phase) / .26;
    float f = fract(t);
    if (abs(n.y) < .5) n = normalize(n + vec3(0., (f - .5) * 1.8, 0.));
    float gap = smoothstep(0., .08, f) * (1. - smoothstep(.92, 1., f));
    float along = abs(vNL.x) > .5 ? vL.z : vL.x;
    float grain = vnoise(vec2(along * 2.2, floor(t) * 7.3)) * .6 + vnoise(vec2(along * 9., floor(t) * 3.1 + f * 4.)) * .4;
    alb = vec3(.15, .095, .058) * (.7 + .55 * grain) * mix(.22, 1., gap);
    if (abs(vNL.y) < .5 && vL.y < 2.8) ao = (.62 + .38 * smoothstep(.35, 1., vL.y)) * (1. - .4 * smoothstep(2.1, 2.75, vL.y));
  } else if (slot == 1) {                            // roof shingles
    float row = vL.y / .135;
    float fr = fract(row);
    float tz = vL.z / .3 + floor(row) * .5;
    float tab = fract(tz);
    float edge = smoothstep(0., .14, fr) * smoothstep(0., .06, tab) * (1. - smoothstep(.94, 1., tab));
    alb = vec3(.055, .052, .058) * (.55 + .45 * edge) * (.8 + .4 * hash12(floor(vec2(tz, row))));
    spec = .5 * edge;
  } else if (slot == 2) {                            // trim and boards
    alb = vec3(.10, .072, .048) * (.8 + .4 * vnoise(vL.xy * 9. + vL.z * 5.));
  } else if (slot == 3) {                            // glass
    vec2 uv = vUv;
    vec2 fw = fwidth(uv) * 1.2 + 1e-4;
    float mx = 1. - smoothstep(.045 - fw.x, .045 + fw.x, abs(uv.x - .5));
    float my = 1. - smoothstep(.04 - fw.y, .04 + fw.y, abs(uv.y - .56));
    float bar = max(mx, my);
    float cl = 1. - smoothstep(.17 - fw.x, .21 + fw.x, uv.x);
    float cr = smoothstep(.79 - fw.x, .83 + fw.x, uv.x);
    float curtain = max(cl, cr);
    float folds = .65 + .35 * sin(uv.x * 75.);
    vec3 room = vec3(1., .62, .3) * 4. * (.75 + .35 * exp(-pow(uv.x - .5, 2.) * 10.) - .25 * uv.y);
    vec3 cloth = vec3(1., .5, .26) * 2.2 * folds;
    emit = mix(room, cloth, curtain) * (1. - bar) * uLamp;
    alb = vec3(.02, .016, .012) * bar;
    float F = .04 + .96 * pow(1. - max(dot(n, V), 0.), 5.);
    emit += (1. - bar) * (uHaze * 1.4 + uMoonCol * .25 * pow(max(dot(reflect(-V, n), uMoonDir), 0.), 40.)) * max(F, .15);
  } else if (slot == 4) {                            // fieldstone
    vec2 q = abs(vNL.x) > .5 ? vL.zy : vL.xy;
    if (abs(vNL.y) > .5) q = vL.xz;
    float st = vnoise(q * 3.2) * .65 + vnoise(q * 11.) * .35;
    float mortar = smoothstep(.18, .3, abs(fract(vnoise(q * 2.1 + 3.) * 3.) - .5));
    alb = vec3(.085, .085, .092) * (.6 + .8 * st) * mix(.45, 1., mortar);
  } else if (slot == 5) {                            // lantern
    alb = vec3(.02);
    emit = vec3(1., .66, .36) * 2.4 * uLamp;
  } else {                                           // end grain
    alb = vec3(.21, .155, .1) * (.8 + .4 * vnoise(vL.yz * 14. + vL.x * 3.));
  }
  float K = max(dot(n, uKeyDir), 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.5 + .5 * n.y)) * ao + alb * lampLight(vW, n);
  col += spec * uMoonCol * pow(max(dot(reflect(-V, n), uMoonDir), 0.), 24.) * 1.5;
  col += emit;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

// ---------- Chimney smoke ----------
const SMOKE_VERT = /* glsl */ `
${GLSL_WORLD}
uniform vec3 uOrigin;
uniform vec2 uSize;
varying vec2 vUv;
varying vec3 vW;
void main(){
  vec3 toCam = cameraPosition - uOrigin; toCam.y = 0.;
  vec3 right = normalize(vec3(toCam.z, 0., -toCam.x) + vec3(1e-4, 0., 0.));
  vec3 w = uOrigin + right * (uv.x - .5) * uSize.x + vec3(0., uv.y * uSize.y, 0.);
  w.xz += uWindDir * uv.y * uv.y * uSize.y * .4;
  vUv = uv; vW = w;
  gl_Position = mirrorProject(w);
}`;

const SMOKE_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform float uSmoke;
varying vec2 vUv;
varying vec3 vW;
void main(){
  float y = vUv.y, x = (vUv.x - .5) * 2.;
  float width = .14 + .86 * sqrt(y);
  float t = uTime;
  vec2 p = vec2(x / width * .7, y * 3.4 - t * .23);
  p.x += (fbm3(vec2(y * 2.2 - t * .05, 3.7)) - .5) * 1.1 * y;
  float n = fbm(p * 1.8 + vec2(0., -t * .04));
  float prof = exp(-pow(x / width, 2.) * 2.6);
  float a = prof * smoothstep(0., .05, y) * (1. - smoothstep(.4, 1., y)) * clamp(.25 + 1.4 * (n - .3), 0., 1.);
  a = clamp(a, 0., 1.) * .35 * uSmoke;
  vec3 V = normalize(vW - cameraPosition);
  float fwd = pow(max(dot(V, uMoonDir), 0.), 6.);
  vec3 col = uSkyAmb * 2.5 + uMoonCol * (.22 + 1.8 * fwd);
  col = applyHaze(col, vW);
  gl_FragColor = vec4(col * a, a);
}`;

export function createLand(shared, { seed = 1, debug = {} } = {}) {
  const group = new THREE.Group();
  const stats = {};
  const t0 = performance.now();

  // Terrain
  const terrainU = { ...shared, uDebug: { value: debug.forest ? 1 : 0 } };
  const terrain = new THREE.Mesh(buildTerrain(), new THREE.ShaderMaterial({
    uniforms: terrainU, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, side: THREE.DoubleSide,
  }));
  terrain.frustumCulled = false;
  terrain.renderOrder = 2;                       // after trees and cabin: they hide a lot of it
  group.add(terrain);
  stats.terrainMs = Math.round(performance.now() - t0);
  stats.terrainTris = terrain.geometry.index.count / 3;

  // Trees
  const t1 = performance.now();
  const treeU = { ...shared, uSway: { value: 0.004 }, uRim: { value: 0.55 } };
  const treeMat = new THREE.ShaderMaterial({ uniforms: treeU, vertexShader: TREE_VERT, fragmentShader: TREE_FRAG, side: THREE.DoubleSide });
  const groups = scatterTrees(seed >>> 0);
  const farTier = [];
  const counts = [0, 0, 0];
  let treeTris = 0;
  for (const g of groups.values()) {
    const geo = conifer(SPECIES[g.sp], g.tier, seeded(1000 + g.sp * 10 + g.variant));
    const n = g.seeds.length;
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(g.seeds), 1));
    geo.setAttribute('aSnow', new THREE.InstancedBufferAttribute(new Float32Array(g.snow), 1));
    const mesh = new THREE.InstancedMesh(geo, treeMat, n);
    mesh.instanceMatrix.array.set(g.mats);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 0;
    group.add(mesh);
    if (g.tier === 2) farTier.push(mesh);
    counts[g.tier] += n;
    treeTris += (geo.index.count / 3) * n;
  }
  stats.trees = counts;
  stats.treeTris = treeTris;
  stats.treeMs = Math.round(performance.now() - t1);

  // Cabin
  const cabinMat = new THREE.ShaderMaterial({ uniforms: { ...shared }, vertexShader: CABIN_VERT, fragmentShader: CABIN_FRAG, side: THREE.DoubleSide });
  cabinMat.extensions = { derivatives: true };
  const cabin = new THREE.Mesh(cabinGeometry(), cabinMat);
  cabin.position.set(CABIN.x, CABIN.y, CABIN.z);
  cabin.rotation.y = CABIN.yaw;
  cabin.frustumCulled = false;
  cabin.updateMatrixWorld(true);
  group.add(cabin);
  stats.cabinTris = cabin.geometry.attributes.position.count / 3;

  const lampPos = CABIN_LOCAL.lamp.clone().applyMatrix4(cabin.matrixWorld);
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(cabin.quaternion);
  shared.uLampPos.value.copy(lampPos);
  shared.uLampDir.value.copy(front);

  // Smoke
  const smokeU = {
    ...shared,
    uOrigin: { value: CABIN_LOCAL.smoke.clone().applyMatrix4(cabin.matrixWorld) },
    uSize: { value: new THREE.Vector2(3.2, 10) },
    uSmoke: { value: 1 },
  };
  const smoke = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 8).translate(0.5, 0.5, 0), new THREE.ShaderMaterial({
    uniforms: smokeU, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  smoke.frustumCulled = false;
  smoke.renderOrder = 5;
  group.add(smoke);

  return {
    group, terrain, farTier, cabin, smoke, stats,
    lamp: { pos: lampPos, dir: front },
    uniforms: { tree: treeU, smoke: smokeU, terrain: terrainU },
    setSmoke(v) { smokeU.uSmoke.value = v; },
  };
}
