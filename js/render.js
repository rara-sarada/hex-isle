// =============================================================
// 3D描画（three.js / WebGL）：盤面・駒・選択マーカー・ダイス演出
// =============================================================
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import * as M from './models.js';

const TOP = M.TILE_H;

export class BoardRenderer {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    container.appendChild(r.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#9fd3ee');
    scene.fog = new THREE.Fog('#9fd3ee', 22, 48);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 10.5, 9.5);
    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    c.target.set(0, 0, 0.4);
    c.enableDamping = true;
    c.maxPolarAngle = 1.3;
    c.minDistance = 4;
    c.maxDistance = 24;
    c.screenSpacePanning = false;

    scene.add(new THREE.HemisphereLight('#dff3ff', '#5a4a30', 1.1));
    const sun = new THREE.DirectionalLight('#fff4dd', 2.2);
    sun.position.set(6, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 });
    sun.shadow.bias = -0.0008;
    sun.shadow.radius = 3;
    scene.add(sun);

    // 海
    const seaGeo = new THREE.PlaneGeometry(90, 90, 90, 90);
    seaGeo.rotateX(-Math.PI / 2);
    this.seaBase = seaGeo.attributes.position.array.slice();
    this.sea = new THREE.Mesh(seaGeo, new THREE.MeshStandardMaterial({ color: '#2b8fc6', roughness: 0.25, metalness: 0.1, flatShading: true }));
    this.sea.position.y = -0.1;
    this.sea.receiveShadow = true;
    scene.add(this.sea);

    // 島の土台（砂浜）
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(4.75, 5.15, 0.3, 6), M.mat('#e6d39a'));
    sand.rotation.y = Math.PI / 6;
    sand.position.y = -0.15;
    sand.receiveShadow = true;
    scene.add(sand);

    this.boardGroup = new THREE.Group();
    this.pieceGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    scene.add(this.boardGroup, this.pieceGroup, this.markerGroup);

    this.pieces = new Map(); // key -> object
    this.tweens = [];
    this.markers = [];
    this.hovered = null;
    this.onPick = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    

    // ダイス
    this.dice = [M.createDie(), M.createDie()];
    this.dice.forEach((d, i) => { d.position.set(5.2 + i * 0.5, 0.06, 3.6); scene.add(d); });

    this._bindEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    r.setAnimationLoop(() => this._tick());
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // 縦長画面では少し引く
    this.camera.fov = w / h < 0.9 ? 60 : 42;
    this.camera.updateProjectionMatrix();
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointermove', (e) => this._hover(e));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const hit = this._pickAt(e);
      if (hit && this.onPick) this.onPick(hit.userData.kind, hit.userData.id);
    });
  }

  _pickAt(e) {
    if (!this.markers.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.markers.map((m) => m.userData.hit), false);
    return hits.length ? hits[0].object.userData.marker : null;
  }

  _hover(e) {
    const m = this._pickAt(e);
    if (m !== this.hovered) {
      this.hovered = m;
      this.renderer.domElement.style.cursor = m ? 'pointer' : '';
    }
  }

  // ---------------------------------------------------------
  // 盤面（ゲーム開始時に1回）
  // ---------------------------------------------------------
  setBoard(board) {
    this.board = board;
    this.boardGroup.clear();
    this.pieceGroup.clear();
    this.pieces.clear();
    for (const h of board.hexes) {
      const tile = M.createTile(h);
      this.boardGroup.add(tile);
      if (h.num) {
        const tok = M.createNumberToken(h.num);
        tok.position.set(h.x, TOP + 0.025, h.z);
        this.boardGroup.add(tok);
      }
    }
    for (const p of board.ports) {
      const e = board.edges[p.edge];
      const a = board.vertices[e.v[0]], b = board.vertices[e.v[1]];
      const hx = board.hexes[e.hexes[0]];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      let ox = mx - hx.x, oz = mz - hx.z;
      const len = Math.hypot(ox, oz); ox /= len; oz /= len;
      const dock = M.createDock(p.type);
      dock.position.set(mx + ox * 0.62, -0.06, mz + oz * 0.62);
      dock.rotation.y = Math.atan2(ox, oz);
      dock.userData.bob = Math.random() * 6;
      this.boardGroup.add(dock);
      // 桟橋→頂点への板
      for (const v of [a, b]) {
        const sx = dock.position.x, sz = dock.position.z;
        const dx = v.x - sx, dz = v.z - sz, d = Math.hypot(dx, dz);
        const plank = new THREE.Mesh(new THREE.BoxGeometry(d, 0.025, 0.07), M.mat('#9a6a3e'));
        plank.position.set(sx + dx / 2, 0.06, sz + dz / 2);
        plank.rotation.y = -Math.atan2(dz, dx);
        plank.castShadow = plank.receiveShadow = true;
        this.boardGroup.add(plank);
      }
    }
    this.robber = M.createRobber();
    this.pieceGroup.add(this.robber);
    this.robberHex = -1;
  }

  _robberPos(hexId) {
    const h = this.board.hexes[hexId];
    return new THREE.Vector3(h.x + (h.num ? 0.42 : 0), TOP, h.z + (h.num ? 0.18 : 0));
  }

  // ---------------------------------------------------------
  // 状態反映（建物・道・盗賊）
  // ---------------------------------------------------------
  update(state) {
    const B = this.board;
    if (!B) return;
    // 盗賊
    const rh = state.board.robber;
    if (rh !== this.robberHex) {
      const to = this._robberPos(rh);
      if (this.robberHex < 0) this.robber.position.copy(to);
      else this._tween(this.robber, this.robber.position.clone(), to, 700, true);
      this.robberHex = rh;
    }
    const want = new Map();
    for (const [v, bd] of Object.entries(state.buildings)) want.set(`b${v}:${bd.type}:${bd.owner}`, { kind: bd.type, v: +v, owner: bd.owner });
    for (const [e, owner] of Object.entries(state.roads)) want.set(`r${e}:${owner}`, { kind: 'road', e: +e, owner });

    for (const [k, obj] of this.pieces) if (!want.has(k)) { this.pieceGroup.remove(obj); this.pieces.delete(k); }
    for (const [k, p] of want) {
      if (this.pieces.has(k)) continue;
      const color = state.players[p.owner].color;
      let obj, pos;
      if (p.kind === 'road') {
        const e = B.edges[p.e];
        const a = B.vertices[e.v[0]], b = B.vertices[e.v[1]];
        obj = M.createRoad(color);
        pos = new THREE.Vector3((a.x + b.x) / 2, TOP, (a.z + b.z) / 2);
        obj.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      } else {
        const v = B.vertices[p.v];
        obj = p.kind === 'city' ? M.createCity(color) : M.createSettlement(color);
        pos = new THREE.Vector3(v.x, TOP, v.z);
        obj.rotation.y = (p.v * 1.3) % 0.8 - 0.4;
      }
      this.pieceGroup.add(obj);
      this.pieces.set(k, obj);
      if (this._initialized) {
        obj.position.copy(pos).add(new THREE.Vector3(0, 2.2, 0));
        this._tween(obj, obj.position.clone(), pos, 550, false, 'bounce');
      } else obj.position.copy(pos);
    }
    this._initialized = true;
  }

  // ---------------------------------------------------------
  // 選択マーカー
  // kind: 'vertex' | 'edge' | 'hex' / ids: 対象ID配列
  // ---------------------------------------------------------
  setTargets(kind, ids, color = '#ffffff') {
    this.markerGroup.clear();
    this.markers = [];
    this.hovered = null;
    this.renderer.domElement.style.cursor = '';
    if (!kind || !ids?.length) return;
    const B = this.board;
    const glow = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, transparent: true, opacity: 0.8, depthWrite: false });
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const id of ids) {
      let vis, hit;
      if (kind === 'vertex') {
        const v = B.vertices[id];
        vis = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), glow);
        vis.position.set(v.x, TOP + 0.14, v.z);
        hit = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), hitMat);
      } else if (kind === 'edge') {
        const e = B.edges[id];
        const a = B.vertices[e.v[0]], b = B.vertices[e.v[1]];
        vis = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.1), glow);
        vis.position.set((a.x + b.x) / 2, TOP + 0.06, (a.z + b.z) / 2);
        vis.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
        hit = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.3), hitMat);
      } else if (kind === 'hex') {
        const h = B.hexes[id];
        vis = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.045, 8, 6), glow);
        vis.rotation.x = Math.PI / 2;
        vis.rotation.z = Math.PI / 6;
        vis.position.set(h.x, TOP + 0.08, h.z);
        hit = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.5, 6), hitMat);
      }
      hit.position.copy(vis.position);
      hit.rotation.copy(vis.rotation);
      if (kind === 'hex') hit.rotation.set(0, 0, 0);
      vis.userData = { kind, id, hit, phase: Math.random() * 6 };
      hit.userData = { marker: vis };
      this.markerGroup.add(vis, hit);
      this.markers.push(vis);
    }
  }

  // ---------------------------------------------------------
  // ダイス演出
  // ---------------------------------------------------------
  rollDice(d1, d2) {
    [d1, d2].forEach((val, i) => {
      const d = this.dice[i];
      const end = new THREE.Vector3(5.0 + i * 0.55, 0.06 + 0.16, 3.3 + i * 0.2);
      const start = end.clone().add(new THREE.Vector3(-1.5, 2.5, -1));
      const rot = M.dieRotationFor(val);
      const spin = new THREE.Vector3(rot[0] + Math.PI * 4, rot[1] + Math.PI * (2 + i), rot[2] + Math.PI * 4);
      this.tweens.push({ obj: d, from: start, to: end, t0: performance.now(), dur: 900, ease: 'bounce', rotFrom: spin, rotTo: new THREE.Vector3(...rot) });
    });
  }

  focus(x, z) {
    this._tween(this.controls.target, this.controls.target.clone(), new THREE.Vector3(x, 0, z), 600, false, 'smooth', true);
  }

  _tween(obj, from, to, dur, arc = false, ease = 'smooth', isVec = false) {
    this.tweens = this.tweens.filter((t) => t.obj !== obj);
    this.tweens.push({ obj, from, to, t0: performance.now(), dur, arc, ease, isVec });
  }

  _tick() {
    const now = performance.now();
    const t = now / 1000;
    // 波
    const pos = this.sea.geometry.attributes.position;
    const base = this.seaBase;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      pos.array[i * 3 + 1] = Math.sin(x * 0.6 + t * 1.2) * 0.05 + Math.cos(z * 0.7 + t * 0.9) * 0.05;
    }
    pos.needsUpdate = true;
    this.sea.geometry.computeVertexNormals();

    // 港の小舟の揺れ
    for (const ch of this.boardGroup.children) {
      if (ch.userData.bob !== undefined) {
        const boat = ch.getObjectByName('boat');
        if (boat) { boat.position.y = Math.sin(t * 1.6 + ch.userData.bob) * 0.03; boat.rotation.x = Math.sin(t * 1.3 + ch.userData.bob) * 0.08; }
      }
    }
    // マーカーの脈動
    for (const m of this.markers) {
      const s = (m === this.hovered ? 1.45 : 1) * (1 + Math.sin(t * 4 + m.userData.phase) * 0.12);
      m.scale.setScalar(s);
    }
    // トゥイーン
    this.tweens = this.tweens.filter((tw) => {
      let k = Math.min(1, (now - tw.t0) / tw.dur);
      let e;
      if (tw.ease === 'bounce') {
        const n1 = 7.5625, d1 = 2.75; let x = k;
        if (x < 1 / d1) e = n1 * x * x; else if (x < 2 / d1) e = n1 * (x -= 1.5 / d1) * x + 0.75; else if (x < 2.5 / d1) e = n1 * (x -= 2.25 / d1) * x + 0.9375; else e = n1 * (x -= 2.625 / d1) * x + 0.984375;
      } else e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const target = tw.isVec ? tw.obj : tw.obj.position;
      target.lerpVectors(tw.from, tw.to, tw.ease === 'bounce' ? Math.min(1, k * 1.0) : e);
      if (tw.ease === 'bounce') target.y = tw.from.y + (tw.to.y - tw.from.y) * e;
      if (tw.arc) target.y += Math.sin(k * Math.PI) * 1.2;
      if (tw.rotFrom) {
        const r = new THREE.Vector3().lerpVectors(tw.rotFrom, tw.rotTo, 1 - Math.pow(1 - k, 3));
        tw.obj.rotation.set(r.x, r.y, r.z);
      }
      return k < 1;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
