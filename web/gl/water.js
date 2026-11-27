import * as THREE from '../vendor/three.module.min.js';
import { seeded } from './common.js';
import { GLSL_WORLD, CAM, CABIN, LAKE, heightAt, lakeSigned, deg } from './world.js';

// ---------------------------------------------------------------------------------------------
// The lake: a flat plane at y = 0 whose normal comes from six analytic waves plus a few ripple
// rings. It shows the mirrored scene (rendered into a half-resolution target with uMirror = -1)
// with Fresnel, then adds moon and lamp glints so the light lays a path across the water.
// Each wave fades out once it is smaller than the pixel footprint, so distance never shimmers.
// ---------------------------------------------------------------------------------------------

const WATER_VERT = /* glsl */ `
${GLSL_WORLD}
varying vec3 vW;
void main(){
  vW = position;
  gl_Position = mirrorProject(position);
}`;

const WATER_FRAG = /* glsl */ `
${GLSL_WORLD}
uniform sampler2D uRefl;
uniform vec2 uRes, uDistort;
uniform vec4 uWaves[6];          // dir.xy, wavenumber, slope amplitude
uniform float uPhase[6];
uniform vec4 uRipples[4];        // x, z, age, strength
uniform float uGlint, uDebug;
varying vec3 vW;

// Gradient of value noise by forward differences (slope field for the glitter facets).
vec2 gnoise(vec2 q){
  float a = vnoise(q);
  return vec2(vnoise(q + vec2(.2, 0.)) - a, vnoise(q + vec2(0., .2)) - a) * 5.;
}

float beckmann(float ndh, float m){
  float c2 = max(ndh * ndh, 1e-4), m2 = m * m;
  return exp((c2 - 1.) / (c2 * m2)) / (PI * m2 * c2 * c2);
}

void main(){
  vec2 p = vW.xz;
  vec3 V = cameraPosition - vW;
  float dist = length(V);
  V /= max(dist, 1e-3);
  float fp = length(fwidth(p)) + 1e-4;

  vec2 g = vec2(0.);
  for (int i = 0; i < 6; i++){
    vec4 w = uWaves[i];
    float att = clamp(1. - fp * w.z * .45, 0., 1.);
    g += w.xy * (w.w * cos(dot(w.xy, p) * w.z + uPhase[i]) * att);
  }
  for (int i = 0; i < 4; i++){
    vec4 r = uRipples[i];
    if (r.w <= 0.) continue;
    vec2 d = p - r.xy;
    float rr = length(d);
    float x = rr - r.z * .85;
    float env = exp(-x * x * 2.5) * r.w * exp(-r.z * .45) / (1. + rr * .6);
    g += d / max(rr, 1e-3) * (sin(x * 9.) * env * .35 * clamp(1. - fp * 3.6, 0., 1.));
  }
  vec3 n = normalize(vec3(-g.x, 1., -g.y));

  float c = max(dot(n, V), 0.);
  float F = .02 + .98 * pow(1. - c, 5.);
  F = max(F, .16);

  // Catspaw micro-facets: too small to scramble the mirror, but they break the moon's path
  // into glitter. Faded out by the pixel footprint so distant water never sparkles noisily.
  float microAA = clamp(1. - fp * 2.5, 0., 1.);
  vec2 micro = (gnoise(p * 2.3 + uTime * vec2(.21, .13)) + .6 * gnoise(p * 4.3 - uTime * vec2(.17, .26))) * .05 * microAA;
  vec3 ng = normalize(vec3(-(g.x + micro.x), 1., -(g.y + micro.y)));

  vec2 uv = gl_FragCoord.xy / uRes + (vec2(n.x, -n.z) + vec2(ng.x - n.x, n.z - ng.z) * .25) * uDistort;
  vec3 refl = texture2D(uRefl, clamp(uv, vec2(.001), vec2(.999))).rgb;

  // Dark water body, with a little of the cabin light scattering in the shallows.
  vec3 body = vec3(.002, .005, .008) + lampLight(vW, vec3(0., 1., 0.)) * .03;
  vec3 col = mix(body, refl, F);

  // Moon path: the reflection already holds the disc; the glint spreads it into a trail.
  // Up close each facet is a sharp sparkle; with distance the lobe widens into a soft trail.
  float m = mix(.06 + min(fp * .002, .06), .028, microAA);
  vec3 Hm = normalize(uMoonDir + V);
  col += uMoonCol * beckmann(max(dot(ng, Hm), 0.), m) * F * uGlint;

  // Lamp path toward the cabin.
  vec3 Lv = uLampPos - vW;
  float ld = length(Lv);
  vec3 L = Lv / max(ld, 1e-3);
  vec3 Hl = normalize(L + V);
  float through = smoothstep(-.3, .35, dot(-L, uLampDir));
  col += uLampCol * (uLamp * through * beckmann(max(dot(n, Hl), 0.), .09) * F * .05 * 60. / (40. + ld));

  if (uDebug > 1.5) col = refl;
  else if (uDebug > .5) col = n * .5 + .5;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

// ---------- Fireflies ----------
const FLY_VERT = /* glsl */ `
${GLSL_WORLD}
attribute vec4 aSeed;            // seed, phase, speed, size
uniform float uPx, uFire;
varying float vA;
void main(){
  vec3 p = position;
  float t = uTime * aSeed.z;
  p += vec3(sin(t * .7 + aSeed.y * 6.28) * 1.6 + sin(t * .31 + aSeed.x * 20.) * .9,
            sin(t * .53 + aSeed.y * 13.) * .6,
            cos(t * .61 + aSeed.y * 4.) * 1.6 + sin(t * .27 + aSeed.x * 9.) * .7);
  float blink = pow(.5 + .5 * sin(uTime * (.45 + aSeed.x * .6) + aSeed.y * 40.), 7.);
  vec4 mv = viewMatrix * vec4(p.x, p.y * uMirror, p.z, 1.);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, .5);
  gl_PointSize = clamp(uPx * 26. * aSeed.w / d, uPx * 1.3, uPx * 10.);
  vA = blink * uFire * (1. - smoothstep(90., 160., d));
}`;

const FLY_FRAG = /* glsl */ `
varying float vA;
void main(){
  vec2 q = gl_PointCoord * 2. - 1.;
  float r2 = dot(q, q);
  if (r2 > 1. || vA < .002) discard;
  float a = exp(-r2 * 6.) + .6 * exp(-r2 * 40.);
  gl_FragColor = vec4(vec3(.72, 1., .38) * 5. * vA * a, 1.);
}`;

function buildFireflies(rnd, count) {
  const pos = [], seed = [];
  const azMin = deg(-40), azMax = deg(70);
  let guard = 0;
  while (pos.length / 3 < count && guard++ < 20000) {
    const near = rnd() < 0.35;
    // Some by the cabin, some along the shore, a few close to the camera.
    let x, z;
    if (rnd() < 0.25) {
      const a = rnd() * Math.PI * 2, r = 4 + rnd() * 18;
      x = CABIN.x + Math.cos(a) * r; z = CABIN.z + Math.sin(a) * r;
    } else {
      const d = near ? 6 + rnd() * 30 : 30 + rnd() * 110;
      const az = azMin + (azMax - azMin) * rnd();
      x = CAM.x + Math.sin(az) * d; z = CAM.z - Math.cos(az) * d;
    }
    const s = lakeSigned(x, z);
    if (s < -6 || s > 28) continue;
    const y = Math.max(heightAt(x, z), 0) + 0.4 + rnd() * 2.2;
    pos.push(x, y, z);
    seed.push(rnd(), rnd(), 0.5 + rnd() * 0.7, 0.7 + rnd() * 0.6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 4));
  return g;
}

export function createWater(shared, reflTexture, { seed = 1, fireflies = 70, reducedMotion = false } = {}) {
  const rnd = seeded(seed * 31 + 7);
  const group = new THREE.Group();

  // Six waves around the wind direction, from a long swell to fine catspaws.
  const wind = Math.atan2(shared.uWindDir.value.y, shared.uWindDir.value.x);
  const lengths = [9, 5.4, 3.2, 1.9, 1.15, 0.7];
  const slopes = [0.0085, 0.0075, 0.0065, 0.0055, 0.0045, 0.0035];
  const waves = [], omega = [], phases = [];
  lengths.forEach((L, i) => {
    const a = wind + (rnd() - 0.5) * 1.4 + (i % 2 ? 0.35 : -0.35);
    const k = (Math.PI * 2) / L;
    waves.push(new THREE.Vector4(Math.cos(a), Math.sin(a), k, slopes[i]));
    omega.push(Math.sqrt(9.81 * k) * 0.55);
    phases.push(rnd() * Math.PI * 2);
  });
  const ripples = [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 0));
  const baseSlopes = slopes.slice();

  const uniforms = {
    ...shared,
    uRefl: { value: reflTexture },
    uDistort: { value: new THREE.Vector2(0.9, 1.6) },
    uWaves: { value: waves },
    uPhase: { value: phases },
    uRipples: { value: ripples },
    uGlint: { value: 0.55 },
    uDebug: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG });
  mat.extensions = { derivatives: true };
  const geo = new THREE.PlaneGeometry(LAKE.rx * 2 + 80, 150, 32, 16).rotateX(-Math.PI / 2).translate(LAKE.cx, 0, -65);
  const water = new THREE.Mesh(geo, mat);
  water.frustumCulled = false;
  water.renderOrder = 3;
  group.add(water);

  const flyU = { ...shared, uFire: { value: 1 } };
  const flies = new THREE.Points(buildFireflies(rnd, fireflies), new THREE.ShaderMaterial({
    uniforms: flyU, vertexShader: FLY_VERT, fragmentShader: FLY_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  flies.frustumCulled = false;
  flies.renderOrder = 6;
  group.add(flies);

  let nextRipple = 2, rippleSlot = 0, calm = 1;

  return {
    group, water, flies, uniforms, flyUniforms: flyU,
    setDistort(vfov, aspect) {
      const t = Math.tan(vfov / 2);
      uniforms.uDistort.value.set(1 / (t * aspect), 1 / t).multiplyScalar(0.55);
    },
    // calmTarget 1 = evening breeze, about 0.55 = the lake stills once the lights are out.
    update(t, dt, calmTarget = 1) {
      const step = reducedMotion ? dt * 0.3 : dt;
      calm += (calmTarget - calm) * (1 - Math.exp(-dt * 0.08));
      for (let i = 0; i < 6; i++) {
        phases[i] = (phases[i] + omega[i] * step) % (Math.PI * 200);
        waves[i].w = baseSlopes[i] * calm;
      }
      for (const r of ripples) if (r.w > 0) { r.z += dt; if (r.z > 9) r.w = 0; }
      if (!reducedMotion && (nextRipple -= dt) <= 0) {
        nextRipple = 2.5 + rnd() * 5;
        for (let tries = 0; tries < 12; tries++) {
          const d = 12 + rnd() * 70, az = deg(-30 + rnd() * 75);
          const x = CAM.x + Math.sin(az) * d, z = CAM.z - Math.cos(az) * d;
          if (lakeSigned(x, z) < -4) {
            ripples[rippleSlot].set(x, z, 0, 0.6 + rnd() * 0.7);
            rippleSlot = (rippleSlot + 1) % 4;
            break;
          }
        }
      }
    },
  };
}
