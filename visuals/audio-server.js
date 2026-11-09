#!/usr/bin/env node
// audio-server.js
// Single process behind the TV visuals:
//   - captures the PipeWire sink monitor (what goes to the speakers) and analyses it,
//   - broadcasts audio features over WebSocket,
//   - serves the pages of this folder over HTTP (TV opens http://<host>:8765/,
//     phone opens /control.html) and switches the active visual (POST /active/<name>).
// Everything on PORT; active.html is created from DEFAULT_VISUAL when missing.
//
// Usage : node audio-server.js [--target <sink-node-name>] [--min-ref <dB>] [--range <dB>] [--rise <dB>] [--port <n>]
//
// Message format and analysis: analysis.js (shared with the browser).

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const Analysis = require('./analysis');

// ── Config ─────────────────────────────────────────────────────────────────
const RATE     = 48000;
const CHANNELS = 2;
let PORT       = 8765;
const ROOT     = __dirname;                 // the pages live next to this file
const DEFAULT_VISUAL = 'corridor';
const RESERVED = new Set(['index', 'active', 'control']);   // pages that can never go into the TV iframe
const TOOLS    = new Set(['webgl-check']);                    // not visuals, but can be shown on the TV
const HIDDEN   = new Set(['debug']);                          // desktop-only page, never offered for the TV

let TARGET  = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
// Auto-gain : a band's reference level follows its recent peak, but can never
// drop below MIN_REF_DB. Everything below (reference − RANGE_DB) maps to 0.
// With the defaults, anything under −55 dBFS is silence, whatever happens.
// RANGE_DB 20 measured on a real Mixxx mix (2026-11-05): low drops to 0 between
// kicks and reaches ≈0.8 on them; 30 kept every band near 0.85 all the time.
let MIN_REF_DB = -35;
let RANGE_DB   = 20;
const REF_RELEASE_DB_PER_S = 1.5;   // how fast the reference comes down after a loud part
// Kick detection : the low band must rise by RISE_DB within RISE_HOPS hops.
// Measured on a real mix at 156 BPM (2026-11-05): 32 kicks for 31 beats, 27 of them exactly a beat
// apart, unchanged from 6 to 12 dB. The previous spectral-flux detector with an adaptive
// mean + 1.5 sd threshold found 23: a loud start raised the threshold for 1.4 s and regular
// kicks left too thin a margin.
let RISE_DB = 8;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === '--target'  && v) { TARGET = v; i++; }
  else if (a === '--min-ref' && v) { MIN_REF_DB = Number(v); i++; }
  else if (a === '--range'   && v) { RANGE_DB = Number(v); i++; }
  else if (a === '--rise'    && v) { RISE_DB = Number(v); i++; }
  else if (a === '--port'    && v) { PORT = Number(v); i++; }
  else { console.error(`unknown option or missing value: ${a}`); process.exit(2); }
}
if (!Number.isFinite(MIN_REF_DB) || !Number.isFinite(RANGE_DB) || RANGE_DB <= 0 || !(RISE_DB > 0) || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('--min-ref must be a number, --range and --rise numbers > 0, --port an integer in 1-65535');
  process.exit(2);
}


// ── Visuals : list, active one, activation ─────────────────────────────────
function listVisuals() {
  return fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html') && !f.startsWith('.'))
    .map(f => f.slice(0, -5))
    .filter(n => !RESERVED.has(n) && !TOOLS.has(n) && !HIDDEN.has(n))
    .sort();
}

function listTools() {
  return [...TOOLS].filter(n => fs.existsSync(path.join(ROOT, `${n}.html`))).sort();
}

function activeVisual() {
  let active;
  try { active = fs.readFileSync(path.join(ROOT, 'active.html')); } catch (e) { return null; }
  return listVisuals().concat(listTools()).find(n => fs.readFileSync(path.join(ROOT, `${n}.html`)).equals(active)) || null;
}

// Returns an error message, or null on success. Atomic: index.html polls active.html every 2 s.
function activate(name) {
  if (!/^[a-z0-9-]+$/.test(name) || RESERVED.has(name) || HIDDEN.has(name)) return `'${name}' cannot be shown on the TV`;
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
    return send(res, 200, JSON.stringify({ visuals: listVisuals(), tools: listTools(), active: activeVisual() }), 'application/json');
  }
  const m = url.pathname.match(/^\/active\/([^/]+)$/);
  if (m && req.method === 'POST') {
    const err = activate(decodeURIComponent(m[1]));
    return err ? send(res, 400, err) : send(res, 200, JSON.stringify({ active: m[1] }), 'application/json');
  }
  if (url.pathname === '/report' && req.method === 'POST') {
    // Capability report posted by webgl-check.html from the TV (the agent cannot see the screen).
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= 4096) chunks.push(c); });
    req.on('end', () => {
      if (size > 4096) return send(res, 413, 'report too large');
      let report;
      try { report = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, 'invalid JSON'); }
      const line = JSON.stringify(Object.assign({ at: new Date().toISOString(), from: req.socket.remoteAddress }, report));
      fs.appendFileSync(path.join(ROOT, 'reports.jsonl'), line + '\n');
      console.log('\n[report] ' + line);
      send(res, 200, 'ok');
    });
    return;
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

// pw-record gives s16 interleaved stereo; the analyser wants mono floats in [-1, 1].
const analyser = Analysis.create({ rate: RATE, minRefDb: MIN_REF_DB, rangeDb: RANGE_DB, riseDb: RISE_DB }, onFeatures);
let hops = 0;
function onFeatures(f) {
  broadcast(f);
  if (++hops % 12 === 0 || f.onset > 0) {
    process.stdout.write(
      `\rlevel=${f.level.toFixed(2)} low=${f.low.toFixed(2)} mid=${f.mid.toFixed(2)} high=${f.high.toFixed(2)} ` +
      `tone=${f.tone.toFixed(2)} onset=${f.onset ? f.onset.toFixed(2) : '  - '} ` +
      `| dB full=${f.dbg.db.full.toFixed(0)} low=${f.dbg.db.low.toFixed(0)} | clients=${wss.clients.size}   `
    );
  }
}

let leftover = Buffer.alloc(0);
const FRAME_BYTES = 2 * CHANNELS;
proc.stdout.on('data', chunk => {
  const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
  const frames = Math.floor(buf.length / FRAME_BYTES);
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME_BYTES;
    const L = buf.readInt16LE(o);
    const R = CHANNELS > 1 ? buf.readInt16LE(o + 2) : L;
    mono[f] = (L + R) / 65536;
  }
  analyser.push(mono);
  leftover = buf.subarray(frames * FRAME_BYTES);
});

server.listen(PORT, () => {
  console.log(`visuals on http://0.0.0.0:${PORT}/  (TV: /  phone: /control.html  calibration: /debug.html)`);
  console.log(`active visual: ${activeVisual() || 'none'} | capture: monitor of ${TARGET} | silence below ${MIN_REF_DB - RANGE_DB} dBFS (min-ref ${MIN_REF_DB}, range ${RANGE_DB}, kick rise ${RISE_DB} dB)`);
});
