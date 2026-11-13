// End-to-end test of web/ without the hardware: a simulated controller (web/sim/controller.py)
// on a virtual ALSA MIDI port, a temporary 4-channel PipeWire sink standing in for the controller's
// sound card, split into "Inpulse MAIN" and "Inpulse Casque" by scripts/split-outputs.sh as on the
// real setup, headless Chrome driven over the DevTools protocol, and pw-record to check which
// channels of the card actually carry sound. Everything it creates is removed on exit.
//
// Usage: node web/test/e2e.mjs   (make web-test)

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..');
const SINK = `inpulse-sim-${process.pid}`;
const RATE = 48000;
const tmp = mkdtempSync(join(tmpdir(), 'djing-web-test-'));
const cleanups = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// --- Fixtures ----------------------------------------------------------------

/** 10 s stereo 16-bit WAV, 220 Hz sine at -12 dBFS. */
function writeTone(path) {
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
async function startServer() {
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

function createSink() {
  execFileSync('pw-cli', ['create-node', 'adapter', `{ factory.name=support.null-audio-sink node.name=${SINK} node.description="DJControl Inpulse 300 Mk2 (simulation)" media.class=Audio/Sink audio.channels=4 audio.rate=${RATE} audio.position=[FL FR RL RR] object.linger=true }`], { stdio: 'ignore' });
  const node = JSON.parse(execFileSync('pw-dump', { maxBuffer: 1 << 26 })).find((o) => o.info?.props?.['node.name'] === SINK);
  if (!node) throw new Error('sink not created');
  cleanups.push(() => execFileSync('pw-cli', ['destroy', String(node.id)], { stdio: 'ignore' }));
}

/** Runs scripts/split-outputs.sh on the simulated sink, as `make web` does on the real card. */
async function splitOutputs() {
  const proc = spawn(join(REPO, 'scripts/split-outputs.sh'), [SINK], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => proc.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    createInterface({ input: proc.stdout }).on('line', (l) => l.startsWith('ready') && resolve());
    proc.on('exit', (code) => reject(new Error(`split-outputs.sh exited (${code})`)));
  });
}

/** Records `ms` of the sink monitor, returns RMS per channel (4 values, 0..1). */
async function recordRms(ms) {
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

async function startSim() {
  const proc = spawn('uv', ['run', '--quiet', 'python', '-I', 'web/sim/controller.py'], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
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
  };
}

// --- Chrome ------------------------------------------------------------------

async function startChrome(url) {
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
  await page.send('Page.reload');
  await sleep(1000);
  page.eval = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return page;
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const pending = new Map();
  let id = 0;
  const conn = {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
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

// --- Scenario ----------------------------------------------------------------

async function main() {
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  createSink();
  await splitOutputs();
  const sim = await startSim();
  const url = await startServer();
  const page = await startChrome(url);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deckA = (sel) => q(`.deck[data-deck="0"] ${sel}`);

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  check('le simulateur est vu comme la platine', (await page.eval(`${q('#midi')}.textContent`)).includes('connectée'));
  const out = await page.eval(`${q('#out')}.textContent`);
  check('mode deux sorties stéréo', out.startsWith('split'), out);
  check('MAIN sur « Inpulse MAIN »', /Inpulse MAIN/.test(await page.eval(`${q('#mainDevice')}.selectedOptions[0].text`)));
  check('casque sur « Inpulse Casque »', /Inpulse Casque/.test(await page.eval(`${q('#cueDevice')}.selectedOptions[0].text`)));

  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  check('titre chargé sur le deck A', (await page.eval(`${deckA('.name')}.textContent`)) === 'tone.wav');
  check('LED CUE allumée quand un titre est chargé', sim.lastLed(0x91, 0x06) === 0x7f);

  await sim.send('xfader 0');
  await sim.send('press A play', 500);
  check('PLAY de la platine lance le deck A', await page.eval(`${deckA('[data-act=play]')}.classList.contains('on')`));
  check('LED PLAY allumée', sim.lastLed(0x91, 0x07) === 0x7f);
  let rms = await recordRms(1200);
  check('MAIN (canaux 1-2) reçoit le deck A', rms[0] > 0.05 && rms[1] > 0.05, rms.map((v) => v.toFixed(3)).join(' '));
  check('casque (canaux 3-4) muet sans PFL', rms[2] < 0.005 && rms[3] < 0.005);

  await sim.send('press A pfl');
  check('LED PFL allumée', sim.lastLed(0x91, 0x0c) === 0x7f);
  rms = await recordRms(1200);
  check('casque (canaux 3-4) reçoit le deck A avec PFL', rms[2] > 0.05 && rms[3] > 0.05, rms.map((v) => v.toFixed(3)).join(' '));

  await sim.send('knob A volume 0');
  rms = await recordRms(1200);
  check('fader à 0 : MAIN muet', rms[0] < 0.005, rms.map((v) => v.toFixed(3)).join(' '));
  check('fader à 0 : casque toujours actif (pré-fader)', rms[2] > 0.05);
  check('le fader de la platine bouge celui de l\'écran', (await page.eval(`${deckA('[data-knob=volume]')}.value`)) === '0');

  await sim.send('knob A volume 1');
  await sim.send('xfader 1');
  rms = await recordRms(1200);
  check('crossfader à droite : deck A coupé du MAIN', rms[0] < 0.005, rms.map((v) => v.toFixed(3)).join(' '));

  await sim.send('rate A 1');
  const rateText = await page.eval(`${deckA('.rate')}.textContent`);
  check('pitch fader en butée : ±8 %', /8\.00 %/.test(rateText), rateText);
  await sim.send('rate A 0');

  await sim.send('press A play', 300);
  check('PLAY arrête le deck A', !(await page.eval(`${deckA('[data-act=play]')}.classList.contains('on')`)));
  check('LED PLAY éteinte', sim.lastLed(0x91, 0x07) === 0x00);
  const before = await page.eval(`${deckA('.time')}.textContent`);
  await sim.send('jog A 50 touched', 300);
  const after = await page.eval(`${deckA('.time')}.textContent`);
  check('jog touché à l\'arrêt : avance d\'une seconde', before !== after, `${before} -> ${after}`);

  if (process.env.DEBUG) console.log(await page.eval(`${q('#log')}.textContent`), await page.eval(`navigator.requestMIDIAccess().then(a => [...a.inputs.values(), ...a.outputs.values()].map(p => p.type + ':' + p.name))`));
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

let exitCode = 0;
try {
  await main();
  console.log(failures ? `\n${failures} échec(s)` : '\ntout est vert');
  exitCode = failures ? 1 : 0;
} catch (err) {
  console.error(`erreur : ${err.stack || err}`);
  exitCode = 2;
} finally {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
