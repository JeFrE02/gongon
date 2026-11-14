import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { World, TICK, ARENA, WEAPONS, UPGRADES, SHOP } from '../shared/sim.js';
import { initLang, setLang, getLang, t, applyDom, onChange } from './i18n.js';
import survivorUrl from './assets/models/survivor.glb?url';
import zombieUrl from './assets/models/zombie.glb?url';

// ---------------------------------------------------------------------------
// palette (see cook/CRITIQUE.md gate): cold night base, warm off-white squad,
// desaturated cyan-grey horde, amber pickups only.
// ---------------------------------------------------------------------------
const C = {
  night: 0x0b1220, night2: 0x121c2c, slate: 0x2a3a56,
  squad: 0xe8dfd0, horde: 0x6f8a9c, hordeDark: 0x33475a,
  amber: 0xffb454, blood: 0xe0503c, mint: 0x8ef5c8, ice: 0x7fd8ff,
};
const ACCENTS = [C.mint, C.amber, C.ice, C.blood];
// PZ-like oblique iso: narrow fov + high pitch flattens perspective, fixed yaw keeps
// four-direction movement screen-aligned on touch (see cook/PZ-RESEARCH.md).
const FOV = 34;
const PITCH = (48 * Math.PI) / 180;
// oblique iso: camera yawed off the world axes so the ground reads as a diamond, not a top-down grid.
// Movement input is rotated by the same yaw, so W still means "up the screen".
const CAM_YAW = (38 * Math.PI) / 180;
const CAM_DEPTH = 11.0;        // world units of visible depth (PZ frames ~10 tiles)
const HERO_HEIGHT = 1.8;

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// audio: procedural only
// ---------------------------------------------------------------------------
const Audio = {
  ctx: null, on: true,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.ctx = new AC();
  },
  blip(freq, dur, type = 'sine', gain = 0.05, slide = 0) {
    if (!this.on || !this.ctx) return;
    const time = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, time);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), time + dur);
    g.gain.setValueAtTime(gain, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(time); o.stop(time + dur + 0.02);
  },
  noise(dur, gain = 0.05, hp = 800) {
    if (!this.on || !this.ctx) return;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start();
  },
  shoot(w) {
    if (w === 'repeater') this.noise(0.05, 0.028, 1800);
    else if (w === 'scatter') this.noise(0.1, 0.05, 700);
    else { this.noise(0.07, 0.04, 1100); this.blip(220, 0.06, 'triangle', 0.02, -90); }
  },
  hit() { this.blip(140, 0.05, 'square', 0.018, -50); },
  coin() { this.blip(880, 0.07, 'triangle', 0.03, 260); },
  level() { this.blip(520, 0.12, 'sine', 0.04, 180); setTimeout(() => this.blip(780, 0.16, 'sine', 0.035, 120), 80); },
  hurt() { this.noise(0.18, 0.07, 240); this.blip(90, 0.2, 'sawtooth', 0.03, -40); },
  death() { this.blip(160, 0.6, 'sawtooth', 0.05, -110); },
  wave() { this.blip(300, 0.25, 'sine', 0.04, 140); setTimeout(() => this.blip(450, 0.3, 'sine', 0.035, 90), 120); },
  buy() { this.blip(660, 0.08, 'triangle', 0.035, 200); setTimeout(() => this.blip(990, 0.1, 'triangle', 0.03, 80), 70); },
};

// ---------------------------------------------------------------------------
// three setup
// ---------------------------------------------------------------------------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.62;

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.night);
scene.fog = new THREE.FogExp2(0x16222b, 0.0035);

const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 320);
const camTarget = new THREE.Vector3(0, 0, 0);
const camLook = new THREE.Vector3(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xbcd6f0, 0x3d4a38, 2.5));
const key = new THREE.DirectionalLight(0xe6efff, 2.9);
key.position.set(-26, 42, 18);
scene.add(key);
const warm = new THREE.PointLight(C.amber, 55, 46, 2);
warm.position.set(0, 6, -6);
scene.add(warm);
const warm2 = new THREE.PointLight(0xff8a3d, 30, 34, 2);
warm2.position.set(-14, 4, 12);
scene.add(warm2);

// --- ground: procedural canvas texture
function groundTexture() {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = '#26332f'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const r = Math.random() * 5.5 + 0.6;
    const v = 46 + Math.random() * 34;
    g.fillStyle = `rgba(${v + 4},${v + 22},${v + 12},${0.3 + Math.random() * 0.35})`;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  // faint stone tiles
  g.strokeStyle = 'rgba(150,170,190,0.07)'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo((i * s) / 4, 0); g.lineTo((i * s) / 4, s); g.stroke();
    g.beginPath(); g.moveTo(0, (i * s) / 4); g.lineTo(s, (i * s) / 4); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(9, 9);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(ARENA * 2 + 40, ARENA * 2 + 40),
  new THREE.MeshStandardMaterial({ map: groundTexture(), color: 0x6f8579, roughness: 0.95, metalness: 0.02 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// clearing ring: lighter patch under the play area
const clearing = new THREE.Mesh(
  new THREE.CircleGeometry(ARENA * 0.98, 64),
  new THREE.MeshStandardMaterial({ color: 0x556c58, roughness: 0.92, transparent: true, opacity: 0.5 })
);
clearing.rotation.x = -Math.PI / 2;
clearing.position.y = 0.012;
scene.add(clearing);

// --- contact shadow texture
function shadowTexture() {
  const s = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(0,0,0,0.5)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.24)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}
const shadowTex = shadowTexture();
const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), shadowMat, 240);
shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
shadows.renderOrder = 1;
shadows.frustumCulled = false;
scene.add(shadows);

// --- environment: trees, rocks, palisade, torches
const layoutCache = new Map();
function layoutFor(seed) {
  if (!layoutCache.has(seed)) layoutCache.set(seed, new World(seed).obstacles);
  return layoutCache.get(seed);
}
const flames = [];

function buildEnvironment(seed) {
  const obs = layoutFor(seed);
  const trees = obs.filter((o) => o.kind === 'tree');
  const rocks = obs.filter((o) => o.kind === 'rock');

  // decorative forest outside the arena (no collision)
  const rnd = mulberry(seed ^ 0x9e3779b9);
  const outer = [];
  for (let i = 0; i < 150; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = ARENA + 10 + rnd() * 34;
    outer.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, r: 0.9 + rnd() * 1.5 });
  }

  // canopies sit high and small: PZ keeps the play space clear of view-blocking foliage
  // In-arena obstacles are cut stumps and boulders only: nothing inside the play space may
  // block the camera's view of a character (cook/PZ-RESEARCH.md, occlusion by geometry).
  // The tall forest lives outside the palisade, where it reads as a treeline.
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.0, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 1 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const canopyGeo = new THREE.ConeGeometry(0.9, 2.2, 6);
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x3d6353, roughness: 0.95, flatShading: true });
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, outer.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();

  trees.forEach((tr, i) => {
    const s2 = 0.55 + tr.r * 0.3;
    pos.set(tr.x, 0.5 * s2, tr.z); sc.set(s2, s2, s2);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 1.7) % 6.28);
    m.compose(pos, q, sc); trunks.setMatrixAt(i, m);
  });

  outer.forEach((tr, i) => {
    const s2 = tr.r * 1.15;
    pos.set(tr.x, 2.6 * s2, tr.z); sc.set(s2, s2 * 1.25, s2);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 1.7) % 6.28);
    m.compose(pos, q, sc); canopies.setMatrixAt(i, m);
  });

  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  scene.add(trunks, canopies);

  if (rocks.length) {
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x4e5a54, roughness: 1, flatShading: true });
    const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
    rocks.forEach((r, i) => {
      pos.set(r.x, r.r * 0.12, r.z); sc.set(r.r * 0.38, r.r * 0.2, r.r * 0.44);
      q.setFromEuler(new THREE.Euler(rnd() * 0.4, rnd() * 6.28, rnd() * 0.4));
      m.compose(pos, q, sc); rockMesh.setMatrixAt(i, m);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    scene.add(rockMesh);
  }

  // palisade ring with gaps at the four cardinal approaches
  const postGeo = new THREE.BoxGeometry(0.45, 0.8, 0.45);  // knee-high: marks the ring without occluding
  const postMat = new THREE.MeshStandardMaterial({ color: 0x36485c, roughness: 0.95 });
  const posts = [];
  for (let a = 0; a < Math.PI * 2; a += 0.035) {
    const deg = (a * 180) / Math.PI;
    const nearCardinal = [0, 90, 180, 270].some((c) => Math.abs(((deg - c + 540) % 360) - 180) > 172);
    if (nearCardinal) continue;
    posts.push({ x: Math.cos(a) * (ARENA + 1.4), z: Math.sin(a) * (ARENA + 1.4), h: 0.85 + rnd() * 0.3 });
  }
  const palisade = new THREE.InstancedMesh(postGeo, postMat, posts.length);
  posts.forEach((p, i) => {
    pos.set(p.x, 0.4 * p.h, p.z); sc.set(1, p.h, 1);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(p.x, p.z));
    m.compose(pos, q, sc); palisade.setMatrixAt(i, m);
  });
  palisade.instanceMatrix.needsUpdate = true;
  scene.add(palisade);

  // torches at the four gaps, emissive + small point light (2 lights max)
  const torchGeo = new THREE.CylinderGeometry(0.09, 0.12, 2.2, 5);
  const torchMat = new THREE.MeshStandardMaterial({ color: 0x1a2432, roughness: 1 });
  const flameGeo = new THREE.SphereGeometry(0.22, 6, 5);
  const flameMat = new THREE.MeshBasicMaterial({ color: C.amber });
  const torchPositions = [
    [ARENA + 1.0, ARENA + 1.0], [-ARENA - 1.0, ARENA + 1.0],
    [ARENA + 1.0, -ARENA - 1.0], [-ARENA - 1.0, -ARENA - 1.0],
  ];
  torchPositions.forEach(([x, z], i) => {
    const post = new THREE.Mesh(torchGeo, torchMat); post.position.set(x, 1.1, z); scene.add(post);
    const f = new THREE.Mesh(flameGeo, flameMat); f.position.set(x, 2.3, z); scene.add(f);
    if (i < 2) {
      const l = new THREE.PointLight(C.amber, 34, 34, 1.6);
      l.position.set(x, 1.9, z); scene.add(l);
      flames.push({ mesh: f, light: l, base: 34 });
    } else flames.push({ mesh: f, light: null, base: 0 });
  });

  // ground cover: one instanced mesh of grass tufts, cheap depth cue
  const tuftGeo = new THREE.ConeGeometry(0.1, 0.34, 3);
  const tuftMat = new THREE.MeshStandardMaterial({ color: 0x54735f, roughness: 1, flatShading: true });
  const tuftCount = 300;
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftCount);
  for (let i = 0; i < tuftCount; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = 3 + rnd() * (ARENA + 12);
    const s2 = 0.6 + rnd() * 0.9;
    const gx = Math.cos(a) * rad, gz = Math.sin(a) * rad;
    if (Math.abs(gx) < 2.2 || Math.abs(gz) < 2.2) continue; // clear of the road
    pos.set(gx, 0.26 * s2, gz);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    sc.set(s2, s2, s2);
    m.compose(pos, q, sc);
    tufts.setMatrixAt(i, m);
  }
  tufts.instanceMatrix.needsUpdate = true;
  scene.add(tufts);

  // dirt road cross through the clearing: gives the ground a readable structure at iso angle
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x5d5344, roughness: 1 });
  const roadA = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2 + 8, 3.4), roadMat);
  roadA.rotation.x = -Math.PI / 2; roadA.position.y = 0.02; scene.add(roadA);
  const roadB = new THREE.Mesh(new THREE.PlaneGeometry(3.4, ARENA * 2 + 8), roadMat);
  roadB.rotation.x = -Math.PI / 2; roadB.position.y = 0.021; scene.add(roadB);
  const dashMat = new THREE.MeshStandardMaterial({ color: 0x8e8258, roughness: 1 });
  for (let i = -4; i <= 4; i++) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.12), dashMat);
    dash.rotation.x = -Math.PI / 2; dash.position.set(i * 6, 0.025, 0); scene.add(dash);
  }

  // outpost clutter: crates and low walls just inside the palisade, never over the play centre
  const crateGeo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6a5334, roughness: 0.95 });
  const wallGeo = new THREE.BoxGeometry(3.4, 1.5, 0.5);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5b5f5a, roughness: 0.98 });
  const clutter = [];
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = ARENA - 2.5 - rnd() * 3;
    clutter.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, a, wall: rnd() < 0.45 });
  }
  for (const c of clutter) {
    if (c.wall) {
      const w = new THREE.Mesh(wallGeo, wallMat);
      w.position.set(c.x, 0.75, c.z);
      w.rotation.y = c.a;
      scene.add(w);
    } else {
      const k = new THREE.Mesh(crateGeo, crateMat);
      k.position.set(c.x, 0.55, c.z);
      k.rotation.y = c.a;
      k.scale.setScalar(0.75 + rnd() * 0.5);
      scene.add(k);
    }
  }

  // central outpost banner (visual anchor at spawn)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 6, 6), new THREE.MeshStandardMaterial({ color: 0x1a2432 }));
  pole.position.set(-6.5, 2.6, -ARENA + 3.2); scene.add(pole);
  const bannerCloth = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x8b98a6, roughness: 0.92, side: THREE.DoubleSide, emissive: 0x141a22 })
  );
  bannerCloth.position.set(-5.4, 3.6, -ARENA + 3.2); bannerCloth.scale.setScalar(0.62); scene.add(bannerCloth);
  const emblem = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.6, 3), new THREE.MeshBasicMaterial({ color: 0x8f3a30, side: THREE.DoubleSide }));
  emblem.position.set(-5.4, 3.78, -ARENA + 3.22); emblem.scale.setScalar(0.62); scene.add(emblem);
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let tt = Math.imul(a ^ (a >>> 15), 1 | a);
    tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
    return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// assets: real CC BY 3.0 rigged models by Quaternius (credits in public/CREDITS.md)
// ---------------------------------------------------------------------------
const RIGS = { survivor: null, zombie: null };
const ZOMBIE_TINTS = [0x7d8a6c, 0x74808c, 0x8d8266, 0x876e69, 0x718267];
const zombieMats = [];
const flashMat = new THREE.MeshStandardMaterial({ color: 0xfff2e0, emissive: 0xffc89a, emissiveIntensity: 1.6, roughness: 0.6 });

function prepareRig(gltf, name) {
  const sceneRoot = gltf.scene;
  sceneRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(sceneRoot);
  const height = Math.max(0.001, box.max.y - box.min.y);
  const rig = { scene: sceneRoot, animations: gltf.animations || [], height, footY: box.min.y, name };
  sceneRoot.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) if (mat) mat.side = THREE.FrontSide;
    }
  });
  return rig;
}

function clipByName(rig, ...patterns) {
  for (const p of patterns) {
    const found = rig.animations.find((a) => a.name === p) || rig.animations.find((a) => a.name.toLowerCase().includes(p.toLowerCase()));
    if (found) return found;
  }
  return null;
}

function makeChar(rig, { targetHeight = HERO_HEIGHT, tint = null, materialFilter = null } = {}) {
  const group = new THREE.Group();
  const model = skeletonClone(rig.scene);
  const s = targetHeight / rig.height;
  model.scale.setScalar(s);
  model.position.y = -rig.footY * s;
  group.add(model);

  const mats = [];
  const meshes = [];
  model.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const apply = (mat) => {
      const cl = mat.clone();
      if (tint) cl.color = new THREE.Color(tint);
      if (materialFilter) materialFilter(cl, o);
      mats.push(cl);
      return cl;
    };
    o.material = Array.isArray(o.material) ? o.material.map(apply) : apply(o.material);
    meshes.push(o);
  });

  const mixer = new THREE.AnimationMixer(model);
  return { group, model, mixer, mats, meshes, actions: {}, current: '', oneShot: 0, oneShotName: '' };
}

function addActions(ch, rig, map) {
  for (const [state, clip] of Object.entries(map)) {
    if (clip) ch.actions[state] = ch.mixer.clipAction(clip);
  }
}

const SURVIVOR_CLIPS = () => ({
  idle: clipByName(RIGS.survivor, 'CharacterArmature|Idle', 'Idle'),
  walk: clipByName(RIGS.survivor, 'CharacterArmature|Walk', 'Walk'),
  run: clipByName(RIGS.survivor, 'CharacterArmature|Run', 'Run'),
  shoot: clipByName(RIGS.survivor, 'CharacterArmature|Gun_Shoot', 'Gun_Shoot'),
  death: clipByName(RIGS.survivor, 'CharacterArmature|Death', 'Death'),
  hit: clipByName(RIGS.survivor, 'CharacterArmature|HitRecieve', 'HitRecieve'),
});
const ZOMBIE_CLIPS = () => ({
  // the pack's ZombieIdle is a floor pose; standing zombies keep shambling on the walk clip
  idle: clipByName(RIGS.zombie, 'Zombie|ZombieWalk', 'ZombieWalk'),
  walk: clipByName(RIGS.zombie, 'Zombie|ZombieWalk', 'ZombieWalk'),
  run: clipByName(RIGS.zombie, 'Zombie|ZombieRun', 'ZombieRun'),
  bite: clipByName(RIGS.zombie, 'Zombie|ZombieBite', 'ZombieBite'),
  crawl: clipByName(RIGS.zombie, 'Zombie|ZombieCrawl', 'ZombieCrawl'),
});

function playState(ch, state, fade = 0.2) {
  if (ch.current === state) return;
  const next = ch.actions[state];
  if (!next) return;
  const prev = ch.actions[ch.current];
  next.reset();
  next.setLoop(THREE.LoopRepeat, Infinity);
  next.enabled = true;
  next.setEffectiveWeight(1);
  next.fadeIn(fade).play();
  if (prev) prev.fadeOut(fade);
  ch.current = state;
}

function playOnce(ch, state, duration, fade = 0.12) {
  const act = ch.actions[state];
  if (!act || ch.oneShot > 0) return;
  act.reset();
  act.setLoop(THREE.LoopOnce, 1);
  act.clampWhenFinished = true;
  act.enabled = true;
  act.setEffectiveWeight(1);
  act.fadeIn(fade).play();
  ch.oneShot = duration;
  ch.oneShotName = state;
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------
const view = {
  players: new Map(), enemies: new Map(), heroes: new Map(),
  squad: [], squadPrev: [], zombiePool: [], zombieFree: [],
  squadPool: [], squadFree: [], seed: 1,
};

// ---------------------------------------------------------------------------
// GonGon's own art: every character wears a tall red conical hat, a rigid prop
// parented to the head bone so it follows the animation. Height and tilt vary per
// unit so a crowd never reads as one silhouette (see cook/ROUNDS.md style note).
// ---------------------------------------------------------------------------
const HAT_RED = 0xc0271d;
const hatGeo = new THREE.ConeGeometry(0.26, 1.0, 14, 1, false);
const hatBrimGeo = new THREE.CylinderGeometry(0.27, 0.29, 0.045, 14);
const hatTipGeo = new THREE.SphereGeometry(0.055, 8, 6);

function hatMaterial(scale) {
  const m = new THREE.MeshStandardMaterial({
    color: HAT_RED, roughness: 0.72, metalness: 0.02,
    emissive: 0x4a0b06, emissiveIntensity: 0.55,
  });
  m.userData.hat = true;
  return m;
}

// parent a cone to the head bone, counter-rotated and counter-scaled once so it stands
// world-up at bind size; the head bone then carries it through every animation
function addHat(ch, { height = 0.62, radius = 1, tilt = 0, shade = 1 } = {}) {
  let head = null;
  ch.model.traverse((o) => { if (!head && o.isBone && o.name === 'Head') head = o; });
  if (!head) ch.model.traverse((o) => { if (!head && o.isBone && /head/i.test(o.name)) head = o; });
  if (!head) return null;
  ch.model.updateWorldMatrix(true, true);

  const hat = new THREE.Group();
  const mat = hatMaterial();
  mat.color.offsetHSL(0, 0, (shade - 1) * 0.12);
  const cone = new THREE.Mesh(hatGeo, mat);
  cone.scale.set(radius, height, radius);
  cone.position.y = height * 0.5;
  hat.add(cone);
  const brim = new THREE.Mesh(hatBrimGeo, mat);
  brim.scale.setScalar(radius);
  hat.add(brim);
  const tip = new THREE.Mesh(hatTipGeo, mat);
  tip.position.y = height;
  hat.add(tip);

  const wq = new THREE.Quaternion();
  const wp = new THREE.Vector3();
  const ws = new THREE.Vector3();
  head.getWorldQuaternion(wq);
  head.getWorldPosition(wp);
  head.getWorldScale(ws);

  hat.quaternion.copy(wq.invert());          // cancel the bind orientation
  hat.scale.setScalar(1 / Math.max(ws.y, 1e-6));
  hat.position.copy(head.worldToLocal(wp.clone().add(new THREE.Vector3(0, height * 0.34, 0))));
  hat.rotateZ(tilt);
  head.add(hat);
  ch.hat = hat;
  return hat;
}

// Survivor clothing is re-coloured by material name: warm sand jacket and trousers so the
// squad is the brightest thing on the ground (readability gate), skin and boots left natural.
const SURVIVOR_MAP = {
  swat: 0x22303f,   // dark navy jacket
  black: 0x22262c,  // boots, belt
  grey: 0xd6cbb0,   // cream trousers
  brown: 0x6d5236,  // leather straps
  skin: 0xd9a582,
  hair_brown: 0x3a2a1c,
};
function paintSurvivor(mats, accent) {
  for (const mat of mats) {
    const key = String(mat.name || '').toLowerCase();
    if (SURVIVOR_MAP[key] != null) mat.color.setHex(SURVIVOR_MAP[key]);
    else mat.color.setHex(0x2a3542);
    mat.emissive = new THREE.Color(0x12100c);
    mat.emissiveIntensity = 0.45;
    mat.roughness = 0.82;
    mat.metalness = 0;
  }
  // one accent detail only: a scarf/collar band, so co-op players read apart without a ring
  for (const mat of mats) if (/swat/i.test(mat.name || '')) mat.color.lerp(new THREE.Color(accent), 0.22);
}

function makeHero(isMe, accent) {
  const ch = makeChar(RIGS.survivor, { targetHeight: HERO_HEIGHT });
  addActions(ch, RIGS.survivor, SURVIVOR_CLIPS());
  paintSurvivor(ch.mats, accent);
  addHat(ch, { height: 0.92, radius: 1.0, tilt: 0.02 });
  // a carried weapon reads as "armed survivor" at iso distance
  const weapon = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.07, 0.86),
    new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.7, emissive: 0x120c06 })
  );
  weapon.position.set(0.24, 1.02, 0.34);
  weapon.rotation.x = 0.35;
  ch.model.add(weapon);
  if (isMe) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.8, 28),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ch.group.add(ring);
  }
  playState(ch, 'idle', 0);
  scene.add(ch.group);
  return ch;
}

function makeZombie(type) {
  const ch = makeChar(RIGS.zombie, {
    targetHeight: type === 'boss' ? HERO_HEIGHT * 1.55 : type === 'brute' ? HERO_HEIGHT * 1.12 : HERO_HEIGHT * 0.97,
  });
  addActions(ch, RIGS.zombie, ZOMBIE_CLIPS());
  // decayed, tattered palette: muddy tint over the atlas, never a neon enemy color
  const tint = type === 'boss' ? 0x8a6355 : type === 'brute' ? 0x6f7d63 : ZOMBIE_TINTS[(Math.random() * ZOMBIE_TINTS.length) | 0];
  for (const mat of ch.mats) {
    mat.color.setHex(tint);
    mat.roughness = 0.98;
    mat.metalness = 0;
    mat.emissive = new THREE.Color(0x1d2418);
    mat.emissiveIntensity = 0.7;
  }
  ch.meshMats = ch.meshes.map((o) => o.material);
  ch.flashing = false;
  ch.type = type;
  ch.shambles = true;
  // hunched posture: the single strongest silhouette cue vs the upright survivor
  ch.model.rotation.x = type === 'boss' ? 0.18 : type === 'brute' ? 0.14 : 0.11;
  // ragged mismatch: upper and lower body get different low-saturation tints
  const upper = new THREE.Color(tint).offsetHSL(0.02, -0.04, -0.09);
  ch.mats.forEach((mat, i) => mat.color.copy(i === 0 ? upper : new THREE.Color(tint)));
  addHat(ch, {
    height: type === 'boss' ? 1.4 : type === 'brute' ? 1.05 : 0.86 + Math.random() * 0.12,
    radius: type === 'boss' ? 1.2 : type === 'brute' ? 1.1 : 0.95 + Math.random() * 0.1,
    tilt: (Math.random() - 0.5) * 0.16,
    shade: type === 'boss' ? 0.82 : 1,
  });
  playState(ch, 'walk', 0);
  scene.add(ch.group);
  return ch;
}

function makeSquad() {
  const ch = makeChar(RIGS.survivor, { targetHeight: HERO_HEIGHT * 0.96 });
  addActions(ch, RIGS.survivor, SURVIVOR_CLIPS());
  paintSurvivor(ch.mats, 0xcfc6b4);
  addHat(ch, { height: 0.8, radius: 0.92, tilt: -0.03, shade: 0.92 });
  playState(ch, 'idle', 0);
  scene.add(ch.group);
  return ch;
}

function takeZombie(type) {
  for (let i = view.zombieFree.length - 1; i >= 0; i--) {
    const ch = view.zombieFree[i];
    if (ch.type === type) { view.zombieFree.splice(i, 1); ch.group.visible = true; return ch; }
  }
  const ch = makeZombie(type);
  view.zombiePool.push(ch);
  return ch;
}

function freeZombie(ch) {
  ch.group.visible = false;
  ch.oneShot = 0;
  view.zombieFree.push(ch);
}

function takeSquad() {
  const ch = view.squadFree.pop() || (() => { const s = makeSquad(); view.squadPool.push(s); return s; })();
  ch.group.visible = true;
  return ch;
}

function resetView() {
  view.players.clear(); view.enemies.clear();
  for (const [, h] of view.heroes) { scene.remove(h.group); h.mixer.stopAllAction(); }
  view.heroes.clear();
  for (const z of view.zombiePool) freeZombie(z);
  view.squad.length = 0; view.squadPrev.length = 0;
  for (const s of view.squadPool) { s.group.visible = false; view.squadFree.push(s); }
}

function heroFor(id, accent, isMe) {
  if (!view.heroes.has(id)) view.heroes.set(id, makeHero(isMe, accent));
  return view.heroes.get(id);
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
const keys = new Set();
const touchDirs = new Set();
const input = { x: 0, z: 0, dash: false, reload: false };

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.add(k); e.preventDefault(); }
  if (k === ' ') { input.dash = true; e.preventDefault(); }
  if (k === 'r') input.reload = true;
  if (k === 'b') toggleShop();
  if (k === 'escape') togglePause();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

document.querySelectorAll('.pad-btn').forEach((btn) => {
  const dir = btn.dataset.dir;
  const on = (e) => { e.preventDefault(); touchDirs.add(dir); btn.classList.add('on'); Audio.init(); };
  const off = (e) => { e.preventDefault(); touchDirs.delete(dir); btn.classList.remove('on'); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('pointerleave', off);
});
$('#btnDash').addEventListener('pointerdown', (e) => { e.preventDefault(); input.dash = true; });
$('#btnReload').addEventListener('pointerdown', (e) => { e.preventDefault(); input.reload = true; });
$('#btnShop').addEventListener('pointerdown', (e) => { e.preventDefault(); toggleShop(); });

function readInput() {
  let sx = 0, sz = 0;
  if (keys.has('a') || keys.has('arrowleft') || touchDirs.has('left')) sx -= 1;
  if (keys.has('d') || keys.has('arrowright') || touchDirs.has('right')) sx += 1;
  if (keys.has('w') || keys.has('arrowup') || touchDirs.has('up')) sz -= 1;
  if (keys.has('s') || touchDirs.has('down') || keys.has('arrowdown')) sz += 1;
  const m = Math.hypot(sx, sz) || 1;
  sx /= m; sz /= m;
  // screen space -> world space, rotated by the camera yaw
  const c = Math.cos(CAM_YAW), sn = Math.sin(CAM_YAW);
  input.x = sx * c + sz * sn;
  input.z = -sx * sn + sz * c;
  return input;
}

// ---------------------------------------------------------------------------
// game state
// ---------------------------------------------------------------------------
const G = {
  mode: null, // 'solo' | 'coop'
  world: null, me: null, myId: 'you',
  ws: null, code: null, connected: false,
  paused: false, running: false, over: false, ready: false,
  lastSnap: null, snapTime: 0, prevSnap: null,
  prediction: { x: 0, z: 0, active: false },
  seenEvents: 0, name: 'Ranger', muted: false,
  startedAt: 0,
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

let toastTimer = 0;
function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

let bannerTimer = 0;
function banner(main, sub = '') {
  const b = $('#banner');
  b.innerHTML = `${main}${sub ? `<small>${sub}</small>` : ''}`;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------------
// coop server URL: explicit field > same-origin page > desktop error
// ---------------------------------------------------------------------------
const COOP_KEY = 'gongon.coopUrl';

function normalizeWsUrl(raw) {
  let s = String(raw).trim();
  if (!s) throw new Error('empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `ws://${s}`;
  const u = new URL(s); // throws on garbage
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('unsupported scheme');
  if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
  return u.toString();
}

function resolveCoopUrl() {
  const raw = ($('#coopInput')?.value || '').trim();
  if (raw) return normalizeWsUrl(raw);
  const p = location.protocol;
  if (p === 'http:' || p === 'https:') return `${p === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  if (window.gongonDesktop?.isDesktop) throw new Error(t('err.coopNoUrl'));
  throw new Error(t('err.noServer'));
}

function rememberCoopUrl() {
  const raw = ($('#coopInput')?.value || '').trim();
  try {
    if (raw) localStorage.setItem(COOP_KEY, raw);
    else localStorage.removeItem(COOP_KEY);
  } catch {}
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------
function startSolo() {
  Audio.init();
  G.mode = 'solo';
  G.myId = 'you';
  G.world = new World((Math.random() * 1e9) | 0, { solo: true });
  G.world.addPlayer('you', G.name);
  resetView();
  buildEnvironment(G.world.seed);
  beginRun();
}

async function startCoop(mode, code) {
  Audio.init();
  G.mode = 'coop';
  resetView();
  $('#coopErr').textContent = '';
  let url;
  try {
    url = resolveCoopUrl();
  } catch (err) {
    const msg = t('err.coop', { msg: err.message });
    $('#coopErr').textContent = msg;
    toast(msg, 4200);
    return;
  }
  rememberCoopUrl();
  try {
    const ws = new WebSocket(url);
    G.ws = ws;
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(t('err.cannotReach', { url })));
      setTimeout(() => rej(new Error(t('err.timeout', { url }))), 6000);
    });
    ws.onmessage = onServerMessage;
    ws.onclose = () => {
      if (G.running && !G.over) { toast(t('run.disconnected')); endRun(t('run.connLost')); }
    };
    ws.send(JSON.stringify({ t: mode, code, name: G.name }));
  } catch (err) {
    const msg = t('err.coop', { msg: err.message });
    $('#coopErr').textContent = msg;
    toast(msg, 4200);
    hide($('#menu'));
    show($('#menu'));
  }
}

function onServerMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.t === 'welcome') {
    G.myId = m.you; G.code = m.code; G.seed = m.seed;
    buildEnvironment(m.seed);
    $('#roomHint').textContent = t('run.roomHint', { code: m.code });
    beginRun();
    toast(t('run.roomToast', { code: m.code }));
  } else if (m.t === 'error') {
    toast(translateServerError(m.msg), 2600);
    G.ws?.close();
    show($('#menu'));
  } else if (m.t === 'snap') {
    G.prevSnap = G.lastSnap;
    G.lastSnap = m;
    G.snapTime = performance.now();
    handleEvents(m.ev || []);
  } else if (m.t === 'over') {
    endRun(t('over.titleFell'), { wave: m.wave, kills: m.kills });
  }
}

// server sends stable English literals; map the known ones, show anything else as-is
function translateServerError(msg) {
  if (msg === 'Room not found') return t('err.roomNotFound');
  if (msg === 'Room is full (4)') return t('err.roomFull');
  return msg;
}

function beginRun() {
  G.running = true; G.over = false; G.paused = false;
  G.connected = true;
  G.startedAt = performance.now();
  hide($('#menu')); hide($('#over')); hide($('#pause'));
  show($('#hud'));
  show($('#touch'));
  $('#roomHint').textContent = G.mode === 'coop' ? t('run.room', { code: G.code }) : t('run.solo');
  const hint = $('#centerHint');
  hint.textContent = G.mode === 'coop' ? t('run.moveCoop') : t('run.moveSolo');
  hint.style.opacity = '1';
  setTimeout(() => { hint.style.opacity = '0'; }, 4200);
  banner(t('run.waveBanner', { n: 1 }), t('run.waveSub'));
  if (G.mode === 'solo') { G.world.drainEvents(); }
}

function endRun(title, stats) {
  if (G.over) return;
  G.over = true; G.running = false;
  const p = localPlayer();
  hide($('#hud')); hide($('#touch')); hide($('#upgrades')); hide($('#shop')); hide($('#pause'));
  show($('#over'));
  $('#overEyebrow').textContent = title === t('run.connLost') ? t('over.lost') : t('over.fell');
  $('#overTitle').dataset.lost = title === t('run.connLost') ? '1' : '';
  $('#overTitle').textContent = title;
  const wave = stats?.wave ?? G.world?.wave ?? G.lastSnap?.wave ?? 0;
  const kills = stats?.kills ?? G.world?.kills ?? G.lastSnap?.kills ?? 0;
  const coins = p?.coins ?? 0;
  $('#overStats').innerHTML = `
    <div><span>${t('over.wave')}</span><b>${wave}</b></div>
    <div><span>${t('over.slain')}</span><b>${kills}</b></div>
    <div><span>${t('over.coins')}</span><b>${coins}</b></div>`;
  G.ws?.close();
}

function localPlayer() {
  if (G.mode === 'solo') return G.world?.players.get('you');
  if (G.lastSnap) return G.lastSnap.players.find((p) => p.id === G.myId);
  return null;
}

// ---------------------------------------------------------------------------
// events → audio / fx
// ---------------------------------------------------------------------------
function handleEvents(evs) {
  for (const e of evs) {
    if (e.kind === 'shoot') {
      Audio.shoot(e.weapon);
      const h = view.heroes.get(e.id);
      if (h) playOnce(h, 'shoot', 0.35);
    } else if (e.kind === 'hit') Audio.hit();
    else if (e.kind === 'coin') Audio.coin();
    else if (e.kind === 'level') { Audio.level(); }
    else if (e.kind === 'hurt') { if (e.id === G.myId) { Audio.hurt(); shake(0.5); } }
    else if (e.kind === 'death') { if (e.id === G.myId) Audio.death(); }
    else if (e.kind === 'wave') { Audio.wave(); banner(t('run.waveBanner', { n: e.wave }), e.boss ? t('run.bossSub') : ''); }
    else if (e.kind === 'clear') { banner(t('run.cleared'), t('run.clearedSub')); }
    else if (e.kind === 'buy') Audio.buy();
    else if (e.kind === 'bossdown') { banner(t('run.bossDown'), ''); }
  }
}

let shakeAmt = 0;
function shake(a) { shakeAmt = Math.min(1.2, shakeAmt + a); }

// ---------------------------------------------------------------------------
// simulation drivers
// ---------------------------------------------------------------------------
let acc = 0;
let lastFrame = performance.now();

function stepSolo(dt) {
  const w = G.world;
  const p = w.players.get('you');
  if (!p) return;
  if (p.offers || G.paused) { w.drainEvents(); return; }
  const inp = readInput();
  w.setInput('you', inp);
  input.dash = false; input.reload = false;
  acc += dt;
  let steps = 0;
  while (acc >= TICK && steps < 4) { w.step(TICK); acc -= TICK; steps++; }
  handleEvents(w.drainEvents());
  if (w.phase === 'over') endRun(t('over.titleFell'), { wave: w.wave, kills: w.kills });
}

let netAcc = 0;
function stepCoop(dt) {
  if (!G.connected) return;
  netAcc += dt;
  if (netAcc >= 0.05) {
    netAcc = 0;
    const inp = readInput();
    if (G.ws?.readyState === 1) G.ws.send(JSON.stringify({ t: 'input', x: +inp.x.toFixed(3), z: +inp.z.toFixed(3), dash: input.dash, reload: input.reload }));
    input.dash = false; input.reload = false;
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function cameraDistance() {
  const aspect = innerWidth / innerHeight;
  const vert = 2 * Math.tan((FOV * Math.PI) / 360);
  const dVert = CAM_DEPTH / vert;
  const dHorz = (CAM_DEPTH * 0.82) / (vert * Math.max(aspect, 0.35));
  return clamp(Math.max(dVert, dHorz), 16, 62);
}

function updateCamera(dt, focus) {
  const d = cameraDistance();
  camTarget.x += (focus.x - camTarget.x) * Math.min(1, dt * 6);
  camTarget.z += (focus.z - camTarget.z) * Math.min(1, dt * 6);
  if (shakeAmt > 0.001) {
    shakeAmt *= Math.pow(0.02, dt);
    camTarget.x += (Math.random() - 0.5) * shakeAmt * 0.5;
    camTarget.z += (Math.random() - 0.5) * shakeAmt * 0.5;
  }
  const height = Math.sin(PITCH) * d;
  const back = Math.cos(PITCH) * d;
  camera.position.set(camTarget.x + Math.sin(CAM_YAW) * back, height, camTarget.z + Math.cos(CAM_YAW) * back);
  camLook.set(camTarget.x, 0, camTarget.z);
  camera.lookAt(camLook);
}

// one shared step for every character, distance-gated so far units cost no CPU
function stepChar(ch, dt, moving, far) {
  if (ch.oneShot > 0) {
    ch.oneShot -= dt;
    if (ch.oneShot <= 0) ch.current = '';
  }
  if (!far) ch.mixer.update(dt);
  if (ch.oneShot > 0) return;
  // zombies shamble (walk clip); survivors run. Keeps the two gaits visibly different.
  playState(ch, moving ? (ch.shambles ? 'walk' : 'run') : 'idle');
}

function renderView(dt) {
  let shadowIdx = 0;
  const addShadow = (x, z, scale) => {
    if (shadowIdx >= 240) return;
    tmpP.set(x, 0.022, z); tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); tmpS.set(scale, scale, 1);
    tmpM.compose(tmpP, tmpQ, tmpS); shadows.setMatrixAt(shadowIdx++, tmpM);
  };
  const now = performance.now();

  // ---- players
  const solo = G.mode === 'solo';
  const snapPlayers = solo
    ? [...G.world.players.values()].map((p) => ({
        id: p.id, name: p.name, x: p.x, z: p.z, sp: p.speed, hp: p.hp, maxHp: p.maxHp,
        lvl: p.lvl, xp: p.xp, xpNext: p.xpNext, weapon: p.weapon, ammo: p.ammo,
        mag: WEAPONS[p.weapon].mag, reloading: p.reloadT > 0, dead: p.dead,
        respawnT: p.respawnT, coins: p.coins, kills: p.kills, offers: p.offers,
        squad: p.squad.map((s) => [s.x ?? p.x, s.z ?? p.z]),
      }))
    : (G.lastSnap?.players || []);

  const seen = new Set();
  snapPlayers.forEach((sp, idx) => {
    seen.add(sp.id);
    let v = view.players.get(sp.id);
    if (!v) { v = { x: sp.x, z: sp.z, hp: sp.hp, px: sp.x, pz: sp.z }; view.players.set(sp.id, v); }
    const isMe = sp.id === G.myId;
    if (isMe && G.mode === 'coop') {
      const inp = readInput();
      const spd = sp.sp || 8.4;
      v.x += inp.x * spd * dt;
      v.z += inp.z * spd * dt;
      const err = Math.hypot(v.x - sp.x, v.z - sp.z);
      if (err > 2.2) { v.x = sp.x; v.z = sp.z; }
      else { v.x += (sp.x - v.x) * Math.min(1, dt * 3); v.z += (sp.z - v.z) * Math.min(1, dt * 3); }
    } else {
      const k = Math.min(1, dt * 14);
      v.x += (sp.x - v.x) * k; v.z += (sp.z - v.z) * k;
    }
    const hero = heroFor(sp.id, ACCENTS[idx % ACCENTS.length], isMe);
    const dx = v.x - v.px, dz = v.z - v.pz;
    const moving = Math.hypot(dx, dz) > 0.012;
    if (moving) hero.group.rotation.y = Math.atan2(dx, dz);
    hero.group.position.set(v.x, 0, v.z);
    hero.group.visible = !sp.dead;
    v.px = v.x; v.pz = v.z;
    stepChar(hero, dt, moving, false);
    addShadow(v.x, v.z, 1.15);

    sp.squad.forEach(([sx, sz]) => { view.squad.push([sx, sz]); });

    if (isMe) {
      updateCamera(dt, v);
      updateAmmoHud(sp);
    }
  });
  for (const [id, hero] of view.heroes) if (!seen.has(id)) { scene.remove(hero.group); view.heroes.delete(id); }

  // ---- squad spirits: armed survivors in V formation
  const nSquad = view.squad.length;
  while (view.squadPool.length < nSquad) { const s = makeSquad(); view.squadPool.push(s); }
  for (let i = 0; i < view.squadPool.length; i++) {
    const ch = view.squadPool[i];
    if (i >= nSquad) { ch.group.visible = false; continue; }
    const [x, z] = view.squad[i];
    const prev = view.squadPrev[i];
    const dx = prev ? x - prev[0] : 0;
    const dz = prev ? z - prev[1] : 0;
    const moving = Math.hypot(dx, dz) > 0.012;
    if (moving) ch.group.rotation.y = Math.atan2(dx, dz);
    ch.group.position.set(x, 0, z);
    ch.group.visible = true;
    view.squadPrev[i] = [x, z];
    stepChar(ch, dt, moving, false);
    addShadow(x, z, 1.0);
  }
  view.squadPrev.length = nSquad;
  view.squad.length = 0;

  // ---- enemies: real animated zombie characters, capped and pooled
  const enemySource = solo ? G.world.enemies : (G.lastSnap?.enemies || []);
  const eseen = new Set();
  let zi = 0;
  for (const raw of enemySource) {
    const id = solo ? raw.id : raw[0];
    const type = solo ? raw.type : raw[1];
    const ex = solo ? raw.x : raw[2];
    const ez = solo ? raw.z : raw[3];
    const flash = solo ? raw.flash > 0 : raw[5];
    eseen.add(id);
    let v = view.enemies.get(id);
    if (!v) { v = { x: ex, z: ez, px: ex, pz: ez, type, ch: null, biteT: Math.random() * 2 }; view.enemies.set(id, v); }
    const k = Math.min(1, dt * 16);
    v.x += (ex - v.x) * k; v.z += (ez - v.z) * k;
    const dx = v.x - v.px, dz = v.z - v.pz;
    const speed = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    const ch = v.ch || (v.ch = takeZombie(type));
    ch.group.position.set(v.x, 0, v.z);
    if (speed > 0.15) ch.group.rotation.y = Math.atan2(dx, dz);
    const far = (v.x - camTarget.x) ** 2 + (v.z - camTarget.z) ** 2 > 46 * 46;
    stepChar(ch, dt, speed > 0.15, far);
    // bite: contact with any player reads as an attack
    v.biteT -= dt;
    let close = false;
    for (const sp of snapPlayers) {
      if (sp.dead) continue;
      if ((v.x - sp.x) ** 2 + (v.z - sp.z) ** 2 < 2.4 * 2.4) { close = true; break; }
    }
    if (close && v.biteT <= 0 && !ch.oneShot) {
      playOnce(ch, 'bite', 0.75);
      v.biteT = 1.1 + Math.random() * 0.8;
    }
    // hit flash: swap to the shared hot material, then restore each mesh's own material
    if (flash !== ch.flashing) {
      ch.flashing = flash;
      for (let mi = 0; mi < ch.meshes.length; mi++) {
        ch.meshes[mi].material = flash ? flashMat : ch.meshMats[mi];
      }
    }
    addShadow(v.x, v.z, type === 'boss' ? 2.6 : type === 'brute' ? 1.5 : 1.1);
    v.px = v.x; v.pz = v.z;
    zi++;
  }
  for (const [id, v] of view.enemies) {
    if (eseen.has(id)) continue;
    if (v.ch) freeZombie(v.ch);
    view.enemies.delete(id);
  }

  // ---- bullets
  const snapBullets = solo
    ? G.world.bullets.map((b) => [b.x, b.z, b.tint, Math.atan2(b.vz, b.vx)])
    : (G.lastSnap?.bullets || []).map((b) => [b[0], b[1], b[2], 0]);
  bulletMesh.count = Math.min(snapBullets.length, 260);
  snapBullets.slice(0, 260).forEach(([x, z, tint, ang], i) => {
    tmpP.set(x, 0.95, z);
    tmpQ.setFromAxisAngle(up, -ang);
    tmpS.setScalar(1);
    tmpM.compose(tmpP, tmpQ, tmpS);
    bulletMesh.setMatrixAt(i, tmpM);
  });
  bulletMesh.instanceMatrix.needsUpdate = true;

  // ---- orbs
  const snapOrbs = solo ? G.world.orbs.map((o) => [o.x, o.z]) : (G.lastSnap?.orbs || []);
  orbMesh.count = Math.min(snapOrbs.length, 200);
  snapOrbs.slice(0, 200).forEach(([x, z], i) => {
    tmpP.set(x, 0.42 + Math.sin(now / 320 + i) * 0.09, z);
    tmpQ.setFromAxisAngle(up, now / 500 + i);
    tmpS.setScalar(1);
    tmpM.compose(tmpP, tmpQ, tmpS); orbMesh.setMatrixAt(i, tmpM);
  });
  orbMesh.instanceMatrix.needsUpdate = true;

  // ---- pickups
  const snapPickups = solo ? G.world.pickups.map((kk) => [kk.x, kk.z, kk.kind]) : (G.lastSnap?.pickups || []);
  pickupMesh.count = Math.min(snapPickups.length, 40);
  snapPickups.slice(0, 40).forEach(([x, z, kind], i) => {
    tmpP.set(x, 0.7 + Math.sin(now / 400 + i) * 0.12, z);
    tmpQ.setFromAxisAngle(up, now / 600 + i);
    tmpS.setScalar(kind === 'weapon' ? 1.15 : 1);
    tmpM.compose(tmpP, tmpQ, tmpS); pickupMesh.setMatrixAt(i, tmpM);
  });
  pickupMesh.instanceMatrix.needsUpdate = true;

  shadows.count = shadowIdx;
  shadows.instanceMatrix.needsUpdate = true;

  // torch flicker
  for (const f of flames) {
    const tt = now / 130;
    const s = 0.85 + Math.sin(tt) * 0.1 + Math.sin(tt * 2.7) * 0.06;
    f.mesh.scale.setScalar(s);
    if (f.light) f.light.intensity = f.base * s;
  }
  warm.intensity = 24 + Math.sin(now / 220) * 3;
}

const bulletMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.55, 0.09, 0.09),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
  260
);
bulletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bulletMesh.frustumCulled = false;
bulletMesh.count = 0;
scene.add(bulletMesh);

const orbMesh = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.19, 0),
  new THREE.MeshBasicMaterial({ color: C.amber }),
  200
);
orbMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
orbMesh.frustumCulled = false;
scene.add(orbMesh);

const pickupMesh = new THREE.InstancedMesh(
  new THREE.OctahedronGeometry(0.42, 0),
  new THREE.MeshStandardMaterial({ color: C.amber, emissive: C.amber, emissiveIntensity: 0.6, roughness: 0.5 }),
  40
);
pickupMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pickupMesh.frustumCulled = false;
scene.add(pickupMesh);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
let lastOffers = '';
function updateAmmoHud(sp) {
  $('#weaponName').textContent = t(`weapon.${sp.weapon}`);
  $('#ammoNum').textContent = sp.ammo;
  $('#ammoMax').textContent = `/${sp.mag}`;
  const pips = $('#ammoPips');
  if (pips.childElementCount !== sp.mag) {
    pips.innerHTML = '';
    for (let i = 0; i < sp.mag; i++) pips.appendChild(document.createElement('i'));
  }
  [...pips.children].forEach((el, i) => el.classList.toggle('spent', i >= sp.ammo));
  const bar = $('.reload-bar');
  bar.classList.toggle('on', !!sp.reloading);
  if (sp.reloading) {
    const def = WEAPONS[sp.weapon];
    const prog = clamp(1 - (sp.reloadT ?? 0) / def.reload, 0, 1);
    $('#reloadFill').style.width = `${prog * 100}%`;
  }
}

function updateHud() {
  const p = localPlayer();
  if (!p) return;
  $('#waveNum').textContent = G.mode === 'solo' ? G.world.wave : (G.lastSnap?.wave ?? 0);
  $('#killNum').textContent = G.mode === 'solo' ? G.world.kills : (G.lastSnap?.kills ?? 0);
  $('#coinNum').textContent = p.coins;

  const list = G.mode === 'solo'
    ? [...G.world.players.values()].map((q) => ({ id: q.id, name: q.name, hp: q.hp, maxHp: q.maxHp, dead: q.dead }))
    : (G.lastSnap?.players || []).map((q) => ({ id: q.id, name: q.name, hp: q.hp, maxHp: q.maxHp, dead: q.dead }));
  const html = list.map((q) => `
    <div class="squad-chip ${q.id === G.myId ? 'me' : ''} ${q.dead ? 'down' : ''}">
      <b>${escapeHtml(q.name)}</b>
      <span class="hp"><i style="width:${clamp((q.hp / q.maxHp) * 100, 0, 100)}%"></i></span>
    </div>`).join('');
  const el = $('#squadList');
  if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }

  const offers = p.offers || null;
  const sig = offers ? offers.join(',') : '';
  if (sig !== lastOffers) {
    lastOffers = sig;
    if (offers) renderUpgradeCards(offers);
    else hide($('#upgrades'));
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderUpgradeCards(ids) {
  const p = localPlayer();
  const cards = $('#cards');
  cards.innerHTML = ids.map((id) => {
    const stacks = p?.stacks?.[id] || 0;
    return `<button class="card" data-id="${id}">
      <div class="k">${t('hud.upgrade')}</div>
      <div class="n">${t(`upgrade.${id}`)}</div>
      <div class="d">${t(`upgrade.${id}.desc`)}</div>
      ${stacks ? `<div class="stack">×${stacks}</div>` : ''}
    </button>`;
  }).join('');
  show($('#upgrades'));
  cards.querySelectorAll('.card').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (G.mode === 'solo') { G.world.pick('you', id); G.world.drainEvents(); }
      else G.ws?.send(JSON.stringify({ t: 'pick', id }));
      hide($('#upgrades'));
      lastOffers = '';
    };
  });
}

function buildShop() {
  const grid = $('#shopGrid');
  grid.innerHTML = Object.entries(SHOP).map(([id, item]) => `
    <button class="item" data-id="${id}">
      <span class="n">${t(`shop.${id}`)}</span>
      <span class="d">${t(`shop.${id}.desc`)}</span>
      <span class="p">${item.cost} ${t('shop.coins')}</span>
    </button>`).join('');
  grid.querySelectorAll('.item').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (G.mode === 'solo') {
        const ok = G.world.buy('you', id);
        toast(ok ? t('shop.bought') : t('shop.poor'));
        G.world.drainEvents();
      } else {
        G.ws?.send(JSON.stringify({ t: 'buy', id }));
      }
      refreshShop();
    };
  });
  refreshShop();
}

function refreshShop() {
  const p = localPlayer();
  if (!p) return;
  $('#shopCoins').textContent = p.coins;
  document.querySelectorAll('#shopGrid .item').forEach((btn) => {
    const item = SHOP[btn.dataset.id];
    const owned = btn.dataset.id.startsWith('weapon:') && p.weapon === btn.dataset.id.slice(7);
    btn.classList.toggle('owned', owned);
    btn.disabled = owned || p.coins < item.cost || p.dead;
    const price = btn.querySelector('.p');
    if (price) price.textContent = owned ? t('shop.equipped') : `${item.cost} ${t('shop.coins')}`;
  });
}

let shopOpen = false;
function toggleShop() {
  if (!G.running || G.over) return;
  shopOpen = !shopOpen;
  if (shopOpen) { buildShop(); show($('#shop')); if (G.mode === 'solo') G.paused = true; }
  else { hide($('#shop')); if (G.mode === 'solo' && $('#pause').classList.contains('hidden')) G.paused = false; }
}

function togglePause() {
  if (!G.running || G.over) return;
  if (!$('#shop').classList.contains('hidden')) { toggleShop(); return; }
  G.paused = !G.paused;
  if (G.paused) {
    show($('#pause'));
    $('#roomHint').textContent = G.mode === 'coop' ? t('pause.coop', { code: G.code }) : t('pause.solo');
  } else hide($('#pause'));
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!G.running) { renderer.render(scene, camera); return; }

  view.squad.length = 0;
  if (G.mode === 'solo') stepSolo(dt);
  else stepCoop(dt);

  const p = localPlayer();
  const focus = p && view.players.get(p.id) ? view.players.get(p.id) : { x: 0, z: 0 };
  renderView(dt);
  if (!view.players.has(G.myId)) updateCamera(dt, focus);
  updateHud();
  if (shopOpen) refreshShop();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// language
// ---------------------------------------------------------------------------
function syncLangButtons() {
  document.querySelectorAll('.lang-btn').forEach((b) => {
    const on = b.dataset.lang === getLang();
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function onLangChanged() {
  syncLangButtons();
  lastOffers = '';
  if (G.running) {
    $('#roomHint').textContent = G.mode === 'coop' ? t('run.room', { code: G.code }) : t('run.solo');
    if (shopOpen) buildShop();
    const p = localPlayer();
    if (p) updateAmmoHud(p);
  }
  if (G.over && !$('#over').classList.contains('hidden')) {
    // run-result title stays in the language it was produced in; labels follow the switch
    const p2 = localPlayer();
    const wave = G.world?.wave ?? G.lastSnap?.wave ?? 0;
    const kills = G.world?.kills ?? G.lastSnap?.kills ?? 0;
    $('#overStats').innerHTML = `
      <div><span>${t('over.wave')}</span><b>${wave}</b></div>
      <div><span>${t('over.slain')}</span><b>${kills}</b></div>
      <div><span>${t('over.coins')}</span><b>${p2?.coins ?? 0}</b></div>`;
    $('#overEyebrow').textContent = $('#overTitle').dataset.lost ? t('over.lost') : t('over.fell');
  }
}

document.querySelectorAll('.lang-btn').forEach((b) => {
  b.onclick = () => setLang(b.dataset.lang);
});

// read-only probe for automated checks (no gameplay effect)
window.__gongon = {
  counts: () => ({
    enemies: view.enemies.size,
    rendered: view.zombiePool.filter((z) => z.group.visible).length,
    squad: view.squadPool.filter((c) => c.group.visible).length,
    heroes: view.heroes.size,
  }),
  world: () => (G.mode === 'solo' ? { enemies: G.world.enemies.length, wave: G.world.wave, kills: G.world.kills } : null),
  // read-only: does every visible zombie carry a hat, and is it on screen?
  hats: () => {
    const hatP = new THREE.Vector3(), headP = new THREE.Vector3();
    const rows = [];
    for (const z of view.zombiePool) {
      if (!z.group.visible) continue;
      if (!z.hat) { rows.push({ type: z.type, hat: false }); continue; }
      z.hat.getWorldPosition(hatP);
      const ndc = hatP.clone().project(camera);
      const onScreen = Math.abs(ndc.x) < 0.92 && Math.abs(ndc.y) < 0.92 && ndc.z < 1;
      rows.push({ type: z.type, hat: true, hatY: +hatP.y.toFixed(2), ndcX: +ndc.x.toFixed(2), ndcY: +ndc.y.toFixed(2), onScreen });
    }
    return { visible: rows.length, hatless: rows.filter((r) => !r.hat).length, onScreen: rows.filter((r) => r.onScreen).length, rows: rows.slice(0, 8) };
  },
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function setLoadProgress(p) {
  $('#loadFill').style.width = `${clamp(p, 0, 1) * 100}%`;
}

function loadRig(url, label) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(prepareRig(gltf, label)), undefined, () => reject(new Error(label)));
  });
}

async function boot() {
  initLang();
  applyDom();
  syncLangButtons();
  onChange(onLangChanged);
  $('#coopInput').value = localStorage.getItem(COOP_KEY) || '';
  $('#coopInput').addEventListener('change', rememberCoopUrl);
  resize();

  const loadText = $('#loadText');
  setLoadProgress(0.08);
  try {
    RIGS.survivor = await loadRig(survivorUrl, 'survivor');
    setLoadProgress(0.5);
    RIGS.zombie = await loadRig(zombieUrl, 'zombie');
    setLoadProgress(0.9);
  } catch (err) {
    const msg = t('err.asset', { name: err.message });
    loadText.textContent = msg;
    loadText.classList.add('err');
    toast(msg, 8000);
    $('#btnSolo').disabled = true;
    $('#btnHost').disabled = true;
    $('#btnJoin').disabled = true;
    show($('#loading'));
    return;
  }

  G.ready = true;
  setLoadProgress(1);
  hide($('#loading'));
  buildEnvironment(1);
  renderer.render(scene, camera);

  $('#btnSolo').disabled = false;
  $('#btnHost').disabled = false;
  $('#btnJoin').disabled = false;
  $('#nameInput').value = localStorage.getItem('gongon.name') || '';
  frame();
}

$('#btnSolo').onclick = () => {
  G.name = ($('#nameInput').value || '').trim().slice(0, 14) || t('menu.namePlaceholder');
  startSolo();
};
$('#btnHost').onclick = () => {
  G.name = ($('#nameInput').value || '').trim().slice(0, 14) || t('menu.namePlaceholder');
  startCoop('create');
};
$('#btnJoin').onclick = () => {
  const code = ($('#codeInput').value || '').trim().toUpperCase();
  if (code.length !== 4) return toast(t('err.code'));
  G.name = ($('#nameInput').value || '').trim().slice(0, 14) || t('menu.namePlaceholder');
  startCoop('join', code);
};
$('#btnAgain').onclick = () => {
  if (G.mode === 'coop') { hide($('#over')); startCoop('create'); }
  else { hide($('#over')); startSolo(); }
};
$('#btnMenu').onclick = () => { hide($('#over')); show($('#menu')); G.over = false; };
$('#btnResume').onclick = togglePause;
$('#btnQuit').onclick = () => { hide($('#pause')); G.running = false; G.ws?.close(); endRun(t('over.titleLeft')); };
$('#btnShopClose').onclick = toggleShop;
$('#btnPause').onclick = togglePause;
$('#btnAudio').onclick = () => {
  Audio.on = !Audio.on;
  if (Audio.on) Audio.init();
  $('#btnAudio').classList.toggle('off', !Audio.on);
  $('#btnAudio').textContent = Audio.on ? '♪' : '✕';
};
$('#nameInput').addEventListener('change', (e) => localStorage.setItem('gongon.name', e.target.value.slice(0, 14)));

boot();
