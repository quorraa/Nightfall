import * as THREE from '../vendor/three.module.min.js';
import { dirAzEl, deg } from '../gl/world.js';
import { layout } from './dunes/field.js';
import { createCampUniforms } from './dunes/camplight.js';
import { buildSand } from './dunes/sand.js';
import { buildCamp } from './dunes/camp.js';
import { buildRocks, buildShrubs } from './dunes/rocks.js';

// The desert: deep dunes under the darkest, clearest sky. The eye stands on a dune brink; down
// in the next trough a canvas bell tent glows with a lantern inside, embers in a ring of stones
// by the door, a dead acacia over them, and mesas on the far horizon. The lantern stands for
// the screens. No water, so no mirror pass.
export function build({ shared, seed, low, debug }) {
  const t0 = performance.now();
  const L = layout();
  const cam = { x: 0, y: L.camY, z: 0 };

  // Mood: dry, clear air; the moon low behind the left shoulder rakes across the dunes.
  shared.uKeyDir.value.copy(dirAzEl(deg(-92), deg(22)));
  shared.uMoonDir.value.copy(dirAzEl(deg(-97), deg(25)));
  shared.uMoonCol.value.set(0.33, 0.41, 0.68);
  shared.uSkyAmb.value.set(0.008, 0.011, 0.022);
  // Dry air: little haze, with a faint warm airglow mixed into the blue near the horizon.
  shared.uHaze.value.set(0.0135, 0.0135, 0.025);
  shared.uHazeDensity.value = 0.00042;
  shared.uMist.value = 0.0012;
  shared.uMistCol.value.set(0.02, 0.022, 0.036);
  shared.uLampCol.value.set(1.0, 0.55, 0.22);

  const campU = createCampUniforms();
  const site = { x: L.tent.x, y: L.tent.y, z: L.tent.z };
  // Door turned a little left of the camera, so the light wedge falls toward the fire.
  const toCam = Math.atan2(cam.x - site.x, cam.z - site.z);
  const camp = buildCamp(shared, campU, site, toCam - 0.38);
  shared.uLampPos.value.copy(camp.lampPos);
  shared.uLampDir.value.copy(camp.door);
  campU.uDoorDir.value.copy(camp.door);
  campU.uEmberPos.value.copy(camp.fireWorld).add(new THREE.Vector3(0, 0.25, 0));

  const dbg = { normals: 1, ripples: 2, shadow: 3 }[debug] || 0;
  const sand = buildSand(shared, campU, { debug: dbg, na: low ? 520 : 720, nr: low ? 170 : 210 });
  const rocks = buildRocks(shared, campU);
  const shrubs = buildShrubs(shared, campU, site, { count: low ? 160 : 260, seed });

  const group = new THREE.Group();
  group.add(camp.mesh, camp.glow, rocks.mesh, shrubs.mesh, sand.mesh);

  const stats = {
    ...sand.stats, campTris: camp.tris, rockTris: rocks.tris, shrubs: shrubs.count,
    tentDist: Math.round(L.tent.d), duneMs: Math.round(performance.now() - t0),
  };

  return {
    group,
    cam,
    focus: camp.lampPos.clone(),
    aurora: false,
    reflection: null,
    stats,
    update(t, dt, st) {
      const flick = 0.82 + 0.1 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1.3) + 0.08 * Math.sin(t * 5.7 + Math.sin(t * 1.7));
      campU.uEmber.value = st.fire * flick;
    },
  };
}
