// Tools shared by the end-to-end scenarios of web/ (see e2e.mjs): a simulated controller
// (web/sim/controller.py) on a virtual ALSA MIDI port, a temporary 4-channel PipeWire sink standing
// in for the controller's sound card, split into "Inpulse MAIN" and "Inpulse Casque" by
// scripts/split-outputs.sh as on the real setup, headless Chrome driven over the DevTools protocol,
// and pw-record to check which channels of the card actually carry sound. Everything created here
// registers a cleanup, run by cleanup() on exit.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = join(WEB, '..');
export const SINK = `inpulse-sim-${process.pid}`;
export const RATE = 48000;
export const tmp = mkdtempSync(join(tmpdir(), 'djing-web-test-'));
const cleanups = [];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
/** Prints one check line; counts failures (see failureCount). */
export function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
export const failureCount = () => failures;

/** Runs every registered cleanup (latest first) and removes the temporary directory. */
export function cleanup() {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
  cleanups.length = 0;
  rmSync(tmp, { recursive: true, force: true });
}

// --- Fixtures ----------------------------------------------------------------

/** 10 s stereo 16-bit WAV, 220 Hz sine at -12 dBFS. */
export function writeTone(path) {
  const frames = 44100 * 10;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(44100 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 44100));
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  writeFileSync(path, buf);
}

// --- Static server -----------------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
/** Serves web/ on a free localhost port, returns its URL. */
export async function startServer() {
  const server = createServer((req, res) => {
    const path = join(WEB, new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
    if (!path.startsWith(WEB) || !existsSync(path)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(readFileSync(path));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return `http://localhost:${server.address().port}/`;
}

// --- PipeWire sink -----------------------------------------------------------

/** Creates the 4-channel sink that stands in for the controller's sound card. */
export function createSink() {
  execFileSync('pw-cli', ['create-node', 'adapter', `{ factory.name=support.null-audio-sink node.name=${SINK} node.description="DJControl Inpulse 300 Mk2 (simulation)" media.class=Audio/Sink audio.channels=4 audio.rate=${RATE} audio.position=[FL FR RL RR] object.linger=true }`], { stdio: 'ignore' });
  const node = JSON.parse(execFileSync('pw-dump', { maxBuffer: 1 << 26 })).find((o) => o.info?.props?.['node.name'] === SINK);
  if (!node) throw new Error('sink not created');
  cleanups.push(() => execFileSync('pw-cli', ['destroy', String(node.id)], { stdio: 'ignore' }));
}

/** Runs scripts/split-outputs.sh on the simulated sink, as `make web` does on the real card. */
export async function splitOutputs() {
  const proc = spawn(join(REPO, 'scripts/split-outputs.sh'), [SINK], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => proc.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    createInterface({ input: proc.stdout }).on('line', (l) => l.startsWith('ready') && resolve());
    proc.on('exit', (code) => reject(new Error(`split-outputs.sh exited (${code})`)));
  });
}

/** Records `ms` of the sink monitor, returns RMS per channel (4 values, 0..1). */
export async function recordRms(ms) {
  const file = join(tmp, `rec-${Date.now()}.raw`);
  const rec = spawn('pw-record', ['--target', SINK, '-P', 'stream.capture.sink=true', '--rate', String(RATE), '--channels', '4', '--format', 's16', '--raw', file], { stdio: 'ignore' });
  await sleep(ms);
  rec.kill('SIGINT');
  await new Promise((r) => rec.on('exit', r));
  const data = readFileSync(file);
  const sums = [0, 0, 0, 0];
  const frames = Math.floor(data.length / 8);
  const skip = Math.floor(frames / 4); // ignore the start of the capture
  for (let f = skip; f < frames; f++) for (let c = 0; c < 4; c++) sums[c] += (data.readInt16LE(f * 8 + c * 2) / 32768) ** 2;
  return sums.map((s) => Math.sqrt(s / Math.max(1, frames - skip)));
}

// --- Simulated controller ----------------------------------------------------

/**
 * Starts web/sim/controller.py. Returns { leds, send(line, settle), lastLed(status, number), stop() };
 * stop() resolves once the process, and so its virtual MIDI port, is gone.
 */
export async function startSim() {
  const proc = spawn('uv', ['run', '--quiet', 'python', '-I', 'web/sim/controller.py'], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((r) => proc.on('exit', r));
  cleanups.push(() => proc.kill());
  const leds = [];
  let ready;
  const readyP = new Promise((r) => (ready = r));
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.ready) ready();
    if (msg.led) leds.push(msg.led);
    if (msg.error) console.log(`sim: ${msg.error}`);
  });
  await Promise.race([readyP, sleep(30000).then(() => { throw new Error('simulator did not start'); })]);
  return {
    leds,
    async send(line, settle = 150) { proc.stdin.write(`${line}\n`); await sleep(settle); },
    lastLed: (status, number) => [...leds].reverse().find((m) => m[0] === status && m[1] === number)?.[2],
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
    },
  };
}

// --- CPU load ----------------------------------------------------------------

/**
 * Busy-loops `threads` worker threads (default: twice the cores, a load of about 2 per core) in a
 * child node process, until stop() or the end of the run. The child also exits when the test
 * process dies (its stdin closes) and after 10 minutes at most.
 */
export function cpuLoad(threads = availableParallelism() * 2) {
  const code = `const { Worker } = require('node:worker_threads');
for (let i = 0; i < ${threads}; i++) new Worker('for (;;) {}', { eval: true });
process.stdin.on('close', () => process.exit()).resume();
setTimeout(() => process.exit(), 600000);`;
  const proc = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'ignore', 'inherit'] });
  const stop = () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); };
  cleanups.push(stop);
  return { stop };
}

// --- Chrome ------------------------------------------------------------------

/**
 * Starts headless Chrome on `url` with the midi, midiSysex and audioCapture permissions granted.
 * Returns the page: send(method, params), eval(expression), errors (uncaught exceptions since the
 * last reload) and reload().
 */
export async function startChrome(url) {
  const profile = join(tmp, 'chrome');
  const proc = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--no-first-run', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  cleanups.push(() => proc.kill());
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    if (existsSync(join(profile, 'DevToolsActivePort'))) port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  }
  if (!port) throw new Error('Chrome did not start');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await cdp(version.webSocketDebuggerUrl);
  await browser.send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['midi', 'midiSysex', 'audioCapture'] });
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json();
  const page = await cdp(target.webSocketDebuggerUrl);
  page.errors = [];
  page.on = (d) => {
    if (d.method === 'Runtime.exceptionThrown') page.errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  await page.send('Runtime.enable');
  page.reload = async () => {
    page.errors.length = 0;
    await page.send('Page.reload');
    await sleep(1000);
  };
  page.eval = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return page;
}

/** Longest wait for a DevTools answer: a page that never answers fails its scenario instead of hanging the run. */
const CDP_TIMEOUT_MS = 180000;

/** Minimal DevTools protocol client over the WebSocket at `wsUrl`. */
export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const pending = new Map();
  let id = 0;
  const conn = {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`${method}: no answer after ${CDP_TIMEOUT_MS / 1000} s`));
      }, CDP_TIMEOUT_MS);
      pending.set(n, (d) => {
        clearTimeout(timer);
        pending.delete(n);
        if (d.error) reject(new Error(`${method}: ${d.error.message}`));
        else resolve(d.result);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
  };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) pending.get(d.id)?.(d);
    else conn.on?.(d);
  };
  cleanups.push(() => ws.close());
  return conn;
}
