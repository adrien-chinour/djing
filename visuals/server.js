#!/usr/bin/env node
// server.js
// Single process behind the visuals. Two ways to feed it:
//   - local (default): captures the PipeWire sink monitor (what goes to the speakers),
//     analyses it and feeds the reserved session `local` (the TV opens http://<host>:8765/,
//     the phone /control.html);
//   - remote (--no-capture, the container): anyone opens /, shares a tab's sound from
//     their browser (start.html analyses it and publishes the features over WebSocket),
//     gets a public screen link /s/<id> and a signed control link /c/<id>/<token>
//     (also as a QR code: /qr/<id>/<source token>.svg).
// Sessions live in memory and expire after 12 h without any screen or source.
//
// Usage : node server.js [--no-capture] [--target <sink-node-name>] [--min-ref <dB>] [--range <dB>]
//                              [--rise <dB>] [--port <n>]
// Env   : PORT (default 8765), SESSION_SECRET (HMAC key of the links; random at startup when missing,
//         so the links change on every restart).
//
// WebSocket /ws?s=<id>&r=screen            read-only, no token (screen links are public)
//           /ws?s=<id>&r=source&t=<token>  publishes {t:'audio', ...} (format: analysis.js), one per session
// Server → client: {t:'hello', id, active, visuals, tools, source}, {t:'audio', ...}, {t:'active', visual},
//                  {t:'source', on}.

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-generator');
const Analysis = require('./public/analysis');

// ── Config ─────────────────────────────────────────────────────────────────
const RATE     = 48000;
const CHANNELS = 2;
let PORT       = Number(process.env.PORT) || 8765;
const PUBLIC   = path.join(__dirname, 'public');          // everything served over HTTP
const SCENES   = path.join(PUBLIC, 'scenes');             // one .html per visual
const DEFAULT_VISUAL = 'corridor';
const TOOLS    = new Set(['webgl-check']);                // pages of public/ that can be shown on the screen like a visual

const LOCAL_ID       = 'local';
const SESSION_TTL_MS = 12 * 3600 * 1000;    // without any screen or source
const MAX_SESSIONS   = 200;
const CREATE_PER_MIN = 10;                  // per client IP
const SOURCE_MAX_MSG_PER_S = 100;           // a source sends ≈47/s
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';   // 32 symbols, no i/l/o/u
const ID_LENGTH   = 4;                      // 32^4 ≈ 1M ids, easy to type on a TV
const ID_RE       = /^[0-9a-z]{4}$/;
const TOKEN_LENGTH = 22;                    // base64url chars ≈ 130 bits

let CAPTURE = true;
let TARGET  = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
// Auto-gain : a band's reference level follows its recent peak, but can never
// drop below MIN_REF_DB. Everything below (reference − RANGE_DB) maps to 0.
// With the defaults, anything under −55 dBFS is silence, whatever happens.
// RANGE_DB 20 measured on a real Mixxx mix (2026-11-05): low drops to 0 between
// kicks and reaches ≈0.8 on them; 30 kept every band near 0.85 all the time.
let MIN_REF_DB = -35;
let RANGE_DB   = 20;
// Kick detection : the low band must rise by RISE_DB within 3 hops (64 ms).
// Measured on a real mix at 156 BPM (2026-11-05): 32 kicks for 31 beats, 27 of them exactly a beat
// apart, unchanged from 6 to 12 dB.
let RISE_DB = 8;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === '--no-capture') CAPTURE = false;
  else if (a === '--target'  && v) { TARGET = v; i++; }
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

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set: control links change at every restart');
} else if (SECRET.length < 16) {
  console.warn('SESSION_SECRET is short (< 16 chars): use `openssl rand -hex 32`');
}

// ── Visuals : list, validation ─────────────────────────────────────────────
function listVisuals() {
  return fs.readdirSync(SCENES)
    .filter(f => f.endsWith('.html') && !f.startsWith('.'))
    .map(f => f.slice(0, -5))
    .sort();
}

function listTools() {
  return [...TOOLS].filter(n => fs.existsSync(path.join(PUBLIC, `${n}.html`))).sort();
}

// URL of the page the screen iframe loads for a visual or a tool.
function visualPath(name) {
  return TOOLS.has(name) ? `/${name}.html` : `/scenes/${name}.html`;
}

// Returns an error message, or null when `name` can be shown on a screen.
function checkVisual(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return `'${name}' cannot be shown on the screen`;
  if (!fs.existsSync(path.join(PUBLIC, visualPath(name)))) return `unknown visual '${name}' (available: ${listVisuals().join(', ')})`;
  return null;
}

function defaultVisual() {
  const all = listVisuals();
  return all.includes(DEFAULT_VISUAL) ? DEFAULT_VISUAL : (all[0] || null);
}

// ── Sessions, ids and signed tokens ────────────────────────────────────────
const sessions = new Map();   // id → { id, active, source, screens, emptySince, createdAt, msgTimes }

function newId() {
  for (;;) {
    const bytes = crypto.randomBytes(ID_LENGTH);
    let id = '';
    for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[bytes[i] % 32];   // 256 % 32 = 0 → uniform
    if (id !== LOCAL_ID && !sessions.has(id)) return id;
  }
}

function token(id, role) {
  return crypto.createHmac('sha256', SECRET).update(`${id}:${role}`).digest('base64url').slice(0, TOKEN_LENGTH);
}

function checkToken(id, role, given) {
  if (typeof given !== 'string' || given.length !== TOKEN_LENGTH) return false;
  return crypto.timingSafeEqual(Buffer.from(token(id, role)), Buffer.from(given));
}

function createSession(id) {
  const s = { id, active: defaultVisual(), source: null, screens: new Set(), emptySince: Date.now(), createdAt: Date.now(), msgTimes: [] };
  sessions.set(id, s);
  return s;
}

function touch(s) {
  s.emptySince = (s.screens.size === 0 && !s.source) ? (s.emptySince || Date.now()) : null;
}

function sessionInfo(s) {
  return { visuals: listVisuals(), tools: listTools(), active: s.active, activePath: s.active && visualPath(s.active), source: s.source !== null };
}

function broadcast(s, obj) {
  if (s.screens.size === 0) return;
  const msg = JSON.stringify(obj);
  for (const ws of s.screens) if (ws.readyState === 1) ws.send(msg);
}

function setActive(s, name) {
  const err = checkVisual(name);
  if (err) return err;
  s.active = name;
  broadcast(s, { t: 'active', visual: name, path: visualPath(name) });
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.id !== LOCAL_ID && s.emptySince && now - s.emptySince > SESSION_TTL_MS) {
      sessions.delete(s.id);
      console.log(`session ${s.id} expired`);
    }
  }
}, 60 * 1000).unref();

// ── HTTP ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}

function sendJson(res, code, obj) { send(res, code, JSON.stringify(obj), 'application/json'); }

function sendPage(res, name) {
  fs.readFile(path.join(PUBLIC, name), (e, data) => {
    if (e) return send(res, 404, 'not found');
    send(res, 200, data, MIME['.html']);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];   // set by Coolify's proxy; first hop is the client
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || '?';
}

// Absolute origin as seen by the client (behind the proxy or on the LAN).
function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`;
}

const creations = new Map();   // ip → timestamps of the last minute
function allowCreate(ip) {
  const now = Date.now();
  const times = (creations.get(ip) || []).filter(t => now - t < 60 * 1000);
  if (times.length >= CREATE_PER_MIN) { creations.set(ip, times); return false; }
  times.push(now);
  creations.set(ip, times);
  return true;
}

function readBody(req, limit, cb) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size <= limit) chunks.push(c); });
  req.on('end', () => cb(size > limit ? null : Buffer.concat(chunks)));
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  let m;

  if (p === '/healthz' && req.method === 'GET') return sendJson(res, 200, { ok: true, sessions: sessions.size });

  if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    return sendPage(res, sessions.has(LOCAL_ID) ? 'index.html' : 'start.html');
  }

  if (p === '/sessions' && req.method === 'POST') {
    if (!allowCreate(clientIp(req))) return send(res, 429, 'too many sessions created, retry in a minute');
    if (sessions.size >= MAX_SESSIONS) return send(res, 429, 'too many live sessions');
    const s = createSession(newId());
    const base = origin(req);
    console.log(`session ${s.id} created by ${clientIp(req)}`);
    return sendJson(res, 200, {
      id: s.id,
      screenUrl: `${base}/s/${s.id}`,
      controlUrl: `${base}/c/${s.id}/${token(s.id, 'control')}`,
      controlQrUrl: `${base}/qr/${s.id}/${token(s.id, 'source')}.svg`,
      sourceToken: token(s.id, 'source'),
    });
  }

  if ((m = p.match(/^\/qr\/([^/]+)\/([^/.]+)\.svg$/)) && req.method === 'GET') {
    // QR code of the control link, for the phone of whoever started the session (source token).
    const s = sessions.get(m[1]);
    if (!s) return send(res, 404, 'unknown session');
    if (!checkToken(s.id, 'source', m[2])) return send(res, 403, 'source token required');
    const qr = qrcode(0, 'M');
    qr.addData(`${origin(req)}/c/${s.id}/${token(s.id, 'control')}`);
    qr.make();
    return send(res, 200, qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), 'image/svg+xml');
  }

  if ((m = p.match(/^\/s\/([^/]+)$/)) && req.method === 'GET') {
    return sessions.has(m[1]) ? sendPage(res, 'index.html') : send(res, 404, 'unknown session');
  }

  if ((m = p.match(/^\/c\/([^/]+)\/([^/]+)$/)) && req.method === 'GET') {
    if (!sessions.has(m[1])) return send(res, 404, 'unknown session');
    return checkToken(m[1], 'control', m[2]) ? sendPage(res, 'control.html') : send(res, 403, 'invalid control link');
  }

  if (p === '/control.html' && req.method === 'GET') {
    // The phone's bookmark from the file-based era: send it to the local session's signed page.
    if (!sessions.has(LOCAL_ID)) return send(res, 404, 'no local session (server started with --no-capture)');
    return send(res, 302, '', null, { Location: `/c/${LOCAL_ID}/${token(LOCAL_ID, 'control')}` });
  }

  if (p === '/visuals' && req.method === 'GET') {
    const s = sessions.get(url.searchParams.get('s') || LOCAL_ID);
    return s ? sendJson(res, 200, sessionInfo(s)) : send(res, 404, 'unknown session');
  }

  if ((m = p.match(/^\/sessions\/([^/]+)\/active\/([^/]+)$/)) && req.method === 'POST') {
    const s = sessions.get(m[1]);
    if (!s) return send(res, 404, 'unknown session');
    if (!checkToken(s.id, 'control', bearer(req))) return send(res, 403, 'control token required');
    const err = setActive(s, decodeURIComponent(m[2]));
    return err ? send(res, 400, err) : sendJson(res, 200, { active: s.active });
  }

  if ((m = p.match(/^\/active\/([^/]+)$/)) && req.method === 'POST') {
    // LAN shortcut for `switch` / `make visual`: the local session only, trusted like before.
    const s = sessions.get(LOCAL_ID);
    if (!s) return send(res, 404, 'no local session (server started with --no-capture)');
    const err = setActive(s, decodeURIComponent(m[1]));
    return err ? send(res, 400, err) : sendJson(res, 200, { active: s.active });
  }

  if (p === '/report' && req.method === 'POST') {
    // Capability report posted by webgl-check.html from the TV (the agent cannot see the screen).
    return readBody(req, 4096, body => {
      if (!body) return send(res, 413, 'report too large');
      let report;
      try { report = JSON.parse(body.toString('utf8')); } catch (e) { return send(res, 400, 'invalid JSON'); }
      const line = JSON.stringify(Object.assign({ at: new Date().toISOString(), from: clientIp(req) }, report));
      console.log('\n[report] ' + line);
      if (CAPTURE) fs.appendFileSync(path.join(__dirname, 'reports.jsonl'), line + '\n');   // the container has no writable folder
      send(res, 200, 'ok');
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  // Static: .html/.js files of public/ and public/scenes/ only (no dotfiles, no traversal).
  const name = decodeURIComponent(p.slice(1));
  const ext = path.extname(name);
  if (!/^(scenes\/)?[A-Za-z0-9_-]+\.(html|js)$/.test(name) || !MIME[ext]) return send(res, 404, 'not found');
  fs.readFile(path.join(PUBLIC, name), (e, data) => {
    if (e) return send(res, 404, 'not found');
    send(res, 200, data, MIME[ext]);
  });
});
server.on('error', e => { console.error('http server:', e.message); process.exit(1); });

// ── WebSocket, on the same port ────────────────────────────────────────────
// A source frame is ≈300 bytes: cap incoming frames (default is 100 MiB).
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
wss.on('error', e => { console.error('websocket server:', e.message); process.exit(1); });

function reject(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
  const s = sessions.get(url.searchParams.get('s') || LOCAL_ID);
  const role = url.searchParams.get('r') || 'screen';
  if (!s) return reject(socket, 404, 'Not Found');
  if (role !== 'screen' && role !== 'source') return reject(socket, 400, 'Bad Request');
  if (role === 'source' && !checkToken(s.id, 'source', url.searchParams.get('t'))) return reject(socket, 403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, ws => attach(ws, s, role));
});

function attach(ws, s, role) {
  // Without this listener a single malformed frame from any device throws and kills the process.
  ws.on('error', e => console.error('[ws client]', e.message));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'screen') {
    s.screens.add(ws);
    touch(s);
    ws.on('message', () => ws.close(4400, 'screens do not send'));
    ws.on('close', () => { s.screens.delete(ws); touch(s); });
  } else {
    if (s.source) s.source.close(4000, 'replaced by a new source');
    s.source = ws;
    s.msgTimes = [];
    touch(s);
    broadcast(s, { t: 'source', on: true });
    console.log(`session ${s.id}: source connected`);
    ws.on('message', data => onSourceMessage(s, ws, data));
    ws.on('close', () => {
      if (s.source !== ws) return;   // already replaced
      s.source = null;
      touch(s);
      broadcast(s, { t: 'source', on: false });
      console.log(`session ${s.id}: source left`);
    });
  }
  ws.send(JSON.stringify(Object.assign({ t: 'hello', id: s.id }, sessionInfo(s))));
}

const unit = v => (typeof v === 'number' && Number.isFinite(v)) ? Math.min(1, Math.max(0, v)) : 0;

function onSourceMessage(s, ws, data) {
  const now = Date.now();
  s.msgTimes.push(now);
  if (s.msgTimes.length > SOURCE_MAX_MSG_PER_S) {
    if (now - s.msgTimes[0] < 1000) return ws.close(4429, 'too many messages');
    s.msgTimes.shift();
  }
  let msg;
  try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return ws.close(4400, 'invalid JSON'); }
  if (!msg || typeof msg !== 'object') return ws.close(4400, 'invalid message');
  broadcast(s, {
    t: 'audio',
    level: unit(msg.level), low: unit(msg.low), mid: unit(msg.mid), high: unit(msg.high),
    onset: unit(msg.onset), tone: unit(msg.tone),
    dbg: (msg.dbg && typeof msg.dbg === 'object' && !Array.isArray(msg.dbg)) ? msg.dbg : undefined,
  });
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }   // dead TCP behind the proxy
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000).unref();

// ── Local capture (PipeWire) feeds the `local` session ─────────────────────
function startLocalCapture(s) {
  // stream.capture.sink=true makes PipeWire link the sink monitor (speakers), not the microphone.
  const proc = spawn('pw-record', [
    '--rate', String(RATE), '--channels', String(CHANNELS), '--format', 's16', '--raw',
    '--target', TARGET,
    '-P', '{ stream.capture.sink=true }',
    '-',
  ]);
  proc.on('error', e => { console.error('pw-record:', e.message); process.exit(1); });
  proc.stderr.on('data', d => process.stderr.write('[pw-record] ' + d));
  proc.on('exit', code => { console.error('\npw-record exited with code', code); process.exit(1); });

  let hops = 0;
  const analyser = Analysis.create({ rate: RATE, minRefDb: MIN_REF_DB, rangeDb: RANGE_DB, riseDb: RISE_DB }, f => {
    broadcast(s, Object.assign({ t: 'audio' }, f));
    if (++hops % 12 === 0 || f.onset > 0) {
      process.stdout.write(
        `\rlevel=${f.level.toFixed(2)} low=${f.low.toFixed(2)} mid=${f.mid.toFixed(2)} high=${f.high.toFixed(2)} ` +
        `tone=${f.tone.toFixed(2)} onset=${f.onset ? f.onset.toFixed(2) : '  - '} ` +
        `| dB full=${f.dbg.db.full.toFixed(0)} low=${f.dbg.db.low.toFixed(0)} | screens=${s.screens.size}   `
      );
    }
  });

  // pw-record gives s16 interleaved stereo; the analyser wants mono floats in [-1, 1].
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
}

if (CAPTURE) startLocalCapture(createSession(LOCAL_ID));

server.listen(PORT, () => {
  console.log(`visuals on http://0.0.0.0:${PORT}/`);
  if (CAPTURE) {
    console.log(`local session: TV / , phone /control.html , calibration /debug.html | active: ${sessions.get(LOCAL_ID).active || 'none'}`);
    console.log(`capture: monitor of ${TARGET} | silence below ${MIN_REF_DB - RANGE_DB} dBFS (min-ref ${MIN_REF_DB}, range ${RANGE_DB}, kick rise ${RISE_DB} dB)`);
  } else {
    console.log('no capture: remote sessions only (start.html)');
  }
});
