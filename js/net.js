// =============================================================
// オンライン通信（PeerJS / WebRTC P2P）
// 部屋を作った人＝ホスト。ホストがルールエンジンを持ち、全員に状態を配信する
// サーバー不要（GitHub Pages などの静的ホスティングで動作）
//
// 切断対策：
//  ・ホスト⇔参加者で3秒ごとに生存確認（ping/pong）。12秒応答がなければ切断扱い
//  ・参加者は切れたら自動で再接続し続ける（上限なし）
//  ・再接続時は席トークンで同じ席に戻る。古い接続が残っていても新しい方で上書き
//  ・トークンを失っても、ゲーム中は「切断中の席」を選んで戻れる
// =============================================================
/* global Peer */
const PREFIX = 'hexisle-v1-';
const PING_MS = 3000;
const DEAD_MS = 12000;

// 既定は PeerJS 公式の無料シグナリングサーバー（0.peerjs.com）
// 自前サーバーを使う場合は URL に ?peerhost=example.com&peerport=443&peerpath=/ を付ける
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const o = { debug: 1 };
  if (q.get('peerhost')) {
    o.host = q.get('peerhost');
    o.port = +(q.get('peerport') || 443);
    o.path = q.get('peerpath') || '/';
    o.secure = q.get('peersecure') ? q.get('peersecure') === '1' : o.port === 443;
  }
  return o;
}

export function randomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---------------- ホスト ----------------
export class Host {
  constructor(code, handlers) {
    this.code = code;
    this.h = handlers; // { onOpen, onError, onMessage(seat, msg), onJoin(seat), onLeave(seat), onNewcomer(conn, msg) }
    this.seats = []; // {name, token, conn, connected, local, lastSeen}
    this.started = false;
    this._idRetry = 0;
    this._createPeer();
    this._hb = setInterval(() => this._heartbeat(), PING_MS);
  }

  _createPeer() {
    const peer = (this.peer = new Peer(PREFIX + this.code, peerOptions()));
    peer.on('open', () => { this._idRetry = 0; this.h.onOpen?.(); });
    peer.on('connection', (conn) => this._accept(conn));
    peer.on('disconnected', () => {
      // シグナリングサーバーから切れた → 何度でも再接続（既存の対戦接続はそのまま生きる）
      setTimeout(() => { try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); } catch {} }, 2000);
    });
    peer.on('error', (e) => {
      // ページ再読み込み直後は前のIDがサーバーに残っていることがある → 少し待って取り直す
      if (e?.type === 'unavailable-id' && this._idRetry < 30) {
        this._idRetry++;
        this.h.onError?.({ type: 'id-wait', retry: this._idRetry });
        try { peer.destroy(); } catch {}
        setTimeout(() => this._createPeer(), 3000);
        return;
      }
      if (e?.type === 'network' || e?.type === 'server-error' || e?.type === 'socket-error') {
        setTimeout(() => { try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); } catch {} }, 3000);
      }
      this.h.onError?.(e);
    });
  }

  addLocalSeat(name, token) {
    this.seats.push({ name, token, conn: null, connected: true, local: true });
    return 0;
  }

  _bind(idx, conn) {
    const seat = this.seats[idx];
    if (seat.conn && seat.conn !== conn) { const old = seat.conn; old._replaced = true; try { old.close(); } catch {} }
    seat.conn = conn; seat.connected = true; seat.lastSeen = Date.now();
    conn._seat = idx;
    conn.send({ t: 'token', token: seat.token });
    this.h.onJoin?.(idx);
  }

  _accept(conn) {
    conn.on('data', (msg) => {
      if (conn._seat !== undefined) { const s = this.seats[conn._seat]; if (s && s.conn === conn) s.lastSeen = Date.now(); }
      if (msg?.t === 'hello') return this._hello(conn, msg);
      if (msg?.t === 'claim') return this._claim(conn, msg);
      if (msg?.t === 'pong') return;
      if (conn._seat !== undefined && this.seats[conn._seat]?.conn === conn) this.h.onMessage?.(conn._seat, msg);
    });
    conn.on('close', () => this._closed(conn));
    conn.on('error', () => this._closed(conn));
  }

  _closed(conn) {
    if (conn._seat === undefined || conn._replaced) return;
    const seat = this.seats[conn._seat];
    if (seat && seat.conn === conn) { seat.connected = false; seat.conn = null; this.h.onLeave?.(conn._seat); }
  }

  _hello(conn, msg) {
    const tok = String(msg.token || '');
    let idx = tok ? this.seats.findIndex((s) => s.token === tok && !s.local) : -1;
    // ロビー中に同じトークンの別タブが来た場合は別人として扱う
    if (idx >= 0 && !this.started && this.seats[idx].connected && this.seats[idx].conn?.open && this.seats[idx].conn !== conn) idx = -1;
    if (idx >= 0) return this._bind(idx, conn); // 同じ席に復帰（古い接続は上書き）
    if (this.started) {
      // ゲーム中の知らない人：切断中の席に戻るか、空きがあれば途中参加を選んでもらう
      const offline = this.seats.map((s, i) => ({ i, name: s.name, off: !s.local && !s.connected })).filter((s) => s.off).map(({ i, name }) => ({ i, name }));
      conn._name = String(msg.name || 'プレイヤー').slice(0, 12);
      return conn.send({ t: 'choose', offline, canJoin: this.seats.length < 4 });
    }
    if (this.seats.length >= 4) return conn.send({ t: 'reject', msg: '満員です（最大4人）' });
    this.seats.push({ name: String(msg.name || 'プレイヤー').slice(0, 12), token: tok && !this.seats.some((s) => s.token === tok) ? tok : newToken() });
    this._bind(this.seats.length - 1, conn);
  }

  _claim(conn, msg) {
    if (msg.seat === 'new') {
      if (this.seats.length >= 4) return conn.send({ t: 'reject', msg: '満員です（最大4人）' });
      const name = conn._name || 'プレイヤー';
      this.seats.push({ name, token: newToken() });
      const idx = this.seats.length - 1;
      this.h.onNewcomer?.(idx, name);
      return this._bind(idx, conn);
    }
    const idx = +msg.seat;
    const s = this.seats[idx];
    if (!s || s.local || s.connected) return conn.send({ t: 'reject', msg: 'その席は使用中です' });
    this._bind(idx, conn);
  }

  _heartbeat() {
    const now = Date.now();
    this.seats.forEach((s, i) => {
      if (s.local || !s.conn) return;
      if (now - (s.lastSeen || now) > DEAD_MS) {
        const c = s.conn; c._replaced = true;
        s.conn = null; s.connected = false;
        try { c.close(); } catch {}
        this.h.onLeave?.(i);
        return;
      }
      if (s.conn.open) s.conn.send({ t: 'ping', seq: this.h.getSeq?.() ?? 0 });
    });
  }

  send(idx, msg) {
    const s = this.seats[idx];
    if (s?.conn?.open) s.conn.send(msg);
  }
  broadcast(fn) {
    this.seats.forEach((s, i) => { if (s.conn?.open) s.conn.send(fn(i)); });
  }
  kick(idx) {
    const s = this.seats[idx];
    if (s?.conn) { s.conn._replaced = true; s.conn.close(); }
    this.seats.splice(idx, 1);
    this.seats.forEach((s2, i) => { if (s2.conn) s2.conn._seat = i; });
  }
}

// ---------------- クライアント ----------------
export class Client {
  constructor(code, name, token, handlers) {
    this.code = code; this.name = name; this.token = token;
    this.h = handlers; // { onStatus(state, info), onMessage, onError }
    this.lastMsg = 0;
    this.attempt = 0;
    this.stopped = false;
    this._connect();
    this._hb = setInterval(() => this._heartbeat(), PING_MS);
    // スマホでタブに戻ってきたら即座に確認
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this._heartbeat(true); });
    window.addEventListener('online', () => this.reconnect());
  }

  get online() { return !!this.conn?.open && Date.now() - this.lastMsg < DEAD_MS; }

  _connect() {
    if (this.stopped) return;
    this.attempt++;
    this.h.onStatus?.('connecting', this.attempt);
    const go = () => {
      const conn = (this.conn = this.peer.connect(PREFIX + this.code, { reliable: true }));
      conn.on('open', () => {
        if (conn !== this.conn) return;
        this.lastMsg = Date.now();
        conn.send({ t: 'hello', name: this.name, token: this.token });
      });
      conn.on('data', (m) => {
        if (conn !== this.conn) return;
        this.lastMsg = Date.now();
        if (m?.t === 'token') this.token = m.token;
        if (m?.t === 'ping') { conn.send({ t: 'pong' }); if (this.attempt) { this.attempt = 0; this.h.onStatus?.('online'); } }
        if (m?.t === 'state' && this.attempt) { this.attempt = 0; this.h.onStatus?.('online'); }
        if (m?.t === 'lobby' && this.attempt) { this.attempt = 0; this.h.onStatus?.('online'); }
        this.h.onMessage?.(m);
      });
      conn.on('close', () => { if (conn === this.conn) this._scheduleRetry(); });
      conn.on('error', () => { if (conn === this.conn) this._scheduleRetry(); });
    };
    if (this.peer && !this.peer.destroyed && this.peer.open) return go();
    try { this.peer?.destroy(); } catch {}
    const peer = (this.peer = new Peer(peerOptions()));
    peer.on('open', () => { if (peer === this.peer) go(); });
    peer.on('disconnected', () => { setTimeout(() => { try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); } catch {} }, 2000); });
    peer.on('error', (e) => {
      if (peer !== this.peer) return;
      this.h.onError?.(e, this.attempt);
      this._scheduleRetry(true);
    });
  }

  _scheduleRetry(newPeer = false) {
    if (this.stopped || this._retryTimer) return;
    this.h.onStatus?.('offline', this.attempt);
    const wait = Math.min(1000 * (1 + this.attempt), 5000);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (newPeer) { try { this.peer?.destroy(); } catch {} this.peer = null; }
      try { this.conn?.close(); } catch {}
      this._connect();
    }, wait);
  }

  // 手動の再接続：ピアごと作り直す
  reconnect() {
    clearTimeout(this._retryTimer); this._retryTimer = null;
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.attempt = 0;
    this._connect();
  }

  _heartbeat(force = false) {
    if (this.stopped) return;
    if (this.conn?.open) this.conn.send({ t: 'pong' });
    const silent = Date.now() - this.lastMsg;
    if (this.lastMsg && silent > DEAD_MS && !this._retryTimer) {
      // 応答なし → 接続し直す
      try { this.conn?.close(); } catch {}
      this._scheduleRetry(silent > DEAD_MS * 2);
    } else if (force && this.conn?.open) this.conn.send({ t: 'sync' });
  }

  send(msg) { if (this.conn?.open) this.conn.send(msg); }
}
