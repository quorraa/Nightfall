import * as THREE from '../../vendor/three.module.min.js';
import { fbm, ridged, smooth, vnoise } from '../../gl/common.js';
import { GLSL_WORLD, deg } from '../../gl/world.js';
import { GLSL_SWELL } from './sea.js';

// ---------------------------------------------------------------------------------------------
// The coast's land: one signed "distance to the shore" field (positive on land) built from a few
// shapes (the shingle at the bay head, the right-hand shore, a headland running out to the
// lighthouse, the far coast under the mountains, skerries, an island), turned into heights by a
// low-shore or a cliff profile. One polar grid centred on the eye carries both the terrain and
// the sea, so the sea knows its depth and its distance to the shore at every vertex (foam).
// ---------------------------------------------------------------------------------------------

export const CAM = { x: 0, y: 3.2, z: 0 };
const polar = (azDeg, r) => [r * Math.sin(deg(azDeg)), -r * Math.cos(deg(azDeg))];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// The tower stands 10 m back from the tip of a headland that runs out from the right-hand
// shore; the cottage and its yard sit behind it. U runs up the spine, NB across it toward the
// bay (and the eye).
const [TX, TZ] = polar(12, 385);
const U = [0.946, 0.324];
const NB = [-U[1], U[0]];
const at = (a, b) => [TX + U[0] * a + NB[0] * b, TZ + U[1] * a + NB[1] * b];
// Spine from the tip back to the mainland: x, z, half-width.
const SPINE = [[...at(-10, 0), 20], [...at(30, -1), 25], [...at(90, 10), 36], [...at(170, 38), 52], [...at(262, 95), 85]];
const SPINE_LEN = [0];
for (let i = 1; i < SPINE.length; i++) SPINE_LEN.push(SPINE_LEN[i - 1] + Math.hypot(SPINE[i][0] - SPINE[i - 1][0], SPINE[i][1] - SPINE[i - 1][1]));
export const SITE = {
  x: TX, z: TZ,
  yaw: Math.atan2(-U[1], U[0]),                          // local +x runs up the spine, +z toward the bay
  u: U, nb: NB,
};
const PAD = { x: TX + U[0] * 6, z: TZ + U[1] * 6, r0: 18, r1: 27 };

// Sea stacks off the tip, and skerries scattered over the bay (x, z, radius, height).
export const STACKS = [
  { x: at(-46, -8)[0], z: at(-46, -8)[1], r: 6, h: 15, seed: 3 },
  { x: at(-68, 2)[0], z: at(-68, 2)[1], r: 3.4, h: 6.5, seed: 11 },
];
const SKERRIES = [
  [...polar(-3.5, 150), 5.5, 1.6], [...polar(-15, 96), 8, 2.4], [...polar(-26, 150), 13, 3.2],
  [...polar(-9, 235), 4.5, 1.2], [...polar(-34, 82), 6, 2.0], [...polar(-38, 210), 9, 2.6],
  ...STACKS.map((s) => [s.x, s.z, s.r * 0.85, 2.5]),
];
const ISLAND = { x: polar(-31, 2300)[0], z: polar(-31, 2300)[1], rx: 520, rz: 160, h: 55 };

function smax(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * h + k * h * (1 - h);
}

// Signed distance to the headland's outline, and how far along its spine the point lies.
let headAlong = 0;
function headland(x, z) {
  let best = -1e9;
  for (let i = 0; i < SPINE.length - 1; i++) {
    const [ax, az, ar] = SPINE[i], [bx, bz, br] = SPINE[i + 1];
    const dx = bx - ax, dz = bz - az;
    const t = clamp01(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz));
    const v = ar + (br - ar) * t - Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (v > best) { best = v; headAlong = SPINE_LEN[i] + (SPINE_LEN[i + 1] - SPINE_LEN[i]) * t; }
  }
  return best;
}

// Small integer hash for the boulder cells.
function hash2(i, j, k) {
  let x = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// Weathered boulders on a jittered 2.4 m grid: low, lumpy, each a random ellipse.
function boulders(x, z, density) {
  const S = 2.4, gx = Math.floor(x / S), gz = Math.floor(z / S);
  let h = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = gx + i, cz = gz + j;
    if (hash2(cx, cz, 1) > density) continue;
    const px = (cx + 0.25 + 0.5 * hash2(cx, cz, 2)) * S, pz = (cz + 0.25 + 0.5 * hash2(cx, cz, 3)) * S;
    const R = 0.45 + 0.85 * hash2(cx, cz, 4) ** 1.5;
    const a = hash2(cx, cz, 6) * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
    const asp = 1 + 0.8 * hash2(cx, cz, 7);
    const dx = x - px, dz = z - pz;
    const u = (dx * ca + dz * sa) / asp, v = -dx * sa + dz * ca;
    const lump = 0.75 + 0.5 * vnoise(x * 1.7 + cx, z * 1.7 + cz);
    const q = 1 - (u * u + v * v) / (R * R * lump);
    if (q > 0) h = Math.max(h, Math.pow(q, 0.85) * R * (0.4 + 0.3 * hash2(cx, cz, 5)));
  }
  return h;
}

// Signed distance to the shore (m, + on land), how cliff-like the shore is there, and how far
// along the headland's spine (for its rising crest).
const out = { s: 0, c: 0, h: 0, along: -1, rock: 0 };
function shore(x, z) {
  const r = Math.hypot(x, z), az = Math.atan2(x, -z);
  const zNear = -11 - (x < 0 ? 0.012 : 0.006) * x * x;
  let s = z - zNear;                                                   // bay head
  s = smax(s, 0.628 * (x - 12) + 0.778 * (z + 8), 10);                 // right-hand shore
  s = smax(s, r * smooth(deg(13), deg(30), az) - 1350, 40);            // far coast under the mountains
  const hd = headland(x, z);
  out.along = hd > s - 6 ? headAlong : -1;
  s = smax(s, hd, 14);
  const dPad = Math.hypot(x - PAD.x, z - PAD.z);
  const amp = smooth(22, 90, r) * (0.3 + 0.7 * smooth(22, 45, dPad));
  s += ((fbm(x * 0.022 + 3.1, z * 0.022 - 7.7, 3) - 0.5) * 20 + (fbm(x * 0.085, z * 0.085, 2) - 0.5) * 6) * amp;
  let c = smooth(30, 85, x + 0.3 * -z) * (1 - smooth(650, 1000, r));
  // Buttresses and gullies along the cliffs.
  s += (fbm(x * 0.075 + 9.1, z * 0.075 - 2.3, 3) - 0.5) * 9 * c * smooth(20, 60, r);
  // Skerries: low rocks out in the bay.
  for (const [kx, kz, kr] of SKERRIES) {
    const d = Math.hypot(x - kx, z - kz);
    if (d < kr * 2.2) {
      const sk = kr - d + (fbm(x * 0.3 + kx, z * 0.3, 2) - 0.5) * kr * 0.7;
      if (sk > s) { s = sk; c = 0; }
    }
  }
  const ix = (x - ISLAND.x) / ISLAND.rx, iz = (z - ISLAND.z) / ISLAND.rz;
  const si = (1 - Math.hypot(ix, iz)) * ISLAND.rz;
  if (si > s) { s = si; c = 0; }
  out.s = s;
  out.c = c;
  return out;
}

function rawHeight(x, z) {
  const { s, c, along } = shore(x, z);
  const r = Math.hypot(x, z), az = Math.atan2(x, -z);
  let h;
  out.rock = 0;
  if (s < 0) {
    h = -Math.min(14, -s * (0.09 + 0.7 * c));
  } else {
    // Cliffs: a steep face, then a rounded grassy brow rising to the crest. Out on the headland
    // the crest climbs from the tip toward the mainland.
    // The light stands on a low rock point; behind it the headland climbs into cliffs.
    const crest = along >= 0
      ? 3.3 + 15 * smooth(42, 70, along) + 14 * smooth(80, 220, along) + 0.04 * along
        + (7 * fbm(x * 0.02, z * 0.02, 3) + 5 * smooth(0.45, 0.7, fbm(x * 0.045 + 3, z * 0.045, 2))) * smooth(35, 90, along)
      : 20 + 12 * fbm(x * 0.012 + 5.3, z * 0.012 + 1.7, 3);
    const face = crest * (0.55 + 0.2 * fbm(x * 0.05 + 2, z * 0.05, 3));
    const cliff = face * smooth(0.3, 4.5, s) + (crest - face) * smooth(2, 30, s)
      + (fbm(x * 0.07, z * 0.07, 3) - 0.5) * 4 * smooth(3, 12, s);
    const low = 1.25 * smooth(0, 12, s) + 10 * smooth(10, 260, s);
    h = low + (cliff - low) * c;
    const hills = along >= 0 ? 110 * smooth(150, 300, along) : 30 + 80 * smooth(-60, 40, x);
    h += Math.pow(fbm(x * 0.004 + 11.3, z * 0.004 - 4.2, 4), 1.5) * hills * smooth(30, 420, s);
    if (x < 0) h += (fbm(x * 0.03, z * 0.03, 3) - 0.4) * 8 * smooth(10, 60, s);
    if (r > 1300) h += Math.pow(ridged(x * 0.0011 + 5.1, z * 0.0011 + 9.7, 5), 1.7) * 480 * smooth(1700, 2700, r) * smooth(0, 650, s) * smooth(deg(14), deg(30), az);
  }
  for (const [kx, kz, kr, kh] of SKERRIES) {
    const d = Math.hypot(x - kx, z - kz);
    if (d < kr * 1.6 && s > 0 && c === 0) h = Math.max(h, kh * smooth(0, kr * 0.8, s) * (0.7 + 0.6 * fbm(x * 0.4, z * 0.4, 2)));
  }
  if (s > -2 && c === 0 && r > 1500) {
    const ix = (x - ISLAND.x) / ISLAND.rx, iz = (z - ISLAND.z) / ISLAND.rz;
    const ie = 1 - Math.hypot(ix, iz);
    if (ie > 0) h = Math.max(h, ISLAND.h * smooth(0, 0.6, ie) * (0.5 + 0.8 * fbm(x * 0.004, z * 0.004, 3)));
  }
  // Boulders around the eye, thinner on the shingle in front.
  if (r < 95 && s > -6 && c < 0.6) {
    const beach = Math.exp(-(((x + 6) / 13) ** 2)) * smooth(-3, -7, z);
    const dens = 0.5 * (1 - 0.85 * beach) * (1 - smooth(55, 95, r));
    const b = boulders(x, z, dens) * (1 - c / 0.6);
    h += b;
    out.rock = smooth(0.02, 0.12, b);
  }
  out.h = h;
  return h;
}

const PAD_Y = Math.min(3.6, Math.max(2.6, rawHeight(PAD.x, PAD.z)));
SITE.y = PAD_Y;

export function heightAt(x, z) {
  const h = rawHeight(x, z);
  const w = (1 - smooth(PAD.r0, PAD.r1, Math.hypot(x - PAD.x, z - PAD.z))) * smooth(0, 4, out.s);
  return h + (PAD_Y - h) * w;
}

// ---------- Grid ----------
const AZ0 = deg(-47), AZ1 = deg(85);

export function buildGrid(low) {
  const NA = low ? 400 : 520;
  const radii = [];
  for (let r = 3; r < 3000; r += r < 700 ? Math.max(0.06, r * (low ? 0.018 : 0.014)) : r * 0.035) radii.push(r);
  radii.push(3000);
  const NR = radii.length - 1, W = NA + 1, nv = W * (NR + 1);
  const pos = new Float32Array(nv * 3), wpos = new Float32Array(nv * 3);
  const depth = new Float32Array(nv), shoreD = new Float32Array(nv), rock = new Float32Array(nv);
  for (let i = 0; i <= NA; i++) {
    const a = AZ0 + ((AZ1 - AZ0) * i) / NA, sx = Math.sin(a), sz = -Math.cos(a);
    for (let j = 0; j <= NR; j++) {
      const x = CAM.x + sx * radii[j], z = CAM.z + sz * radii[j];
      const k = j * W + i;
      const h = heightAt(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      wpos[k * 3] = x; wpos[k * 3 + 2] = z;
      depth[k] = -h;
      shoreD[k] = out.s;
      rock[k] = out.rock;
    }
  }
  const nor = new Float32Array(nv * 3);
  for (let j = 0; j <= NR; j++) {
    const jd = Math.max(j - 1, 0), ju = Math.min(j + 1, NR);
    for (let i = 0; i <= NA; i++) {
      const il = Math.max(i - 1, 0), ir = Math.min(i + 1, NA);
      const L = (j * W + il) * 3, R = (j * W + ir) * 3, D = (jd * W + i) * 3, Up = (ju * W + i) * 3;
      const ax = pos[R] - pos[L], ay = pos[R + 1] - pos[L + 1], az = pos[R + 2] - pos[L + 2];
      const rx = pos[Up] - pos[D], ry = pos[Up + 1] - pos[D + 1], rz = pos[Up + 2] - pos[D + 2];
      let nx = ay * rz - az * ry, ny = az * rx - ax * rz, nz = ax * ry - ay * rx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      const k = (j * W + i) * 3;
      nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
    }
  }
  // Land keeps cells that reach above the sea floor we can see; the sea keeps cells that reach
  // below the highest swash.
  const landIdx = [], seaIdx = [];
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    const ha = pos[a * 3 + 1], hb = pos[b * 3 + 1], hc = pos[c * 3 + 1], hd = pos[d * 3 + 1];
    if (Math.max(ha, hb, hc, hd) > -1.6) landIdx.push(a, c, b, b, c, d);
    if (Math.min(ha, hb, hc, hd) < 0.9) seaIdx.push(a, c, b, b, c, d);
  }
  const land = new THREE.BufferGeometry();
  land.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  land.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  land.setAttribute('aRock', new THREE.BufferAttribute(rock, 1));
  land.setIndex(new THREE.BufferAttribute(new Uint32Array(landIdx), 1));
  const sea = new THREE.BufferGeometry();
  sea.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
  sea.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  sea.setAttribute('aShore', new THREE.BufferAttribute(shoreD, 1));
  sea.setIndex(new THREE.BufferAttribute(new Uint32Array(seaIdx), 1));
  return { land, sea, verts: nv };
}

// ---------- Sea stacks ----------
function stackGeometry({ x, z, r: R, h: H, seed }) {
  const sides = 30, P = [], I = [];
  const rings = [];
  for (let y = -6; y < H - 1.2; y += 0.7) rings.push(y);
  const cap = [0.35, 0.65, 0.85, 0.97];
  for (const f of cap) rings.push(H - 1.2 + f * 1.2);
  rings.forEach((y, j) => {
    const yr = Math.min(1, Math.max(0, y / H));
    const capF = j >= rings.length - cap.length ? Math.sqrt(1 - cap[j - (rings.length - cap.length)] ** 2) : 1;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const bed = (y / 2.1) % 1;
      const notch = 1 - 0.07 * smooth(0.75, 1, bed < 0 ? bed + 1 : bed);
      const n = fbm(ca * 1.2 + seed + y * 0.09, sa * 1.2 + y * 0.04, 4);
      let rr = R * (0.55 + 0.95 * n) * notch * (1 - 0.3 * yr * yr) * (1 + 0.3 * (1 - smooth(-6, 1.5, y)));
      rr *= capF;
      const lean = 0.06 * y;
      P.push(x + ca * rr + lean, y, z + sa * rr - lean * 0.4);
    }
  });
  const nr = rings.length;
  for (let j = 0; j < nr - 1; j++) for (let k = 0; k < sides; k++) {
    const a = j * sides + k, b = j * sides + ((k + 1) % sides), c = a + sides, d = b + sides;
    I.push(a, c, b, b, c, d);
  }
  const top = P.length / 3;
  P.push(x, H + 0.1, z);
  for (let k = 0; k < sides; k++) I.push((nr - 1) * sides + k, top, (nr - 1) * sides + ((k + 1) % sides));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aRock', new THREE.Float32BufferAttribute(new Float32Array(P.length / 3), 1));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

// ---------- Shaders ----------
const LAND_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aRock;
varying vec3 vW, vN;
varying float vRock;
void main(){
  vW = position; vN = normal; vRock = aRock;
  gl_Position = mirrorProject(position);
}`;

const LAND_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_SWELL}
uniform float uDebug;
varying vec3 vW, vN;
varying float vRock;

// Squared distance to the nearest jittered cell centre: rounded pebbles on the shingle.
float pebbles(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float d = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 g = vec2(float(x), float(y));
    vec2 r = g + hash22(i + g) * .8 + .1 - f;
    d = min(d, dot(r, r));
  }
  return d;
}

void main(){
  if (uMirror < 0. && vW.y < -.05) discard;
  if (vW.y < -1.6){ gl_FragColor = vec4(0., 0., 0., 1.); return; }   // under the opaque sea
  vec3 n = normalize(vN);
  float range = length(vW.xz - cameraPosition.xz);
  float farW = smoothstep(350., 900., range) * smoothstep(.12, .4, 1. - n.y);
  if (farW > .001){
    vec2 q = vW.xz * .016;
    float h0 = fbm3(q);
    vec2 gr = vec2(fbm3(q + vec2(.04, 0.)) - h0, fbm3(q + vec2(0., .04)) - h0) / .04;
    n = normalize(n + vec3(-gr.x, 0., -gr.y) * .55 * farW);
  }
  float nz = fbm(vW.xz * .045);
  float nz2 = vnoise(vW.xz * .55 + vW.y * .3);
  // Weathered pits and cracks on the boulders near the eye.
  if (vRock > .01 && range < 70.){
    vec2 q = vW.xz * 2.6 + vW.y * 1.3;
    float b0 = fbm3(q);
    vec2 gb = vec2(fbm3(q + vec2(.06, 0.)) - b0, fbm3(q + vec2(0., .06)) - b0) / .06;
    n = normalize(n - vec3(gb.x, 0., gb.y) * .22 * vRock);
  }
  float slope0 = 1. - n.y;

  // Bedding planes and vertical joints: the cliffs break into ledges and buttresses.
  float bed = vW.y * .34 + (fbm3(vW.xz * .03) - .5) * 1.6;
  float bf = fract(bed);
  float ledge = smoothstep(0., .12, bf) * (1. - smoothstep(.72, 1., bf));
  float joint = vnoise(vec2((vW.x - vW.z) * .22, vW.y * .05 + floor(bed) * 3.1));
  float steep = smoothstep(.3, .65, slope0) * (1. - smoothstep(300., 900., range));
  vec3 side = normalize(vec3(n.x, 0., n.z) + 1e-4);
  vec3 tang = vec3(-side.z, 0., side.x);
  n = normalize(n + (vec3(0., (bf - .55) * .6, 0.) + tang * (joint - .5) * .9) * steep);
  float slope = 1. - n.y;

  vec3 grass = mix(vec3(.030, .038, .026), vec3(.056, .056, .038), nz);
  vec3 heather = vec3(.048, .033, .042) * (.8 + .4 * nz2);
  vec3 veg = mix(grass, heather, smoothstep(.42, .66, fbm3(vW.xz * .02 + 4.)));
  float big = fbm3(vec2((vW.x - vW.z) * .045, vW.y * .09));
  vec3 rock = mix(vec3(.044, .045, .052), vec3(.118, .112, .108), clamp(nz2 * .3 + joint * .35 + big * .6 - .1, 0., 1.)) * mix(.72, 1.02, ledge);
  rock *= mix(.55, 1., smoothstep(.5, 4., vW.y));                 // dark, weed-stained foot
  float rk = max(smoothstep(.26, .5, slope0 + (nz - .5) * .3), vRock);
  // Grey-green lichen on the boulders.
  rock = mix(rock, vec3(.08, .085, .06), vRock * smoothstep(.55, .8, vnoise(vW.xz * 3.1 + vW.y * 2.)) * .7);
  vec3 alb = mix(veg, rock, rk);

  // Shingle at the bay head.
  float beach = (1. - smoothstep(1.3, 2.4, vW.y + (nz - .5))) * (1. - smoothstep(.2, .45, slope0)) * (1. - smoothstep(50., 110., range)) * (1. - vRock);
  if (beach > .01){
    float pb = range < 45. ? pebbles(vW.xz * 7.) : .3;
    float stone = 1. - smoothstep(.12, .45, pb);
    vec3 sh = mix(vec3(.030, .030, .032), vec3(.10, .098, .094) * (.75 + .5 * hash12(floor(vW.xz * 7.))), stone);
    alb = mix(alb, sh, beach);
  }

  // The swash: wet stone, wrack and seaweed a little above the moving water, foam lace at its edge.
  float eta = swellH(vW.xz) * .6;
  float above = vW.y - eta;
  float wet = 1. - smoothstep(0., .9, above);
  alb = mix(alb, vec3(.026, .024, .012) * (.7 + .6 * nz2), (1. - smoothstep(.1, .8, vW.y + (nz2 - .5) * .4)) * rk * .85);
  alb *= 1. - .5 * wet;
  float lace = smoothstep(.42, .7, fbm3(vW.xz * 1.6 + vec2(uTime * .05, uTime * .02)));
  float foam = (1. - smoothstep(0., .04 + .1 * lace + range * .0025, above)) * mix(lace, .6, smoothstep(40., 200., range)) * (1. - smoothstep(500., 900., range));
  // Swell breaking against the cliffs and stacks: white water thrown up the rock as each crest
  // arrives, sliding back down as it passes.
  float sw = swellH(vW.xz) / max(uSwell[0].w + uSwell[1].w + uSwell[2].w, 1e-3);
  float splashH = (.4 + 2.2 * smoothstep(-.1, .9, sw)) * (.6 + .8 * fbm3(vW.xz * .09 + vec2(0., uTime * .03)));
  float splash = (1. - smoothstep(splashH * .3, splashH, above)) * smoothstep(.3, .6, slope0) * smoothstep(60., 150., range)
               * (1. - smoothstep(700., 1200., range)) * smoothstep(.3, .6, vnoise(vec2((vW.x - vW.z) * .25, vW.y * .8 - uTime * .4)) + .25);
  foam = max(foam, splash * .8);

  float snowLine = 430. + (fbm3(vW.xz * .004) - .5) * 160.;
  float snow = smoothstep(snowLine - 40., snowLine + 40., vW.y + (nz2 - .5) * 30.) * smoothstep(.4, .66, n.y);
  alb = mix(alb, vec3(.78, .82, .92), snow);

  float K = max(dot(n, uKeyDir), 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.5 + .5 * n.y)) + alb * lampLight(vW, n);
  vec3 V = normalize(cameraPosition - vW);
  col += wet * uMoonCol * .3 * pow(max(dot(reflect(-V, n), uMoonDir), 0.), 28.);
  vec3 foamCol = vec3(.72, .78, .88) * (uMoonCol * (.45 + .55 * K) + uSkyAmb * 2.);
  col = mix(col, foamCol, foam * .85);
  if (uDebug > .5) col = vec3(rk, beach, wet) * .2;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

export function createLand(shared, swellU, { low = false, debug = '' } = {}) {
  const t0 = performance.now();
  const grid = buildGrid(low);
  const uniforms = { ...shared, ...swellU, uDebug: { value: debug === 'land' ? 1 : 0 } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: LAND_VERT, fragmentShader: LAND_FRAG, side: THREE.DoubleSide });
  const group = new THREE.Group();
  const terrain = new THREE.Mesh(grid.land, mat);
  terrain.frustumCulled = false;
  terrain.renderOrder = 2;
  group.add(terrain);
  const stacks = STACKS.map((s) => {
    const m = new THREE.Mesh(stackGeometry(s), mat);
    m.frustumCulled = false;
    m.renderOrder = 1;
    group.add(m);
    return m;
  });
  return {
    group, terrain, stacks, seaGeometry: grid.sea,
    stats: { landMs: Math.round(performance.now() - t0), gridVerts: grid.verts, landTris: grid.land.index.count / 3, seaTris: grid.sea.index.count / 3 },
  };
}
