// =============================================================
// ゲームルールエンジン（純粋ロジック・描画/通信に非依存）
// ホストのみがこのエンジンで状態を進め、各クライアントには view() で配信する
// =============================================================

export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RES_JP = { wood: '木材', brick: 'レンガ', sheep: '羊毛', wheat: '小麦', ore: '鉱石' };
export const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
export const TERRAIN_RES = { forest: 'wood', hills: 'brick', pasture: 'sheep', fields: 'wheat', mountains: 'ore', desert: null };
export const DEV_JP = { knight: '騎士', vp: '勝利点', road: '街道建設', plenty: '収穫', monopoly: '独占' };
export const PLAYER_COLORS = ['#e04545', '#3a78e0', '#f2f2f2', '#f09a28'];
export const PLAYER_COLOR_JP = ['赤', '青', '白', 'オレンジ'];

export const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};

const SQ3 = Math.sqrt(3);
const WIN_VP = 10;

function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const emptyRes = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const total = (r) => RES.reduce((s, k) => s + (r[k] || 0), 0);
const hasRes = (have, cost) => RES.every((k) => (have[k] || 0) >= (cost[k] || 0));
const subRes = (a, c) => RES.forEach((k) => (a[k] -= c[k] || 0));
const addRes = (a, c) => RES.forEach((k) => (a[k] += c[k] || 0));

// -------------------------------------------------------------
// 盤面生成：19ヘクス（半径2）、ポインティトップ
// -------------------------------------------------------------
export function hexCenter(q, r) {
  return { x: SQ3 * (q + r / 2), z: 1.5 * r };
}

export function generateBoard(rnd = Math.random) {
  const coords = [];
  for (let q = -2; q <= 2; q++)
    for (let r = -2; r <= 2; r++) if (Math.abs(q + r) <= 2) coords.push([q, r]);

  const terrains = shuffle(
    [...Array(4).fill('forest'), ...Array(3).fill('hills'), ...Array(4).fill('pasture'),
     ...Array(4).fill('fields'), ...Array(3).fill('mountains'), 'desert'], rnd);

  const hexes = coords.map(([q, r], i) => ({ id: i, q, r, ...hexCenter(q, r), terrain: terrains[i], num: 0, vertices: [] }));

  // 頂点・辺の構築
  const vMap = new Map();
  const vertices = [];
  const edges = [];
  const eMap = new Map();
  const vkey = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  for (const h of hexes) {
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = h.x + Math.cos(a), z = h.z + Math.sin(a);
      const k = vkey(x, z);
      let id = vMap.get(k);
      if (id === undefined) {
        id = vertices.length;
        vMap.set(k, id);
        vertices.push({ id, x, z, hexes: [], edges: [], adj: [], port: null });
      }
      vertices[id].hexes.push(h.id);
      ids.push(id);
    }
    h.vertices = ids;
    for (let i = 0; i < 6; i++) {
      const a = ids[i], b = ids[(i + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      let eid = eMap.get(k);
      if (eid === undefined) {
        eid = edges.length;
        eMap.set(k, eid);
        edges.push({ id: eid, v: [Math.min(a, b), Math.max(a, b)], hexes: [] });
        vertices[a].edges.push(eid); vertices[b].edges.push(eid);
        vertices[a].adj.push(b); vertices[b].adj.push(a);
      }
      edges[eid].hexes.push(h.id);
    }
  }

  // 数字チップ：6と8が隣接しないように再抽選
  const nums = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  const land = hexes.filter((h) => h.terrain !== 'desert');
  const neighbors = (h) => hexes.filter((o) => o !== h && Math.hypot(o.x - h.x, o.z - h.z) < 1.8);
  for (let tries = 0; tries < 500; tries++) {
    shuffle(nums, rnd);
    land.forEach((h, i) => (h.num = nums[i]));
    const bad = land.some((h) => (h.num === 6 || h.num === 8) && neighbors(h).some((o) => o.num === 6 || o.num === 8));
    if (!bad) break;
  }

  // 港：海岸の辺30本を角度順に並べ、間隔パターンで9箇所
  const coast = edges.filter((e) => e.hexes.length === 1);
  coast.forEach((e) => {
    const a = vertices[e.v[0]], b = vertices[e.v[1]];
    e._ang = Math.atan2((a.z + b.z) / 2, (a.x + b.x) / 2);
  });
  coast.sort((a, b) => a._ang - b._ang);
  const portTypes = shuffle(['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'], rnd);
  const gaps = [3, 3, 4, 3, 3, 4, 3, 3, 4];
  let idx = Math.floor(rnd() * coast.length);
  const ports = [];
  for (let i = 0; i < 9; i++) {
    const e = coast[idx % coast.length];
    ports.push({ edge: e.id, type: portTypes[i] });
    vertices[e.v[0]].port = portTypes[i];
    vertices[e.v[1]].port = portTypes[i];
    idx += gaps[i];
  }
  coast.forEach((e) => delete e._ang);

  const desert = hexes.find((h) => h.terrain === 'desert');
  return { hexes, vertices, edges, ports, robber: desert.id };
}

// -------------------------------------------------------------
// 状態生成
// -------------------------------------------------------------
export function createGame(playerInfos, rnd = Math.random) {
  const board = generateBoard(rnd);
  const devDeck = shuffle([
    ...Array(14).fill('knight'), ...Array(5).fill('vp'),
    ...Array(2).fill('road'), ...Array(2).fill('plenty'), ...Array(2).fill('monopoly')], rnd);
  const n = playerInfos.length;
  const players = playerInfos.map((p, i) => ({
    id: i, name: p.name, color: PLAYER_COLORS[i],
    res: emptyRes(), dev: [], newDev: [], knights: 0,
    roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4,
  }));
  const order = [...Array(n).keys()];
  return {
    board, players, devDeck,
    bank: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 },
    buildings: {}, // vertexId -> {owner, type:'settlement'|'city'}
    roads: {}, // edgeId -> owner
    phase: 'setup',
    setup: { order: [...order, ...order.slice().reverse()], idx: 0, step: 'settlement', lastVertex: null },
    current: 0,
    step: 'setup', // setup | roll | main | discard | robber | steal | ended
    dice: null,
    devPlayed: false,
    freeRoads: 0,
    pendingDiscard: {},
    trade: null,
    largestArmy: null,
    longestRoad: null,
    longestLen: {},
    winner: null,
    log: [{ id: 1, t: 'ゲーム開始！ 初期配置：開拓地→街道を置いてください' }],
    logId: 1,
    seq: 0,
  };
}

// -------------------------------------------------------------
// 補助判定
// -------------------------------------------------------------
function log(s, t) { s.logId = (s.logId || 0) + 1; s.log.push({ id: s.logId, t }); if (s.log.length > 120) s.log.shift(); }
const pname = (s, i) => s.players[i].name;

export function canPlaceSettlementAt(s, v, pid, requireRoad) {
  const B = s.board;
  if (s.buildings[v]) return false;
  if (B.vertices[v].adj.some((a) => s.buildings[a])) return false; // 距離ルール
  if (!requireRoad) return true;
  return B.vertices[v].edges.some((e) => s.roads[e] === pid);
}

export function canPlaceRoadAt(s, e, pid, fromVertex = null) {
  const B = s.board;
  if (s.roads[e] !== undefined) return false;
  const [a, b] = B.edges[e].v;
  if (fromVertex !== null) return a === fromVertex || b === fromVertex;
  for (const v of [a, b]) {
    const bd = s.buildings[v];
    if (bd && bd.owner === pid) return true;
    if (bd && bd.owner !== pid) continue; // 相手の建物で接続が切れる
    if (B.vertices[v].edges.some((oe) => oe !== e && s.roads[oe] === pid)) return true;
  }
  return false;
}

export function legalTargets(s, pid, kind) {
  const B = s.board;
  if (kind === 'settlement') {
    const setup = s.phase === 'setup' || s.step === 'joinSetup';
    // 初期配置では、隣に空いている辺（街道を置ける場所）がある頂点だけ
    return B.vertices.map((v) => v.id).filter((v) => canPlaceSettlementAt(s, v, pid, !setup) && (!setup || B.vertices[v].edges.some((e) => s.roads[e] === undefined)));
  }
  if (kind === 'road') {
    const from = s.phase === 'setup' ? s.setup.lastVertex : s.step === 'joinSetup' ? s.joinSetup.lastVertex : null;
    return B.edges.map((e) => e.id).filter((e) => canPlaceRoadAt(s, e, pid, from));
  }
  if (kind === 'city') {
    return Object.keys(s.buildings).map(Number).filter((v) => s.buildings[v].owner === pid && s.buildings[v].type === 'settlement');
  }
  if (kind === 'robber') return B.hexes.map((h) => h.id).filter((h) => h !== B.robber);
  return [];
}

export function tradeRates(s, pid) {
  const rates = { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 };
  for (const [v, bd] of Object.entries(s.buildings)) {
    if (bd.owner !== pid) continue;
    const port = s.board.vertices[v].port;
    if (port === 'any') RES.forEach((r) => (rates[r] = Math.min(rates[r], 3)));
    else if (port) rates[port] = 2;
  }
  return rates;
}

export function victoryPoints(s, pid, includeHidden = true) {
  let vp = 0;
  for (const bd of Object.values(s.buildings)) if (bd.owner === pid) vp += bd.type === 'city' ? 2 : 1;
  if (s.largestArmy === pid) vp += 2;
  if (s.longestRoad === pid) vp += 2;
  if (includeHidden) {
    const p = s.players[pid];
    vp += p.dev.filter((d) => d === 'vp').length + p.newDev.filter((d) => d === 'vp').length;
  }
  return vp;
}

// 最長交易路（DFSで辺を1回ずつ使う最長パス）
export function longestRoadOf(s, pid) {
  const B = s.board;
  const mine = Object.keys(s.roads).map(Number).filter((e) => s.roads[e] === pid);
  if (!mine.length) return 0;
  const used = new Set();
  let best = 0;
  const dfs = (v, len) => {
    best = Math.max(best, len);
    const bd = s.buildings[v];
    if (len > 0 && bd && bd.owner !== pid) return; // 相手の建物で通過不可
    for (const e of B.vertices[v].edges) {
      if (s.roads[e] !== pid || used.has(e)) continue;
      used.add(e);
      const [a, b] = B.edges[e].v;
      dfs(a === v ? b : a, len + 1);
      used.delete(e);
    }
  };
  const starts = new Set();
  mine.forEach((e) => B.edges[e].v.forEach((v) => starts.add(v)));
  starts.forEach((v) => dfs(v, 0));
  return best;
}

function updateLongestRoad(s) {
  const lens = s.players.map((p) => longestRoadOf(s, p.id));
  s.longestLen = Object.fromEntries(lens.map((l, i) => [i, l]));
  const holder = s.longestRoad;
  const max = Math.max(...lens);
  if (holder !== null && lens[holder] === max && max >= 5) return; // 保持者は同点なら維持
  const top = lens.map((l, i) => [l, i]).filter(([l]) => l === max && l >= 5);
  const prev = holder;
  if (top.length === 1) s.longestRoad = top[0][1];
  else if (holder !== null && (lens[holder] < 5 || lens[holder] < max)) s.longestRoad = null; // 同点複数なら誰も持たない
  if (s.longestRoad !== prev && s.longestRoad !== null) log(s, `🛤️ ${pname(s, s.longestRoad)} が最長交易路を獲得（${max}本）`);
  if (s.longestRoad === null && prev !== null) log(s, `🛤️ 最長交易路は保持者なしになりました`);
}

function updateLargestArmy(s, pid) {
  const k = s.players[pid].knights;
  if (k < 3) return;
  const holder = s.largestArmy;
  if (holder === pid) return;
  if (holder === null || k > s.players[holder].knights) {
    s.largestArmy = pid;
    log(s, `⚔️ ${pname(s, pid)} が最大騎士力を獲得（騎士${k}枚）`);
  }
}

function checkWin(s) {
  const pid = s.current;
  if (s.phase !== 'play') return;
  if (victoryPoints(s, pid) >= WIN_VP) {
    s.phase = 'ended'; s.step = 'ended'; s.winner = pid;
    log(s, `🏆 ${pname(s, pid)} の勝利！（${victoryPoints(s, pid)}点）`);
  }
}

function produce(s, roll) {
  const B = s.board;
  const gains = s.players.map(() => emptyRes());
  for (const h of B.hexes) {
    if (h.num !== roll || h.id === B.robber) continue;
    const r = TERRAIN_RES[h.terrain];
    for (const v of h.vertices) {
      const bd = s.buildings[v];
      if (bd) gains[bd.owner][r] += bd.type === 'city' ? 2 : 1;
    }
  }
  // 銀行の在庫不足：その資源の需要が在庫を超え、かつ複数人が受け取るなら誰も受け取らない
  for (const r of RES) {
    const need = gains.reduce((a, g) => a + g[r], 0);
    if (need > s.bank[r]) {
      const takers = gains.filter((g) => g[r] > 0);
      if (takers.length > 1) { gains.forEach((g) => (g[r] = 0)); log(s, `銀行の${RES_JP[r]}が不足のため配布なし`); }
      else takers.forEach((g) => (g[r] = s.bank[r]));
    }
  }
  gains.forEach((g, i) => {
    if (total(g) === 0) return;
    addRes(s.players[i].res, g); subRes(s.bank, g);
    log(s, `${pname(s, i)} が獲得: ${RES.filter((r) => g[r]).map((r) => RES_ICON[r] + '×' + g[r]).join(' ')}`);
  });
}

function stealCandidates(s, hexId, pid) {
  const owners = new Set();
  for (const v of s.board.hexes[hexId].vertices) {
    const bd = s.buildings[v];
    if (bd && bd.owner !== pid && total(s.players[bd.owner].res) > 0) owners.add(bd.owner);
  }
  return [...owners];
}

function stealFrom(s, victim, thief, rnd) {
  const vr = s.players[victim].res;
  const pool = RES.flatMap((r) => Array(vr[r]).fill(r));
  if (!pool.length) return;
  const r = pool[Math.floor(rnd() * pool.length)];
  vr[r]--; s.players[thief].res[r]++;
  log(s, `🦹 ${pname(s, thief)} が ${pname(s, victim)} から資源を1枚奪った`);
  s._private = { to: [thief, victim], t: `奪われた/奪った資源: ${RES_ICON[r]} ${RES_JP[r]}` };
}

function afterRobberMoved(s, rnd) {
  const cands = stealCandidates(s, s.board.robber, s.current);
  if (cands.length === 0) { s.step = s.dice ? 'main' : 'roll'; return; }
  if (cands.length === 1) { stealFrom(s, cands[0], s.current, rnd); s.step = s.dice ? 'main' : 'roll'; return; }
  s.step = 'steal';
  s.stealCands = cands;
}

// 手番を次の人へ
function passTurn(s) {
  const P = s.players[s.current];
  P.dev.push(...P.newDev); P.newDev = [];
  s.freeRoads = 0; s.devPlayed = false; s.trade = null; s.dice = null;
  delete s.stealCands;
  s.current = (s.current + 1) % s.players.length;
  log(s, `— ${pname(s, s.current)} の手番 —`);
  beginTurn(s);
}
function beginTurn(s) {
  const P = s.players[s.current];
  if (P.pendingSetup > 0 && legalTargets(s, P.id, 'settlement').length === 0) {
    P.pendingSetup = 0;
    log(s, `${P.name} の初期配置：置ける場所がないため省略`);
  }
  if (P.pendingSetup > 0) {
    s.step = 'joinSetup';
    s.joinSetup = { step: 'settlement', lastVertex: null };
    if (P.pendingSetup === 2) log(s, `${P.name} は途中参加：開拓地と街道を2回置いてください`);
  } else s.step = 'roll';
}

// 途中参加（最大4人）
export function addPlayer(s, name) {
  if (s.players.length >= 4) throw new Error('満員です（最大4人）');
  const id = s.players.length;
  s.players.push({
    id, name, color: PLAYER_COLORS[id],
    res: emptyRes(), dev: [], newDev: [], knights: 0,
    roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4, pendingSetup: 2,
  });
  log(s, `🙋 ${name} が途中参加しました（自分の番で初期配置）`);
  s.seq++;
  return id;
}

// ホストによる強制スキップ
function forceSkip(s, rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const act = (a) => applyAction(s, a, rnd);
  if (s.step === 'discard') {
    for (const pid of Object.keys(s.pendingDiscard).map(Number)) {
      if (pid === 0) continue;
      const P = s.players[pid], need = s.pendingDiscard[pid];
      const pool = RES.flatMap((r) => Array(P.res[r]).fill(r));
      const res = emptyRes();
      for (let i = 0; i < need; i++) res[pool.splice(Math.floor(rnd() * pool.length), 1)[0]]++;
      act({ type: 'discard', pid, res });
    }
    log(s, '⏭️ ホストが捨て札を自動処理しました');
    return;
  }
  const pid = s.current;
  log(s, `⏭️ ホストが ${pname(s, pid)} の番を自動で進めました`);
  let guard = 0;
  while (guard++ < 20) {
    if (s.phase === 'ended' || s.current !== pid) return;
    const setupNow = s.phase === 'setup' || s.step === 'joinSetup';
    if (setupNow) {
      const st = s.phase === 'setup' ? s.setup.step : s.joinSetup.step;
      if (st === 'settlement') act({ type: 'setupSettlement', pid, v: pick(legalTargets(s, pid, 'settlement')) });
      else act({ type: 'setupRoad', pid, e: pick(legalTargets(s, pid, 'road')) });
      if (s.phase === 'setup' && s.current !== pid) return; // 初期配置は1手番ずつ
      continue;
    }
    if (s.step === 'robber') { act({ type: 'moveRobber', pid, hex: pick(legalTargets(s, pid, 'robber')) }); continue; }
    if (s.step === 'steal') { act({ type: 'steal', pid, victim: pick(s.stealCands) }); continue; }
    if (s.step === 'discard') return;
    // roll / main：ダイスを振らずに手番を渡す
    passTurn(s);
    return;
  }
}

// -------------------------------------------------------------
// アクション適用（違反時は Error を投げる）
// action = { type, pid, ... }
// -------------------------------------------------------------
export function applyAction(s, a, rnd = Math.random) {
  if (s.phase === 'ended') throw new Error('ゲームは終了しています');
  const pid = a.pid;
  const P = s.players[pid];
  if (!P) throw new Error('不正なプレイヤー');
  const isCur = pid === s.current;
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  delete s._private;

  switch (a.type) {
    // ---------- 初期配置 ----------
    case 'setupSettlement': {
      if (s.step === 'joinSetup') {
        // 途中参加プレイヤーの初期配置
        need(isCur && s.joinSetup.step === 'settlement', 'いまは置けません');
        need(legalTargets(s, pid, 'settlement').includes(a.v), 'そこには置けません');
        s.buildings[a.v] = { owner: pid, type: 'settlement' };
        P.settlementsLeft--;
        s.joinSetup.lastVertex = a.v;
        s.joinSetup.step = 'road';
        if (P.pendingSetup === 1) {
          for (const h of s.board.vertices[a.v].hexes) {
            const r = TERRAIN_RES[s.board.hexes[h].terrain];
            if (r && s.bank[r] > 0) { P.res[r]++; s.bank[r]--; }
          }
        }
        log(s, `${P.name} が開拓地を配置`);
        break;
      }
      need(s.phase === 'setup' && isCur && s.setup.step === 'settlement', 'いまは置けません');
      need(legalTargets(s, pid, 'settlement').includes(a.v), 'そこには置けません');
      s.buildings[a.v] = { owner: pid, type: 'settlement' };
      P.settlementsLeft--;
      s.setup.lastVertex = a.v;
      s.setup.step = 'road';
      // 2巡目は隣接タイルの資源を受け取る
      if (s.setup.idx >= s.setup.order.length / 2) {
        for (const h of s.board.vertices[a.v].hexes) {
          const r = TERRAIN_RES[s.board.hexes[h].terrain];
          if (r && s.bank[r] > 0) { P.res[r]++; s.bank[r]--; }
        }
      }
      log(s, `${P.name} が開拓地を配置`);
      break;
    }
    case 'setupRoad': {
      if (s.step === 'joinSetup') {
        need(isCur && s.joinSetup.step === 'road', 'いまは置けません');
        need(canPlaceRoadAt(s, a.e, pid, s.joinSetup.lastVertex), 'そこには置けません');
        s.roads[a.e] = pid; P.roadsLeft--;
        P.pendingSetup--;
        if (P.pendingSetup > 0) { delete s.joinSetup; beginTurn(s); }
        else { delete s.joinSetup; s.step = 'roll'; log(s, `${P.name} の初期配置完了。ダイスを振ってください`); }
        updateLongestRoad(s);
        break;
      }
      need(s.phase === 'setup' && isCur && s.setup.step === 'road', 'いまは置けません');
      need(canPlaceRoadAt(s, a.e, pid, s.setup.lastVertex), 'そこには置けません');
      s.roads[a.e] = pid; P.roadsLeft--;
      s.setup.idx++;
      s.setup.step = 'settlement';
      s.setup.lastVertex = null;
      if (s.setup.idx >= s.setup.order.length) {
        s.phase = 'play'; s.current = 0;
        log(s, `初期配置完了！ ${pname(s, 0)} の手番です`);
        beginTurn(s);
      } else {
        s.current = s.setup.order[s.setup.idx];
      }
      updateLongestRoad(s);
      break;
    }

    // ---------- ダイス ----------
    case 'roll': {
      need(s.phase === 'play' && isCur && s.step === 'roll', 'いまはダイスを振れません');
      const d1 = 1 + Math.floor(rnd() * 6), d2 = 1 + Math.floor(rnd() * 6);
      s.dice = [d1, d2]; s.rollSeq = (s.rollSeq || 0) + 1;
      const sum = d1 + d2;
      log(s, `🎲 ${P.name} の出目: ${d1}+${d2} = ${sum}`);
      if (sum === 7) {
        s.pendingDiscard = {};
        s.players.forEach((p) => { const t = total(p.res); if (t > 7) s.pendingDiscard[p.id] = Math.floor(t / 2); });
        if (Object.keys(s.pendingDiscard).length) {
          s.step = 'discard';
          log(s, `7！ 手札8枚以上のプレイヤーは半分を捨ててください`);
        } else {
          s.step = 'robber';
          log(s, `7！ ${P.name} は盗賊を移動してください`);
        }
      } else {
        produce(s, sum);
        s.step = 'main';
      }
      break;
    }
    case 'discard': {
      need(s.step === 'discard' && s.pendingDiscard[pid], '捨てる必要はありません');
      const cnt = total(a.res);
      need(cnt === s.pendingDiscard[pid], `${s.pendingDiscard[pid]}枚選んでください`);
      need(hasRes(P.res, a.res) && RES.every((r) => (a.res[r] || 0) >= 0), '資源が足りません');
      subRes(P.res, a.res); addRes(s.bank, a.res);
      delete s.pendingDiscard[pid];
      log(s, `${P.name} が${cnt}枚捨てた`);
      if (!Object.keys(s.pendingDiscard).length) { s.step = 'robber'; log(s, `${pname(s, s.current)} は盗賊を移動してください`); }
      break;
    }
    case 'moveRobber': {
      need(isCur && s.step === 'robber', 'いまは盗賊を動かせません');
      need(a.hex !== s.board.robber && s.board.hexes[a.hex], '同じ場所には置けません');
      s.board.robber = a.hex;
      log(s, `🦹 ${P.name} が盗賊を移動`);
      afterRobberMoved(s, rnd);
      break;
    }
    case 'steal': {
      need(isCur && s.step === 'steal' && s.stealCands.includes(a.victim), '選べません');
      stealFrom(s, a.victim, pid, rnd);
      delete s.stealCands;
      s.step = s.dice ? 'main' : 'roll';
      break;
    }

    // ---------- 建設 ----------
    case 'build': {
      need(s.phase === 'play' && isCur && s.step === 'main', 'いまは建設できません');
      if (a.kind === 'road') {
        const free = s.freeRoads > 0;
        need(free || hasRes(P.res, COST.road), '資源が足りません');
        need(P.roadsLeft > 0, '街道の在庫がありません');
        need(canPlaceRoadAt(s, a.e, pid), 'そこには置けません');
        if (free) s.freeRoads--; else { subRes(P.res, COST.road); addRes(s.bank, COST.road); }
        s.roads[a.e] = pid; P.roadsLeft--;
        log(s, `${P.name} が街道を建設${free ? '（無料）' : ''}`);
        updateLongestRoad(s);
      } else if (a.kind === 'settlement') {
        need(s.freeRoads === 0, '先に無料の街道を置いてください');
        need(hasRes(P.res, COST.settlement), '資源が足りません');
        need(P.settlementsLeft > 0, '開拓地の在庫がありません');
        need(canPlaceSettlementAt(s, a.v, pid, true), 'そこには置けません');
        subRes(P.res, COST.settlement); addRes(s.bank, COST.settlement);
        s.buildings[a.v] = { owner: pid, type: 'settlement' }; P.settlementsLeft--;
        log(s, `${P.name} が開拓地を建設`);
        updateLongestRoad(s); // 他人の道を分断する可能性
      } else if (a.kind === 'city') {
        need(s.freeRoads === 0, '先に無料の街道を置いてください');
        need(hasRes(P.res, COST.city), '資源が足りません');
        need(P.citiesLeft > 0, '都市の在庫がありません');
        const bd = s.buildings[a.v];
        need(bd && bd.owner === pid && bd.type === 'settlement', '自分の開拓地を選んでください');
        subRes(P.res, COST.city); addRes(s.bank, COST.city);
        bd.type = 'city'; P.citiesLeft--; P.settlementsLeft++;
        log(s, `${P.name} が都市を建設`);
      } else throw new Error('不明な建設');
      checkWin(s);
      break;
    }

    // ---------- 発展カード ----------
    case 'buyDev': {
      need(s.phase === 'play' && isCur && s.step === 'main' && s.freeRoads === 0, 'いまは購入できません');
      need(hasRes(P.res, COST.dev), '資源が足りません');
      need(s.devDeck.length > 0, '発展カードの山札がありません');
      subRes(P.res, COST.dev); addRes(s.bank, COST.dev);
      const card = s.devDeck.pop();
      P.newDev.push(card);
      log(s, `${P.name} が発展カードを購入`);
      s._private = { to: [pid], t: `引いたカード: ${DEV_JP[card]}` };
      checkWin(s);
      break;
    }
    case 'playDev': {
      need(s.phase === 'play' && isCur, '自分の手番ではありません');
      need(!s.devPlayed, '発展カードは1ターン1枚までです');
      need(s.step === 'main' || (s.step === 'roll' && a.card === 'knight'), 'いまは使えません');
      need(s.freeRoads === 0, '先に無料の街道を置いてください');
      need(a.card !== 'vp', '勝利点カードは使用不要です');
      const i = P.dev.indexOf(a.card);
      need(i >= 0, 'そのカードを持っていません（購入したターンは使えません）');
      if (a.card === 'plenty') {
        need(Array.isArray(a.pick) && a.pick.length === 2 && a.pick.every((r) => RES.includes(r)), '資源を2つ選んでください');
        const want = emptyRes(); a.pick.forEach((r) => want[r]++);
        need(hasRes(s.bank, want), '銀行の在庫が足りません');
      }
      if (a.card === 'monopoly') need(RES.includes(a.res), '資源を選んでください');
      P.dev.splice(i, 1);
      s.devPlayed = true;
      if (a.card === 'knight') {
        P.knights++;
        log(s, `⚔️ ${P.name} が騎士を使用`);
        updateLargestArmy(s, pid);
        s.step = 'robber'; // 盗賊移動後、ダイス前なら roll に戻る（afterRobberMoved）
      } else if (a.card === 'road') {
        s.freeRoads = Math.min(2, P.roadsLeft);
        log(s, `🛤️ ${P.name} が街道建設を使用（無料で街道2本）`);
      } else if (a.card === 'plenty') {
        a.pick.forEach((r) => { P.res[r]++; s.bank[r]--; });
        log(s, `🎁 ${P.name} が収穫を使用: ${a.pick.map((r) => RES_ICON[r]).join(' ')}`);
      } else if (a.card === 'monopoly') {
        let got = 0;
        s.players.forEach((o) => { if (o.id !== pid) { got += o.res[a.res]; P.res[a.res] += o.res[a.res]; o.res[a.res] = 0; } });
        log(s, `💰 ${P.name} が独占を使用: ${RES_ICON[a.res]}×${got} を獲得`);
      }
      checkWin(s);
      break;
    }

    // ---------- 交易 ----------
    case 'bankTrade': {
      need(s.phase === 'play' && isCur && s.step === 'main' && s.freeRoads === 0, 'いまは交易できません');
      need(RES.includes(a.give) && RES.includes(a.get) && a.give !== a.get, '資源を選んでください');
      const rate = tradeRates(s, pid)[a.give];
      need(P.res[a.give] >= rate, `${RES_JP[a.give]}が${rate}枚必要です`);
      need(s.bank[a.get] > 0, '銀行の在庫がありません');
      P.res[a.give] -= rate; s.bank[a.give] += rate;
      P.res[a.get]++; s.bank[a.get]--;
      log(s, `${P.name} が交易: ${RES_ICON[a.give]}×${rate} → ${RES_ICON[a.get]}×1`);
      break;
    }
    case 'offerTrade': {
      need(s.phase === 'play' && isCur && s.step === 'main' && s.freeRoads === 0, 'いまは交渉できません');
      need(total(a.give) > 0 && total(a.get) > 0, '出す資源と欲しい資源を選んでください');
      need(hasRes(P.res, a.give), '資源が足りません');
      need(!RES.some((r) => a.give[r] > 0 && a.get[r] > 0), '同じ資源を出して受け取ることはできません');
      s.trade = { from: pid, give: { ...emptyRes(), ...a.give }, get: { ...emptyRes(), ...a.get }, responses: {}, auto: {}, autoDelay: {}, id: (s.trade?.id || 0) + 1 };
      // 欲しい資源を持っていない人は最初から「×（資源不足）」にしておく
      s.players.forEach((o) => {
        if (o.id !== pid && !hasRes(o.res, s.trade.get)) {
          s.trade.responses[o.id] = false; s.trade.auto[o.id] = true;
          s.trade.autoDelay[o.id] = 3000 + Math.floor(rnd() * 7000); // 表示は3〜10秒後（人が断ったように見せる）
        }
      });
      log(s, `🤝 ${P.name} が交渉を提案: 出す ${fmt(a.give)} ／ 欲しい ${fmt(a.get)}`);
      break;
    }
    case 'respondTrade': {
      need(s.trade && pid !== s.trade.from, '回答できる交渉がありません');
      if (a.accept) need(hasRes(P.res, s.trade.get), '資源が足りません');
      s.trade.responses[pid] = !!a.accept;
      log(s, `${P.name} が交渉を${a.accept ? '承諾' : '拒否'}`);
      break;
    }
    case 'confirmTrade': {
      need(s.trade && pid === s.trade.from && isCur, '確定できません');
      const o = s.players[a.with];
      need(o && s.trade.responses[a.with] === true, 'その相手は承諾していません');
      need(hasRes(P.res, s.trade.give) && hasRes(o.res, s.trade.get), '資源が足りません');
      subRes(P.res, s.trade.give); addRes(o.res, s.trade.give);
      subRes(o.res, s.trade.get); addRes(P.res, s.trade.get);
      log(s, `🤝 ${P.name} と ${o.name} の交渉成立`);
      s.trade = null;
      break;
    }
    case 'cancelTrade': {
      need(s.trade && pid === s.trade.from, '取り消せません');
      s.trade = null;
      log(s, `${P.name} が交渉を取り下げた`);
      break;
    }

    case 'endTurn': {
      need(s.phase === 'play' && isCur && s.step === 'main', 'いまはターンを終了できません');
      passTurn(s);
      break;
    }
    case 'forceSkip': {
      // ホスト専用：止まっている人（切断・放置）の処理を自動で進める
      need(pid === 0, 'ホストだけが使えます');
      forceSkip(s, rnd);
      break;
    }
    default: throw new Error('不明なアクション: ' + a.type);
  }
  s.seq++;
  return s;
}

function fmt(r) {
  return RES.filter((k) => r[k] > 0).map((k) => RES_ICON[k] + '×' + r[k]).join(' ') || 'なし';
}
export { fmt as fmtRes, total as resTotal, hasRes };

// -------------------------------------------------------------
// 誰が今アクションを求められているか
// -------------------------------------------------------------
export function whoMustAct(s) {
  if (s.phase === 'ended') return [];
  if (s.step === 'discard') return Object.keys(s.pendingDiscard).map(Number);
  return [s.current];
}

// 各プレイヤーへ配信するビュー（他人の手札内容・山札を隠す）
export function view(s, pid) {
  const v = JSON.parse(JSON.stringify(s));
  v.devDeckCount = s.devDeck.length;
  delete v.devDeck;
  v.players.forEach((p) => {
    p.resCount = total(p.res);
    p.devCount = p.dev.length + p.newDev.length;
    p.vpPublic = victoryPoints(s, p.id, false);
    if (p.id !== pid && s.phase !== 'ended') {
      p.res = null; p.dev = null; p.newDev = null;
    } else {
      p.vp = victoryPoints(s, p.id, true);
    }
  });
  if (s._private && !s._private.to.includes(pid)) delete v._private;
  return v;
}
