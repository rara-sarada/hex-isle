// =============================================================
// 3D描画（three.js / WebGL）：盤面・駒・選択マーカー・ダイス演出
// =============================================================
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import * as M from './models.js?v=20261003151941';

const TOP = M.TILE_H;

export class BoardRenderer {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
    const lowEnd = window.innerWidth < 900 || /Android|iPhone|iPad/i.test(navigator.userAgent);
    sun.shadow.mapSize.set(lowEnd ? 1024 : 2048, lowEnd ? 1024 : 2048);
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
    this.fxGroup = new THREE.Group();
    scene.add(this.boardGroup, this.pieceGroup, this.markerGroup, this.fxGroup);
    this.fx = []; // 演出用パーティクル
    this.shakeUntil = 0; this.shakeMag = 0;
    this.onEvent = null; // (name, data) => 効果音など

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
    // GPUの描画コンテキストが失われたら（盤面が真っ黒になる原因）作り直す
    r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._lost = true; });
    r.domElement.addEventListener('webglcontextrestored', () => { this._lost = false; this.rebuild(); });
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
      if (m) this.onEvent?.('hover');
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
  // 盤面・駒を作り直す（コンテキスト復帰時など）
  rebuild() {
    if (!this.board) return;
    this.fx.forEach((f) => this.fxGroup.remove(f.mesh)); this.fx = [];
    this.setBoard(this.board);
    this._initialized = false;
    if (this.lastState) this.update(this.lastState);
  }

  resetView() {
    this.camera.position.set(0, 10.5, 9.5);
    this.controls.target.set(0, 0, 0.4);
    this.controls.update();
  }

  update(state) {
    this.lastState = state;
    const B = this.board;
    if (!B) return;
    // 盗賊
    const rh = state.board.robber;
    if (rh !== this.robberHex) {
      const to = this._robberPos(rh);
      if (this.robberHex < 0) this.robber.position.copy(to);
      else {
        this.smoke(this.robber.position.clone());
        this._tween(this.robber, this.robber.position.clone(), to, 700, true);
        setTimeout(() => { this.smoke(to.clone()); this.puff(to.clone(), '#3a3a44', 14); this.shake(250, 0.05); }, 680);
      }
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
        // 最初の着地（約36%地点）で土煙と効果音
        setTimeout(() => {
          this.puff(pos.clone(), '#d9c7a0', p.kind === 'road' ? 8 : 14);
          if (p.kind === 'city') { this.sparkle(pos.clone().add(new THREE.Vector3(0, 0.3, 0)), '#ffd75a', 26); this.shake(200, 0.03); }
          if (p.kind === 'settlement') this.sparkle(pos.clone().add(new THREE.Vector3(0, 0.25, 0)), color, 12);
          this.onEvent?.('land', { kind: p.kind, owner: p.owner });
        }, 200);
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
    setTimeout(() => { this.dice.forEach((d) => this.puff(d.position.clone().setY(0.05), '#ffffff', 6)); this.onEvent?.('diceLand'); }, 330);
  }

  // ---------------------------------------------------------
  // 演出（パーティクル・リング・浮かぶアイコン・画面揺れ）
  // ---------------------------------------------------------
  _spawn(mesh, life, vel, opts = {}) {
    if (this.fx.length > 400) return;
    this.fxGroup.add(mesh);
    this.fx.push({ mesh, t0: performance.now(), life, vel, grav: opts.grav ?? 0, grow: opts.grow ?? 0, spin: opts.spin ?? null, fade: opts.fade ?? true, s0: mesh.scale.x });
  }

  puff(pos, color = '#d9c7a0', n = 12) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(FXG.sphere, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.85, roughness: 1, depthWrite: false }));
      const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 0.8;
      m.position.copy(pos).add(new THREE.Vector3(0, 0.03, 0));
      m.scale.setScalar(0.03 + Math.random() * 0.03);
      this._spawn(m, 500 + Math.random() * 300, new THREE.Vector3(Math.cos(a) * sp, 0.3 + Math.random() * 0.5, Math.sin(a) * sp), { grow: 2.2, grav: -1.5 });
    }
  }

  sparkle(pos, color = '#ffe27a', n = 16) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(FXG.star, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }));
      const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 0.9;
      m.position.copy(pos);
      m.scale.setScalar(0.03 + Math.random() * 0.03);
      this._spawn(m, 700 + Math.random() * 500, new THREE.Vector3(Math.cos(a) * sp, 1.2 + Math.random() * 1.4, Math.sin(a) * sp), { grav: -3, spin: new THREE.Vector3(4, 6, 3) });
    }
  }

  smoke(pos) {
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(FXG.sphere, new THREE.MeshStandardMaterial({ color: '#6a6a74', transparent: true, opacity: 0.5, roughness: 1, depthWrite: false }));
      m.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.1 + Math.random() * 0.2, (Math.random() - 0.5) * 0.3));
      m.scale.setScalar(0.06 + Math.random() * 0.05);
      this._spawn(m, 900 + Math.random() * 500, new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3), { grow: 1.6 });
    }
  }

  ring(pos, color = '#fff2a8', delay = 0) {
    setTimeout(() => {
      const m = new THREE.Mesh(FXG.ring, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.rotation.x = Math.PI / 2; m.rotation.z = Math.PI / 6;
      m.position.copy(pos);
      m.scale.setScalar(0.5);
      this._spawn(m, 900, new THREE.Vector3(0, 0.15, 0), { grow: 1.4 });
    }, delay);
  }

  floatIcon(pos, text, delay = 0) {
    setTimeout(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const x = c.getContext('2d');
      x.font = '92px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 10;
      x.fillText(text, 64, 70);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sp.renderOrder = 20;
      sp.position.copy(pos);
      sp.scale.setScalar(0.55);
      this._spawn(sp, 1600, new THREE.Vector3(0, 0.9, 0));
    }, delay);
  }

  // ダイスの出目に応じて産出したタイルを光らせ、資源アイコンを浮かべる
  produce(state, sum, icons) {
    const B = this.board;
    let i = 0;
    for (const h of B.hexes) {
      if (h.num !== sum) continue;
      const blocked = h.id === state.board.robber;
      const pos = new THREE.Vector3(h.x, TOP + 0.05, h.z);
      if (blocked) { this.smoke(pos.clone()); this.floatIcon(pos.clone().setY(TOP + 0.6), '🚫', 300); continue; }
      const owners = h.vertices.map((v) => state.buildings[v]).filter(Boolean);
      this.ring(pos.clone(), '#fff2a8', 350 + i * 120);
      this.ring(pos.clone(), '#ffd75a', 550 + i * 120);
      owners.forEach((bd, j) => {
        const vtx = B.vertices[h.vertices.find((v) => state.buildings[v] === bd)];
        const icon = icons[h.terrain];
        if (!icon) return;
        const p = new THREE.Vector3(h.x + (vtx.x - h.x) * 0.5, TOP + 0.4, h.z + (vtx.z - h.z) * 0.5);
        this.floatIcon(p, icon, 450 + i * 120 + j * 90);
        if (bd.type === 'city') this.floatIcon(p.clone().add(new THREE.Vector3(0.12, 0.12, 0)), icon, 550 + i * 120 + j * 90);
      });
      if (owners.length) setTimeout(() => this.sparkle(pos.clone().setY(TOP + 0.2), '#fff6c0', 10), 400 + i * 120);
      i++;
    }
  }

  confetti(ms = 4000) {
    const colors = ['#e04545', '#3a78e0', '#f2f2f2', '#f09a28', '#5cc46a', '#ffd75a', '#c86be0'];
    const end = performance.now() + ms;
    const burst = () => {
      for (let i = 0; i < 18; i++) {
        const m = new THREE.Mesh(FXG.plane, new THREE.MeshBasicMaterial({ color: colors[Math.floor(Math.random() * colors.length)], side: THREE.DoubleSide, transparent: true, depthWrite: false }));
        m.position.set((Math.random() - 0.5) * 9, 5 + Math.random() * 2, (Math.random() - 0.5) * 8);
        m.scale.setScalar(0.08 + Math.random() * 0.06);
        this._spawn(m, 3000, new THREE.Vector3((Math.random() - 0.5) * 0.6, -1.4 - Math.random(), (Math.random() - 0.5) * 0.6), { spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6), fade: false });
      }
      if (performance.now() < end) setTimeout(burst, 160);
    };
    burst();
    // 花火
    for (let k = 0; k < 6; k++) setTimeout(() => {
      const p = new THREE.Vector3((Math.random() - 0.5) * 7, 2.5 + Math.random() * 1.5, (Math.random() - 0.5) * 6);
      this.sparkle(p, colors[k % colors.length], 40);
      this.onEvent?.('firework');
    }, 300 + k * 550);
  }

  shake(ms = 400, mag = 0.12) {
    this.shakeUntil = performance.now() + ms;
    this.shakeMag = mag;
  }

  _tickFx(now, dt) {
    this.fx = this.fx.filter((f) => {
      const k = (now - f.t0) / f.life;
      if (k >= 1) { this.fxGroup.remove(f.mesh); f.mesh.material.map?.dispose(); f.mesh.material.dispose(); return false; }
      f.vel.y += f.grav * dt;
      f.mesh.position.addScaledVector(f.vel, dt);
      if (f.mesh.position.y < 0.02 && f.grav < 0 && !f.spin) f.mesh.position.y = 0.02;
      if (f.grow) f.mesh.scale.setScalar(f.s0 * (1 + f.grow * k));
      if (f.spin) { f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt; f.mesh.rotation.z += f.spin.z * dt; }
      if (f.fade) f.mesh.material.opacity = (f.mesh.material.userData.o0 ??= f.mesh.material.opacity) * (1 - k * k);
      return true;
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
    if (this._lost) return;
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
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    this._tickFx(now, dt);
    this.controls.update();
    let off = null;
    if (now < this.shakeUntil) {
      const m = this.shakeMag * ((this.shakeUntil - now) / 400 + 0.3);
      off = new THREE.Vector3((Math.random() - 0.5) * m, (Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      this.camera.position.add(off);
    }
    this.renderer.render(this.scene, this.camera);
    if (off) this.camera.position.sub(off);
  }
}

const FXG = {
  sphere: new THREE.IcosahedronGeometry(1, 0),
  star: new THREE.OctahedronGeometry(1, 0),
  ring: new THREE.TorusGeometry(0.75, 0.05, 6, 6),
  plane: new THREE.PlaneGeometry(1, 0.6),
};
