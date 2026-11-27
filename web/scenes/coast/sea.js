import * as THREE from '../../vendor/three.module.min.js';
import { GLSL_WORLD, deg } from '../../gl/world.js';

// ---------------------------------------------------------------------------------------------
// The sea: a long swell rolling in toward the eye (three sines that really move the surface near
// the shore, so the waterline runs up the shingle and back), wind chop and catspaws as normals
// only, the mirrored world from the reflection pass, moon glitter, the lantern's path, and foam
// where the water is shallow or close to the rocks. The swell is shared with the land shader so
// the rocks get wet and laced with foam exactly where the water reaches.
// ---------------------------------------------------------------------------------------------

export const GLSL_SWELL = /* glsl */ `
uniform vec4 uSwell[3];          // dir.xy, wavenumber, height amplitude (m)
uniform float uSwellPh[3];
float swellH(vec2 p){
  float h = 0.;
  for (int i = 0; i < 3; i++){ vec4 w = uSwell[i]; h += w.w * sin(dot(w.xy, p) * w.z - uSwellPh[i]); }
  return h;
}
vec2 swellG(vec2 p){
  vec2 g = vec2(0.);
  for (int i = 0; i < 3; i++){ vec4 w = uSwell[i]; g += w.xy * (w.w * w.z * cos(dot(w.xy, p) * w.z - uSwellPh[i])); }
  return g;
}
`;

// Swell from the open sea, slightly off the bay's axis. Periods are slowed a little: a calm
// night, not a storm.
export function createSwell(rnd) {
  const lengths = [58, 37, 23], heights = [0.2, 0.11, 0.06], az = [-4, 9, -17];
  const swell = [], omega = [], ph = [];
  lengths.forEach((L, i) => {
    const a = deg(az[i] + (rnd() - 0.5) * 6);
    const k = (Math.PI * 2) / L;
    swell.push(new THREE.Vector4(-Math.sin(a), Math.cos(a), k, heights[i]));
    omega.push(Math.sqrt(9.81 * k) * 0.72);
    ph.push(rnd() * Math.PI * 2);
  });
  const uniforms = { uSwell: { value: swell }, uSwellPh: { value: ph } };
  return {
    uniforms,
    update(dt, calm) {
      for (let i = 0; i < 3; i++) {
        ph[i] = (ph[i] + omega[i] * dt) % (Math.PI * 200);
        swell[i].w = heights[i] * calm;
      }
    },
  };
}

const SEA_VERT = /* glsl */ `
${GLSL_WORLD}
${GLSL_SWELL}
attribute float aDepth, aShore;
varying vec3 vW;
varying float vDepth, vShore, vAmp;
void main(){
  vec3 p = position;
  float d = length(p.xz - cameraPosition.xz);
  // Shoaling water rises less at the very edge; far away the swell is only shading.
  vAmp = (.6 + .4 * smoothstep(0., 3., aDepth)) * (1. - smoothstep(250., 900., d));
  p.y = swellH(p.xz) * vAmp;
  vW = p; vDepth = aDepth; vShore = aShore;
  gl_Position = mirrorProject(p);
}`;

const SEA_FRAG = /* glsl */ `
${GLSL_WORLD}
${GLSL_SWELL}
uniform sampler2D uRefl;
uniform vec2 uRes, uDistort;
uniform vec4 uWaves[5];          // dir.xy, wavenumber, slope amplitude
uniform float uPhase[5];
uniform float uGlint, uDebug, uChop;
varying vec3 vW;
varying float vDepth, vShore, vAmp;

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

  vec2 g = swellG(p) * vAmp;
  for (int i = 0; i < 5; i++){
    vec4 w = uWaves[i];
    float att = clamp(1. - fp * w.z * .45, 0., 1.);
    g += w.xy * (w.w * uChop * cos(dot(w.xy, p) * w.z + uPhase[i]) * att);
  }
  vec3 n = normalize(vec3(-g.x, 1., -g.y));
  float microAA = clamp(1. - fp * 2.5, 0., 1.);
  vec2 micro = (gnoise(p * 1.7 + uTime * vec2(.05, .19)) + .6 * gnoise(p * 3.6 - uTime * vec2(.13, .22))) * .06 * microAA * uChop;
  vec3 ng = normalize(vec3(-(g.x + micro.x), 1., -(g.y + micro.y)));

  float c = max(dot(n, V), 0.);
  float F = max(.02 + .98 * pow(1. - c, 5.), .14);
  vec2 uv = gl_FragCoord.xy / uRes + (vec2(n.x, -n.z) + vec2(ng.x - n.x, n.z - ng.z) * .25) * uDistort;
  vec3 refl = texture2D(uRefl, clamp(uv, vec2(.001), vec2(.999))).rgb;

  float depth = vDepth + vW.y;
  vec3 body = mix(vec3(.010, .020, .020), vec3(.0018, .0045, .0075), smoothstep(.2, 3., depth));
  body *= uSkyAmb / vec3(.010, .014, .027) * .9;
  vec3 col = mix(body, refl, F);

  // Moon glitter: sharp facets close by, a soft trail with distance.
  float m = mix(.075 + min(fp * .002, .06), .04, microAA);
  vec3 Hm = normalize(uMoonDir + V);
  col += uMoonCol * beckmann(max(dot(ng, Hm), 0.), m) * F * uGlint;

  // The lantern's path toward the eye.
  vec3 Lv = uLampPos - vW;
  float ld = length(Lv);
  vec3 Hl = normalize(Lv / max(ld, 1e-3) + V);
  col += uLampCol * (uLamp * beckmann(max(dot(ng, Hl), 0.), .07) * F * 2.4 / (60. + ld));

  // Foam: the edge of the wash, surf against the rocks, and breaking crests in the shallows.
  float sw = swellH(p) / max(uSwell[0].w + uSwell[1].w + uSwell[2].w, 1e-3);
  float laceN = fbm3(p * vec2(.75, 1.1) + vec2(sw * .35, -uTime * .07)) * .65 + vnoise(p * 3.1 - uTime * .1) * .35;
  float lace = mix(.48, laceN, clamp(1. - fp * .8, 0., 1.));
  float edge = (1. - smoothstep(0., .04 + .22 * lace, depth)) * (.4 + .6 * lace);
  float surfW = 5. + min(dist * .02, 8.);
  float surf = smoothstep(-surfW, -.3, vShore) * smoothstep(.36, .68, lace + .18 * sw) * (1. - smoothstep(.6, 8., depth) * .4);
  float crest = smoothstep(.45, .95, sw) * smoothstep(.12, .5, depth) * (1. - smoothstep(.9, 2.2, depth));
  float wake = smoothstep(.2, .7, sw) * (1. - smoothstep(-.2, .6, sw - .5)) * (1. - smoothstep(.3, 1.4, depth));
  float foam = clamp(edge + surf * .85 + (crest + wake * .5) * smoothstep(.36, .62, lace), 0., 1.);
  vec3 foamCol = vec3(.72, .78, .88) * (uMoonCol * .75 + uSkyAmb * 2.2);
  col = mix(col, foamCol, foam * .9);

  if (uDebug > 1.5) col = refl;
  else if (uDebug > .5) col = vec3(foam, clamp(depth * .2, 0., 1.), clamp(-vShore * .05, 0., 1.)) * .3;
  gl_FragColor = vec4(applyHaze(col, vW), 1.);
}`;

export function createSea(shared, swellU, reflTexture, geometry, rnd, { debug = '' } = {}) {
  // Chop and catspaws around the onshore breeze.
  const lengths = [7.5, 4.6, 2.9, 1.8, 1.1];
  const slopes = [0.024, 0.02, 0.016, 0.013, 0.01];
  const waves = [], omega = [], phases = [];
  lengths.forEach((L, i) => {
    const a = deg(90 + (rnd() - 0.5) * 70 + (i % 2 ? 22 : -22));
    const k = (Math.PI * 2) / L;
    waves.push(new THREE.Vector4(Math.cos(a), Math.sin(a), k, slopes[i]));
    omega.push(Math.sqrt(9.81 * k) * 0.55);
    phases.push(rnd() * Math.PI * 2);
  });
  const uniforms = {
    ...shared, ...swellU,
    uRefl: { value: reflTexture },
    uDistort: { value: new THREE.Vector2(0.9, 1.6) },
    uWaves: { value: waves },
    uPhase: { value: phases },
    uGlint: { value: 0.5 },
    uChop: { value: 1 },
    uDebug: { value: debug === 'water' ? 1 : debug === 'seaRefl' ? 2 : 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG, side: THREE.DoubleSide });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return {
    mesh, uniforms,
    setDistort(vfov, aspect) {
      const t = Math.tan(vfov / 2);
      uniforms.uDistort.value.set(1 / (t * aspect), 1 / t).multiplyScalar(0.55);
    },
    update(dt, calm) {
      for (let i = 0; i < 5; i++) phases[i] = (phases[i] + omega[i] * dt) % (Math.PI * 200);
      uniforms.uChop.value = 0.35 + 0.65 * calm;
    },
  };
}
