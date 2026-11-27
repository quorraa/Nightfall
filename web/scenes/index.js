// The scenes you can pick from the phone. Each module exports build(ctx) returning
//   { group, cam: {x, y, z}, focus: Vector3, aurora, reflection: { hide: [...] } | null,
//     stats?, setView?(vfov, aspect), update(t, dt, st), dispose?() }
// ctx = { shared, renderer, reflTexture, seed, rnd, low, debug, reducedMotion }.
// focus is the lamp that stands for the screens; the camera frames the shot around it.
// Scenes with ready: false load with ?scene=ID but don't show in the picker yet.
const ALL = [
  { id: 'lake', name: 'Lake', line: 'A cabin across still water', ready: true, load: () => import('./lake.js') },
  { id: 'coast', name: 'Lighthouse', line: 'A beam turning over the sea', ready: false, load: () => import('./coast.js') },
  { id: 'dunes', name: 'Desert', line: 'A lantern-lit tent in the dunes', ready: false, load: () => import('./dunes.js') },
];

export const SCENES = ALL.filter((s) => s.ready);
export const DEFAULT_SCENE = 'lake';
export const sceneById = (id) => ALL.find((s) => s.id === id) || ALL.find((s) => s.id === DEFAULT_SCENE);
