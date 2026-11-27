import * as THREE from '../../vendor/three.module.min.js';

// Light from the camp, shared by every desert material. The lantern hangs inside a canvas tent:
// most of its light leaves as a soft glow through the canvas (a big source, so no hot spot at
// the walls), a brighter wedge leaves through the open door, and the fire's embers add a small
// red-orange pool. uLampPos / uLamp / uLampCol are the shared lamp uniforms.
export function createCampUniforms() {
  return {
    uDoorDir: { value: new THREE.Vector3(0, 0, 1) },
    uEmberPos: { value: new THREE.Vector3() },
    uEmber: { value: 1 },
  };
}

export const GLSL_CAMP = /* glsl */ `
uniform vec3 uDoorDir, uEmberPos;
uniform float uEmber;
vec3 campLight(vec3 wp, vec3 n){
  vec3 v = uLampPos - wp;
  float d2 = dot(v, v);
  vec3 L = v * inversesqrt(max(d2, 1e-4));
  vec2 out2 = -v.xz * inversesqrt(max(dot(v.xz, v.xz), 1e-4));
  float door = smoothstep(.86, .97, dot(out2, uDoorDir.xz)) * smoothstep(-.75, -.05, -L.y);
  float wrap = clamp(dot(n, L) * .75 + .25, 0., 1.);
  vec3 c = uLampCol * (uLamp * (.8 + 1.5 * door) * 2.6 / (1. + d2 * .075)) * wrap;
  vec3 e = uEmberPos - wp;
  float e2 = dot(e, e);
  vec3 Le = e * inversesqrt(max(e2, 1e-4));
  c += vec3(1., .36, .12) * (uEmber * .55 / (1. + e2 * 1.1)) * clamp(dot(n, Le) * .8 + .2, 0., 1.);
  return c;
}
`;
