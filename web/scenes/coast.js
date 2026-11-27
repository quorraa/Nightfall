import * as THREE from '../vendor/three.module.min.js';
import { dirAzEl, deg } from '../gl/world.js';
import { CAM, SITE, createLand } from './coast/land.js';
import { createSwell, createSea } from './coast/sea.js';
import { createLighthouse, LANTERN_Y } from './coast/lighthouse.js';

// The coast: from a rocky shore at the head of a bay, open sea runs out to the horizon under the
// moon; a headland on the right runs out to a white lighthouse whose two beams turn slowly
// through the sea haze. The lantern stands for the screens.
export function build({ shared, reflTexture, rnd, low, debug, reducedMotion }) {
  const t0 = performance.now();
  // Mood: the moon hangs just right of the light and lays its path across the bay (left of the
  // light it would sit under the clock on a phone held sideways); the key comes from the left so
  // the headland's bay-side cliffs and the tower's left flank catch it.
  const lampAz = Math.atan2(SITE.x - CAM.x, -(SITE.z - CAM.z));
  shared.uMoonDir.value.copy(dirAzEl(lampAz + deg(6.5), deg(17)));
  shared.uKeyDir.value.copy(dirAzEl(deg(-112), deg(30)));
  shared.uHazeDensity.value = 0.00085;
  shared.uMist.value = 0.0045;
  shared.uMistCol.value.set(0.028, 0.034, 0.058);
  shared.uLampCol.value.set(1.0, 0.66, 0.36);

  const swell = createSwell(rnd);
  const land = createLand(shared, swell.uniforms, { low, debug });
  const sea = createSea(shared, swell.uniforms, reflTexture, land.seaGeometry, rnd, { debug });
  const light = createLighthouse(shared, SITE, { reducedMotion });

  shared.uLampPos.value.copy(light.lantern);
  shared.uLampDir.value.set(0, -1, 0);

  const group = new THREE.Group();
  group.add(land.group, sea.mesh, light.group);

  const camPos = new THREE.Vector3(CAM.x, CAM.y, CAM.z);
  let calm = 1;
  return {
    group,
    cam: CAM,
    focus: light.lantern.clone(),
    aurora: true,
    reflection: { hide: [sea.mesh] },
    stats: { ...land.stats, ...light.stats, lanternY: +(SITE.y + LANTERN_Y).toFixed(1), coastMs: Math.round(performance.now() - t0) },
    setView(vfov, aspect) { sea.setDistort(vfov, aspect); },
    update(t, dt, st) {
      // The sea settles a little once the lights are out.
      calm += ((st.night ? 0.6 : 1) - calm) * (1 - Math.exp(-dt * 0.08));
      const step = reducedMotion ? dt * 0.4 : dt;
      swell.update(step, calm);
      sea.update(step, calm);
      light.update(t, camPos);
    },
  };
}
