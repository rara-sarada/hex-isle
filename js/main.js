// =============================================================
// アプリ本体：画面遷移・HUD・入力 → アクション送信
// =============================================================
import * as G from './game.js?v=20261003164026';
import { BoardRenderer } from './render.js?v=20261003164026';
import { Host, Client, randomCode } from './net.js?v=20261003164026';
import { sfx, Sound } from './audio.js?v=20261003164026';
import { RULE_SECTIONS } from './rules.js?v=20261003164026';

const $ = (id) => document.getElementById(id);
const BUILD = '20261003164026';
// 手番の強調色はプレイヤー色に関係なく統一（白など見えにくい色を避ける）
const TURN_COLOR = '#ff9f1a';
const TURN_TEXT = '#d35400';

// 予期しないエラーは画面に出す（黙って固まらないように）
function showErr(msg) {
  const e = $('errBar');
  if (!e) return;
  e.innerHTML = `⚠️ 表示エラーが起きました：${String(msg).replace(/[<>&]/g, '')}<br><button id="errReload">🔁 再読み込みして復帰（席はそのまま）</button>`;
  e.classList.remove('hidden');
  e.querySelector('#errReload').onclick = () => location.reload();
}
window.addEventListener('error', (ev) => showErr(ev.message));
window.addEventListener('unhandledrejection', (ev) => showErr(ev.reason?.message || ev.reason));

// 新しい版が公開されていないか確認（古いファイルが混ざると動かないため）
async function checkVersion() {
  if (BUILD.startsWith('__')) return; // 開発中
  try {
    const r = await fetch('version.json?' + Date.now(), { cache: 'no-store' });
    const { v } = await r.json();
    if (v === BUILD) return;
    let tried = null; try { tried = sessionStorage.getItem('hexisle-reload'); } catch {}
    if (!app?.v && tried !== v) { try { sessionStorage.setItem('hexisle-reload', v); } catch {} location.reload(); return; }
    const e = $('errBar');
    e.innerHTML = `🆕 新しい版が公開されています。<button id="errReload">🔁 再読み込み（席はそのまま戻ります）</button>${tried === v ? '<br>直らない場合は Ctrl+F5（スマホはタブを開き直す）' : ''}`;
    e.classList.remove('hidden');
    e.querySelector('#errReload').onclick = () => { try { sessionStorage.setItem('hexisle-reload', v); } catch {} location.reload(); };
  } catch {}
}
setTimeout(checkVersion, 500);
setInterval(checkVersion, 60000);
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

// 席の識別トークンはタブごと（sessionStorage）。同じブラウザの別タブでも別プレイヤーとして入れる
const tabStore = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const newTok = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
let token = tabStore.get('hexisle-token') || newTok();
tabStore.set('hexisle-token', token);
// 部屋ごとの席トークン：タブ（sessionStorage）とブラウザ（localStorage）の両方に保存。
// タブを閉じても・ブラウザを再起動しても同じ席に戻れる
const seatKey = (code) => 'hexisle-seat-' + code;
const loadSeatToken = (code) => tabStore.get(seatKey(code)) || store.get(seatKey(code)) || newTok();
const saveSeatToken = (code, t) => { tabStore.set(seatKey(code), t); store.set(seatKey(code), t); };
$('nameInput').value = store.get('hexisle-name') || '';
const urlQ = new URLSearchParams(location.search);
const urlRoom = urlQ.get('room');
if (urlRoom) $('codeInput').value = urlRoom.toUpperCase();
if (store.get('hexisle-host')) $('resumeBox').classList.remove('hidden');
// URLを部屋に合わせて書き換える（再読み込みで自動復帰できるように）
function setUrl(code, isHost) {
  const q = new URLSearchParams(location.search);
  q.set('room', code);
  if (isHost) q.set('host', '1'); else q.delete('host');
  history.replaceState(null, '', `${location.pathname}?${q}`);
}
// 自動復帰：ホストは保存済みの部屋を、参加者は前回入った部屋へ
setTimeout(() => {
  const saved = store.get('hexisle-host');
  const room = urlRoom?.toUpperCase();
  if (urlQ.get('host') === '1' && saved && saved.code === room) return startHost(saved.code, saved);
  if (room && !urlQ.get('host') && (tabStore.get(seatKey(room)) || store.get('hexisle-joined') === room)) startClient(room);
}, 0);

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
  $('modalBody').classList.remove('rules');
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
$('btnLeave').onclick = () => { store.del('hexisle-joined'); location.href = location.pathname + location.search.replace(/[?&](room|host)=[^&]*/g, ''); };
$('btnRetry').onclick = () => { $('btnRetry').classList.add('hidden'); $('lobbyMsg').textContent = '部屋に接続中…'; app.client?.reconnect(); };
$('netBtn').onclick = () => { if (app.role === 'client') { app.client?.reconnect(); toast('再接続しています…', true); } else if (app.role === 'host') { publish(); toast('全員に最新の盤面を送りました', true); } };
$('btnView').onclick = () => renderer.resetView();
$('btnRules').onclick = () => openRules();
$('btnRulesMenu').onclick = () => openRules();

// Windows（OS）の通知：自分の対応が必要になったとき、画面を見ていなくても知らせる
const notifyOn = () => store.get('hexisle-notify') === true && 'Notification' in window && Notification.permission === 'granted';
function notifyLabel() {
  const b = $('btnNotify');
  if (!('Notification' in window)) { b.textContent = '🔕 通知非対応'; b.disabled = true; return; }
  b.textContent = notifyOn() ? '🔔 通知オン' : '🔕 通知オフ';
  b.classList.toggle('on', notifyOn());
}
$('btnNotify').onclick = async () => {
  if (!('Notification' in window)) return;
  if (notifyOn()) { store.set('hexisle-notify', false); notifyLabel(); toast('通知をオフにしました'); return; }
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') { toast('⚠️ ブラウザで通知がブロックされています（アドレスバー左の鍵マーク→通知を許可）'); notifyLabel(); return; }
  store.set('hexisle-notify', true); notifyLabel();
  new Notification('HEX ISLE', { body: '通知をオンにしました。自分の番や交渉が来たら知らせます', tag: 'hexisle-test' });
};
notifyLabel();
function notify(body) {
  if (!notifyOn() || document.hasFocus()) return; // 画面を見ているときは出さない
  try {
    const n = new Notification('HEX ISLE ～開拓の島～', { body, tag: 'hexisle-turn', renotify: true, requireInteraction: false });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

// ルールブック（章ごとのタブ）
function openRules(id = RULE_SECTIONS[0].id) {
  app.modalKind = 'rules';
  const sec = RULE_SECTIONS.find((r) => r.id === id) || RULE_SECTIONS[0];
  modal(`<div class="rhead"><h3>📖 ルールブック</h3><button id="rClose">✕ 閉じる</button></div>
    <div class="rtabs">${RULE_SECTIONS.map((r) => `<button data-r="${r.id}" class="${r.id === sec.id ? 'on' : ''}">${r.title}</button>`).join('')}</div>
    <div class="rbody"><h4>${sec.title}</h4>${sec.html}</div>`, (b) => {
    b.querySelectorAll('[data-r]').forEach((x) => (x.onclick = () => openRules(x.dataset.r)));
    b.querySelector('#rClose').onclick = () => closeModal();
  });
  $('modalBody').classList.add('rules');
}
$('btnCopy').onclick = () => { $('inviteUrl').select(); navigator.clipboard?.writeText($('inviteUrl').value); toast('招待リンクをコピーしました', true); };
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
  setUrl(code, true);
  const host = (app.host = new Host(code, {
    onOpen: () => {
      $('lobbyMsg').textContent = saved ? '部屋を再開しました。参加者の再接続を待っています' : '友だちに部屋コードか招待リンクを送ってください';
      setNet('online');
      if (app.game) { publish(); toast('部屋をオンラインに戻しました。参加者は自動で戻ってきます', true); } else renderLobby();
    },
    onError: (e) => {
      if (e?.type === 'id-wait') { setNet('connecting', e.retry); $('lobbyMsg').textContent = `前回の接続の解放を待っています…（${e.retry}）`; return; }
      $('lobbyMsg').textContent = peerErrorText(e); toast(peerErrorText(e)); setNet('offline');
    },
    onJoin: (i) => { if (app.game) { publish(); toast(`${host.seats[i].name} が接続しました`, true); } else renderLobby(); },
    onLeave: (i) => { if (app.game) { publish(); toast(`${host.seats[i].name} が切断しました（自動で戻れます）`); } else { host.seats.splice(i, 1); host.seats.forEach((s, j) => s.conn && (s.conn._seat = j)); renderLobby(); } },
    onNewcomer: (i, name) => { G.addPlayer(app.game, name); toast(`${name} が途中参加しました`, true); },
    onMessage: (i, m) => hostHandle(i, m),
    getSeq: () => app.game?.seq ?? 0,
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
  $('btnStart').disabled = seats.length < 1;
  $('btnStart').textContent = `いまの${seats.length}人でゲーム開始`;
  if (isHost) $('lobbyHint').textContent = '人数は決めなくてOK。集まった人で開始でき、開始後も4人まで途中参加できます';
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

const stateMsg = (i) => ({ t: 'state', s: G.view(app.game, i), you: i, online: app.host.seats.map((s) => !!s.connected) });
function hostHandle(i, m) {
  if (m.t === 'sync' && app.game) return app.host.send(i, stateMsg(i)); // 同期ズレの修復要求
  if (m.t === 'act' && app.game) {
    try {
      G.applyAction(app.game, { ...m.a, pid: i });
      publish();
    } catch (e) { app.host.send(i, { t: 'err', msg: e.message }); app.host.send(i, stateMsg(i)); }
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
  app.joined = false;
  token = loadSeatToken(app.code);
  saveSeatToken(app.code, token);
  store.set('hexisle-joined', app.code);
  setUrl(app.code, false);
  clearTimeout(app.joinTimer);
  app.joinTimer = setTimeout(() => {
    if (app.joined) return;
    $('lobbyMsg').innerHTML = 'ホストに接続できません（自動で再試行中）。<br>・部屋コードが正しいか／ホストが画面を開いたままか確認<br>・会社/学校/一部モバイル回線ではP2P通信が遮断されることがあります（Wi-Fiを切り替えて再試行）';
    $('btnRetry')?.classList.remove('hidden');
  }, 15000);
  try { app.client?.peer?.destroy(); } catch {}
  app.client = new Client(app.code, myName(), token, {
    onStatus: (st, n) => setNet(st, n),
    onError: (e, n) => { if (!app.joined && n <= 1) $('lobbyMsg').textContent = peerErrorText(e) + '（自動で再試行します）'; },
    onMessage: (m) => {
      if (m.t === 'token') { token = m.token; saveSeatToken(app.code, token); }
      else if (m.t === 'ping') { if (app.v && m.seq !== app.v.seq) app.client.send({ t: 'sync' }); } // 番号がずれていたら最新を要求
      else if (m.t === 'lobby') { app.joined = true; app.lobbySeats = m.seats; app.me = m.you; $('lobbyMsg').textContent = 'ホストの開始を待っています'; renderLobby(); }
      else if (m.t === 'reject') { $('lobbyMsg').textContent = m.msg; toast(m.msg); }
      else if (m.t === 'choose') chooseSeat(m);
      else if (m.t === 'state') {
        app.joined = true;
        // 古い状態が後から届いても無視（順序の入れ替わり対策）
        if (app.v && m.s.seq < app.v.seq && m.you === app.me) return;
        app.me = m.you;
        app.seatsOnline = m.online;
        if (!app.v) enterGame();
        if (app.modalKind === 'choose') closeModal();
        receive(m.s);
      } else if (m.t === 'err') toast('⚠️ ' + m.msg);
      else if (m.t === 'chat') addChat(m);
    },
  });
}

// ゲーム中に席トークンが分からない場合：どの席に戻るか選ぶ
function chooseSeat(m) {
  app.joined = true;
  app.modalKind = 'choose';
  const btns = m.offline.map((s) => `<button class="primary" data-seat="${s.i}">「${esc(s.name)}」として戻る</button>`).join('');
  modal(`<h3>ゲームは進行中です</h3><p>${m.offline.length ? '切断中の席に戻れます。自分の席を選んでください。' : ''}${m.canJoin ? '新しいプレイヤーとして途中参加もできます（自分の番で初期配置）。' : ''}</p>
    <div class="row-end" style="flex-direction:column;align-items:stretch">${btns}${m.canJoin ? '<button data-seat="new">🙋 新しく途中参加する</button>' : ''}${!btns && !m.canJoin ? '<p>空いている席がありません（満員）。</p>' : ''}</div>`,
  (b) => b.querySelectorAll('[data-seat]').forEach((x) => (x.onclick = () => { app.client.send({ t: 'claim', seat: x.dataset.seat }); $('modalBody').innerHTML = '<p>接続中…</p>'; })));
}

// 接続状態の表示
function setNet(st, n) {
  app.net = st;
  const el = $('netBtn');
  if (!el) return;
  el.className = 'mini net ' + st;
  el.textContent = st === 'online' ? '🟢 接続中' : st === 'connecting' ? `🟡 再接続中…${n > 1 ? `（${n}回目）` : ''}` : '🔴 切断（自動で再接続します）';
  $('netBar').classList.toggle('hidden', st === 'online' || !app.v);
  $('netBar').textContent = st === 'online' ? '' : '📡 接続が切れました。自動で戻ります…（押すとすぐ再接続）';
}
$('netBar').onclick = () => app.client?.reconnect();

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
    app.host.broadcast((i) => stateMsg(i));
    app.seatsOnline = app.host.seats.map((s) => !!s.connected);
    store.set('hexisle-host', app.game.phase === 'ended' ? null : { code: app.code, game: app.game, seats: app.host.seats.map((s) => ({ name: s.name, token: s.token })) });
    receive(G.view(app.game, 0));
  } else if (app.role === 'local') {
    app.me = actor();
    receive(G.view(app.game, app.me));
  }
}

function dispatch(a) {
  if (app.role === 'client') {
    if (!app.client.online) { toast('⚠️ 接続が切れています。再接続を待ってください'); app.client.reconnect(); return; }
    return app.client.send({ t: 'act', a, base: app.v?.seq });
  }
  try {
    G.applyAction(app.game, { pid: app.me, ...a });
    publish();
  } catch (e) { toast('⚠️ ' + e.message); }
}

function enterGame() {
  show('hud');
  closeModal();
}

// ダイスが転がっている間は結果（産出・ログ・手札・次の操作）を見せない
const DICE_MS = 1050;
function receive(v) {
  if (app.hold) { app.pending = v; return; }
  const rolled = app.v && app.boardKey && v.dice && (v.rollSeq || 0) !== app.lastRollSeq
    && v.board.hexes.map((h) => h.terrain[0] + h.num).join('') === app.boardKey;
  if (rolled) {
    app.lastRollSeq = v.rollSeq;
    renderer.rollDice(...v.dice);
    sfx('diceShake');
    app.hold = true; app.pending = v;
    setTimeout(() => {
      app.hold = false;
      const p = app.pending; app.pending = null;
      app.revealRoll = true;
      applyState(p);
    }, DICE_MS);
    return;
  }
  applyState(v);
}

function applyState(v) {
  let prev = app.v;
  app.v = v;
  const key = v.board.hexes.map((h) => h.terrain[0] + h.num).join('');
  if (key !== app.boardKey) { app.boardKey = key; renderer.setBoard(v.board); app.lastRollSeq = v.rollSeq || 0; app.lastLogId = 0; $('log').innerHTML = ''; prev = null; }
  renderer.update(v);
  if (app.revealRoll) { app.revealRoll = false; if (v.dice) diceFx(v); }
  else if ((v.rollSeq || 0) !== app.lastRollSeq && v.dice) { app.lastRollSeq = v.rollSeq; renderer.rollDice(...v.dice); }
  if (prev && prev.board.robber !== v.board.robber) sfx('robber');
  if (prev) eventFx(prev, v);
  if (v._private && v.seq !== app.lastPrivSeq) { app.lastPrivSeq = v.seq; toast(v._private.t, true); }
  // 自分の手番が来たら通知
  if (prev && v.current !== prev.current && v.phase === 'play' && prev.phase === 'play') {
    if (app.role === 'local') { banner(`${v.players[v.current].name} の番`, TURN_COLOR); sfx('myTurn'); }
    else if (v.current === app.me) { banner('あなたの番！', TURN_COLOR); sfx('myTurn'); }
  }
  if (app.buildMode && !(v.current === app.me && v.step === 'main')) app.buildMode = null;
  // 自分が何かする必要がある間は、画面枠を光らせる＋タブ名で知らせる＋スマホを振動
  const mustAct = G.whoMustAct(v).includes(app.me) && v.phase !== 'ended';
  const wasMust = prev ? G.whoMustAct(prev).includes(app.me) && prev.phase !== 'ended' : false;
  document.body.classList.toggle('myturn', mustAct);
  document.body.style.setProperty('--me', TURN_COLOR);
  if (mustAct && !wasMust && app.role !== 'local') {
    try { navigator.vibrate?.([120, 80, 120]); } catch {}
    if (prev && v.step !== 'roll') sfx('myTurn');
    notify(v.step === 'discard' ? '7が出ました：手札を捨ててください' : v.step === 'steal' ? '奪う相手を選んでください' : v.step === 'robber' ? '盗賊を動かしてください' : 'あなたの番です');
  }
  const offerNow = v.trade && v.trade.from !== app.me && v.trade.responses[app.me] === undefined;
  if (offerNow && app.lastNotifyTrade !== v.trade.id && app.role !== 'local') { app.lastNotifyTrade = v.trade.id; notify(`${v.players[v.trade.from].name} から交渉が来ました`); }
  titleBlink(mustAct && app.role !== 'local');
  try { renderHUD(); } catch (e) { console.error(e); showErr(e.message); }
}

let blinkT = null;
function titleBlink(on) {
  const base = 'HEX ISLE ～開拓の島～';
  clearInterval(blinkT);
  if (!on || !document.hidden) { document.title = on ? '★あなたの番！ ' + base : base; return; }
  let f = false;
  blinkT = setInterval(() => { f = !f; document.title = f ? '★★ あなたの番です ★★' : base; }, 900);
}
document.addEventListener('visibilitychange', () => app.v && titleBlink(document.body.classList.contains('myturn') && app.role !== 'local'));

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
  }, 0);
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
  if (v.phase === 'setup' || v.step === 'joinSetup') {
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
  if (v.phase === 'setup' || v.step === 'joinSetup') {
    if ((v.phase === 'setup' ? v.setup.step : v.joinSetup.step) === 'settlement') return renderer.setTargets('vertex', G.legalTargets(v, me, 'settlement'), color);
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
  const who = '';
  if (v.phase === 'ended') return `🏆 ${v.players[v.winner].name} の勝利！`;
  if (v.phase === 'setup') {
    const round = v.setup.idx < v.setup.order.length / 2 ? '1巡目' : '2巡目（隣接資源をもらえる）';
    return `初期配置 ${round} — ${v.setup.step === 'settlement' ? '開拓地を置く場所を選択' : '開拓地につながる街道を選択'}`;
  }
  if (v.step === 'discard') {
    const waiting = Object.keys(v.pendingDiscard).map((i) => v.players[i].name).join('、');
    return `7が出た！ 手札を半分捨てる人: ${waiting}`;
  }
  if (v.step === 'joinSetup') return `${who}途中参加の初期配置（残り${cur.pendingSetup}回）— ${v.joinSetup.step === 'settlement' ? '開拓地を置く場所を選択' : '開拓地につながる街道を選択'}`;
  if (v.step === 'roll') return `${who}ダイスを振ってください`;
  if (v.step === 'robber') return `${who}盗賊を移動するタイルを選択`;
  if (v.step === 'steal') return `${who}資源を奪う相手を選択`;
  if (v.freeRoads > 0) return `${who}無料の街道を置く場所を選択（残り${v.freeRoads}本）`;
  if (app.buildMode) return `${who}${{ road: '街道', settlement: '開拓地', city: '都市' }[app.buildMode]}を建てる場所を選択`;
  return `${who}建設・交易・ターン終了`;
}

// ホスト用：止まっている人を飛ばすボタン（切断中なら目立たせる）
function hostSkipHtml(v, mustAct) {
  if (app.role !== 'host' || v.phase === 'ended' || mustAct) return '';
  const waiting = G.whoMustAct(v).filter((p) => p !== 0);
  if (!waiting.length) return '';
  const off = waiting.some((p) => app.seatsOnline && !app.seatsOnline[p]);
  return `<button id="skipBtn" class="mini ${off ? 'primary' : ''}">⏭️ ${off ? '切断中の人を' : ''}自動で進める</button>`;
}

function renderHUD() {
  const v = app.v, me = app.me;
  const P = v.players[me];
  const online = app.seatsOnline;
  // プレイヤー一覧
  $('players').innerHTML = v.players.map((p) => {
    const isMe = p.id === me;
    const vp = p.vp ?? p.vpPublic;
    return `<div class="pl ${p.id === v.current ? 'cur' : ''} ${online && !online[p.id] ? 'off' : ''}" style="--pc:${p.color}">
      <div class="top">${p.id === v.current ? '<span class="arrow">▶</span>' : ''}<span class="dot" style="background:${p.color}"></span>${esc(p.name)}${isMe && app.role !== 'local' ? '（あなた）' : ''}${online && !online[p.id] ? ' 📴' : ''}<span class="vp">${vp}点</span></div>
      <div class="stats"><span title="資源カード">🃏${p.resCount}</span><span title="発展カード">📜${p.devCount}</span><span title="使用した騎士">⚔️${p.knights}</span><span title="最長の道">🛤️${v.longestLen?.[p.id] ?? 0}</span>
      ${v.largestArmy === p.id ? '<span class="badge">最大騎士力</span>' : ''}${v.longestRoad === p.id ? '<span class="badge">最長交易路</span>' : ''}</div></div>`;
  }).join('');

  const mustAct = G.whoMustAct(v).includes(me) && v.phase !== 'ended';
  const curP = v.players[v.current];
  $('status').innerHTML = (mustAct
    ? `<div class="who" style="--pc:${TURN_TEXT}">🎯 ${app.role === 'local' ? esc(v.players[me].name) + ' の番' : 'あなたの番'}</div>`
    : v.phase === 'ended' ? '' : `<div class="who wait" style="--pc:${curP.color}">⏳ <span class="dot" style="background:${curP.color}"></span>${esc(curP.name)} の番${online && !online[curP.id] ? '（📴切断中）' : ''}</div>`)
    + `<div class="what">${esc(statusText(v))}</div>` + hostSkipHtml(v, mustAct);
  $('status').classList.toggle('me', mustAct);
  $('status').querySelector('#skipBtn')?.addEventListener('click', () => {
    if (!confirm('止まっているプレイヤーの処理を自動で進めますか？\n（ダイス前なら番を飛ばし、捨て札・盗賊はランダムで処理）')) return;
    dispatch({ type: 'forceSkip' });
  });

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
  if (P.res) {
    const n = G.resTotal(P.res);
    const devN = (P.dev?.length || 0) + (P.newDev?.length || 0);
    $('handInfo').innerHTML = `<div class="hn ${n >= 8 ? 'warn' : ''}"><b>${n}</b><span>枚</span></div><div class="hl">手札${n >= 8 ? '<br><em>7で半分捨て</em>' : ''}</div>${devN ? `<div class="hd">📜${devN}</div>` : ''}`;
  } else $('handInfo').innerHTML = '';
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
      btn('aRoll', '🎲 ダイスを振る', myTurn && v.step === 'roll', myTurn && v.step === 'roll' ? 'primary pulse' : ''),
      btn('aRoad', '🛤️ 街道<small class="cost">🌲🧱</small>', main && has(G.COST.road) && P.roadsLeft > 0, app.buildMode === 'road' ? 'on' : ''),
      btn('aSet', '🏠 開拓地<small class="cost">🌲🧱🐑🌾</small>', main && has(G.COST.settlement) && P.settlementsLeft > 0, app.buildMode === 'settlement' ? 'on' : ''),
      btn('aCity', '🏰 都市<small class="cost">🌾×2 ⛰️×3</small>', main && has(G.COST.city) && P.citiesLeft > 0, app.buildMode === 'city' ? 'on' : ''),
      btn('aDev', `📜 発展(${v.devDeckCount})<small class="cost">🐑🌾⛰️</small>`, main && has(G.COST.dev) && v.devDeckCount > 0),
      btn('aTrade', '🤝 交易', main),
      btn('aEnd', '⏭️ ターン終了', main, main ? 'primary' : ''),
      ...(v.step === 'joinSetup' && myTurn ? [] : []),
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
  on('aNew', () => { store.del('hexisle-host'); store.del('hexisle-joined'); location.href = location.pathname; });

  renderCostCard(P);
  renderTradeBanner();
  renderOffer();
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
  // 自動の×は、人が考えて断ったように少し遅れて見せる（持っていないのがバレないように）
  if (app.tradeSeen?.id !== T.id) {
    app.tradeSeen = { id: T.id, t0: Date.now() };
    Object.values(T.autoDelay || {}).forEach((ms) => setTimeout(() => app.v && renderTradeBanner(), ms + 50));
  }
  const hiddenAuto = (pid) => T.auto?.[pid] && pid !== me && Date.now() < app.tradeSeen.t0 + (T.autoDelay?.[pid] ?? 0);
  const respText = others.map((p) => `${esc(p.name)}: ${T.responses[p.id] === true ? '✅' : T.responses[p.id] === false && !hiddenAuto(p.id) ? '❌' : '…'}`).join('　');
  if (T.from === me) {
    // 提案者：承諾者と成立させる／取り下げ
    let localBtns = '';
    if (app.role === 'local') {
      localBtns = others.filter((p) => T.responses[p.id] === undefined).map((p) => `<button data-la="${p.id}">${esc(p.name)}として承諾</button>`).join('');
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
    if (!answered && app.role !== 'local') return tb.classList.add('hidden'); // 中央の大きい表示で回答する
    tb.innerHTML = `${desc}<div>${respText}</div>${answered ? '' : `<div class="row"><button class="primary" id="tAcc" ${can ? '' : 'disabled'}>承諾</button><button id="tRej">拒否</button></div>`}`;
    if (!answered) {
      $('tAcc').onclick = () => dispatch({ type: 'respondTrade', accept: true });
      $('tRej').onclick = () => dispatch({ type: 'respondTrade', accept: false });
    }
  }
}

// 交渉を持ちかけられたとき：画面中央に大きく表示
function renderOffer() {
  const v = app.v, me = app.me, box = $('offer');
  const T = v.trade;
  const show = T && v.phase === 'play' && T.from !== me && T.responses[me] === undefined && app.role !== 'local';
  if (!show) { box.classList.add('hidden'); app.offerShown = null; app.offerSig = null; return; }
  const P = v.players[me], from = v.players[T.from];
  const can = P.res && G.hasRes(P.res, T.get);
  // ほかの人が返事をしても作り直さない（同じ交渉・同じ手札なら何もしない）
  const sig = T.id + '|' + JSON.stringify(P.res);
  if (app.offerSig === sig && !box.classList.contains('hidden')) return;
  const fresh = app.offerShown !== T.id;
  app.offerSig = sig;
  const big = (r) => G.RES.filter((k) => r[k] > 0).map((k) => `<div class="oc"><div class="oi">${G.RES_ICON[k]}</div><div class="on">×${r[k]}</div><div class="ol">${G.RES_JP[k]}</div></div>`).join('');
  box.innerHTML = `<div class="ocard ${fresh ? 'anim' : ''}" style="--pc:${from.color}">
    <div class="ohead">🤝 <span class="dot" style="background:${from.color}"></span>${esc(from.name)} から交渉！</div>
    <div class="orow"><div class="obox give"><div class="ot">あなたが渡す</div><div class="oset">${big(T.get)}</div></div>
      <div class="oarrow">⇄</div>
      <div class="obox get"><div class="ot">あなたがもらう</div><div class="oset">${big(T.give)}</div></div></div>
    <div class="ohave">あなたの手札：${G.RES.map((k) => `${G.RES_ICON[k]}${P.res?.[k] ?? 0}`).join('　')}</div>
    <div class="obtns"><button class="primary ok" id="oAcc" ${can ? '' : 'disabled'}>✅ 承諾する</button><button class="ng" id="oRej">❌ 断る</button></div>
  </div>`;
  box.classList.remove('hidden');
  if (app.offerShown !== T.id) { app.offerShown = T.id; sfx('offer'); try { navigator.vibrate?.(150); } catch {} }
  $('oAcc').onclick = () => dispatch({ type: 'respondTrade', accept: true });
  $('oRej').onclick = () => dispatch({ type: 'respondTrade', accept: false });
}

// 建設コスト表（常時表示。いま建てられる物は✅）
function renderCostCard(P) {
  const ok = (c) => P.res && G.hasRes(P.res, c);
  const row = (name, icons, c, pt = '') => `<div class="cc ${ok(c) ? 'ok' : ''}"><span class="mk">${ok(c) ? '✅' : '・'}</span><b>${name}</b><span class="ic">${icons}</span>${pt ? `<small>${pt}</small>` : ''}</div>`;
  $('costCard').innerHTML = '<div class="cct">📋 建設コスト</div>'
    + row('街道', '🌲🧱', G.COST.road)
    + row('開拓地', '🌲🧱🐑🌾', G.COST.settlement, '1点')
    + row('都市', '🌾🌾⛰️⛰️⛰️', G.COST.city, '2点')
    + row('発展カード', '🐑🌾⛰️', G.COST.dev)
    + '<div class="ccn">最長交易路(5本〜) +2点<br>最大騎士力(騎士3枚〜) +2点</div>';
}

// デバッグ用
window.__app = app;
window.__dispatch = dispatch;
window.__G = G;
window.__renderer = renderer;
