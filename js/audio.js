// =============================================================
// 効果音・環境音（Web Audio API で合成。音声ファイル不要）
// =============================================================
let ctx = null, master = null, sfxBus = null, ambBus = null, noiseBuf = null;
let enabled = true, volume = 0.7;
try { const s = JSON.parse(localStorage.getItem('hexisle-sound') || 'null'); if (s) { enabled = s.enabled; volume = s.volume ?? 0.7; } } catch {}

function save() { try { localStorage.setItem('hexisle-sound', JSON.stringify({ enabled, volume })); } catch {} }

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = enabled ? volume : 0;
  sfxBus = ctx.createGain();
  ambBus = ctx.createGain();
  ambBus.gain.value = 0.35;
  sfxBus.connect(comp); ambBus.connect(comp); comp.connect(master); master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startAmbience();
}
// ブラウザの自動再生制限：最初の操作で有効化
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { init(); ctx?.state === 'suspended' && ctx.resume(); }, { passive: true }));

export const Sound = {
  get enabled() { return enabled; },
  get state() { return ctx ? ctx.state : 'none'; },
  get volume() { return volume; },
  setEnabled(v) { enabled = v; save(); if (master) master.gain.setTargetAtTime(enabled ? volume : 0, ctx.currentTime, 0.05); },
  setVolume(v) { volume = v; save(); if (master && enabled) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05); },
};

const ready = () => ctx && enabled && ctx.state === 'running';

// ---------------- 合成の部品 ----------------
function tone(freq, { t = 0, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.005, slide = null, filter = null, bus = sfxBus, vibrato = 0 } = {}) {
  const t0 = ctx.currentTime + t;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
  if (vibrato) {
    const l = ctx.createOscillator(), lg = ctx.createGain();
    l.frequency.value = 6; lg.gain.value = vibrato;
    l.connect(lg); lg.connect(o.frequency); l.start(t0); l.stop(t0 + dur + 0.05);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = o;
  if (filter) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter; o.connect(f); node = f; }
  node.connect(g); g.connect(bus);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

function noise({ t = 0, dur = 0.1, type = 'bandpass', freq = 1000, q = 1, gain = 0.3, sweep = null, attack = 0.002, bus = sfxBus } = {}) {
  const t0 = ctx.currentTime + t;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(bus);
  src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);
}

const N = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDIノート→周波数

// ---------------- 効果音 ----------------
const S = {
  click() { tone(1100, { dur: 0.05, type: 'triangle', gain: 0.12 }); },
  hover() { tone(1600, { dur: 0.03, type: 'sine', gain: 0.05 }); },
  error() { tone(160, { dur: 0.18, type: 'square', gain: 0.12, filter: 900 }); tone(120, { t: 0.09, dur: 0.18, type: 'square', gain: 0.1, filter: 900 }); },

  diceShake() {
    for (let i = 0; i < 11; i++) noise({ t: i * 0.06 + Math.random() * 0.03, dur: 0.035, freq: 2500 + Math.random() * 2500, q: 4, gain: 0.25 });
  },
  diceLand() {
    [0, 0.12, 0.2].forEach((t, i) => {
      noise({ t, dur: 0.07, type: 'lowpass', freq: 900, gain: 0.5 / (i + 1) });
      tone(180, { t, dur: 0.08, slide: 90, gain: 0.25 / (i + 1) });
    });
  },
  knock(pitch = 1) {
    tone(260 * pitch, { dur: 0.12, slide: 140 * pitch, gain: 0.45 });
    noise({ dur: 0.05, freq: 900 * pitch, q: 2, gain: 0.35 });
  },
  road() { S.knock(1.3); noise({ t: 0.03, dur: 0.12, freq: 500, q: 1, gain: 0.15 }); },
  settlement() {
    S.knock(1);
    [60, 64, 67].forEach((n, i) => tone(N(n + 12), { t: 0.08 + i * 0.07, dur: 0.35, type: 'triangle', gain: 0.18 }));
  },
  city() {
    S.knock(0.8);
    [55, 60, 64, 67, 72].forEach((n, i) => tone(N(n), { t: 0.1 + i * 0.09, dur: 0.5, type: 'sawtooth', gain: 0.12, filter: 2200 }));
    tone(N(79), { t: 0.6, dur: 0.9, type: 'triangle', gain: 0.12, vibrato: 4 });
  },
  gain(count = 1) {
    const base = [72, 76, 79, 84, 88];
    for (let i = 0; i < Math.min(count, 5); i++) {
      tone(N(base[i]), { t: i * 0.07, dur: 0.25, type: 'triangle', gain: 0.16 });
      tone(N(base[i] + 12), { t: i * 0.07 + 0.02, dur: 0.18, type: 'sine', gain: 0.06 });
    }
  },
  seven() {
    tone(110, { dur: 0.9, type: 'sawtooth', gain: 0.18, filter: 700, vibrato: 6 });
    tone(117, { dur: 0.9, type: 'sawtooth', gain: 0.18, filter: 700 });
    tone(55, { t: 0.05, dur: 1.4, type: 'sine', gain: 0.4 });
    noise({ dur: 1.2, type: 'lowpass', freq: 300, gain: 0.25, attack: 0.02 });
  },
  robber() {
    noise({ dur: 0.7, type: 'lowpass', freq: 250, gain: 0.4, attack: 0.05 });
    tone(220, { dur: 0.6, slide: 70, type: 'triangle', gain: 0.2 });
    tone(N(48), { t: 0.35, dur: 0.6, type: 'sawtooth', gain: 0.08, filter: 600 });
    tone(N(51), { t: 0.35, dur: 0.6, type: 'sawtooth', gain: 0.08, filter: 600 });
  },
  steal() { noise({ dur: 0.35, freq: 3500, sweep: 400, q: 3, gain: 0.35 }); tone(900, { t: 0.2, dur: 0.12, slide: 500, type: 'triangle', gain: 0.1 }); },
  card() { noise({ dur: 0.06, type: 'highpass', freq: 3000, gain: 0.3 }); noise({ t: 0.08, dur: 0.08, type: 'highpass', freq: 2200, gain: 0.25 }); tone(N(84), { t: 0.12, dur: 0.3, type: 'sine', gain: 0.1 }); },
  knight() {
    [[55, 0, 0.25], [60, 0.22, 0.25], [64, 0.44, 0.6]].forEach(([n, t, d]) => tone(N(n), { t, dur: d, type: 'sawtooth', gain: 0.14, filter: 1600, attack: 0.03 }));
    noise({ t: 0.45, dur: 0.3, type: 'highpass', freq: 5000, gain: 0.12 });
  },
  magic() { [76, 79, 83, 88, 91, 95].forEach((n, i) => tone(N(n), { t: i * 0.05, dur: 0.4, type: 'sine', gain: 0.1 })); },
  trade() { tone(N(88), { dur: 0.25, type: 'triangle', gain: 0.15 }); tone(N(93), { t: 0.12, dur: 0.4, type: 'triangle', gain: 0.15 }); },
  offer() { tone(N(79), { dur: 0.15, type: 'sine', gain: 0.12 }); tone(N(83), { t: 0.1, dur: 0.2, type: 'sine', gain: 0.12 }); },
  achievement() {
    [60, 64, 67, 72].forEach((n, i) => tone(N(n + 12), { t: i * 0.1, dur: 0.5, type: 'triangle', gain: 0.16 }));
    [72, 76, 79].forEach((n) => tone(N(n + 12), { t: 0.45, dur: 1.0, type: 'sine', gain: 0.08, vibrato: 3 }));
  },
  myTurn() { tone(N(81), { dur: 0.7, type: 'sine', gain: 0.2 }); tone(N(88), { t: 0.15, dur: 0.9, type: 'sine', gain: 0.16 }); },
  win() {
    const mel = [[67, 0, 0.18], [67, 0.2, 0.18], [67, 0.4, 0.18], [72, 0.6, 0.7], [71, 1.3, 0.2], [72, 1.5, 0.2], [76, 1.7, 1.2]];
    mel.forEach(([n, t, d]) => { tone(N(n), { t, dur: d + 0.1, type: 'sawtooth', gain: 0.12, filter: 2500 }); tone(N(n - 12), { t, dur: d + 0.1, type: 'triangle', gain: 0.1 }); });
    [48, 55, 60, 64].forEach((n) => tone(N(n), { t: 1.7, dur: 1.6, type: 'triangle', gain: 0.08 }));
    for (let i = 0; i < 6; i++) noise({ t: 1.8 + i * 0.25, dur: 0.4, type: 'highpass', freq: 4000, gain: 0.08 });
  },
  firework() {
    noise({ dur: 0.5, type: 'lowpass', freq: 400, gain: 0.35, attack: 0.01 });
    for (let i = 0; i < 10; i++) noise({ t: 0.15 + Math.random() * 0.6, dur: 0.04, type: 'highpass', freq: 3000 + Math.random() * 3000, gain: 0.12 });
  },
  banner() { noise({ dur: 0.25, freq: 1200, sweep: 3000, q: 1, gain: 0.08 }); },
  start() { [60, 67, 72, 76].forEach((n, i) => tone(N(n), { t: i * 0.12, dur: 0.6, type: 'triangle', gain: 0.14 })); },
};

export function sfx(name, ...args) {
  if (!ready() || !S[name]) return;
  try { S[name](...args); } catch (e) { console.warn('sfx', name, e); }
}

// ---------------- 環境音（波とカモメ） ----------------
function startAmbience() {
  // 波：ローパスしたノイズの音量をゆっくり揺らす
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
  const g = ctx.createGain(); g.gain.value = 0.12;
  const lfo = ctx.createOscillator(), lg = ctx.createGain();
  lfo.frequency.value = 0.12; lg.gain.value = 0.1;
  lfo.connect(lg); lg.connect(g.gain);
  const lfo2 = ctx.createOscillator(), lg2 = ctx.createGain();
  lfo2.frequency.value = 0.07; lg2.gain.value = 250;
  lfo2.connect(lg2); lg2.connect(f.frequency);
  src.connect(f); f.connect(g); g.connect(ambBus);
  src.start(); lfo.start(); lfo2.start();
  // カモメ：ときどき鳴く
  const gull = () => {
    if (ready()) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        tone(1900 + Math.random() * 300, { t: i * 0.28, dur: 0.22, slide: 1300, type: 'triangle', gain: 0.025, bus: ambBus, vibrato: 40 });
      }
    }
    setTimeout(gull, 9000 + Math.random() * 14000);
  };
  setTimeout(gull, 5000);
}
