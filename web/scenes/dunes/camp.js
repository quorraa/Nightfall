import * as THREE from '../../vendor/three.module.min.js';
import { seeded } from '../../gl/common.js';
import { GLSL_WORLD } from '../../gl/world.js';
import { GLSL_CAMP } from './camplight.js';
import { heightAt } from './field.js';

// ---------------------------------------------------------------------------------------------
// The camp: a canvas bell tent with a lantern inside, a ring of stones with embers in front of
// the door, and a dead acacia standing over them. Written as one slot-tagged mesh in the tent's
// local frame (y = 0 is the sand pad, +z is the door).
// ---------------------------------------------------------------------------------------------

export const TENT = { R: 2.5, wall: 0.7, apex: 3.15, lampY: 1.5 };
export const FIRE_LOCAL = new THREE.Vector3(1.7, 0, 4.4);
const TREE_LOCAL = new THREE.Vector3(-6.8, 0, -2.6);

const SLOT = { canvas: 0, wood: 1, stone: 2, char: 3, ember: 4, bark: 5 };

function writer() {
  const P = [], N = [], S = [];
  const push = (p, n, s) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); S.push(s); };
  return { P, N, S, push };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// A smooth grid surface given as rows of points; normals from neighbours, oriented away from
// `axisOut` (a function giving an outward hint per point).
function gridSurface(w, rows, slot, outHint, wrap) {
  const nr = rows.length, nc = rows[0].length;
  const nAt = (j, i) => {
    const il = wrap ? (i - 1 + nc) % nc : Math.max(i - 1, 0), ir = wrap ? (i + 1) % nc : Math.min(i + 1, nc - 1);
    const jd = Math.max(j - 1, 0), ju = Math.min(j + 1, nr - 1);
    let n = norm(cross(sub(rows[ju][i], rows[jd][i]), sub(rows[j][ir], rows[j][il])));
    const h = outHint(rows[j][i]);
    if (n[0] * h[0] + n[1] * h[1] + n[2] * h[2] < 0) n = mul(n, -1);
    return n;
  };
  const cols = wrap ? nc : nc - 1;
  for (let j = 0; j + 1 < nr; j++) {
    for (let i = 0; i < cols; i++) {
      const i1 = (i + 1) % nc;
      const q = [[j, i], [j, i1], [j + 1, i1], [j + 1, i]];
      for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) {
        const [a, b] = q[k];
        w.push(rows[a][b], nAt(a, b), slot);
      }
    }
  }
}

// Tapered tube between two points.
function tube(w, p0, p1, r0, r1, slot, sides = 5) {
  const d = norm(sub(p1, p0));
  const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, up)), v = cross(u, d);
  const ring = (p, r) => {
    const out = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const nn = add(mul(u, c), mul(v, s));
      out.push([add(p, mul(nn, r)), nn]);
    }
    return out;
  };
  const A = ring(p0, r0), B = ring(p1, r1);
  for (let k = 0; k < sides; k++) {
    const j = (k + 1) % sides;
    for (const [p, n] of [A[k], B[k], B[j], A[k], B[j], A[j]]) w.push(p, n, slot);
  }
}

// Irregular stone: a squashed, jittered octahedron-ish lump.
function stone(w, c, size, rnd) {
  const pts = [];
  const sx = size * (0.9 + rnd() * 0.4), sy = size * (0.55 + rnd() * 0.25), sz = size * (0.8 + rnd() * 0.4);
  const rot = rnd() * Math.PI;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -0.3, 0], [0, 0, 1], [0, 0, -1],
    [0.7, 0.6, 0.7], [-0.7, 0.6, 0.7], [0.7, 0.6, -0.7], [-0.7, 0.6, -0.7]];
  for (const d of dirs) {
    const k = 0.85 + rnd() * 0.3;
    const x = d[0] * sx * k, y = d[1] * sy * k, z = d[2] * sz * k;
    pts.push([c[0] + x * cr - z * sr, c[1] + y, c[2] + x * sr + z * cr]);
  }
  const tris = [[2, 4, 6], [2, 6, 0], [2, 0, 8], [2, 8, 5], [2, 5, 9], [2, 9, 1], [2, 1, 7], [2, 7, 4],
    [3, 6, 4], [3, 0, 6], [3, 8, 0], [3, 5, 8], [3, 9, 5], [3, 1, 9], [3, 7, 1], [3, 4, 7]];
  for (const t of tris) {
    const a = pts[t[0]], b = pts[t[1]], cc = pts[t[2]];
    let n = norm(cross(sub(b, a), sub(cc, a)));
    const m = mul(add(add(a, b), cc), 1 / 3);
    if ((m[0] - c[0]) * n[0] + (m[1] - c[1]) * n[1] + (m[2] - c[2]) * n[2] < 0) n = mul(n, -1);
    w.push(a, n, SLOT.stone); w.push(b, n, SLOT.stone); w.push(cc, n, SLOT.stone);
  }
}

function tentGeometry(w) {
  const { R, wall, apex } = TENT;
  const NS = 60;
  const rows = [];
  const ringAt = (r, y, sag) => {
    const row = [];
    for (let k = 0; k < NS; k++) {
      const th = (k / NS) * Math.PI * 2;
      const u = (k / NS) * 12 % 1;
      const rr = r * (1 - sag * Math.sin(Math.PI * u));
      row.push([Math.sin(th) * rr, y, Math.cos(th) * rr]);
    }
    return row;
  };
  rows.push(ringAt(R + 0.04, -0.12, 0));
  rows.push(ringAt(R, 0.12, 0.008));
  rows.push(ringAt(R, wall, 0.012));
  const NR = 10;
  for (let j = 1; j <= NR; j++) {
    const t = j / NR;
    const r = R + (0.09 - R) * t;
    const y = wall + (apex - wall) * (0.6 * t + 0.4 * t * t);
    rows.push(ringAt(r, y, 0.04 * Math.sin(Math.PI * Math.min(1, t * 1.15))));
  }
  rows.push(ringAt(0.001, apex + 0.04, 0));
  gridSurface(w, rows, SLOT.canvas, (p) => [p[0], 0.4, p[2]], true);
  // Pole cap above the apex.
  tube(w, [0, apex - 0.05, 0], [0, apex + 0.32, 0], 0.035, 0.028, SLOT.wood, 6);
}

function fireGeometry(w, rnd) {
  const c = [FIRE_LOCAL.x, 0, FIRE_LOCAL.z];
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2 + rnd() * 0.25;
    const r = 0.62 + rnd() * 0.06;
    stone(w, [c[0] + Math.cos(a) * r, 0.06, c[2] + Math.sin(a) * r], 0.16 + rnd() * 0.06, rnd);
  }
  // Ember bed: a low disc.
  const NS = 14, rb = 0.5;
  for (let k = 0; k < NS; k++) {
    const a0 = (k / NS) * Math.PI * 2, a1 = ((k + 1) / NS) * Math.PI * 2;
    w.push([c[0], 0.1, c[2]], [0, 1, 0], SLOT.ember);
    w.push([c[0] + Math.cos(a1) * rb, 0.03, c[2] + Math.sin(a1) * rb], [0, 1, 0], SLOT.ember);
    w.push([c[0] + Math.cos(a0) * rb, 0.03, c[2] + Math.sin(a0) * rb], [0, 1, 0], SLOT.ember);
  }
  // Burnt-down logs crossing the embers.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI + rnd() * 0.4;
    const dx = Math.cos(a) * 0.42, dz = Math.sin(a) * 0.42;
    tube(w, [c[0] - dx, 0.14 + k * 0.02, c[2] - dz], [c[0] + dx, 0.08 + k * 0.03, c[2] + dz], 0.06, 0.045, SLOT.char, 6);
  }
}

// A dead umbrella-thorn: a short leaning trunk, limbs that fork upward and out, and a flat,
// spreading crown of bare twigs.
function treeGeometry(w, base, rnd) {
  const branch = (p0, dir, len, r0, depth) => {
    // Two segments with a bend, tapering.
    const bend = norm(add(dir, [(rnd() - 0.5) * 0.35, (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.35]));
    const pm = add(p0, mul(dir, len * 0.5));
    const p1 = add(pm, mul(bend, len * 0.5));
    const rm = r0 * 0.85, r1 = r0 * 0.68;
    tube(w, p0, pm, r0, rm, SLOT.bark, depth < 2 ? 6 : 4);
    tube(w, pm, p1, rm, r1, SLOT.bark, depth < 2 ? 6 : 4);
    if (depth >= 3) return;
    const kids = depth === 0 ? 3 : depth === 1 ? 3 : 2 + (rnd() < 0.5 ? 1 : 0);
    const az0 = rnd() * Math.PI * 2;
    for (let k = 0; k < kids; k++) {
      const az = az0 + (k / kids) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
      // Steeper limbs low down, nearly level twigs at the top: the flat crown.
      const tilt = [0.75, 1.05, 1.3][depth] + (rnd() - 0.5) * 0.25;
      const hd = [Math.sin(az) * Math.sin(tilt), Math.cos(tilt), Math.cos(az) * Math.sin(tilt)];
      const d = norm(add(mul(bend, 0.35), hd));
      const l = len * [0.95, 0.7, 0.6][depth] * (0.8 + rnd() * 0.4);
      branch(p1, d, l, r1 * (0.62 + rnd() * 0.1), depth + 1);
    }
  };
  const lean = [0.18, 1, -0.08];
  branch(base, norm(lean), 1.9, 0.17, 0);
}

const CAMP_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aSlot;
varying vec3 vW, vN, vL;
varying float vSlot;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz; vL = position; vN = mat3(modelMatrix) * normal; vSlot = aSlot;
  gl_Position = mirrorProject(w.xyz);
}`;

const CAMP_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_CAMP}
uniform vec3 uFireLocal;
varying vec3 vW, vN, vL;
varying float vSlot;
void main(){
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  if (dot(n, V) < 0.) n = -n;
  int slot = int(vSlot + .5);
  vec3 alb = vec3(.1), emit = vec3(0.);
  float wrapK = 0.;
  if (slot == 0) {                                   // canvas
    vec3 lp = vL;
    float r = length(lp.xz);
    float th = atan(lp.x, lp.z);                      // 0 at the door
    // Seams between the twelve roof panels, and along the eave.
    float u = th * 12. / 6.2831853;
    float sd = abs(fract(u + .5) - .5) * 6.2831853 / 12. * max(r, .05);
    float sw = fwidth(sd) + 1e-4;
    float seam = (1. - smoothstep(.025, .025 + sw * 1.5, sd)) * smoothstep(.75, .9, lp.y);
    float eave = 1. - smoothstep(.03, .03 + fwidth(lp.y) * 1.5 + 1e-4, abs(lp.y - ${TENT.wall.toFixed(2)}));
    seam = max(seam, eave * .8);
    // Door: the flaps are tied back into a tall triangle; inside, the lantern hangs on the pole.
    float hw = .27 * pow(clamp(1. - lp.y / 1.95, 0., 1.), .8);
    float tw = fwidth(th) + 1e-4;
    float door = 1. - smoothstep(hw - tw, hw + tw, abs(th));
    float flap = (1. - smoothstep(hw + .07 - tw, hw + .07 + tw, abs(th))) * (1. - door) * step(lp.y, 2.05);
    vec3 q = lp - vec3(0., ${TENT.lampY.toFixed(2)}, 0.);
    float E = 1. / (1. + dot(q, q) * .3);
    float soil = smoothstep(.04, .2, lp.y);
    float glow = E * (1. + seam * 1.6) * (1. - flap * .6) * mix(.35, 1., soil);
    alb = vec3(.46, .43, .37) * mix(.55, 1., soil) * (1. - .2 * flap);
    // Canvas filters the flame toward amber.
    emit = uLampCol * vec3(1., .78, .6) * (1.15 * glow * uLamp);
    // Through the door: the lit inside, the lantern itself a hot point at the pole.
    float lant = exp(-pow((lp.y - ${TENT.lampY.toFixed(2)}) / .16, 2.) - th * th * 260.);
    vec3 inside = uLampCol * uLamp * (2.6 + 1.8 * smoothstep(.1, 1.2, lp.y) + 7. * lant);
    inside = mix(inside, uLampCol * uLamp * 1.1 * vec3(1., .75, .6), step(lp.y, .12));
    emit = mix(emit, inside, door);
    alb *= 1. - door;
    wrapK = .25;
  } else if (slot == 1) {                            // pole cap
    alb = vec3(.07, .05, .035);
  } else if (slot == 2) {                            // stones
    alb = vec3(.13, .115, .1) * (.8 + .4 * hash12(floor(vL.xz * 6.)));
  } else if (slot == 3) {                            // charred logs, glowing where they touch the embers
    alb = vec3(.025, .02, .018);
    float hot = smoothstep(.2, .55, vnoise(vL.xz * 9. + uTime * .35)) * (1. - smoothstep(.06, .16, vL.y));
    emit = vec3(1., .3, .07) * hot * 2.2 * uEmber;
  } else if (slot == 4) {                            // embers
    vec2 e = vL.xz - uFireLocal.xz;
    float rr = length(e);
    float nz = vnoise(vL.xz * 11. + vec2(uTime * .4, -uTime * .3)) * .6 + vnoise(vL.xz * 23. - uTime * .7) * .4;
    float hot = smoothstep(.35, .8, nz) * (1. - smoothstep(.15, .5, rr));
    alb = vec3(.03, .025, .02);
    emit = vec3(1., .32, .07) * (.35 + 3.2 * hot) * uEmber * (1. - smoothstep(.3, .5, rr));
  } else {                                           // bleached bark
    float g = vnoise(vec2(vL.y * 7., atan(vL.x, vL.z) * 3.)) ;
    alb = vec3(.16, .15, .14) * (.7 + .5 * g);
    wrapK = .3;
  }
  float K = max((dot(n, uKeyDir) + wrapK) / (1. + wrapK), 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.6 + .4 * n.y) + uMoonCol * .04) + alb * campLight(vW, n);
  col += emit;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

const GLOW_VERT = /* glsl */ `
${GLSL_WORLD}
uniform vec3 uOrigin;
uniform float uSize;
varying vec2 vUv;
varying vec3 vW;
void main(){
  vec3 toCam = normalize(cameraPosition - uOrigin);
  vec3 right = normalize(cross(vec3(0., 1., 0.), toCam));
  vec3 up = cross(toCam, right);
  vec3 w = uOrigin + (right * (uv.x - .5) + up * (uv.y - .5)) * uSize;
  vUv = uv; vW = w;
  gl_Position = mirrorProject(w);
}`;

const GLOW_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_CAMP}
varying vec2 vUv;
varying vec3 vW;
void main(){
  vec2 q = vUv * 2. - 1.;
  float r2 = dot(q, q);
  float a = exp(-r2 * 7.) * .55 + exp(-r2 * 30.) * .6;
  vec3 c = vec3(1., .42, .14) * a * uEmber * .55;
  gl_FragColor = vec4(c * (1. - smoothstep(.8, 1., r2)), 1.);
}`;

export function buildCamp(shared, campU, site, yaw) {
  const rnd = seeded(4242);
  const w = writer();
  tentGeometry(w);
  fireGeometry(w, rnd);
  // The tree stands outside the flat pad, so root it on the sand.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const toWorld = (p) => [site.x + p.x * c + p.z * s, site.y + p.y, site.z - p.x * s + p.z * c];
  const tw = toWorld(TREE_LOCAL);
  const treeY = Math.min(heightAt(tw[0], tw[2]), site.y + 0.6) - site.y - 0.15;
  treeGeometry(w, [TREE_LOCAL.x, treeY, TREE_LOCAL.z], seeded(91));
  // A couple of stones half-buried near the tree.
  stone(w, [TREE_LOCAL.x + 0.9, treeY + 0.05, TREE_LOCAL.z + 0.6], 0.32, rnd);
  stone(w, [TREE_LOCAL.x - 0.5, treeY + 0.02, TREE_LOCAL.z + 1.1], 0.22, rnd);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(w.P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(w.N, 3));
  g.setAttribute('aSlot', new THREE.Float32BufferAttribute(w.S, 1));
  const uniforms = { ...shared, ...campU, uFireLocal: { value: FIRE_LOCAL.clone() } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: CAMP_VERT, fragmentShader: CAMP_FRAG, side: THREE.DoubleSide });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(site.x, site.y, site.z);
  mesh.rotation.y = yaw;
  mesh.frustumCulled = false;
  mesh.updateMatrixWorld(true);

  const fireWorld = FIRE_LOCAL.clone().applyMatrix4(mesh.matrixWorld);
  const glowU = { ...shared, ...campU, uOrigin: { value: fireWorld.clone().add(new THREE.Vector3(0, 0.35, 0)) }, uSize: { value: 2.2 } };
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), new THREE.ShaderMaterial({
    uniforms: glowU, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  glow.frustumCulled = false;
  glow.renderOrder = 6;

  const lampPos = new THREE.Vector3(0, TENT.lampY, 0).applyMatrix4(mesh.matrixWorld);
  const door = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
  return { mesh, glow, lampPos, door, fireWorld, tris: w.P.length / 9 };
}
