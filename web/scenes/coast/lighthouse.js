import * as THREE from '../../vendor/three.module.min.js';
import { GLSL_WORLD } from '../../gl/world.js';

// ---------------------------------------------------------------------------------------------
// The lighthouse: a white tapered tower with a black gallery and lantern, a keeper's cottage and
// a whitewashed yard wall, written as one slot-tagged mesh in a local frame (+x up the headland,
// +z toward the bay, y = 0 the yard). The lantern's two opposed beams are open cones whose
// shader integrates in-scattered light across the view ray analytically (a Gaussian tube that
// widens and fades with distance, brighter toward the eye by a forward-scattering phase), and a
// soft glow at the lantern flares briefly each time a beam swings past the eye.
// ---------------------------------------------------------------------------------------------

// The tower is kept short and stands low on the point so the lantern stays within about 3 degrees
// of the horizon: on a phone held sideways anything higher sits behind the clock.
const TOWER_H = 16;
const DY = TOWER_H - 20;                     // the gallery and lantern were drawn for a 20 m tower
export const LANTERN_Y = 22.25 + DY;        // lantern centre above the yard
const towerR = (y) => 2.0 + 0.85 * Math.pow(1 - Math.min(1, Math.max(0, y / TOWER_H)), 1.6);

function lighthouseGeometry() {
  const P = [], N = [], UV = [], S = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const push = (p, n, uv, s) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); UV.push(uv[0], uv[1]); S.push(s); };

  function face(pts, slot, inside, uvs) {
    let n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
    if (inside && dot(n, sub(c, inside)) < 0) n = [-n[0], -n[1], -n[2]];
    const uv = (i) => (uvs ? uvs[i] : [pts[i][0] + pts[i][2], pts[i][1]]);
    for (let i = 1; i + 1 < pts.length; i++) { push(pts[0], n, uv(0), slot); push(pts[i], n, uv(i), slot); push(pts[i + 1], n, uv(i + 1), slot); }
  }
  function prism(b, off, slot) {
    const t = b.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
    const c = [0, 1, 2].map((k) => (b.reduce((s, p) => s + p[k], 0) + t.reduce((s, p) => s + p[k], 0)) / 8);
    face(b, slot, c); face(t, slot, c);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face([b[i], b[j], t[j], t[i]], slot, c); }
  }
  const box = (x0, y0, z0, x1, y1, z1, slot) => prism([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, y1 - y0, 0], slot);
  // Surface of revolution about the tower axis from a [radius, y] profile.
  function lathe(prof, slot, sides = 32) {
    for (let s = 0; s + 1 < prof.length; s++) {
      const [r0, y0] = prof[s], [r1, y1] = prof[s + 1];
      const dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
      const nr = dy / l, ny = -dr / l;
      for (let k = 0; k < sides; k++) {
        const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
        const q = [[r0, y0, a0], [r1, y1, a0], [r1, y1, a1], [r0, y0, a1]].map(([r, y, a]) => ({
          p: [Math.cos(a) * r, y, Math.sin(a) * r], n: [Math.cos(a) * nr, ny, Math.sin(a) * nr], uv: [a / (Math.PI * 2), y],
        }));
        for (const i of [0, 1, 2, 0, 2, 3]) push(q[i].p, q[i].n, q[i].uv, slot);
      }
    }
  }

  // Tower, on a stone plinth.
  const up = (prof) => prof.map(([r, y]) => [r, y + DY]);
  lathe([[3.4, -0.8], [3.4, 0.9], [2.9, 0.95]], 3, 28);
  const prof = [];
  for (let y = 0.9; y <= TOWER_H - 0.99; y += 1.3) prof.push([towerR(y), y]);
  prof.push([towerR(TOWER_H - 1), TOWER_H - 1], ...up([[2.25, 19.45], [2.7, 19.8], [3.05, 20.0]]));
  lathe(prof, 0, 32);
  lathe(up([[3.05, 20.0], [3.1, 20.32], [2.05, 20.36]]), 1, 32);           // gallery deck
  lathe(up([[2.05, 20.32], [2.05, 21.05], [1.9, 21.1]]), 1, 24);           // lantern base
  lathe(up([[1.9, 21.1], [1.9, 23.45]]), 2, 24);                           // glazing
  lathe(up([[1.9, 23.45], [2.18, 23.55], [2.05, 23.85], [1.65, 24.4], [1.05, 24.85], [0.45, 25.12], [0.12, 25.2]]), 1, 24);
  lathe(up([[0.12, 25.2], [0.36, 25.3], [0.4, 25.5], [0.3, 25.7], [0.06, 25.78]]), 1, 10);   // ventilator
  lathe(up([[0.05, 25.78], [0.04, 26.7]]), 1, 4);                           // lightning rod

  // Small windows up the bay side of the tower.
  for (const [y, a] of [[4.2, 1.35], [8.4, 1.65], [12.6, 1.4]]) {
    const r = towerR(y) + 0.03, ca = Math.cos(a), sa = Math.sin(a), tx = -sa, tz = ca;
    const w = 0.32, hh = 0.55;
    face([[ca * r - tx * w, y - hh, sa * r - tz * w], [ca * r + tx * w, y - hh, sa * r + tz * w],
      [ca * r + tx * w, y + hh, sa * r + tz * w], [ca * r - tx * w, y + hh, sa * r - tz * w]], 6, [0, y, 0]);
  }
  { // Door toward the cottage.
    const r = towerR(1.5) + 0.03, w = 0.55;
    face([[r, 0.9, -w], [r, 0.9, w], [r, 3.0, w], [r, 3.0, -w]], 6, [0, 2, 0]);
  }

  // Keeper's cottage: long side to the bay, chimneys on both gables.
  const CX = 13, CZ = 4.2, W2 = 5, D2 = 2.7, EAVE = 2.9, RIDGE = 5.0;
  box(CX - W2, -0.6, CZ - D2, CX + W2, EAVE, CZ + D2, 0);
  const inside = [CX, 1.5, CZ];
  for (const x of [CX - W2, CX + W2]) face([[x, EAVE, CZ - D2], [x, EAVE, CZ + D2], [x, RIDGE, CZ]], 0, inside);
  const pitch = Math.atan2(RIDGE - EAVE, D2), ov = 0.35, th = 0.16;
  for (const s of [-1, 1]) {
    const ez = CZ + s * (D2 + ov), ey = EAVE - ov * Math.tan(pitch);
    prism([[CX - W2 - 0.15, RIDGE, CZ], [CX + W2 + 0.15, RIDGE, CZ], [CX + W2 + 0.15, ey, ez], [CX - W2 - 0.15, ey, ez]],
      [0, th * Math.cos(pitch), s * th * Math.sin(pitch)], 4);
  }
  for (const x of [CX - W2 + 0.45, CX + W2 - 0.45]) {
    box(x - 0.45, EAVE, CZ - 0.6, x + 0.45, RIDGE + 1.0, CZ + 0.6, 0);
    box(x - 0.52, RIDGE + 1.0, CZ - 0.67, x + 0.52, RIDGE + 1.12, CZ + 0.67, 3);
    for (const dz of [-0.25, 0.25]) box(x - 0.1, RIDGE + 1.12, CZ + dz - 0.1, x + 0.1, RIDGE + 1.4, CZ + dz + 0.1, 3);
  }
  const GLASS = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const zf = CZ + D2 + 0.03;
  for (const x of [CX - 3.3, CX + 1.4, CX + 3.5]) {
    face([[x - 0.45, 1.0, zf], [x + 0.45, 1.0, zf], [x + 0.45, 2.2, zf], [x - 0.45, 2.2, zf]], 5, inside, GLASS);
    box(x - 0.55, 0.9, zf - 0.03, x + 0.55, 1.0, zf + 0.1, 3);
  }
  face([[CX - 1.4, 0, zf], [CX - 0.5, 0, zf], [CX - 0.5, 2.1, zf], [CX - 1.4, 2.1, zf]], 6, inside);
  // A small window in the far gable too, seen past the tower from the left.
  face([[CX - W2 - 0.03, 1.1, CZ - 0.4], [CX - W2 - 0.03, 1.1, CZ + 0.4], [CX - W2 - 0.03, 2.1, CZ + 0.4], [CX - W2 - 0.03, 2.1, CZ - 0.4]], 5, inside, GLASS);

  // The yard wall.
  const X0 = -10.5, X1 = 23.5, Z0 = -10.5, Z1 = 11.5, T = 0.25, H = 1.3;
  box(X0 - T, -0.8, Z0 - T, X1 + T, H, Z0 + T, 0);
  box(X0 - T, -0.8, Z1 - T, X1 + T, H, Z1 + T, 0);
  box(X0 - T, -0.8, Z0 + T, X0 + T, H, Z1 - T, 0);
  box(X1 - T, -0.8, Z0 + T, X1 + T, H, Z1 - T, 0);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('aSlot', new THREE.Float32BufferAttribute(S, 1));
  return g;
}

const LH_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aSlot;
varying vec3 vW, vN, vL;
varying vec2 vUv;
varying float vSlot;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz; vL = position; vN = mat3(modelMatrix) * normal;
  vUv = uv; vSlot = aSlot;
  gl_Position = mirrorProject(w.xyz);
}`;

const LH_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform float uFlare;
uniform vec3 uBeamDir;
varying vec3 vW, vN, vL;
varying vec2 vUv;
varying float vSlot;
void main(){
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  int slot = int(vSlot + .5);
  vec3 alb = vec3(.1), emit = vec3(0.);
  float spec = 0.;
  if (slot == 0) {                                   // whitewash
    float streak = vnoise(vec2(vL.x * 3. + vL.z * 3., vL.y * .25)) * .5 + vnoise(vL.xz * 9. + vL.y * .7) * .5;
    alb = vec3(.60, .60, .58) * (.86 + .14 * streak) * mix(.78, 1., smoothstep(-.5, 2.5, vL.y));
  } else if (slot == 1) {                            // black paint and copper
    alb = vec3(.022, .022, .024); spec = .7;
  } else if (slot == 2) {                            // lantern glazing: the lens and lamp inside
    float a = vUv.x * 6.2831853;
    vec2 fw = fwidth(vUv) * vec2(1., 1.) + 1e-4;
    // Diagonal astragals, as on many northern lanterns.
    float diag = abs(fract((vUv.x * 12. + (vUv.y - ${(21.1 + DY).toFixed(2)}) * 1.1)) - .5);
    float bars = 1. - smoothstep(.05, .05 + fw.x * 14., diag);
    float lens = exp(-pow((vUv.y - ${LANTERN_Y.toFixed(2)}) / .55, 2.));
    // Brightest where a beam's lens panel faces the eye.
    vec3 radial = vec3(cos(a), 0., sin(a));
    vec3 lamp = vec3(1., .78, .52) * (3.2 + 2.2 * lens + uFlare * 40. * lens);
    emit = lamp * (1. - bars * .8) * uLamp;
    alb = vec3(.02);
    float F = .04 + .96 * pow(1. - max(dot(n, V), 0.), 5.);
    emit += uHaze * 1.2 * F;
  } else if (slot == 3) {                            // dressed stone
    alb = vec3(.20, .195, .19) * (.8 + .3 * vnoise(vL.xy * 4. + vL.z * 3.));
  } else if (slot == 4) {                            // slate
    float row = fract(vL.y / .2);
    alb = vec3(.04, .042, .05) * (.7 + .3 * smoothstep(0., .2, row)) * (.85 + .3 * hash12(floor(vec2(vL.x / .3, vL.y / .2))));
    spec = .4;
  } else if (slot == 5) {                            // cottage windows
    vec2 uv = vUv;
    vec2 fw = fwidth(uv) * 1.2 + 1e-4;
    float bar = max(1. - smoothstep(.05 - fw.x, .05 + fw.x, abs(uv.x - .5)), 1. - smoothstep(.04 - fw.y, .04 + fw.y, abs(uv.y - .5)));
    emit = vec3(1., .6, .3) * 3. * (.8 + .3 * (1. - uv.y)) * (1. - bar) * uLamp;
    alb = vec3(.02);
  } else {                                           // dark openings
    alb = vec3(.012, .012, .014);
  }
  float K = max(dot(n, uKeyDir), 0.);
  vec3 col = alb * (uMoonCol * K + uSkyAmb * (.55 + .45 * n.y)) + alb * lampLight(vW, n);
  col += spec * uMoonCol * pow(max(dot(reflect(-V, n), uMoonDir), 0.), 30.) * 1.2;
  col += emit;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

// ---------- Gallery railing: a thin dark veil with a solid handrail ----------
const RAIL_FRAG = /* glsl */ `
${GLSL_WORLD}
varying vec3 vW, vN, vL;
varying vec2 vUv;
varying float vSlot;
void main(){
  float y = vUv.y;
  float rail = step(${(21.12 + DY).toFixed(2)}, y);
  float posts = step(.86, fract(vUv.x * 40.));
  float a = max(rail, max(posts * .9, .32));
  vec3 col = vec3(.012) + vec3(1., .7, .45) * uLamp * .05 * (1. - rail);
  gl_FragColor = vec4(applyHaze(col, vW), a);
}`;

// ---------- Beams ----------
const BEAM_LEN = 1100, BEAM_R0 = 0.9, BEAM_SPREAD = 0.034, BEAM_COVER = 2.6;

function beamGeometry() {
  const P = [], SIDE = [], I = [];
  const seg = 24, rings = 10;
  for (const side of [1, -1]) {
    const base = P.length / 3;
    for (let j = 0; j <= rings; j++) {
      const t = BEAM_LEN * Math.pow(j / rings, 1.6);
      const r = BEAM_COVER * (BEAM_R0 + t * BEAM_SPREAD);
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        P.push(side * t, Math.cos(a) * r, Math.sin(a) * r);
        SIDE.push(side);
      }
    }
    for (let j = 0; j < rings; j++) for (let k = 0; k < seg; k++) {
      const a = base + j * seg + k, b = base + j * seg + ((k + 1) % seg), c = a + seg, d = b + seg;
      I.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(SIDE, 1));
  g.setIndex(I);
  return g;
}

const BEAM_VERT = /* glsl */ `
${GLSL_WORLD}
attribute float aSide;
varying vec3 vW;
varying float vSide;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz; vSide = aSide;
  gl_Position = mirrorProject(w.xyz);
}`;

const BEAM_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform vec3 uA, uD, uBeamCol;
uniform float uBeamGain;
varying vec3 vW;
varying float vSide;
void main(){
  // One fragment per pixel: the near side of the cone (winding flips in the mirror pass).
  bool near = uMirror > 0. ? gl_FrontFacing : !gl_FrontFacing;
  if (!near) discard;
  vec3 O = vec3(cameraPosition.x, cameraPosition.y * uMirror, cameraPosition.z);
  vec3 R = normalize(vW - O);
  vec3 D = uD * vSide;
  vec3 w0 = O - uA;
  float b = dot(R, D), d = dot(R, w0), e = dot(D, w0);
  float den = max(1. - b * b, 1e-5);
  float s = max((b * e - d) / den, 0.);
  float t = max((e - b * d) / den, 0.);
  vec3 q = O + R * s - (uA + D * t);
  float r = ${BEAM_R0.toFixed(2)} + t * ${BEAM_SPREAD.toFixed(4)};
  // Light crossing a Gaussian tube: profile across, path length through it, power spread
  // over its cross-section. The path length is capped for rays running along the beam.
  float sinT = sqrt(den);
  float dens = exp(-dot(q, q) / (r * r)) / (r * max(sinT, r / 220.));
  // Forward scattering in the sea haze: brighter as the beam swings toward the eye.
  float phase = 1.25 / (1.25 - clamp(-b, -1., 1.) * .95);
  float atten = exp(-t / 650.) * smoothstep(0., 4., t);
  float patchy = .55 + .9 * fbm3(vec2(t * .011 - uTime * .025, vSide * 5.3 + q.y * .04));
  float fog = exp(-s * .0009);
  vec3 col = uBeamCol * (uLamp * uBeamGain * dens * phase * atten * patchy * fog);
  gl_FragColor = vec4(col, 1.);
}`;

// ---------- Glow and flare around the lantern ----------
const GLOW_VERT = /* glsl */ `
${GLSL_WORLD}
uniform vec3 uCenter;
uniform float uSize;
varying vec2 vQ;
void main(){
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 c = uCenter + normalize(cameraPosition - uCenter) * 5.;
  vec3 w = c + (right * position.x + up * position.y * uMirror) * uSize;
  vQ = position.xy;
  gl_Position = mirrorProject(w);
}`;

const GLOW_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform float uFlare;
uniform vec3 uCenter;
varying vec2 vQ;
void main(){
  vec2 q = vQ;
  float r2 = dot(q, q);
  float halo = exp(-r2 * 60.) * .7 + exp(-r2 * 9.) * .05;
  float flare = exp(-r2 * 140.) * 6. + exp(-r2 * 14.) * .35 + exp(-q.y * q.y * 900.) * exp(-abs(q.x) * 3.) * .25;
  vec3 col = vec3(1., .8, .56) * uLamp * (halo + flare * uFlare);
  float fog = exp(-length(uCenter - cameraPosition) * .0006);
  gl_FragColor = vec4(col * fog, 1.);
}`;

export function createLighthouse(shared, site, { reducedMotion = false } = {}) {
  const group = new THREE.Group();
  const extra = { uFlare: { value: 0 }, uBeamDir: { value: new THREE.Vector3(1, 0, 0) } };

  const mat = new THREE.ShaderMaterial({ uniforms: { ...shared, ...extra }, vertexShader: LH_VERT, fragmentShader: LH_FRAG, side: THREE.DoubleSide });
  mat.extensions = { derivatives: true };
  const body = new THREE.Mesh(lighthouseGeometry(), mat);
  body.position.set(site.x, site.y, site.z);
  body.rotation.y = site.yaw;
  body.frustumCulled = false;
  body.updateMatrixWorld(true);
  group.add(body);

  // Railing veil.
  const railGeo = new THREE.CylinderGeometry(3.0, 3.0, 0.95, 40, 1, true).translate(0, 20.32 + DY + 0.475, 0);
  const ry = railGeo.attributes.position, ruv = railGeo.attributes.uv;
  for (let i = 0; i < ry.count; i++) ruv.setY(i, ry.getY(i));
  railGeo.setAttribute('aSlot', new THREE.Float32BufferAttribute(new Float32Array(ry.count), 1));
  const rail = new THREE.Mesh(railGeo, new THREE.ShaderMaterial({
    uniforms: { ...shared }, vertexShader: LH_VERT, fragmentShader: RAIL_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  rail.position.copy(body.position);
  rail.rotation.y = site.yaw;
  rail.frustumCulled = false;
  rail.renderOrder = 4;
  group.add(rail);

  const lantern = new THREE.Vector3(0, LANTERN_Y, 0).applyMatrix4(body.matrixWorld);

  // Beams.
  const beamU = {
    ...shared,
    uA: { value: lantern.clone() },
    uD: { value: new THREE.Vector3(1, 0, 0) },
    uBeamCol: { value: new THREE.Vector3(1, 0.84, 0.64) },
    uBeamGain: { value: 0.07 },
  };
  const beams = new THREE.Mesh(beamGeometry(), new THREE.ShaderMaterial({
    uniforms: beamU, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  beams.position.copy(lantern);
  beams.frustumCulled = false;
  beams.renderOrder = 6;
  group.add(beams);

  // Glow.
  const glowU = { ...shared, uCenter: { value: lantern.clone() }, uSize: { value: 26 }, uFlare: extra.uFlare };
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: glowU, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  glow.frustumCulled = false;
  glow.renderOrder = 7;
  group.add(glow);

  // One sweep every 15 s. Held where both beams cross the view when motion is reduced.
  const SWEEP = (Math.PI * 2) / 15;
  const toCam = new THREE.Vector2();
  let angle = 0;
  const camAz = Math.atan2(-lantern.z, -lantern.x);          // beam angle that points at the eye
  const rest = camAz + 0.4;

  return {
    group, body, beams, glow, lantern,
    stats: { lighthouseTris: body.geometry.attributes.position.count / 3 },
    update(t, camPos) {
      angle = reducedMotion ? rest : rest - 0.25 + t * SWEEP;
      const dx = Math.cos(angle), dz = Math.sin(angle);
      beamU.uD.value.set(dx, -0.004, dz).normalize();
      beams.rotation.set(0, -angle, 0);
      beams.rotation.z = -0.004;
      extra.uBeamDir.value.copy(beamU.uD.value);
      // Flare: how squarely either beam faces the eye (horizontally).
      toCam.set(camPos.x - lantern.x, camPos.z - lantern.z).normalize();
      const c = Math.abs(dx * toCam.x + dz * toCam.y);
      const off = Math.acos(Math.min(1, c));
      extra.uFlare.value = Math.exp(-((off / 0.075) ** 2));
    },
  };
}
