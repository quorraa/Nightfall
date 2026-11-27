import * as THREE from '../../vendor/three.module.min.js';
import { GLSL_WORLD, deg } from '../../gl/world.js';
import { FC, TB, LAMBDA, WIND, duneAttribs, padAt, SITE } from './field.js';
import { GLSL_CAMP } from './camplight.js';

// ---------------------------------------------------------------------------------------------
// Sand: a polar grid centred on the camera (dense near, sparse far). Each vertex carries the
// dune phase, the amplitude and the gradients of phase, amplitude and the base swell, so the
// fragment shader rebuilds the slope of the dune profile per pixel: brinks stay sharp at any
// mesh density, and the brink is widened to the pixel footprint so it never crawls.
// Wind ripples are a procedural normal faded out before they reach the pixel size.
// ---------------------------------------------------------------------------------------------

const SAND_VERT = /* glsl */ `
${GLSL_WORLD}
attribute vec4 aD0;      // phase, amplitude, dphase/dx, dphase/dz
attribute vec4 aD1;      // damp/dx, damp/dz, dbase/dx, dbase/dz
attribute float aPad;
varying vec3 vW;
varying vec4 vD0, vD1;
varying float vPad;
void main(){
  vW = position; vD0 = aD0; vD1 = aD1; vPad = aPad;
  gl_Position = mirrorProject(position);
}`;

const SAND_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_CAMP}
uniform float uDebug;
uniform vec2 uWind;
varying vec3 vW;
varying vec4 vD0, vD1;
varying float vPad;
#define FC ${FC.toFixed(3)}
#define LAMBDA ${LAMBDA.toFixed(1)}

#define TB ${TB.toFixed(3)}
#define SA ${(2 / (1 + TB)).toFixed(5)}
#define SC ${(1 / (1 - TB * TB)).toFixed(5)}
float prof(float f){
  if (f < FC){ float t = f / FC; return t * t * (2. - t); }
  float t = (f - FC) / (1. - FC);
  return t < TB ? 1. - SA * t : SC * (1. - t) * (1. - t);
}
float dWind(float f){ float t = min(f, FC) / FC; return (4. * t - 3. * t * t) / FC; }
float dSlip(float f){
  float t = (max(f, FC) - FC) / (1. - FC);
  return (t < TB ? -SA : -2. * SC * (1. - t)) / (1. - FC);
}

void main(){
  float s = vD0.x, H = vD0.y;
  vec2 ds = vD0.zw;
  float f = fract(s);
  // Brink width: at least ~0.6 m, or the pixel footprint in phase.
  float fw = max(fwidth(s) * .75, .6 / LAMBDA);
  float slip = smoothstep(-fw, fw, f - FC);
  float P = prof(f);
  float dP = mix(dWind(f), dSlip(f), slip);
  vec2 g = vD1.zw + P * vD1.xy + H * dP * ds;
  g *= 1. - vPad;
  vec3 n0 = normalize(vec3(-g.x, 1., -g.y));
  vec3 n = n0;

  // Wind ripples on the windward slopes and the flats (none on the slip faces), crossing the
  // wind, gently sinuous. Faded by the pixel footprint so the far sand stays still.
  vec2 p = vW.xz;
  vec2 wd = normalize(ds + vec2(1e-5));
  vec2 cr = vec2(-wd.y, wd.x);
  float rw = vnoise(p * .21) * 1.6 + vnoise(vec2(dot(p, cr) * .9, dot(p, wd) * .12)) * .5;
  float rp = dot(p, wd) / .62 + rw;
  float fr = fwidth(rp);
  float rippleAmt = (1. - slip) * (1. - vPad * .7) * clamp(1.5 - fr * 3., 0., 1.) * (.55 + .45 * vnoise(p * .05));
  float ph = rp * 6.2831;
  float rs = cos(ph + .55 * sin(ph)) * (1. + .55 * cos(ph));     // asymmetric: steep lee, long stoss
  n = normalize(n + vec3(wd.x, 0., wd.y) * rs * .16 * rippleAmt);

  // Moon shadow cast by the brink just upwind (the dune profile is known, so this is one test).
  vec3 Lk = uKeyDir;
  vec2 lh = normalize(Lk.xz);
  float tanEl = Lk.y / max(length(Lk.xz), 1e-3);
  float dph = f >= FC ? f - FC : f + 1. - FC;
  float gs = max(length(ds), 1e-4);
  float Dw = dph / gs;                                      // metres along the wind to the brink
  float along = max(dot(lh, -wd), .25);
  float drop = H * (1. - P);
  float clear = Dw / along * tanEl - drop;
  float sh = smoothstep(-.6 - .04 * Dw, .6 + .04 * Dw, clear);
  sh = mix(sh, 1., vPad);

  // Sand: pale and faintly warm; the moon and the night sky make it silver-blue.
  float grain = vnoise(p * 1.7) * .5 + vnoise(p * .13) * .5;
  vec3 alb = mix(vec3(.41, .37, .32), vec3(.48, .43, .36), grain);
  // Avalanche streaks down the slip faces.
  float streak = vnoise(vec2(dot(p, cr) * 1.3, dot(p, wd) * .06));
  alb *= 1. - slip * .12 * streak;
  float K = max(dot(n, Lk), 0.) * sh;
  float rim = max(dot(n0, Lk), 0.);
  vec3 amb = uSkyAmb * (.55 + .45 * n.y) + uMoonCol * .028 * (.6 + .4 * rim);   // sky + bounce from lit sand
  vec3 col = alb * (uMoonCol * K + amb);
  col += alb * campLight(vW, n);
  // A faint sheen of moonlight off the grains near the brinks seen against the light.
  vec3 V = normalize(cameraPosition - vW);
  col += uMoonCol * .03 * pow(max(dot(reflect(-V, n), Lk), 0.), 6.) * sh;

  if (uDebug > 2.5) col = vec3(sh) * .2;
  else if (uDebug > 1.5) col = vec3(rippleAmt, slip, fract(s)) * .2;
  else if (uDebug > .5) col = (n * .5 + .5) * .2;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

export function buildSand(shared, campU, { debug = 0, az0 = deg(-72), az1 = deg(86), na = 720, nr = 210 } = {}) {
  const t0 = performance.now();
  const NA = na, NR = nr;
  const radii = new Float64Array(NR + 1);
  for (let j = 0; j <= NR; j++) radii[j] = 1.5 * Math.pow(3000 / 1.5, j / NR);
  const W = NA + 1, nv = W * (NR + 1);
  const pos = new Float32Array(nv * 3);
  const d0 = new Float32Array(nv * 4), d1 = new Float32Array(nv * 4), pad = new Float32Array(nv);
  const raw = new Float32Array(8);
  const S = new Float64Array(nv), A = new Float64Array(nv), B = new Float64Array(nv);
  for (let i = 0; i <= NA; i++) {
    const a = az0 + ((az1 - az0) * i) / NA, sx = Math.sin(a), sz = -Math.cos(a);
    for (let j = 0; j <= NR; j++) {
      const x = sx * radii[j], z = sz * radii[j];
      const v = j * W + i;
      // Values only; gradients come from the neighbours below (a third of the noise calls).
      const h = duneAttribs(x, z, raw, 0, true);
      S[v] = raw[0]; A[v] = raw[1]; B[v] = raw[6];
      const w = padAt(x, z);
      pad[v] = w;
      pos[v * 3] = x; pos[v * 3 + 1] = w > 0 ? h + (SITE.ty - h) * w : h; pos[v * 3 + 2] = z;
    }
  }
  // Gradients of phase, amplitude and base from the grid: solve the 2x2 system given by the
  // azimuthal and radial differences.
  for (let j = 0; j <= NR; j++) {
    const jd = Math.max(j - 1, 0), ju = Math.min(j + 1, NR);
    for (let i = 0; i <= NA; i++) {
      const il = Math.max(i - 1, 0), ir = Math.min(i + 1, NA);
      const v = j * W + i, L = j * W + il, R = j * W + ir, D = jd * W + i, U = ju * W + i;
      const ax = pos[R * 3] - pos[L * 3], az = pos[R * 3 + 2] - pos[L * 3 + 2];
      const bx = pos[U * 3] - pos[D * 3], bz = pos[U * 3 + 2] - pos[D * 3 + 2];
      const det = ax * bz - az * bx || 1e-9;
      const grad = (arr) => {
        const da = arr[R] - arr[L], db = arr[U] - arr[D];
        return [(da * bz - az * db) / det, (ax * db - da * bx) / det];
      };
      const gs = grad(S), ga = grad(A), gb = grad(B);
      d0[v * 4] = S[v]; d0[v * 4 + 1] = A[v]; d0[v * 4 + 2] = gs[0]; d0[v * 4 + 3] = gs[1];
      d1[v * 4] = ga[0]; d1[v * 4 + 1] = ga[1]; d1[v * 4 + 2] = gb[0]; d1[v * 4 + 3] = gb[1];
    }
  }
  const idx = new Uint32Array(NA * NR * 6);
  let o = 0;
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aD0', new THREE.BufferAttribute(d0, 4));
  g.setAttribute('aD1', new THREE.BufferAttribute(d1, 4));
  g.setAttribute('aPad', new THREE.BufferAttribute(pad, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));

  const uniforms = { ...shared, ...campU, uDebug: { value: debug }, uWind: { value: new THREE.Vector2(WIND.x, WIND.z) } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SAND_VERT, fragmentShader: SAND_FRAG });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;          // after the camp and rocks: they hide some of it
  return { mesh, uniforms, stats: { sandMs: Math.round(performance.now() - t0), sandTris: idx.length / 3 } };
}
