#!/usr/bin/env node
// audio-server.js
// Single process behind the TV visuals:
//   - captures the PipeWire sink monitor (what goes to the speakers) and analyses it,
//   - broadcasts audio features over WebSocket,
//   - serves the pages of this folder over HTTP (TV opens http://<host>:8765/,
//     phone opens /control.html) and switches the active visual (POST /active/<name>).
// Everything on PORT; active.html is created from DEFAULT_VISUAL when missing.
//
// Usage : node audio-server.js [--target <sink-node-name>] [--min-ref <dB>] [--range <dB>] [--port <n>]
//
// Message (≈47 per second, raw values — smoothing is the visual's job):
//   level  0-1  perceived loudness (full band, dB scale, bounded auto-gain)
//   low    0-1  40-120 Hz   (kick / sub)
//   mid    0-1  250-2000 Hz (voices, synths)
//   high   0-1  4-12 kHz    (hats, cymbals)
//   onset  0-1  strength of a low-band attack on this hop, 0 otherwise
//   tone   0-1  spectral balance : 1 = bass-heavy (warm), 0 = treble-heavy (cold)
//   dbg    raw dB values, auto-gain references, flux and threshold (for debug.html)

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── Config ─────────────────────────────────────────────────────────────────
const RATE     = 48000;
const CHANNELS = 2;
const FFTSIZE  = 4096;    // ≈11.7 Hz per bin → usable bass resolution
const HOP      = 1024;    // new analysis every ≈21 ms → low latency despite large window
let PORT       = 8765;
const ROOT     = __dirname;                 // the pages live next to this file
const DEFAULT_VISUAL = 'corridor';
const RESERVED = new Set(['index', 'active', 'debug', 'control']);   // pages that are not visuals

let TARGET  = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
// Auto-gain : a band's reference level follows its recent peak, but can never
// drop below MIN_REF_DB. Everything below (reference − RANGE_DB) maps to 0.
// With the defaults, anything under −55 dBFS is silence, whatever happens.
// RANGE_DB 20 measured on a real Mixxx mix (2026-11-05): low drops to 0 between
// kicks and reaches ≈0.8 on them; 30 kept every band near 0.85 all the time.
let MIN_REF_DB = -35;
let RANGE_DB   = 20;
const REF_RELEASE_DB_PER_S = 1.5;   // how fast the reference comes down after a loud part

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === '--target'  && v) { TARGET = v; i++; }
  else if (a === '--min-ref' && v) { MIN_REF_DB = Number(v); i++; }
  else if (a === '--range'   && v) { RANGE_DB = Number(v); i++; }
  else if (a === '--port'    && v) { PORT = Number(v); i++; }
  else { console.error(`unknown option or missing value: ${a}`); process.exit(2); }
}
if (!Number.isFinite(MIN_REF_DB) || !Number.isFinite(RANGE_DB) || RANGE_DB <= 0 || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('--min-ref must be a number, --range a number > 0, --port an integer in 1-65535');
  process.exit(2);
}

const HOP_S  = HOP / RATE;
const BIN_HZ = RATE / FFTSIZE;

// ── Visuals : list, active one, activation ─────────────────────────────────
function listVisuals() {
  return fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html') && !f.startsWith('.'))
    .map(f => f.slice(0, -5))
    .filter(n => !RESERVED.has(n))
    .sort();
}

function activeVisual() {
  let active;
  try { active = fs.readFileSync(path.join(ROOT, 'active.html')); } catch (e) { return null; }
  return listVisuals().find(n => fs.readFileSync(path.join(ROOT, `${n}.html`)).equals(active)) || null;
}

// Returns an error message, or null on success. Atomic: index.html polls active.html every 2 s.
function activate(name) {
  if (!/^[a-z0-9-]+$/.test(name) || RESERVED.has(name)) return `'${name}' is not a visual`;
  const src = path.join(ROOT, `${name}.html`);
  if (!fs.existsSync(src)) return `unknown visual '${name}' (available: ${listVisuals().join(', ')})`;
  const tmp = path.join(ROOT, '.active.tmp');
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, path.join(ROOT, 'active.html'));
  return null;
}

if (!fs.existsSync(path.join(ROOT, 'active.html'))) {
  const first = listVisuals().includes(DEFAULT_VISUAL) ? DEFAULT_VISUAL : listVisuals()[0];
  if (first) { activate(first); console.log(`active.html missing: activated ${first}`); }
}

// ── HTTP : static pages + control API ──────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/visuals' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ visuals: listVisuals(), active: activeVisual() }), 'application/json');
  }
  const m = url.pathname.match(/^\/active\/([^/]+)$/);
  if (m && req.method === 'POST') {
    const err = activate(decodeURIComponent(m[1]));
    return err ? send(res, 400, err) : send(res, 200, JSON.stringify({ active: m[1] }), 'application/json');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  // Static: only top-level .html/.js files of this folder (no node_modules, no dotfiles).
  const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const ext = path.extname(name);
  if (name.includes('/') || name.startsWith('.') || !MIME[ext]) return send(res, 404, 'not found');
  fs.readFile(path.join(ROOT, name), (e, data) => {
    if (e) return send(res, 404, 'not found');
    send(res, 200, data, MIME[ext]);
  });
});
server.on('error', e => { console.error('http server:', e.message); process.exit(1); });

// ── WebSocket, on the same port ────────────────────────────────────────────
// The server never reads anything meaningful: cap incoming frames (default is 100 MiB).
const wss = new WebSocketServer({ server, maxPayload: 1024 });
// Without these listeners a single malformed frame from any device on the LAN throws and kills the process.
wss.on('error', e => { console.error('websocket server:', e.message); process.exit(1); });
wss.on('connection', ws => ws.on('error', e => console.error('[ws client]', e.message)));
function broadcast(obj) {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// ── FFT (radix-2, in place) with precomputed twiddles ─────────────────────
const twRe = new Float32Array(FFTSIZE / 2);
const twIm = new Float32Array(FFTSIZE / 2);
for (let k = 0; k < FFTSIZE / 2; k++) {
  twRe[k] = Math.cos(-2 * Math.PI * k / FFTSIZE);
  twIm[k] = Math.sin(-2 * Math.PI * k / FFTSIZE);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = twRe[j * step], wi = twIm[j * step];
        const a = i + j, b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
      }
    }
  }
}

const hann = new Float32Array(FFTSIZE);
for (let k = 0; k < FFTSIZE; k++) hann[k] = 0.5 * (1 - Math.cos(2 * Math.PI * k / (FFTSIZE - 1)));
// Scale so that a full-scale sine reads ≈ 0 dBFS (Hann coherent gain 0.5, single-sided ×2)
const MAG_SCALE = 4 / FFTSIZE;
const HANN_ENBW = 1.5;

// ── Bands ──────────────────────────────────────────────────────────────────
function bins(loHz, hiHz) {
  return [Math.max(1, Math.round(loHz / BIN_HZ)), Math.min(FFTSIZE / 2 - 1, Math.round(hiHz / BIN_HZ))];
}
const BANDS = {
  full: bins(30,   16000),
  low:  bins(40,   120),
  mid:  bins(250,  2000),
  high: bins(4000, 12000),
};
const FLUX_BINS = bins(35, 200);   // onset detection looks at kick territory only

function bandDb(power, [lo, hi]) {
  let sum = 0;
  for (let k = lo; k <= hi; k++) sum += power[k];
  return 10 * Math.log10(sum / HANN_ENBW + 1e-12);
}

// ── Bounded auto-gain, one per band ───────────────────────────────────────
const ref = { full: MIN_REF_DB, low: MIN_REF_DB, mid: MIN_REF_DB, high: MIN_REF_DB };

function toLevel(name, db) {
  ref[name] = Math.max(MIN_REF_DB, ref[name] - REF_RELEASE_DB_PER_S * HOP_S, db);
  const floor = ref[name] - RANGE_DB;
  return Math.min(1, Math.max(0, (db - floor) / RANGE_DB));
}

// ── Onset detection : log-magnitude spectral flux, adaptive threshold ─────
const FLUX_HISTORY = 64;            // ≈1.4 s of context
const fluxHist = new Float32Array(FLUX_HISTORY);
let fluxCount = 0;
const prevLogMag = new Float32Array(FFTSIZE / 2).fill(-120);
const REFRACTORY_S = 0.12;
let lastOnsetT = -1;
let t = 0;

function detectOnset(logMag, lowDb) {
  const [lo, hi] = FLUX_BINS;
  let flux = 0;
  for (let k = lo; k <= hi; k++) {
    const d = logMag[k] - prevLogMag[k];
    if (d > 0) flux += d;
  }
  flux /= (hi - lo + 1);

  const n = Math.min(fluxCount, FLUX_HISTORY);
  let mean = 0, sd = 0;
  for (let i = 0; i < n; i++) mean += fluxHist[i];
  mean = n ? mean / n : 0;
  for (let i = 0; i < n; i++) sd += (fluxHist[i] - mean) ** 2;
  sd = n ? Math.sqrt(sd / n) : 0;
  const thr = mean + 1.5 * sd + 0.5;   // +0.5 dB so a flat signal never triggers

  fluxHist[fluxCount++ % FLUX_HISTORY] = flux;

  let onset = 0;
  // Gate on absolute level (silence floor), not on the auto-gained level:
  // a kick starts from near 0 after the release, the gate must not depend on RANGE_DB.
  const audible = lowDb > MIN_REF_DB - RANGE_DB;
  if (n >= 16 && flux > thr && audible && (t - lastOnsetT) > REFRACTORY_S) {
    onset = Math.min(1, 0.4 + (flux - thr) / (3 * sd + 1));
    lastOnsetT = t;
  }
  return { onset, flux, thr };
}

// ── Capture ────────────────────────────────────────────────────────────────
// stream.capture.sink=true makes PipeWire link the sink monitor (speakers),
// not the microphone.
const proc = spawn('pw-record', [
  '--rate', String(RATE), '--channels', String(CHANNELS), '--format', 's16', '--raw',
  '--target', TARGET,
  '-P', '{ stream.capture.sink=true }',
  '-',
]);
proc.on('error', e => { console.error('pw-record:', e.message); process.exit(1); });
proc.stderr.on('data', d => process.stderr.write('[pw-record] ' + d));
proc.on('exit', code => { console.error('\npw-record exited with code', code); process.exit(1); });

const ring = new Float32Array(FFTSIZE);   // circular buffer of the last FFTSIZE mono samples
let ringPos = 0;                            // next write index (= oldest sample)
let pendingHop = 0;                         // samples received since last analysis
let leftover = Buffer.alloc(0);
const FRAME_BYTES = 2 * CHANNELS;

const re = new Float32Array(FFTSIZE);
const im = new Float32Array(FFTSIZE);
const power = new Float32Array(FFTSIZE / 2);
const logMag = new Float32Array(FFTSIZE / 2);

function analyse() {
  for (let i = 0; i < FFTSIZE; i++) {
    re[i] = ring[(ringPos + i) % FFTSIZE] * hann[i];   // oldest → newest
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k < FFTSIZE / 2; k++) {
    const m = Math.hypot(re[k], im[k]) * MAG_SCALE;
    power[k] = m * m;
    logMag[k] = Math.max(-120, 20 * Math.log10(m + 1e-9));
  }

  const db = {
    full: bandDb(power, BANDS.full),
    low:  bandDb(power, BANDS.low),
    mid:  bandDb(power, BANDS.mid),
    high: bandDb(power, BANDS.high),
  };
  const level = toLevel('full', db.full);
  const low   = toLevel('low',  db.low);
  const mid   = toLevel('mid',  db.mid);
  const high  = toLevel('high', db.high);

  const { onset, flux, thr } = detectOnset(logMag, db.low);
  prevLogMag.set(logMag);

  // Balance between bands, each already auto-gained → a track that is
  // naturally bass-heavy does not stay red forever. Neutral 0.5 when silent.
  const sum  = low + mid + high;
  const tone = sum > 0.05 ? (low * 1 + mid * 0.5) / sum : 0.5;

  t += HOP_S;

  const r3 = v => Math.round(v * 1000) / 1000;
  const r1 = v => Math.round(v * 10) / 10;
  broadcast({
    level: r3(level), low: r3(low), mid: r3(mid), high: r3(high),
    onset: r3(onset), tone: r3(tone),
    dbg: {
      db:  { full: r1(db.full), low: r1(db.low), mid: r1(db.mid), high: r1(db.high) },
      ref: { full: r1(ref.full), low: r1(ref.low), mid: r1(ref.mid), high: r1(ref.high) },
      flux: r3(flux), thr: r3(thr), range: RANGE_DB, minRef: MIN_REF_DB,
    },
  });

  if (fluxCount % 12 === 0 || onset > 0) {
    process.stdout.write(
      `\rlevel=${level.toFixed(2)} low=${low.toFixed(2)} mid=${mid.toFixed(2)} high=${high.toFixed(2)} ` +
      `tone=${tone.toFixed(2)} onset=${onset ? onset.toFixed(2) : '  - '} ` +
      `| dB full=${db.full.toFixed(0)} low=${db.low.toFixed(0)} | clients=${wss.clients.size}   `
    );
  }
}

proc.stdout.on('data', chunk => {
  const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
  const frames = Math.floor(buf.length / FRAME_BYTES);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME_BYTES;
    const L = buf.readInt16LE(o);
    const R = CHANNELS > 1 ? buf.readInt16LE(o + 2) : L;
    ring[ringPos] = (L + R) / 65536;
    ringPos = (ringPos + 1) % FFTSIZE;
    if (++pendingHop >= HOP) { pendingHop = 0; analyse(); }
  }
  leftover = buf.subarray(frames * FRAME_BYTES);
});

server.listen(PORT, () => {
  console.log(`visuals on http://0.0.0.0:${PORT}/  (TV: /  phone: /control.html  calibration: /debug.html)`);
  console.log(`active visual: ${activeVisual() || 'none'} | capture: monitor of ${TARGET} | silence below ${MIN_REF_DB - RANGE_DB} dBFS (min-ref ${MIN_REF_DB}, range ${RANGE_DB})`);
});
