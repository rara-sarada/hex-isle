// =============================================================
// オンライン通信（PeerJS / WebRTC P2P）
// 部屋を作った人＝ホスト。ホストがルールエンジンを持ち、全員に状態を配信する
// サーバー不要（GitHub Pages などの静的ホスティングで動作）
// =============================================================
/* global Peer */
const PREFIX = 'hexisle-v1-';

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
function autoReconnect(peer) {
  let tries = 0;
  peer.on('disconnected', () => {
    if (peer.destroyed || tries >= 5) return;
    tries++;
    setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch {} }, 2000 * tries);
  });
  peer.on('open', () => (tries = 0));
}

export function randomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ---------------- ホスト ----------------
export class Host {
  constructor(code, handlers) {
    this.code = code;
    this.h = handlers; // { onOpen, onError, onMessage(seatIdx, msg), onJoin(), onLeave() }
    this.seats = []; // {name, token, conn, connected}
    this.peer = new Peer(PREFIX + code, peerOptions());
    autoReconnect(this.peer);
    this.peer.on('open', () => this.h.onOpen?.());
    this.peer.on('error', (e) => this.h.onError?.(e));
    this.peer.on('connection', (conn) => this._accept(conn));
  }

  addLocalSeat(name, token) {
    this.seats.push({ name, token, conn: null, connected: true, local: true });
    return 0;
  }

  _accept(conn) {
    conn.on('data', (msg) => {
      if (msg?.t === 'hello') {
        let idx = this.seats.findIndex((s) => s.token === msg.token);
        if (idx < 0) {
          if (this.started) return conn.send({ t: 'reject', msg: 'ゲームはすでに始まっています' });
          if (this.seats.length >= 4) return conn.send({ t: 'reject', msg: '満員です（最大4人）' });
          idx = this.seats.length;
          this.seats.push({ name: String(msg.name || 'プレイヤー').slice(0, 12), token: msg.token });
        }
        const seat = this.seats[idx];
        seat.conn = conn; seat.connected = true;
        conn._seat = idx;
        this.h.onJoin?.(idx);
        return;
      }
      if (conn._seat !== undefined) this.h.onMessage?.(conn._seat, msg);
    });
    conn.on('close', () => {
      if (conn._seat === undefined) return;
      const seat = this.seats[conn._seat];
      if (seat && seat.conn === conn) { seat.connected = false; seat.conn = null; this.h.onLeave?.(conn._seat); }
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
    if (s?.conn) s.conn.close();
    this.seats.splice(idx, 1);
    this.seats.forEach((s2, i) => { if (s2.conn) s2.conn._seat = i; });
  }
}

// ---------------- クライアント ----------------
export class Client {
  constructor(code, name, token, handlers) {
    this.h = handlers; // { onOpen, onMessage, onClose, onError }
    this.peer = new Peer(peerOptions());
    this.peer.on('error', (e) => this.h.onError?.(e));
    this.peer.on('open', () => {
      const conn = (this.conn = this.peer.connect(PREFIX + code, { reliable: true }));
      conn.on('open', () => { conn.send({ t: 'hello', name, token }); this.h.onOpen?.(); });
      conn.on('data', (m) => this.h.onMessage?.(m));
      conn.on('close', () => this.h.onClose?.());
      conn.on('error', (e) => this.h.onError?.(e));
    });
  }
  send(msg) { if (this.conn?.open) this.conn.send(msg); }
}
