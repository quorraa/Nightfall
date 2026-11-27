import * as THREE from '../vendor/three.module.min.js';
import { smooth } from '../gl/common.js';
import { CAM, CABIN } from '../gl/world.js';
import { createLand } from '../gl/land.js';
import { createWater } from '../gl/water.js';

// The lake: a log cabin across still water, forested hills, snowy peaks, an aurora at night.
// The lamp in the cabin's windows stands for the screens.
export function build({ shared, reflTexture, seed, low, debug, reducedMotion }) {
  const land = createLand(shared, { seed, debug: { forest: debug === 'forest' } });
  const water = createWater(shared, reflTexture, { seed, fireflies: low ? 40 : 70, reducedMotion });
  if (debug === 'water') water.uniforms.uDebug.value = 1;
  const group = new THREE.Group();
  group.add(land.group, water.group);

  return {
    group,
    cam: CAM,
    focus: new THREE.Vector3(CABIN.x, CABIN.y, CABIN.z),
    aurora: true,
    reflection: { hide: [water.water, ...land.farTier] },
    stats: land.stats,
    setView(vfov, aspect) { water.setDistort(vfov, aspect); },
    update(t, dt, st) {
      water.flyUniforms.uFire.value = st.fire;
      land.setSmoke(0.4 + 0.6 * smooth(0, 0.6, st.lamp));
      water.update(t, dt, st.night ? 0.55 : 1);
    },
  };
}
