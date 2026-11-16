import { createHash } from 'node:crypto';

export type CompositionFiles = Record<string, string>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Kinetic typography: words rise in one by one over a slow gradient, driven only by CSS keyframes. */
export function buildMotionComposition(input: {
  text: string;
  duration: number;
  width: number;
  height: number;
}): CompositionFiles {
  const words = input.text.trim().split(/\s+/).filter(word => word.length > 0).slice(0, 40);
  const headline = Math.max(32, Math.round(input.width / (words.length > 12 ? 26 : 16)));
  const step = Math.min(0.45, Math.max(0.12, (input.duration - 2) / Math.max(1, words.length)));
  const spans = words
    .map((word, index) => `<span class="w" style="animation-delay:${(0.3 + index * step).toFixed(2)}s">${escapeHtml(word)}</span>`)
    .join(' ');
  const fadeOutAt = Math.max(1, input.duration - 0.8);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b0f17;overflow:hidden;font-family:Inter,system-ui,sans-serif}
  #stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 700px at 30% 20%,#1b2740 0%,#0b0f17 70%)}
  #glow{position:absolute;width:60%;height:60%;border-radius:50%;filter:blur(90px);opacity:.35;
    background:linear-gradient(135deg,#4f8cff,#b46bff);animation:drift ${input.duration}s linear both}
  h1{position:relative;margin:0;max-width:78%;text-align:center;color:#eef2fa;font-weight:800;
    font-size:${headline}px;line-height:1.12;letter-spacing:-.01em;animation:out .8s ${fadeOutAt.toFixed(2)}s both}
  .w{display:inline-block;opacity:0;transform:translateY(.45em);animation:rise .7s cubic-bezier(.2,.8,.2,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(.45em)}to{opacity:1;transform:none}}
  @keyframes out{from{opacity:1}to{opacity:0}}
  @keyframes drift{from{transform:translate(-18%,-8%) scale(.9)}to{transform:translate(18%,8%) scale(1.15)}}
</style></head>
<body>
  <div data-composition-id="root" data-no-timeline data-start="0" data-duration="${input.duration}"
       data-width="${input.width}" data-height="${input.height}">
    <div id="stage"><div id="glow"></div><h1>${spans}</h1></div>
  </div>
</body></html>
`;
  return { 'index.html': html };
}

export type WorldTheme = 'dawn' | 'day' | 'dusk' | 'night';
export type WorldLandform = 'hills' | 'mountains' | 'dunes' | 'islands';
export type LandmarkKind = 'observatory' | 'bridge' | 'tower' | 'castle' | 'obelisk';

export type WorldSpec = {
  title: string;
  seed: number;
  duration: number;
  width: number;
  height: number;
  theme: WorldTheme;
  landform: WorldLandform;
  landmark: LandmarkKind;
  trees: number;
  rocks: number;
  water: boolean;
  fog: number;
};

/** Derive a deterministic world description from the prompt: same text and seed give the same world. */
export function deriveWorldSpec(input: {
  prompt: string;
  seed: number;
  duration: number;
  width: number;
  height: number;
}): WorldSpec {
  const text = input.prompt.toLowerCase();
  const has = (pattern: RegExp) => pattern.test(text);
  const theme: WorldTheme = has(/\b(night|moon|midnight|stars?|nocturnal)\b/) ? 'night'
    : has(/\b(dusk|sunset|evening|twilight)\b/) ? 'dusk'
      : has(/\b(noon|midday|sunny|daylight|bright)\b/) ? 'day'
        : 'dawn';
  const landform: WorldLandform = has(/\b(desert|dunes?|sand|sahara)\b/) ? 'dunes'
    : has(/\b(island|archipelago|sea|ocean|coast|lagoon)\b/) ? 'islands'
      : has(/\b(mountains?|highlands?|peaks?|alps|cliffs?|canyon)\b/) ? 'mountains'
        : 'hills';
  const landmark: LandmarkKind = has(/\b(observatory|telescope|dome)\b/) ? 'observatory'
    : has(/\b(bridge|arch)\b/) ? 'bridge'
      : has(/\b(castle|fortress|ruins?)\b/) ? 'castle'
        : has(/\b(tower|lighthouse|spire)\b/) ? 'tower'
          : 'obelisk';
  const forest = has(/\b(forest|pines?|trees?|woods?|jungle|grove)\b/);
  const digest = createHash('sha256').update(`${input.prompt}|${input.seed}`).digest();
  return {
    title: input.prompt.trim().slice(0, 90),
    seed: digest.readUInt32BE(0),
    duration: input.duration,
    width: input.width,
    height: input.height,
    theme,
    landform,
    landmark,
    trees: forest ? 340 : landform === 'dunes' ? 0 : 90,
    rocks: landform === 'mountains' ? 120 : 50,
    water: landform === 'islands' || has(/\b(lake|river|water|bridge|harbou?r)\b/),
    fog: has(/\b(mist|misty|fog|foggy|haze|hazy)\b/) ? 0.02 : 0.007
  };
}

const worldRuntime = String.raw`
import * as THREE from "three";
const SPEC = window.__WORLD_SPEC__;
const THEMES = {
  dawn:  { sky: 0xf2b894, fog: 0xe9c3a6, sun: 0xffd2a0, sunPos: [-60, 22, -40], sunI: 2.4, hemi: 0.55 },
  day:   { sky: 0x8fc4ee, fog: 0xbcdcf2, sun: 0xffffff, sunPos: [40, 80, 20], sunI: 3.0, hemi: 0.75 },
  dusk:  { sky: 0x3a2350, fog: 0x7a4a66, sun: 0xff8a4c, sunPos: [70, 14, 30], sunI: 2.0, hemi: 0.4 },
  night: { sky: 0x050914, fog: 0x0b1530, sun: 0x9db8ff, sunPos: [-30, 60, -30], sunI: 1.0, hemi: 0.3 }
};
const theme = THEMES[SPEC.theme];
const SIZE = 180;
const WATER = -1.5;

function hash(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(SPEC.seed | 0, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  const u = smooth(fx), v = smooth(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < 5; i++) { sum += amp * vnoise(x * freq, z * freq); freq *= 2; amp *= 0.5; }
  return sum;
}
function mulberry(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LAND = {
  hills: { scale: 0.022, amp: 14, power: 1.2 },
  mountains: { scale: 0.018, amp: 44, power: 1.7 },
  dunes: { scale: 0.03, amp: 11, power: 1 },
  islands: { scale: 0.02, amp: 20, power: 1.3 }
}[SPEC.landform];
const LANDMARK_AT = [SIZE * 0.08, -SIZE * 0.05];

function terrain(x, z) {
  let h = fbm(x * LAND.scale, z * LAND.scale);
  if (SPEC.landform === "dunes") {
    h = 0.5 + 0.5 * Math.sin((x * 0.05 + h * 6) + z * 0.012);
  } else {
    h = Math.pow(h, LAND.power);
  }
  let y = (h - 0.28) * LAND.amp;
  if (SPEC.landform === "islands") {
    const r = Math.hypot(x, z) / (SIZE * 0.5);
    y -= Math.pow(Math.min(1, r), 2.2) * 26;
  }
  const dist = Math.hypot(x - LANDMARK_AT[0], z - LANDMARK_AT[1]);
  const flat = Math.min(1, Math.max(0, (dist - 9) / 18));
  const base = SPEC.landform === "islands" ? 1.5 : 2.5;
  return base + (y - base) * flat;
}

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SPEC.width, SPEC.height, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(theme.sky);
scene.fog = new THREE.FogExp2(theme.fog, SPEC.fog);
const camera = new THREE.PerspectiveCamera(48, SPEC.width / SPEC.height, 0.5, 900);

scene.add(new THREE.HemisphereLight(theme.sky, 0x2a2f2a, theme.hemi));
const sun = new THREE.DirectionalLight(theme.sun, theme.sunI);
sun.position.set(...theme.sunPos);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 400 });
scene.add(sun);
const disc = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 12), new THREE.MeshBasicMaterial({ color: theme.sun, fog: false }));
disc.position.set(...theme.sunPos).normalize().multiplyScalar(600);
scene.add(disc);

const SEGMENTS = 150;
const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
geometry.rotateX(-Math.PI / 2);
const pos = geometry.attributes.position;
const colors = new Float32Array(pos.count * 3);
const palette = {
  hills: [0x2f5d3a, 0x6c8f4a, 0xc9c9b0],
  mountains: [0x3b4f3a, 0x77705f, 0xf3f6fa],
  dunes: [0xc79a5c, 0xe3bc7c, 0xf2d9a4],
  islands: [0xd8c38d, 0x4f8a45, 0x8a8f7a]
}[SPEC.landform].map(function (c) { return new THREE.Color(c); });
const tmp = new THREE.Color();
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), z = pos.getZ(i);
  const y = terrain(x, z);
  pos.setY(i, y);
  const t = Math.min(1, Math.max(0, (y - WATER) / (LAND.amp * 0.7)));
  if (t < 0.5) tmp.copy(palette[0]).lerp(palette[1], t * 2); else tmp.copy(palette[1]).lerp(palette[2], (t - 0.5) * 2);
  const shade = 0.88 + 0.12 * vnoise(x * 0.4, z * 0.4);
  colors.set([tmp.r * shade, tmp.g * shade, tmp.b * shade], i * 3);
}
geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
geometry.computeVertexNormals();
const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: false }));
ground.receiveShadow = true;
scene.add(ground);

if (SPEC.water) {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(SIZE * 3, SIZE * 3).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2f6f8f, transparent: true, opacity: 0.82, roughness: 0.15, metalness: 0.1 })
  );
  water.position.y = WATER;
  scene.add(water);
}

const rand = mulberry(SPEC.seed);
function scatter(count, accept) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 40) {
    const x = (rand() - 0.5) * SIZE * 0.96, z = (rand() - 0.5) * SIZE * 0.96;
    const y = terrain(x, z);
    if (y > WATER + 0.6 && accept(x, y, z)) out.push([x, y, z]);
  }
  return out;
}
const away = function (x, z) { return Math.hypot(x - LANDMARK_AT[0], z - LANDMARK_AT[1]) > 14; };
const dummy = new THREE.Object3D();
function instances(geom, material, points, scaleFn) {
  if (points.length === 0) return;
  const mesh = new THREE.InstancedMesh(geom, material, points.length);
  points.forEach(function (p, i) {
    const s = scaleFn();
    dummy.position.set(p[0], p[1] + s.lift, p[2]);
    dummy.rotation.set(s.tilt, rand() * Math.PI * 2, 0);
    dummy.scale.set(s.x, s.y, s.x);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}
instances(new THREE.ConeGeometry(1.6, 6, 7), new THREE.MeshStandardMaterial({ color: 0x1f4a2e, roughness: 0.9 }),
  scatter(SPEC.trees, function (x, y, z) { return away(x, z) && y < LAND.amp * 0.55; }),
  function () { const k = 0.7 + rand() * 0.9; return { x: k, y: k, lift: 3 * k, tilt: 0 }; });
instances(new THREE.DodecahedronGeometry(1.4, 0), new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 1 }),
  scatter(SPEC.rocks, function (x, y, z) { return away(x, z); }),
  function () { const k = 0.5 + rand() * 1.6; return { x: k, y: k * 0.7, lift: 0.2, tilt: rand() * 0.5 }; });

const stone = new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 0.7 });
const roof = new THREE.MeshStandardMaterial({ color: 0x8a96a8, roughness: 0.35, metalness: 0.4 });
const base = terrain(LANDMARK_AT[0], LANDMARK_AT[1]);
const landmark = new THREE.Group();
landmark.position.set(LANDMARK_AT[0], base, LANDMARK_AT[1]);
function part(geom, material, x, y, z) {
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  landmark.add(mesh);
  return mesh;
}
switch (SPEC.landmark) {
  case "observatory":
    part(new THREE.CylinderGeometry(5, 6, 8, 24), stone, 0, 4, 0);
    part(new THREE.SphereGeometry(5.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), roof, 0, 8, 0);
    part(new THREE.BoxGeometry(1.2, 8, 0.4), new THREE.MeshStandardMaterial({ color: 0x1b1f27 }), 0, 9, 4.2);
    break;
  case "bridge":
    for (let i = -2; i <= 2; i++) part(new THREE.BoxGeometry(2.4, 6 - Math.abs(i) * 0.4, 3), stone, i * 5, 3, 0);
    part(new THREE.BoxGeometry(26, 1, 4), stone, 0, 6.2, 0);
    break;
  case "tower":
    part(new THREE.CylinderGeometry(2.6, 3.6, 22, 20), stone, 0, 11, 0);
    part(new THREE.ConeGeometry(3.6, 5, 20), roof, 0, 24.5, 0);
    break;
  case "castle":
    part(new THREE.BoxGeometry(16, 8, 12), stone, 0, 4, 0);
    for (const sx of [-8, 8]) for (const sz of [-6, 6]) {
      part(new THREE.CylinderGeometry(2.2, 2.4, 13, 14), stone, sx, 6.5, sz);
      part(new THREE.ConeGeometry(2.8, 4, 14), roof, sx, 15, sz);
    }
    break;
  default:
    part(new THREE.BoxGeometry(3, 24, 3), stone, 0, 12, 0);
    part(new THREE.ConeGeometry(2.2, 4, 4), roof, 0, 26, 0);
}
scene.add(landmark);

const title = document.getElementById("title");
function ease(u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }
function lerp(a, b, u) { return a + (b - a) * u; }

function renderAt(time) {
  const t = Math.max(0, Math.min(SPEC.duration, Number(time) || 0));
  const u = ease(t / SPEC.duration);
  const angle = lerp(-2.35, -0.55, u);
  const radius = lerp(120, 52, u);
  const x = LANDMARK_AT[0] + Math.cos(angle) * radius;
  const z = LANDMARK_AT[1] + Math.sin(angle) * radius;
  const y = Math.max(terrain(x, z) + 6, lerp(48, 17, u));
  camera.position.set(x, y, z);
  camera.fov = lerp(52, 40, u);
  camera.updateProjectionMatrix();
  camera.lookAt(LANDMARK_AT[0], base + lerp(4, 11, u), LANDMARK_AT[1]);
  const fadeIn = Math.min(1, Math.max(0, (t - 0.3) / 1));
  const fadeOut = Math.min(1, Math.max(0, (SPEC.duration * 0.55 - t) / 0.9));
  title.style.opacity = String(Math.min(fadeIn, fadeOut));
  title.style.transform = "translateY(" + ((1 - fadeIn) * 24).toFixed(1) + "px)";
  renderer.render(scene, camera);
}

window.addEventListener("hf-seek", function (event) { renderAt(event.detail.time); });
window.__worldReady = true;
renderAt(window.__hfThreeTime || 0);
`;

/** A deterministic Three.js world project that HyperFrames renders frame by frame via `hf-seek`. */
export function buildWorldProject(spec: WorldSpec): CompositionFiles {
  const json = JSON.stringify(spec).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(spec.title)}</title><style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:Inter,system-ui,sans-serif}
  #c{position:absolute;inset:0;width:100%;height:100%}
  #title{position:absolute;left:6%;bottom:9%;max-width:70%;color:#fff;opacity:0;
    text-shadow:0 2px 18px rgba(0,0,0,.55);font-weight:700;font-size:${Math.max(24, Math.round(spec.width / 30))}px;line-height:1.15}
</style></head>
<body>
  <div data-composition-id="root" data-no-timeline data-start="0" data-duration="${spec.duration}"
       data-width="${spec.width}" data-height="${spec.height}">
    <canvas id="c" width="${spec.width}" height="${spec.height}"></canvas>
    <div id="title">${escapeHtml(spec.title)}</div>
  </div>
  <script>window.__WORLD_SPEC__ = ${json};</script>
  <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.181.2/build/three.module.js"}}</script>
  <script type="module">${worldRuntime}</script>
</body></html>
`;
  return { 'index.html': html };
}
