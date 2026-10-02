// =============================================================
// アプリ本体：画面遷移・HUD・入力 → アクション送信
// =============================================================
import * as G from './game.js';
import { BoardRenderer } from './render.js';
import { Host, Client, randomCode } from './net.js';
import { sfx, Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const RES = G.RES;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const renderer = new BoardRenderer($('scene'));
renderer.onPick = onPick;
renderer.onEvent = (name, d) => {
  if (name === 'land') sfx(d.kind === 'road' ? 'road' : d.kind);
  else sfx(name);
};

const app = {
  role: null, // 'host' | 'client' | 'local'
  host: null, client: null, code: null,
  game: null, // ホスト/ローカルの完全な状態
  v: null, // 自分に見えている状態
  me: 0,
  boardKey: null,
  buildMode: null,
  lastRollSeq: 0,
  lastPrivSeq: -1,
  lastLogId: 0,
  chats: [],
};

let token = store.get('hexisle-token');
if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('hexisle-token', token); }
$('nameInput').value = store.get('hexisle-name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('codeInput').value = urlRoom.toUpperCase();
if (store.get('hexisle-host')) $('resumeBox').classList.remove('hidden');

// -------------------------------------------------------------
// 共通UI
// -------------------------------------------------------------
function toast(t, ok = false) {
  if (String(t).startsWith('⚠️')) sfx('error');
  const d = document.createElement('div');
  d.className = 'toast' + (ok ? ' ok' : '');
  d.textContent = t;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 3300);
}
function show(id) {
  ['menu', 'lobby', 'hud'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
}
function modal(html, bind) {
  $('modalBody').innerHTML = html;
  $('modal').classList.remove('hidden');
  bind?.($('modalBody'));
}
function closeModal() { $('modal').classList.add('hidden'); app.modalKind = null; }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const myName = () => ($('nameInput').value.trim() || 'プレイヤー').slice(0, 12);

// -------------------------------------------------------------
// メニュー
// -------------------------------------------------------------
$('btnCreate').onclick = () => {
  store.set('hexisle-name', myName());
  startHost(randomCode());
};
$('btnJoin').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) return ($('menuMsg').textContent = '5文字の部屋コードを入力してください');
  store.set('hexisle-name', myName());
  startClient(code);
};
$('btnLocal').onclick = () => {
  const n = +$('localCount').value;
  app.role = 'local';
  const names = Array.from({ length: n }, (_, i) => (i === 0 ? myName() : `プレイヤー${i + 1}`));
  app.game = G.createGame(names.map((name) => ({ name })));
  enterGame();
  publish();
};
$('btnResume').onclick = () => {
  const saved = store.get('hexisle-host');
  if (!saved) return;
  startHost(saved.code, saved);
};
$('btnLeave').onclick = () => (location.href = location.pathname + location.search.replace(/[?&]room=[^&]*/, ''));
$('btnCopy').onclick = () => { $('inviteUrl').select(); navigator.clipboard?.writeText($('inviteUrl').value); toast('招待リンクをコピーしました', true); };
$('btnCost').onclick = () => $('costCard').classList.toggle('hidden');
document.addEventListener('click', (e) => { if (e.target.closest('button:not(:disabled)')) sfx('click'); }, true);
function soundLabel() { $('btnSound').textContent = Sound.enabled ? '🔊 音あり' : '🔇 音なし'; }
$('btnSound').onclick = () => { Sound.setEnabled(!Sound.enabled); soundLabel(); };
soundLabel();

function inviteUrl(code) {
  const q = new URLSearchParams(location.search);
  q.set('room', code);
  return `${location.origin}${location.pathname}?${q}`;
}

function peerErrorText(e) {
  const t = e?.type || '';
  if (t === 'unavailable-id') return 'その部屋コードは使用中です。もう一度作成してください';
  if (t === 'peer-unavailable') return '部屋が見つかりません（コード違い／ホストが閉じた可能性）';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return '接続サーバーに繋がりません。ネットワークを確認してください';
  if (t === 'browser-incompatible') return 'このブラウザはWebRTCに対応していません';
  return '通信エラー: ' + (e?.message || t);
}

// -------------------------------------------------------------
// ホスト
// -------------------------------------------------------------
function startHost(code, saved = null) {
  app.role = 'host';
  app.code = code;
  show('lobby');
  $('roomCode').textContent = code;
  $('inviteUrl').value = inviteUrl(code);
  $('lobbyMsg').textContent = '接続サーバーに登録中…';
  const host = (app.host = new Host(code, {
    onOpen: () => { $('lobbyMsg').textContent = saved ? '部屋を再開しました。参加者の再接続を待っています' : '友だちに部屋コードか招待リンクを送ってください'; renderLobby(); },
    onError: (e) => { $('lobbyMsg').textContent = peerErrorText(e); toast(peerErrorText(e)); },
    onJoin: (i) => { if (app.game) { publish(); toast(`${host.seats[i].name} が接続しました`, true); } else renderLobby(); },
    onLeave: (i) => { if (app.game) { publish(); toast(`${host.seats[i].name} が切断しました`); } else { host.seats.splice(i, 1); host.seats.forEach((s, j) => s.conn && (s.conn._seat = j)); renderLobby(); } },
    onMessage: (i, m) => hostHandle(i, m),
  }));
  if (saved) {
    host.seats = saved.seats.map((s, i) => ({ ...s, conn: null, connected: i === 0, local: i === 0 }));
    host.started = true;
    app.game = saved.game;
    app.me = 0;
    enterGame();
    publish();
  } else {
    host.addLocalSeat(myName(), token);
  }
}

function renderLobby() {
  const seats = app.role === 'host' ? app.host.seats : app.lobbySeats || [];
  $('seatList').innerHTML = seats.map((s, i) =>
    `<li><span class="dot" style="background:${G.PLAYER_COLORS[i]}"></span>${esc(s.name)}${i === 0 ? '（ホスト）' : ''}${i === app.me ? ' ← あなた' : ''}
     ${app.role === 'host' && i > 0 ? `<button class="mini" data-kick="${i}" style="margin-left:auto">外す</button>` : ''}</li>`).join('');
  $('seatList').querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => { app.host.kick(+b.dataset.kick); renderLobby(); }));
  const isHost = app.role === 'host';
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = seats.length < 2;
  $('btnStart').textContent = seats.length < 2 ? 'ゲーム開始（2人以上）' : `ゲーム開始（${seats.length}人）`;
  if (isHost) app.host.broadcast((i) => ({ t: 'lobby', seats: seats.map((s) => ({ name: s.name })), you: i }));
}
$('btnStart').onclick = () => {
  const h = app.host;
  h.started = true;
  app.game = G.createGame(h.seats.map((s) => ({ name: s.name })));
  app.me = 0;
  enterGame();
  publish();
};

function hostHandle(i, m) {
  if (m.t === 'act' && app.game) {
    try {
      G.applyAction(app.game, { ...m.a, pid: i });
      publish();
    } catch (e) { app.host.send(i, { t: 'err', msg: e.message }); }
  } else if (m.t === 'chat') {
    const c = { from: app.host.seats[i]?.name || '?', text: String(m.text).slice(0, 80) };
    app.host.broadcast(() => ({ t: 'chat', ...c }));
    addChat(c);
  }
}

// -------------------------------------------------------------
// クライアント
// -------------------------------------------------------------
function startClient(code) {
  app.role = 'client';
  app.code = code;
  show('lobby');
  $('roomCode').textContent = code;
  $('inviteUrl').value = inviteUrl(code);
  $('lobbyMsg').textContent = '部屋に接続中…';
  connectClient();
}
function connectClient() {
  app.client = new Client(app.code, myName(), token, {
    onOpen: () => { $('lobbyMsg').textContent = 'ホストの開始を待っています'; },
    onError: (e) => { const t = peerErrorText(e); $('lobbyMsg').textContent = t; toast(t); },
    onClose: () => {
      toast('ホストとの接続が切れました');
      if (app.v) modal(`<h3>接続が切れました</h3><p>ホストがページを閉じたか、通信が途切れました。</p><div class="row-end"><button class="primary" id="re">再接続</button></div>`,
        (b) => (b.querySelector('#re').onclick = () => { closeModal(); connectClient(); }));
    },
    onMessage: (m) => {
      if (m.t === 'lobby') { app.lobbySeats = m.seats; app.me = m.you; renderLobby(); }
      else if (m.t === 'reject') { $('lobbyMsg').textContent = m.msg; toast(m.msg); }
      else if (m.t === 'state') {
        app.me = m.you;
        app.seatsOnline = m.online;
        if (!app.v) enterGame();
        receive(m.s);
      } else if (m.t === 'err') toast('⚠️ ' + m.msg);
      else if (m.t === 'chat') addChat(m);
    },
  });
}

// -------------------------------------------------------------
// 状態の配信と受信
// -------------------------------------------------------------
function actor() {
  // ローカル（1台）モードでは「今操作すべき人」の視点で表示
  if (app.role !== 'local') return app.me;
  const w = G.whoMustAct(app.game);
  return w.length ? w[0] : app.game.current;
}

function publish() {
  if (app.role === 'host') {
    const online = app.host.seats.map((s) => !!s.connected);
    app.host.broadcast((i) => ({ t: 'state', s: G.view(app.game, i), you: i, online }));
    app.seatsOnline = online;
    store.set('hexisle-host', app.game.phase === 'ended' ? null : { code: app.code, game: app.game, seats: app.host.seats.map((s) => ({ name: s.name, token: s.token })) });
    receive(G.view(app.game, 0));
  } else if (app.role === 'local') {
    app.me = actor();
    receive(G.view(app.game, app.me));
  }
}

function dispatch(a) {
  if (app.role === 'client') return app.client.send({ t: 'act', a });
  try {
    G.applyAction(app.game, { pid: app.me, ...a });
    publish();
  } catch (e) { toast('⚠️ ' + e.message); }
}

function enterGame() {
  show('hud');
  closeModal();
}

function receive(v) {
  let prev = app.v;
  app.v = v;
  const key = v.board.hexes.map((h) => h.terrain[0] + h.num).join('');
  if (key !== app.boardKey) { app.boardKey = key; renderer.setBoard(v.board); app.lastRollSeq = v.rollSeq || 0; app.lastLogId = 0; $('log').innerHTML = ''; prev = null; }
  renderer.update(v);
  if ((v.rollSeq || 0) !== app.lastRollSeq && v.dice) { app.lastRollSeq = v.rollSeq; renderer.rollDice(...v.dice); diceFx(v); }
  if (prev && prev.board.robber !== v.board.robber) sfx('robber');
  if (prev) eventFx(prev, v);
  if (v._private && v.seq !== app.lastPrivSeq) { app.lastPrivSeq = v.seq; toast(v._private.t, true); }
  // 自分の手番が来たら通知
  if (prev && v.current !== prev.current && v.phase === 'play' && prev.phase === 'play') {
    if (app.role === 'local') { banner(`${v.players[v.current].name} の番`, v.players[v.current].color); sfx('myTurn'); }
    else if (v.current === app.me) { banner('あなたの番！', v.players[app.me].color); sfx('myTurn'); }
  }
  if (app.buildMode && !(v.current === app.me && v.step === 'main')) app.buildMode = null;
  renderHUD();
}

// -------------------------------------------------------------
// 演出（効果音・バナー・数字ポップ）
// -------------------------------------------------------------
const TERRAIN_ICON = { forest: '🌲', hills: '🧱', pasture: '🐑', fields: '🌾', mountains: '⛰️' };

function banner(text, color = '#d9822b', sub = '') {
  const b = $('banner');
  b.innerHTML = `<div class="bt">${esc(text)}</div>${sub ? `<div class="bs">${esc(sub)}</div>` : ''}`;
  b.style.setProperty('--bc', color);
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  sfx('banner');
}

function diceFx(v) {
  sfx('diceShake');
  const sum = v.dice[0] + v.dice[1];
  setTimeout(() => {
    const n = $('bigNum');
    n.textContent = sum;
    n.className = sum === 7 ? 'seven' : (sum === 6 || sum === 8) ? 'hot' : '';
    void n.offsetWidth; n.classList.add('show');
    if (sum === 7) {
      sfx('seven');
      renderer.shake(600, 0.18);
      const f = $('flash'); f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
      setTimeout(() => banner('盗賊が現れた！', '#b03a2e', '手札8枚以上は半分捨てる'), 500);
    } else {
      renderer.produce(v, sum, TERRAIN_ICON);
      const hit = v.board.hexes.filter((h) => h.num === sum && h.id !== v.board.robber && h.vertices.some((x) => v.buildings[x])).length;
      if (hit) setTimeout(() => sfx('gain', hit + 1), 450);
    }
  }, 600);
}

function eventFx(prev, v) {
  const fresh = v.log.filter((l) => l.id > (prev.log.at(-1)?.id ?? 0));
  if (fresh.length > 12) return; // 再接続時などの大量ログでは鳴らさない
  for (const { t } of fresh) {
    if (t.includes('奪った')) sfx('steal');
    else if (t.includes('騎士を使用')) { sfx('knight'); renderer.shake(250, 0.05); }
    else if (t.includes('最長交易路を獲得') || t.includes('最大騎士力を獲得')) {
      const name = t.replace(/^\S+\s/, '').split(' が ')[0];
      setTimeout(() => { sfx('achievement'); banner(t.includes('最長') ? '🛤️ 最長交易路！' : '⚔️ 最大騎士力！', '#7a4a10', `${name} +2点`); }, 700);
    }
    else if (t.includes('交渉成立')) sfx('trade');
    else if (t.includes('交渉を提案')) sfx('offer');
    else if (t.includes('交易:')) sfx('trade');
    else if (t.includes('発展カードを購入')) sfx('card');
    else if (t.startsWith('🎁') || t.startsWith('💰') || t.includes('街道建設を使用')) sfx('magic');
    else if (t.includes('初期配置完了')) { sfx('start'); banner('開拓スタート！'); }
    else if (t.includes('の勝利')) {
      setTimeout(() => { sfx('win'); renderer.confetti(5000); }, 400);
    }
  }
  // 自分の手札が増えたカードを弾ませる
  const a = prev.players[app.me]?.res, b = v.players[app.me]?.res;
  if (a && b) app.bumpRes = RES.filter((r) => b[r] > a[r]);
}

function addChat(c) {
  const d = document.createElement('div');
  d.className = 'chat';
  d.textContent = `💬 ${c.from}: ${c.text}`;
  $('log').appendChild(d);
  $('log').scrollTop = 1e9;
}
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  if (app.role === 'client') app.client.send({ t: 'chat', text });
  else if (app.role === 'host') hostHandle(0, { t: 'chat', text });
  else addChat({ from: app.v.players[app.me].name, text });
};

// -------------------------------------------------------------
// 盤面クリック
// -------------------------------------------------------------
function onPick(kind, id) {
  const v = app.v;
  if (!v) return;
  if (v.phase === 'setup') {
    if (kind === 'vertex') dispatch({ type: 'setupSettlement', v: id });
    if (kind === 'edge') dispatch({ type: 'setupRoad', e: id });
    return;
  }
  if (v.step === 'robber' && kind === 'hex') return dispatch({ type: 'moveRobber', hex: id });
  if (kind === 'edge') dispatch({ type: 'build', kind: 'road', e: id });
  if (kind === 'vertex') dispatch({ type: 'build', kind: app.buildMode === 'city' ? 'city' : 'settlement', v: id });
  if (v.freeRoads <= 1) app.buildMode = null;
}

function updateTargets() {
  const v = app.v, me = app.me;
  const color = v.players[me]?.color || '#fff';
  const myTurn = v.current === me && v.phase !== 'ended';
  if (!myTurn) return renderer.setTargets(null);
  if (v.phase === 'setup') {
    if (v.setup.step === 'settlement') return renderer.setTargets('vertex', G.legalTargets(v, me, 'settlement'), color);
    return renderer.setTargets('edge', G.legalTargets(v, me, 'road'), color);
  }
  if (v.step === 'robber') return renderer.setTargets('hex', G.legalTargets(v, me, 'robber'), '#ff5050');
  if (v.step === 'main' && v.freeRoads > 0) return renderer.setTargets('edge', G.legalTargets(v, me, 'road'), color);
  if (v.step === 'main' && app.buildMode) {
    const k = app.buildMode;
    return renderer.setTargets(k === 'road' ? 'edge' : 'vertex', G.legalTargets(v, me, k), color);
  }
  renderer.setTargets(null);
}

// -------------------------------------------------------------
// HUD
// -------------------------------------------------------------
function statusText(v) {
  const me = app.me;
  const cur = v.players[v.current];
  const mine = v.current === me;
  const who = mine ? (app.role === 'local' ? `${cur.name}：` : 'あなたの番：') : `${cur.name} の番：`;
  if (v.phase === 'ended') return `🏆 ${v.players[v.winner].name} の勝利！`;
  if (v.phase === 'setup') {
    const round = v.setup.idx < v.players.length ? '1巡目' : '2巡目（隣接資源をもらえる）';
    return `${who}初期配置 ${round} — ${v.setup.step === 'settlement' ? '開拓地を置く場所を選択' : '開拓地につながる街道を選択'}`;
  }
  if (v.step === 'discard') {
    const waiting = Object.keys(v.pendingDiscard).map((i) => v.players[i].name).join('、');
    return `7が出た！ 手札を半分捨てる人: ${waiting}`;
  }
  if (v.step === 'roll') return `${who}ダイスを振ってください`;
  if (v.step === 'robber') return `${who}盗賊を移動するタイルを選択`;
  if (v.step === 'steal') return `${who}資源を奪う相手を選択`;
  if (v.freeRoads > 0) return `${who}無料の街道を置く場所を選択（残り${v.freeRoads}本）`;
  if (app.buildMode) return `${who}${{ road: '街道', settlement: '開拓地', city: '都市' }[app.buildMode]}を建てる場所を選択`;
  return `${who}建設・交易・ターン終了`;
}

function renderHUD() {
  const v = app.v, me = app.me;
  const P = v.players[me];
  const online = app.seatsOnline;
  // プレイヤー一覧
  $('players').innerHTML = v.players.map((p) => {
    const isMe = p.id === me;
    const vp = p.vp ?? p.vpPublic;
    return `<div class="pl ${p.id === v.current ? 'cur' : ''} ${online && !online[p.id] ? 'off' : ''}">
      <div class="top"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${isMe && app.role !== 'local' ? '（あなた）' : ''}${online && !online[p.id] ? ' 📴' : ''}<span class="vp">${vp}点</span></div>
      <div class="stats"><span title="資源カード">🃏${p.resCount}</span><span title="発展カード">📜${p.devCount}</span><span title="使用した騎士">⚔️${p.knights}</span><span title="最長の道">🛤️${v.longestLen?.[p.id] ?? 0}</span>
      ${v.largestArmy === p.id ? '<span class="badge">最大騎士力</span>' : ''}${v.longestRoad === p.id ? '<span class="badge">最長交易路</span>' : ''}</div></div>`;
  }).join('');

  $('status').textContent = statusText(v);
  $('status').classList.toggle('me', G.whoMustAct(v).includes(me));

  // ログ（新しい行だけ追加。チャットは間に挟まる）
  const fresh = v.log.filter((l) => l.id > app.lastLogId);
  if (fresh.length) {
    $('log').insertAdjacentHTML('beforeend', fresh.map((l) => `<div>${esc(l.t)}</div>`).join(''));
    app.lastLogId = fresh[fresh.length - 1].id;
    while ($('log').children.length > 200) $('log').firstChild.remove();
    $('log').scrollTop = 1e9;
  }

  // 手札
  const colors = { wood: '#2f7a3a', brick: '#c06a3c', sheep: '#8fd16a', wheat: '#e8c64a', ore: '#8d8f96' };
  const bump = app.bumpRes || []; app.bumpRes = null;
  $('hand').innerHTML = P.res ? RES.map((r) => `<div class="rc ${P.res[r] ? '' : 'zero'} ${bump.includes(r) ? 'bump' : ''}" style="--c:${colors[r]}"><div class="i">${G.RES_ICON[r]}</div><div class="n">${P.res[r]}</div><div class="l">${G.RES_JP[r]}</div></div>`).join('') : '';

  // 発展カード
  const myTurn = v.current === me && v.phase === 'play';
  const devs = {};
  (P.dev || []).forEach((d) => (devs[d] = (devs[d] || 0) + 1));
  const newDevs = {};
  (P.newDev || []).forEach((d) => (newDevs[d] = (newDevs[d] || 0) + 1));
  const canPlay = (d) => myTurn && !v.devPlayed && d !== 'vp' && v.freeRoads === 0 && (v.step === 'main' || (v.step === 'roll' && d === 'knight'));
  $('devs').innerHTML = [
    ...Object.entries(devs).map(([d, n]) => `<button data-dev="${d}" ${canPlay(d) ? '' : 'disabled'} title="${devHelp(d)}">${devIcon(d)} ${G.DEV_JP[d]}×${n}</button>`),
    ...Object.entries(newDevs).map(([d, n]) => `<button disabled title="購入したターンは使えません">${devIcon(d)} ${G.DEV_JP[d]}×${n}（新）</button>`),
  ].join('');
  $('devs').querySelectorAll('[data-dev]').forEach((b) => (b.onclick = () => playDev(b.dataset.dev)));

  // アクション
  const main = myTurn && v.step === 'main' && v.freeRoads === 0;
  const has = (c) => P.res && G.hasRes(P.res, c);
  const btn = (id, label, enabled, cls = '') => `<button id="${id}" class="${cls}" ${enabled ? '' : 'disabled'}>${label}</button>`;
  $('actions').innerHTML = v.phase === 'ended'
    ? btn('aNew', '🔁 メニューへ', true, 'primary')
    : [
      btn('aRoll', '🎲 ダイス', myTurn && v.step === 'roll', myTurn && v.step === 'roll' ? 'primary' : ''),
      btn('aRoad', '🛤️ 街道', main && has(G.COST.road) && P.roadsLeft > 0, app.buildMode === 'road' ? 'on' : ''),
      btn('aSet', '🏠 開拓地', main && has(G.COST.settlement) && P.settlementsLeft > 0, app.buildMode === 'settlement' ? 'on' : ''),
      btn('aCity', '🏰 都市', main && has(G.COST.city) && P.citiesLeft > 0, app.buildMode === 'city' ? 'on' : ''),
      btn('aDev', `📜 発展(${v.devDeckCount})`, main && has(G.COST.dev) && v.devDeckCount > 0),
      btn('aTrade', '🤝 交易', main),
      btn('aEnd', '⏭️ ターン終了', main, main ? 'primary' : ''),
    ].join('');
  const on = (id, f) => { const b = $(id); if (b) b.onclick = f; };
  on('aRoll', () => dispatch({ type: 'roll' }));
  const toggle = (k) => { app.buildMode = app.buildMode === k ? null : k; renderHUD(); };
  on('aRoad', () => toggle('road'));
  on('aSet', () => toggle('settlement'));
  on('aCity', () => toggle('city'));
  on('aDev', () => dispatch({ type: 'buyDev' }));
  on('aTrade', openTrade);
  on('aEnd', () => { app.buildMode = null; dispatch({ type: 'endTurn' }); });
  on('aNew', () => { store.del('hexisle-host'); location.href = location.pathname; });

  renderTradeBanner();
  updateTargets();
  autoModals();
}

const devIcon = (d) => ({ knight: '⚔️', vp: '⭐', road: '🛤️', plenty: '🎁', monopoly: '💰' }[d]);
const devHelp = (d) => ({
  knight: '盗賊を移動して資源を1枚奪う（ダイス前でも可）',
  vp: '持っているだけで1点（他人には非公開）',
  road: '街道を2本無料で建設',
  plenty: '好きな資源を2枚もらう',
  monopoly: '資源を1種類指定し、全員から全部もらう',
}[d]);

// -------------------------------------------------------------
// 自動で開くダイアログ（捨て札・強奪相手・勝利）
// -------------------------------------------------------------
function autoModals() {
  const v = app.v, me = app.me;
  if (v.phase === 'ended') {
    if (app.modalKind !== 'win') {
      app.modalKind = 'win';
      const rank = [...v.players].sort((a, b) => (b.vp ?? 0) - (a.vp ?? 0));
      modal(`<div class="win"><div class="big">🏆</div><h3>${esc(v.players[v.winner].name)} の勝利！</h3>
        <p>${rank.map((p) => `${esc(p.name)}：${p.vp ?? p.vpPublic}点`).join('<br>')}</p>
        <div class="row-end" style="justify-content:center"><button id="wClose">盤面を見る</button></div></div>`,
      (b) => (b.querySelector('#wClose').onclick = () => { $('modal').classList.add('hidden'); }));
    }
    return;
  }
  if (v.step === 'discard' && v.pendingDiscard[me]) {
    if (app.modalKind !== 'discard' + me) openDiscard(v.pendingDiscard[me]);
    return;
  }
  if (v.step === 'steal' && v.current === me) {
    if (app.modalKind !== 'steal') {
      app.modalKind = 'steal';
      modal(`<h3>🦹 誰から奪いますか？</h3><div class="row-end" style="justify-content:center;flex-wrap:wrap">${v.stealCands.map((i) =>
        `<button data-v="${i}"><span class="dot" style="background:${v.players[i].color}"></span> ${esc(v.players[i].name)}（${v.players[i].resCount}枚）</button>`).join('')}</div>`,
      (b) => b.querySelectorAll('[data-v]').forEach((x) => (x.onclick = () => { closeModal(); dispatch({ type: 'steal', victim: +x.dataset.v }); })));
    }
    return;
  }
  if (['discard', 'steal'].some((k) => (app.modalKind || '').startsWith(k))) closeModal();
}

// 資源カウンタ付きピッカー
function counterPicker(container, state, { max = {}, onChange }) {
  container.innerHTML = RES.map((r) => `<div class="cell"><div class="i">${G.RES_ICON[r]}</div><div class="cnt" data-c="${r}">${state[r]}</div>
    ${max[r] !== undefined ? `<div class="have">所持 ${max[r]}</div>` : ''}
    <div class="pm"><button data-m="${r}">−</button><button data-p="${r}">＋</button></div></div>`).join('');
  container.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { const r = b.dataset.m; if (state[r] > 0) state[r]--; refresh(); }));
  container.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { const r = b.dataset.p; if (max[r] === undefined || state[r] < max[r]) state[r]++; refresh(); }));
  function refresh() { RES.forEach((r) => (container.querySelector(`[data-c="${r}"]`).textContent = state[r])); onChange?.(); }
  onChange?.();
}
const zero = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });

function openDiscard(need) {
  const me = app.me;
  app.modalKind = 'discard' + me;
  const P = app.v.players[me];
  const sel = zero();
  modal(`<h3>手札を${need}枚捨ててください${app.role === 'local' ? `（${esc(P.name)}）` : ''}</h3><div class="picker" id="dp"></div>
    <div class="row-end"><span id="dc"></span><button class="primary" id="dOk" disabled>捨てる</button></div>`, (b) => {
    counterPicker(b.querySelector('#dp'), sel, {
      max: P.res,
      onChange: () => {
        const t = G.resTotal(sel);
        b.querySelector('#dc').textContent = `${t} / ${need}`;
        b.querySelector('#dOk').disabled = t !== need;
      },
    });
    b.querySelector('#dOk').onclick = () => { closeModal(); dispatch({ type: 'discard', res: sel }); };
  });
}

function pickResources(title, count, cb) {
  const picks = [];
  modal(`<h3>${title}</h3><div class="picker" id="pp">${RES.map((r) => `<div class="cell"><div class="i">${G.RES_ICON[r]}</div><button class="pick" data-r="${r}">${G.RES_JP[r]}</button></div>`).join('')}</div>
    <div class="row-end"><span id="pc"></span><button id="pCancel">やめる</button></div>`, (b) => {
    const upd = () => (b.querySelector('#pc').textContent = picks.map((r) => G.RES_ICON[r]).join(' ') + (count > 1 ? `（${picks.length}/${count}）` : ''));
    b.querySelectorAll('[data-r]').forEach((x) => (x.onclick = () => {
      picks.push(x.dataset.r); upd();
      if (picks.length >= count) { closeModal(); cb(picks); }
    }));
    b.querySelector('#pCancel').onclick = closeModal;
    upd();
  });
}

function playDev(card) {
  if (card === 'plenty') return pickResources('🎁 収穫：もらう資源を2つ選択', 2, (pick) => dispatch({ type: 'playDev', card, pick }));
  if (card === 'monopoly') return pickResources('💰 独占：資源を1種類選択', 1, ([res]) => dispatch({ type: 'playDev', card, res }));
  dispatch({ type: 'playDev', card });
}

// -------------------------------------------------------------
// 交易
// -------------------------------------------------------------
function openTrade() {
  const v = app.v, me = app.me;
  const P = v.players[me];
  const rates = G.tradeRates(v, me);
  let tab = 'bank';
  let give = null, get = null;
  const offerGive = zero(), offerGet = zero();
  const draw = () => {
    modal(`<h3>🤝 交易</h3><div class="tabs"><button id="tBank" class="${tab === 'bank' ? 'on' : ''}">銀行・港</button><button id="tPl" class="${tab === 'pl' ? 'on' : ''}">プレイヤーと交渉</button></div>
      <div id="tBody"></div>`, (b) => {
      b.querySelector('#tBank').onclick = () => { tab = 'bank'; draw(); };
      b.querySelector('#tPl').onclick = () => { tab = 'pl'; draw(); };
      const body = b.querySelector('#tBody');
      if (tab === 'bank') {
        body.innerHTML = `<div>出す資源（レート）</div><div class="picker">${RES.map((r) => `<div class="cell ${give === r ? 'sel' : ''}"><div class="i">${G.RES_ICON[r]}</div><div class="have">所持 ${P.res[r]}</div><button class="pick" data-g="${r}" ${P.res[r] >= rates[r] ? '' : 'disabled'}>${rates[r]}:1</button></div>`).join('')}</div>
          <div>もらう資源</div><div class="picker">${RES.map((r) => `<div class="cell ${get === r ? 'sel' : ''}"><div class="i">${G.RES_ICON[r]}</div><div class="have">銀行 ${v.bank[r]}</div><button class="pick" data-t="${r}" ${r !== give && v.bank[r] > 0 ? '' : 'disabled'}>選択</button></div>`).join('')}</div>
          <div class="row-end"><button id="tClose">閉じる</button><button class="primary" id="tDo" ${give && get ? '' : 'disabled'}>交換する</button></div>`;
        body.querySelectorAll('[data-g]').forEach((x) => (x.onclick = () => { give = x.dataset.g; if (get === give) get = null; draw(); }));
        body.querySelectorAll('[data-t]').forEach((x) => (x.onclick = () => { get = x.dataset.t; draw(); }));
        body.querySelector('#tDo').onclick = () => { dispatch({ type: 'bankTrade', give, get }); give = get = null; setTimeout(() => app.modalKind === 'trade' && openTrade(), 50); };
      } else {
        body.innerHTML = `<div>出す資源</div><div class="picker" id="og"></div><div>欲しい資源</div><div class="picker" id="ot"></div>
          <div class="row-end"><button id="tClose">閉じる</button><button class="primary" id="tOffer">提案する</button></div>`;
        counterPicker(body.querySelector('#og'), offerGive, { max: P.res });
        counterPicker(body.querySelector('#ot'), offerGet, {});
        body.querySelector('#tOffer').onclick = () => { closeModal(); dispatch({ type: 'offerTrade', give: offerGive, get: offerGet }); };
      }
      body.querySelector('#tClose').onclick = closeModal;
    });
    app.modalKind = 'trade';
  };
  draw();
}

function renderTradeBanner() {
  const v = app.v, me = app.me, tb = $('tradeBanner');
  const T = v.trade;
  if (!T || v.phase !== 'play') return tb.classList.add('hidden');
  tb.classList.remove('hidden');
  const from = v.players[T.from];
  const desc = `<div><b>${esc(from.name)}</b> の提案：出す ${G.fmtRes(T.give)} ／ 欲しい ${G.fmtRes(T.get)}</div>`;
  const others = v.players.filter((p) => p.id !== T.from);
  const respText = others.map((p) => `${esc(p.name)}: ${T.responses[p.id] === true ? '✅' : T.responses[p.id] === false ? '❌' : '…'}`).join('　');
  if (T.from === me) {
    // 提案者：承諾者と成立させる／取り下げ
    let localBtns = '';
    if (app.role === 'local') {
      localBtns = others.map((p) => `<button data-la="${p.id}">${esc(p.name)}として承諾</button>`).join('');
    }
    tb.innerHTML = `${desc}<div>${respText}</div><div class="row">${others.filter((p) => T.responses[p.id] === true).map((p) => `<button class="primary" data-w="${p.id}">${esc(p.name)} と成立</button>`).join('')}${localBtns}<button id="tCancel">取り下げ</button></div>`;
    tb.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => dispatch({ type: 'confirmTrade', with: +b.dataset.w })));
    tb.querySelectorAll('[data-la]').forEach((b) => (b.onclick = () => {
      try { G.applyAction(app.game, { type: 'respondTrade', pid: +b.dataset.la, accept: true }); publish(); } catch (e) { toast('⚠️ ' + e.message); }
    }));
    tb.querySelector('#tCancel').onclick = () => dispatch({ type: 'cancelTrade' });
  } else {
    const P = v.players[me];
    const can = P.res && G.hasRes(P.res, T.get);
    const answered = T.responses[me] !== undefined;
    tb.innerHTML = `${desc}<div>${respText}</div>${answered ? '' : `<div class="row"><button class="primary" id="tAcc" ${can ? '' : 'disabled'}>承諾</button><button id="tRej">拒否</button></div>`}`;
    if (!answered) {
      $('tAcc').onclick = () => dispatch({ type: 'respondTrade', accept: true });
      $('tRej').onclick = () => dispatch({ type: 'respondTrade', accept: false });
    }
  }
}

// デバッグ用
window.__app = app;
window.__dispatch = dispatch;
window.__G = G;
window.__renderer = renderer;
