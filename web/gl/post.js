import * as THREE from '../vendor/three.module.min.js';
import { FS_VERT, fullscreenTriangle } from './common.js';

// ---------------------------------------------------------------------------------------------
// Final image: the scene renders linear HDR into a half-float target (MSAA when available),
// bloom is a dual-filter mip chain (Karis-weighted, soft-knee prefilter on the first step, tent
// upsampling added back down the chain), and one composite pass does exposure, a night-vision
// (Purkinje) shift toward blue in the darks, tone mapping, split toning, vignette, sRGB and
// dither. Tone mapping and sRGB happen exactly once, here.
// ---------------------------------------------------------------------------------------------

const DOWN_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uFirst, uThreshold, uKnee;
varying vec2 vUv;
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
vec3 prefilter(vec3 c){
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0., 2. * uKnee);
  rq = rq * rq / (4. * uKnee + 1e-5);
  return c * (max(rq, br - uThreshold) / max(br, 1e-5));
}
void main(){
  vec2 o = uTexel;
  vec3 s0 = texture2D(uSrc, vUv).rgb;
  vec3 s1 = texture2D(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  vec3 s2 = texture2D(uSrc, vUv + vec2( o.x, -o.y)).rgb;
  vec3 s3 = texture2D(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  vec3 s4 = texture2D(uSrc, vUv + vec2( o.x,  o.y)).rgb;
  if (uFirst > .5){
    // Karis average: one very bright texel (the moon, a firefly) cannot flicker the whole chain.
    s0 = prefilter(s0); s1 = prefilter(s1); s2 = prefilter(s2); s3 = prefilter(s3); s4 = prefilter(s4);
    float w0 = 4. / (1. + lum(s0)), w1 = 1. / (1. + lum(s1)), w2 = 1. / (1. + lum(s2)), w3 = 1. / (1. + lum(s3)), w4 = 1. / (1. + lum(s4));
    gl_FragColor = vec4((s0 * w0 + s1 * w1 + s2 * w2 + s3 * w3 + s4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.);
  } else {
    gl_FragColor = vec4((s0 * 4. + s1 + s2 + s3 + s4) / 8., 1.);
  }
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec2 d = uTexel;
  vec3 s = texture2D(uSrc, vUv).rgb * 4.
    + (texture2D(uSrc, vUv + vec2(-d.x, 0.)).rgb + texture2D(uSrc, vUv + vec2(d.x, 0.)).rgb
     + texture2D(uSrc, vUv + vec2(0., -d.y)).rgb + texture2D(uSrc, vUv + vec2(0., d.y)).rgb) * 2.
    + texture2D(uSrc, vUv + vec2(-d.x, -d.y)).rgb + texture2D(uSrc, vUv + vec2(d.x, -d.y)).rgb
    + texture2D(uSrc, vUv + vec2(-d.x, d.y)).rgb + texture2D(uSrc, vUv + vec2(d.x, d.y)).rgb;
  gl_FragColor = vec4(s / 16., 1.);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uScene, uBloom;
uniform vec2 uRes;
uniform float uBloomGain, uExposure, uPurkinje, uMode, uFade;
varying vec2 vUv;
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
vec3 toSRGB(vec3 c){
  c = clamp(c, 0., 1.);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c));
}
void main(){
  vec3 c = texture2D(uScene, vUv).rgb;
  if (uMode > .5 && uMode < 1.5){
    // No-post baseline: plain exposure and a clamp, nothing else.
    gl_FragColor = vec4(toSRGB(c * 1.25), 1.);
    return;
  }
  vec3 b = texture2D(uBloom, vUv).rgb * uBloomGain;
  c = uMode > 1.5 ? b * 3. : c + b;
  c *= uExposure;
  // Scotopic shift: very dark tones lose colour and lean blue, as night vision does.
  float L = lum(c);
  c = mix(c, L * vec3(.55, .75, 1.25), uPurkinje * (1. - smoothstep(.002, .05, L)));
  c = 1. - exp(-c);
  float l2 = lum(c);
  c *= mix(vec3(.95, .98, 1.06), vec3(1.05, 1., .93), smoothstep(.05, .6, l2));
  vec2 q = vUv - .5;
  q.x *= uRes.x / uRes.y;
  c *= 1. - .34 * smoothstep(.25, 1.05, length(q) * 1.15);
  c = toSRGB(c * uFade);
  // Interleaved gradient noise: one code value of dither kills banding in the night gradients.
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  gl_FragColor = vec4(c + (ign - .5) / 255., 1.);
}`;

export function createPost(renderer, { msaa = 4, levels = 6 } = {}) {
  const ext = renderer.extensions;
  const canFloat = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
  const type = canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const rtOpts = { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };

  const sceneRT = new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, depthBuffer: true, samples: msaa });
  const reflRT = new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, depthBuffer: true });
  const mips = [];
  for (let i = 0; i < levels; i++) mips.push(new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, depthBuffer: false }));

  const quad = new THREE.Mesh(fullscreenTriangle());
  quad.frustumCulled = false;
  const qScene = new THREE.Scene();
  qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const flat = { depthTest: false, depthWrite: false };

  const downU = { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 0.5 }, uKnee: { value: 0.3 } };
  const down = new THREE.ShaderMaterial({ uniforms: downU, vertexShader: FS_VERT, fragmentShader: DOWN_FRAG, ...flat });
  const upU = { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } };
  const up = new THREE.ShaderMaterial({
    uniforms: upU, vertexShader: FS_VERT, fragmentShader: UP_FRAG, ...flat,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const compU = {
    uScene: { value: sceneRT.texture }, uBloom: { value: mips[0].texture },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBloomGain: { value: 0.75 / levels }, uExposure: { value: 1.25 }, uPurkinje: { value: 0.3 },
    uMode: { value: 0 }, uFade: { value: 1 },
  };
  const composite = new THREE.ShaderMaterial({ uniforms: compU, vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, ...flat });

  let active = levels;
  function pass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(qScene, qCam);
  }

  return {
    sceneRT, reflRT, uniforms: compU,
    info: { float: canFloat, msaa },
    setSize(w, h) {
      sceneRT.setSize(w, h);
      reflRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
      let mw = w, mh = h;
      active = 0;
      for (const m of mips) {
        mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
        m.setSize(mw, mh);
        if (mw >= 8 && mh >= 8) active++;
      }
      active = Math.max(1, active);
      compU.uRes.value.set(w, h);
    },
    render({ mode = 0, source = null } = {}) {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      if (mode !== 1) {
        let src = sceneRT;
        for (let i = 0; i < active; i++) {
          downU.uSrc.value = src.texture;
          downU.uTexel.value.set(1 / src.width, 1 / src.height);
          downU.uFirst.value = i === 0 ? 1 : 0;
          pass(down, mips[i]);
          src = mips[i];
        }
        for (let i = active - 2; i >= 0; i--) {
          const s = mips[i + 1];
          upU.uSrc.value = s.texture;
          upU.uTexel.value.set(1 / s.width, 1 / s.height);
          pass(up, mips[i]);
        }
        compU.uBloomGain.value = 0.75 / active;
      }
      compU.uScene.value = source ? source.texture : sceneRT.texture;
      compU.uMode.value = mode;
      pass(composite, null);
      renderer.autoClear = autoClear;
    },
    materials: [down, up, composite],
  };
}
