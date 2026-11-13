// Scenario of the headphone mix (#49): the on-screen cue/master knob (0 = cue only, default;
// 1 = master only; constant-power curve) and the split cue switch (cue in mono on the left
// headphone channel, master in mono on the right), measured on channels 3-4 of the card against
// MAIN on channels 1-2.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, recordRms, sleep, tmp } from '../lib.mjs';

/** 60 s stereo 16-bit WAV, 220 Hz sine at -12 dBFS (writeTone() of lib.mjs lasts 10 s, too short here). */
function writeLongTone(path) {
  const frames = 44100 * 60;
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

const show = (rms) => rms.map((v) => v.toFixed(4)).join(' ');
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance * b;

export default async function ({ page, sim }) {
  const wav = join(tmp, 'tone-60s.wav');
  writeLongTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const setRange = (sel, v) => page.eval(`(() => { const e = ${q(sel)}; e.value = '${v}'; e.dispatchEvent(new Event('input')); })()`);
  const setSplit = (on) => page.eval(`(() => { const e = ${q('#splitCue')}; e.checked = ${on}; e.dispatchEvent(new Event('change')); })()`);
  const measure = async () => { await sleep(300); return recordRms(1500); };

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const doc = await page.send('DOM.getDocument');
  for (const d of [0, 1]) {
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `.deck[data-deck="${d}"] input[type=file]` });
    await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  }
  await sleep(1500);
  check('potentiomètre cue/master à 0 par défaut', (await page.eval(`${q('#cueMix')}.value`)) === '0');
  check('mode split du casque coupé par défaut', !(await page.eval(`${q('#splitCue')}.checked`)));

  await sim.send('xfader 0');
  await sim.send('press A play', 500);
  let rms = await measure();
  check('cue/master à 0, sans PFL : casque (canaux 3-4) muet', rms[0] > 0.05 && rms[2] < 0.005 && rms[3] < 0.005, show(rms));

  await setRange('#cueMix', 1);
  rms = await measure();
  check('cue/master à 1 : canal 3 = canal 1 à 1 % près', near(rms[2], rms[0], 0.01), show(rms));
  check('cue/master à 1 : canal 4 = canal 2 à 1 % près', near(rms[3], rms[1], 0.01), show(rms));

  await setRange('#cueMix', 0.5);
  rms = await measure();
  check('cue/master à 0,5 sans PFL : casque à cos(π/4) du MAIN (puissance constante)', near(rms[2], rms[0] * Math.SQRT1_2, 0.02), show(rms));

  // Cue = deck A alone (PFL, out of MAIN by the crossfader); master = deck B alone, quieter.
  await setRange('#cueMix', 0);
  await sim.send('press A pfl');
  await sim.send('knob B gain 0.2');
  await sim.send('xfader 1');
  await sim.send('press B play', 500);
  rms = await measure();
  const cueRef = rms[2];
  check('cue/master à 0 avec PFL A : casque = deck A, MAIN = deck B', cueRef > 0.05 && rms[0] > 0.01 && !near(rms[0], cueRef, 0.2), show(rms));

  await setSplit(true);
  rms = await measure();
  check('split : canal 3 = cue (deck A en PFL)', near(rms[2], cueRef, 0.01), `${show(rms)} cue ${cueRef.toFixed(4)}`);
  check('split : canal 4 = master à 1 % près du canal 1', near(rms[3], rms[0], 0.01), show(rms));
  await setRange('#cueMix', 1);
  rms = await measure();
  check('split : le potentiomètre cue/master n\'agit pas', near(rms[2], cueRef, 0.01) && near(rms[3], rms[0], 0.01), show(rms));

  await sim.send('press B play', 500);
  rms = await measure();
  check('split, deck B arrêté : canal 4 (master) muet, canal 3 (cue) actif', rms[3] < 0.005 && near(rms[2], cueRef, 0.01), show(rms));
  await sim.send('press A pfl');
  rms = await measure();
  check('split, PFL A coupé : canal 3 (cue) muet', rms[2] < 0.005, show(rms));

  await setSplit(false);
  await sim.send('press B play', 500);
  rms = await measure();
  check('split coupé, cue/master à 1 : casque = MAIN à 1 %', near(rms[2], rms[0], 0.01) && near(rms[3], rms[1], 0.01), show(rms));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
