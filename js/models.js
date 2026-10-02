// =============================================================
// 3Dモデル（すべてプロシージャル生成：外部モデルファイル不要）
// =============================================================
import * as THREE from 'three';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...opts }));
  return matCache.get(key);
}

function mesh(geo, material, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1 } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  if (typeof s === 'number') m.scale.setScalar(s); else m.scale.set(...s);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// 簡易シード乱数
export function seeded(seed) {
  let t = seed >>> 0 || 1;
  return () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; };
}

// -------------------------------------------------------------
// 地形タイル
// -------------------------------------------------------------
export const TERRAIN_COLOR = {
  forest: '#2f7a3a', hills: '#c06a3c', pasture: '#8fd16a', fields: '#e8c64a', mountains: '#8d8f96', desert: '#e3d19a',
};
export const TILE_H = 0.22;

const G = {
  cone: new THREE.ConeGeometry(1, 1, 7),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.IcosahedronGeometry(1, 0),
  sphereSmooth: new THREE.SphereGeometry(1, 10, 8),
  dodeca: new THREE.DodecahedronGeometry(1, 0),
};

function decorPositions(rnd, count, rMin = 0.42, rMax = 0.78) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < 400) {
    const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin);
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    if (out.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 0.2)) out.push(p);
  }
  return out;
}

function tree(x, z, s, rnd) {
  const g = new THREE.Group();
  g.add(mesh(G.cyl, mat('#6b4a2b'), { y: 0.05 * s, s: [0.035 * s, 0.1 * s, 0.035 * s] }));
  const shade = ['#1f6b2c', '#2a8038', '#195a26'][Math.floor(rnd() * 3)];
  g.add(mesh(G.cone, mat(shade), { y: 0.2 * s, s: [0.13 * s, 0.22 * s, 0.13 * s] }));
  g.add(mesh(G.cone, mat(shade), { y: 0.3 * s, s: [0.1 * s, 0.17 * s, 0.1 * s] }));
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * 6;
  return g;
}

function sheep(x, z, rnd) {
  const g = new THREE.Group();
  g.add(mesh(G.sphere, mat('#fbfbf5'), { y: 0.08, s: [0.085, 0.065, 0.06] }));
  g.add(mesh(G.sphere, mat('#fbfbf5'), { x: -0.03, y: 0.11, s: [0.05, 0.045, 0.05] }));
  g.add(mesh(G.box, mat('#2b2b2b'), { x: 0.09, y: 0.1, s: [0.05, 0.045, 0.04] }));
  for (const [lx, lz] of [[0.04, 0.03], [0.04, -0.03], [-0.04, 0.03], [-0.04, -0.03]])
    g.add(mesh(G.box, mat('#2b2b2b'), { x: lx, y: 0.025, z: lz, s: [0.015, 0.05, 0.015] }));
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * 6;
  return g;
}

function wheatBundle(x, z, rnd) {
  const g = new THREE.Group();
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.add(mesh(G.cyl, mat('#c9a227'), { x: Math.cos(a) * 0.025, z: Math.sin(a) * 0.025, y: 0.07, rz: Math.cos(a) * 0.15, rx: Math.sin(a) * 0.15, s: [0.008, 0.14, 0.008] }));
    g.add(mesh(G.sphere, mat('#f2cf55'), { x: Math.cos(a) * 0.035, z: Math.sin(a) * 0.035, y: 0.15, s: [0.02, 0.04, 0.02] }));
  }
  g.add(mesh(G.cyl, mat('#8a6b1f'), { y: 0.07, s: [0.03, 0.015, 0.03] }));
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * 6;
  return g;
}

function mountain(x, z, s, rnd) {
  const g = new THREE.Group();
  g.add(mesh(G.cone, mat('#6e7078'), { y: 0.2 * s, s: [0.22 * s, 0.4 * s, 0.22 * s], ry: rnd() }));
  g.add(mesh(G.cone, mat('#f4f6fa'), { y: 0.34 * s, s: [0.085 * s, 0.13 * s, 0.085 * s], ry: rnd() }));
  g.position.set(x, 0, z);
  return g;
}

function oreRock(x, z, rnd) {
  const g = new THREE.Group();
  g.add(mesh(G.dodeca, mat('#55606e'), { y: 0.04, s: 0.05 }));
  g.add(mesh(G.dodeca, mat('#7fb3d5', { metalness: 0.4, roughness: 0.4 }), { x: 0.05, y: 0.03, s: 0.03 }));
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * 6;
  return g;
}

function brickStack(x, z, rnd) {
  const g = new THREE.Group();
  const m = mat('#a8432a');
  for (let row = 0; row < 3; row++)
    for (let i = 0; i < 3 - row; i++)
      g.add(mesh(G.box, m, { x: (i - (2 - row) / 2) * 0.07, y: 0.02 + row * 0.04, s: [0.065, 0.035, 0.1] }));
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * 6;
  return g;
}

function clayMound(x, z, rnd) {
  return mesh(G.sphereSmooth, mat('#b25a32'), { x, z, y: 0, s: [0.16 + rnd() * 0.06, 0.1, 0.14 + rnd() * 0.05] });
}

function cactus(x, z, rnd) {
  const g = new THREE.Group();
  const m = mat('#4c8a3f');
  g.add(mesh(G.cyl, m, { y: 0.1, s: [0.03, 0.2, 0.03] }));
  g.add(mesh(G.cyl, m, { x: 0.04, y: 0.12, s: [0.02, 0.08, 0.02] }));
  g.add(mesh(G.cyl, m, { x: -0.04, y: 0.09, s: [0.02, 0.07, 0.02] }));
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * 6;
  return g;
}

export function createTile(hex) {
  const g = new THREE.Group();
  const rnd = seeded(hex.id * 97 + 13);
  // 土台（側面は土色、上面は地形色）
  const base = mesh(new THREE.CylinderGeometry(0.985, 1.0, TILE_H, 6), [mat('#8b6b45'), mat(TERRAIN_COLOR[hex.terrain]), mat('#6b5236')]);
  base.position.y = TILE_H / 2;
  base.castShadow = false;
  g.add(base);

  const top = new THREE.Group();
  top.position.y = TILE_H;
  g.add(top);

  const T = hex.terrain;
  if (T === 'forest') decorPositions(rnd, 9, 0.38, 0.8).forEach((p) => top.add(tree(p.x, p.z, 0.8 + rnd() * 0.5, rnd)));
  if (T === 'pasture') {
    decorPositions(rnd, 4, 0.42, 0.75).forEach((p) => top.add(sheep(p.x, p.z, rnd)));
    decorPositions(rnd, 5, 0.45, 0.8).forEach((p) => top.add(mesh(G.sphere, mat('#6fbf4f'), { x: p.x, z: p.z, s: [0.06, 0.04, 0.06] })));
  }
  if (T === 'fields') decorPositions(rnd, 10, 0.4, 0.8).forEach((p) => top.add(wheatBundle(p.x, p.z, rnd)));
  if (T === 'mountains') {
    decorPositions(rnd, 4, 0.48, 0.72).forEach((p) => top.add(mountain(p.x, p.z, 0.9 + rnd() * 0.5, rnd)));
    decorPositions(rnd, 2, 0.4, 0.6).forEach((p) => top.add(oreRock(p.x, p.z, rnd)));
  }
  if (T === 'hills') {
    decorPositions(rnd, 4, 0.5, 0.78).forEach((p) => top.add(clayMound(p.x, p.z, rnd)));
    decorPositions(rnd, 2, 0.42, 0.6).forEach((p) => top.add(brickStack(p.x, p.z, rnd)));
  }
  if (T === 'desert') {
    decorPositions(rnd, 3, 0.45, 0.75).forEach((p) => top.add(cactus(p.x, p.z, rnd)));
    decorPositions(rnd, 3, 0.4, 0.8).forEach((p) => top.add(mesh(G.dodeca, mat('#b9a77a'), { x: p.x, z: p.z, y: 0.02, s: 0.04 })));
  }
  g.position.set(hex.x, 0, hex.z);
  return g;
}

// -------------------------------------------------------------
// 数字チップ
// -------------------------------------------------------------
const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
export function createNumberToken(num) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#f6ecd2'; x.beginPath(); x.arc(128, 128, 126, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#c9b48a'; x.lineWidth = 8; x.stroke();
  const red = num === 6 || num === 8;
  x.fillStyle = red ? '#c62828' : '#2a2a2a';
  x.font = `bold ${red ? 128 : 112}px Georgia, serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(String(num), 128, 116);
  const p = PIPS[num];
  for (let i = 0; i < p; i++) { x.beginPath(); x.arc(128 + (i - (p - 1) / 2) * 22, 200, 8, 0, Math.PI * 2); x.fill(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 40);
  const m = mesh(geo, [mat('#d8c7a0'), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }), mat('#d8c7a0')]);
  m.rotation.y = Math.PI / 2; // テクスチャの向き補正（画面上方向＝-Z に数字の上が来る）
  return m;
}

// -------------------------------------------------------------
// 建物・道・盗賊
// -------------------------------------------------------------
function roofGeo(w, d, h) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 - 0.015, 0); shape.lineTo(w / 2 + 0.015, 0); shape.lineTo(0, h); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d + 0.03, bevelEnabled: false });
  geo.translate(0, 0, -(d + 0.03) / 2);
  return geo;
}
const ROOF_S = roofGeo(0.2, 0.2, 0.11);
const ROOF_C = roofGeo(0.18, 0.2, 0.1);

function darker(hex, k = 0.65) {
  const c = new THREE.Color(hex); c.multiplyScalar(k); return '#' + c.getHexString();
}

export function createSettlement(color) {
  const g = new THREE.Group();
  g.add(mesh(G.box, mat(color), { y: 0.075, s: [0.2, 0.15, 0.2] }));
  g.add(mesh(ROOF_S, mat(darker(color)), { y: 0.15 }));
  g.add(mesh(G.box, mat('#3b2a1a'), { y: 0.05, z: 0.101, s: [0.05, 0.08, 0.005] }));
  g.add(mesh(G.box, mat('#3b2a1a'), { x: 0.06, y: 0.27, s: [0.03, 0.08, 0.03] }));
  return g;
}

export function createCity(color) {
  const g = new THREE.Group();
  g.add(mesh(G.box, mat(color), { x: 0.08, y: 0.07, s: [0.2, 0.14, 0.22] }));
  g.add(mesh(ROOF_C, mat(darker(color)), { x: 0.08, y: 0.14 }));
  g.add(mesh(G.box, mat(color), { x: -0.1, y: 0.15, s: [0.15, 0.3, 0.15] }));
  g.add(mesh(G.cone, mat(darker(color)), { x: -0.1, y: 0.36, ry: Math.PI / 4, s: [0.12, 0.13, 0.12] }));
  g.add(mesh(G.box, mat('#ffe9a8', { emissive: '#ffcc55', emissiveIntensity: 0.4 }), { x: -0.1, y: 0.22, z: 0.076, s: [0.04, 0.05, 0.005] }));
  g.add(mesh(G.box, mat('#3b2a1a'), { x: 0.08, y: 0.045, z: 0.111, s: [0.05, 0.08, 0.005] }));
  return g;
}

export function createRoad(color, length = 0.62) {
  const g = new THREE.Group();
  g.add(mesh(G.box, mat(color), { y: 0.04, s: [length, 0.07, 0.09] }));
  g.add(mesh(G.box, mat(darker(color, 0.8)), { y: 0.077, s: [length * 0.92, 0.008, 0.05] }));
  return g;
}

export function createRobber() {
  const pts = [
    [0, 0], [0.12, 0], [0.12, 0.03], [0.08, 0.05], [0.07, 0.16], [0.1, 0.22], [0.075, 0.27], [0.05, 0.28], [0.085, 0.33], [0.085, 0.38], [0.05, 0.42], [0, 0.43],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(pts, 16);
  const g = new THREE.Group();
  g.add(mesh(geo, mat('#2c2c34', { roughness: 0.5, flatShading: false })));
  // 目
  g.add(mesh(G.sphereSmooth, mat('#ff5a5a', { emissive: '#ff2020', emissiveIntensity: 1.2 }), { x: -0.03, y: 0.36, z: 0.075, s: 0.012 }));
  g.add(mesh(G.sphereSmooth, mat('#ff5a5a', { emissive: '#ff2020', emissiveIntensity: 1.2 }), { x: 0.03, y: 0.36, z: 0.075, s: 0.012 }));
  g.scale.setScalar(1.25);
  return g;
}

// -------------------------------------------------------------
// 港（桟橋＋小舟＋看板）
// -------------------------------------------------------------
const PORT_LABEL = { any: '3:1', wood: '🌲 2:1', brick: '🧱 2:1', sheep: '🐑 2:1', wheat: '🌾 2:1', ore: '⛰️ 2:1' };
export function createPortLabel(type) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(255,248,230,0.95)';
  x.strokeStyle = '#6b4a2b'; x.lineWidth = 8;
  x.beginPath(); x.roundRect(8, 8, 240, 112, 24); x.fill(); x.stroke();
  x.fillStyle = '#2a2a2a'; x.font = 'bold 56px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(PORT_LABEL[type], 128, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false }));
  sp.renderOrder = 10;
  sp.scale.set(0.7, 0.35, 1);
  return sp;
}

export function createDock(type) {
  const g = new THREE.Group();
  const wood = mat('#8a5a32'), dark = mat('#5b3a1e');
  g.add(mesh(G.box, wood, { y: 0.1, s: [0.42, 0.04, 0.3] }));
  for (const [px, pz] of [[-0.18, -0.12], [0.18, -0.12], [-0.18, 0.12], [0.18, 0.12]])
    g.add(mesh(G.cyl, dark, { x: px, y: 0.02, z: pz, s: [0.025, 0.2, 0.025] }));
  // 小舟
  const boat = new THREE.Group();
  boat.add(mesh(G.box, mat('#a0522d'), { y: 0.04, s: [0.3, 0.06, 0.12] }));
  boat.add(mesh(G.cyl, dark, { y: 0.18, s: [0.01, 0.24, 0.01] }));
  boat.add(mesh(new THREE.ConeGeometry(0.08, 0.16, 3), mat('#f4f1e6'), { x: 0.04, y: 0.2, rz: -Math.PI / 2, s: [1, 1, 0.1] }));
  boat.position.set(0, 0, 0.28);
  boat.name = 'boat';
  g.add(boat);
  const label = createPortLabel(type);
  label.position.set(0, 0.5, 0);
  g.add(label);
  return g;
}

// -------------------------------------------------------------
// ダイス
// -------------------------------------------------------------
function dieFace(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#fbf7ef'; x.fillRect(0, 0, 128, 128);
  x.fillStyle = n === 1 ? '#c62828' : '#222';
  const P = { 1: [[64, 64]], 2: [[36, 36], [92, 92]], 3: [[32, 32], [64, 64], [96, 96]], 4: [[36, 36], [92, 36], [36, 92], [92, 92]], 5: [[32, 32], [96, 32], [64, 64], [32, 96], [96, 96]], 6: [[36, 30], [92, 30], [36, 64], [92, 64], [36, 98], [92, 98]] }[n];
  P.forEach(([px, py]) => { x.beginPath(); x.arc(px, py, n === 1 ? 16 : 11, 0, Math.PI * 2); x.fill(); });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.4 });
}
// BoxGeometry の面順: +x, -x, +y, -y, +z, -z
export const DIE_FACES = [1, 6, 2, 5, 3, 4];
export function createDie() {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), DIE_FACES.map(dieFace));
  m.castShadow = true;
  return m;
}
// 指定の目を上(+y)に向ける回転
export function dieRotationFor(value) {
  const i = DIE_FACES.indexOf(value);
  return [
    [0, 0, Math.PI / 2], [0, 0, -Math.PI / 2], [0, 0, 0], [Math.PI, 0, 0], [-Math.PI / 2, 0, 0], [Math.PI / 2, 0, 0],
  ][i];
}
