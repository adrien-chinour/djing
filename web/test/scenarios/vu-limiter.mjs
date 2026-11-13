// Scenario of the VU meters and the MAIN limiter (#48): on-screen meters for deck A, deck B
// (pre-fader) and MAIN left/right, the controller's VU LEDs and their rate, the -1 dBFS limiter on
// MAIN measured on channels 1-2 of the card, and the limiter light.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, RATE, SINK, sleep, tmp } from '../lib.mjs';

/** 30 s stereo 16-bit WAV at RATE, 220 Hz sine at full scale. */
function writeFullScaleTone(path) {
  const frames = RATE * 30;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(32767 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  writeFileSync(path, buf);
}

/** Records `ms` of the sink monitor, returns the peak per channel (4 values, 0..1). */
async function recordPeak(ms) {
  const file = join(tmp, `peak-${Date.now()}.raw`);
  const rec = spawn('pw-record', ['--target', SINK, '-P', 'stream.capture.sink=true', '--rate', String(RATE), '--channels', '4', '--format', 's16', '--raw', file], { stdio: 'ignore' });
  await sleep(ms);
  rec.kill('SIGINT');
  await new Promise((r) => rec.on('exit', r));
  const data = readFileSync(file);
  const peaks = [0, 0, 0, 0];
  const frames = Math.floor(data.length / 8);
  for (let f = Math.floor(frames / 4); f < frames; f++) {
    for (let c = 0; c < 4; c++) peaks[c] = Math.max(peaks[c], Math.abs(data.readInt16LE(f * 8 + c * 2) / 32768));
  }
  return peaks;
}

const dbfs = (v) => `${(20 * Math.log10(v)).toFixed(2)} dBFS`;

export default async function ({ page, sim }) {
  const wav = join(tmp, 'full-scale.wav');
  writeFullScaleTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const level = async (sel) => Number(await page.eval(`${q(sel)}.dataset.level`));
  const levels = async () => Promise.all(['[data-meter=vu][data-deck="0"]', '[data-meter=vu][data-deck="1"]', '[data-meter="vu.mainLeft"]', '[data-meter="vu.mainRight"]'].map(level));
  const limitOn = () => page.eval(`${q('#limit')}.classList.contains('on')`);
  const show = (v) => v.map((x) => x.toFixed(2)).join(' ');

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const doc = await page.send('DOM.getDocument');
  for (const d of [0, 1]) {
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `.deck[data-deck="${d}"] input[type=file]` });
    await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  }
  await sleep(1500);

  await sim.send('press A play', 600);
  let v = await levels();
  check('VU deck A actif, deck B à zéro quand seul A joue', v[0] > 0.5 && v[1] === 0, show(v));
  check('VU master gauche et droite actifs', v[2] > 0.5 && v[3] > 0.5, show(v));
  check('LED VU deck A (0xB1 0x40) allumée', sim.lastLed(0xb1, 0x40) > 60, String(sim.lastLed(0xb1, 0x40)));
  check('LED VU deck B (0xB2 0x40) à 0', sim.lastLed(0xb2, 0x40) === 0, String(sim.lastLed(0xb2, 0x40)));
  check('LED VU master (0xB0 0x40 et 0x41) allumées', sim.lastLed(0xb0, 0x40) > 60 && sim.lastLed(0xb0, 0x41) > 60, `${sim.lastLed(0xb0, 0x40)} ${sim.lastLed(0xb0, 0x41)}`);
  check('LED VU dans 0..125', sim.leds.filter((m) => m[1] === 0x40 || m[1] === 0x41).every((m) => m[2] <= 125));

  await sim.send('knob A volume 0', 600);
  v = await levels();
  check('VU deck A pré-fader : actif fader à 0', v[0] > 0.5, show(v));
  check('VU master à zéro fader à 0', v[2] === 0 && v[3] === 0, show(v));
  await sim.send('knob A volume 1');

  // Gain knob swept faster than the ticks: the level changes at every tick, one message per tick at most.
  const vuMessages = () => sim.leds.filter((m) => [0xb0, 0xb1, 0xb2].includes(m[0]) && (m[1] === 0x40 || m[1] === 0x41));
  const before = vuMessages().length;
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 2000; i++) await sim.send(`knob A gain ${0.1 + (i % 90) / 100}`, 10);
  await sleep(100);
  const elapsed = (Date.now() - t0) / 1000;
  const counts = {};
  for (const m of vuMessages().slice(before)) counts[m.slice(0, 2).join(' ')] = (counts[m.slice(0, 2).join(' ')] || 0) + 1;
  const maxRate = Math.max(...Object.values(counts)) / elapsed;
  check('LED VU : au plus 30 messages par seconde par LED', maxRate <= 30, `${maxRate.toFixed(1)}/s ${JSON.stringify(counts)}`);
  check('LED VU deck A suit le niveau (messages reçus)', (counts['177 64'] || 0) > 10, JSON.stringify(counts));

  await sim.send('knob A gain 1');
  await sim.send('knob B gain 1');
  await sim.send('press B play', 600);
  const peaks = await recordPeak(1500);
  check('limiteur : deux decks gain max sur un sinus pleine échelle ≤ −0,9 dBFS sur les canaux 1-2', Math.max(peaks[0], peaks[1]) <= 10 ** (-0.9 / 20), `${dbfs(peaks[0])} ${dbfs(peaks[1])}`);
  check('limiteur : le MAIN joue toujours (> −2 dBFS)', Math.min(peaks[0], peaks[1]) > 10 ** (-2 / 20), `${dbfs(peaks[0])} ${dbfs(peaks[1])}`);
  check('voyant de saturation allumé', await limitOn(), await page.eval(`${q('#limit')}.title`));

  await sim.send('press B play');
  await sim.send('knob A gain 0.5', 800);
  check('voyant de saturation éteint à niveau modéré (−3 dBFS)', !(await limitOn()), await page.eval(`${q('#limit')}.title`));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
