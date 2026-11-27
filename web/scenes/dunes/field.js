import { fbm, smooth } from '../../gl/common.js';

// ---------------------------------------------------------------------------------------------
// The desert's one height field, shared by the sand mesh, the camp and everything scattered on
// the dunes. Transverse dunes march downwind (toward +x, slightly away from the camera): a long
// gentle windward slope rises to a sharp brink, then the slip face drops at the angle of repose.
// The crest lines wander (domain warp) and the dunes grow and shrink (amplitude field). Under
// them a slow swell and, far off, big rounded draa ridges stack up toward the horizon.
//
// The sand shader rebuilds the dune profile per pixel from the interpolated dune phase, so the
// crests stay razor sharp however coarse the mesh is (see sand.js).
// ---------------------------------------------------------------------------------------------

export const LAMBDA = 160;            // crest spacing (m)
export const FC = 0.8;                // where the brink sits in the phase (windward 0..FC, slip FC..1)
export const TB = 0.7;                     // the slip face is a plane at the angle of repose down to TB, then an apron
const SA = 2 / (1 + TB), SC = SA / (2 * (1 - TB));
// Downwind points right and a little toward the camera, so the crests run away from the eye
// at a slant: lit windward flanks on their left, dark slip faces on their right.
const WA = 0.62;
export const WIND = { x: Math.cos(WA), z: Math.sin(WA) };
export const TENT_AZ = 0.12;          // the tent's bearing from the camera (rad, toward +x)

const P = { phase0: 0, ampNear: 1 };

function warpAt(x, z) {
  return (fbm(x * 0.0036 + 7.1, z * 0.0036 - 3.3, 3) - 0.5) * 1.3 + (fbm(x * 0.0095 + 1.3, z * 0.0095 + 8.8, 2) - 0.5) * 0.45;
}
export function phaseAt(x, z) {
  return (x * WIND.x + z * WIND.z) / LAMBDA + warpAt(x, z) + P.phase0;
}

// Dune height: big dunes in places, low sand sheets between. Far out the mesh is too coarse for
// 120 m dunes, so they give way to the big draa ridges in the base. Under the camera the
// amplitude is fixed so the shot works whatever the noise does.
export const SITE = { tx: 0, tz: 0, ty: 0, camY: 0 };
function ampAt(x, z) {
  const n = fbm(x * 0.0031 + 21.7, z * 0.0031 - 5.2, 3);
  const dc = Math.hypot(x, z);
  const a = (3 + 27 * Math.pow(smooth(0.34, 0.68, n), 1.3)) * (1 - 0.8 * smooth(500, 1400, dc));
  return a + (P.ampNear - a) * (1 - smooth(40, 160, dc));
}

export function profile(f) {
  if (f < FC) { const t = f / FC; return t * t * (2 - t); }
  const t = (f - FC) / (1 - FC);
  return t < TB ? 1 - SA * t : SC * (1 - t) * (1 - t);
}

function baseAt(x, z) {
  const d = Math.hypot(x, z);
  const swell = (fbm(x * 0.0011 + 3.7, z * 0.0011 - 9.1, 3) - 0.5) * 34;
  // Big rounded draa ridges far out, so the horizon is a stack of soft layers.
  const s2 = (x * 0.9 + z * 0.44) / 560 + (fbm(x * 0.0008 + 5.3, z * 0.0008 + 2.1, 2) - 0.5) * 1.8;
  const f2 = s2 - Math.floor(s2);
  const g = f2 < 0.66 ? smooth(0, 1, f2 / 0.66) * (0.85 + 0.15 * f2 / 0.66) : Math.pow(1 - (f2 - 0.66) / 0.34, 1.6);
  const draa = g * 42 * smooth(250, 1400, d) * (0.35 + fbm(x * 0.0007 - 4.4, z * 0.0007 + 6.6, 2));
  const hum = (fbm(x * 0.028 + 9.9, z * 0.028 - 1.7, 2) - 0.5) * 0.9;
  return swell + draa + hum;
}

// Flat pad under the tent and the fire.
const PAD_R0 = 5.5, PAD_R1 = 11;
export function padAt(x, z) {
  if (!SITE.ty) return 0;
  return 1 - smooth(PAD_R0, PAD_R1, Math.hypot(x - SITE.tx, z - SITE.tz));
}

function rawHeight(x, z) {
  const s = phaseAt(x, z);
  return baseAt(x, z) + ampAt(x, z) * profile(s - Math.floor(s));
}

export function heightAt(x, z) {
  const h = rawHeight(x, z);
  const w = padAt(x, z);
  return w > 0 ? h + (SITE.ty - h) * w : h;
}

// Everything the sand shader needs at one vertex: [phase, amplitude, dphase/dx, dphase/dz,
// damp/dx, damp/dz, dbase/dx, dbase/dz].
// With valuesOnly the gradients are left for the caller (the sand mesh takes them from its grid).
export function duneAttribs(x, z, out, k, valuesOnly = false) {
  const e = 0.5;
  const s = phaseAt(x, z), a = ampAt(x, z), b = baseAt(x, z);
  out[k] = s; out[k + 1] = a; out[k + 6] = b;
  if (valuesOnly) return b + a * profile(s - Math.floor(s));
  const sx = phaseAt(x + e, z), sz = phaseAt(x, z + e);
  const ax = ampAt(x + e, z), az = ampAt(x, z + e);
  const bx = baseAt(x + e, z), bz = baseAt(x, z + e);
  out[k + 2] = (sx - s) / e; out[k + 3] = (sz - s) / e;
  out[k + 4] = (ax - a) / e; out[k + 5] = (az - a) / e; out[k + 6] = (bx - b) / e; out[k + 7] = (bz - b) / e;
  return b + a * profile(s - Math.floor(s));
}

// Lay the site out: the camera on a brink, the tent low on the next windward slope.
export function layout({ eye = 1.65, tentDist = 90, tentAz = TENT_AZ, camPhase = 0.1, ampNear = 11, fMin = 0.015, fMax = 0.14, fWant = 0.05 } = {}) {
  P.phase0 = 0; P.ampNear = ampNear;
  SITE.tx = 0; SITE.tz = 0; SITE.ty = 0;
  // Put a brink right under the camera.
  const s0 = phaseAt(0, 0);
  P.phase0 = FC - camPhase - (s0 - Math.floor(s0));
  const camY = rawHeight(0, 0) + eye;
  // Search near the tent's bearing for a spot in the trough at the foot of a slip face, seen
  // clearly from the camera a few degrees below the horizon.
  let best = null;
  for (let az = tentAz - 0.45; az <= tentAz + 0.45; az += 0.01) {
    const sx = Math.sin(az), sz = -Math.cos(az);
    for (let d = 55; d < 170; d += 1) {
      const x = sx * d, z = sz * d;
      const s = phaseAt(x, z), f = s - Math.floor(s);
      if (f < fMin || f > fMax) continue;
      const y = rawHeight(x, z);
      const dep = Math.atan2(camY - y - 1.5, d);
      // The sand just in front of the door must be in view, not only the lamp.
      let clear = true;
      for (let k = 0.05; k < 0.9 && clear; k += 0.01) {
        if (rawHeight(x * k, z * k) > camY + (y + 0.2 - camY) * k - 0.25) clear = false;
      }
      if (!clear) continue;
      const score = Math.abs(d - tentDist) / 10 + Math.abs(az - tentAz) * 10 + Math.abs(dep - 0.085) * 60 + Math.abs(f - fWant) * 8;
      if (!best || score < best.score) best = { d, x, z, f, dep, az, score };
    }
  }
  if (!best) best = { d: tentDist, x: Math.sin(tentAz) * tentDist, z: -Math.cos(tentAz) * tentDist, dep: 0, none: true };
  SITE.tx = best.x; SITE.tz = best.z;
  SITE.ty = rawHeight(best.x, best.z);
  SITE.camY = camY;
  return { camY, tent: { x: best.x, y: SITE.ty, z: best.z, d: best.d, f: best.f, az: best.az, dep: best.dep, none: !!best.none } };
}
