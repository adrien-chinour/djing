// Scenario of the analysis of files loaded outside the library (#84): click tracks at 126 BPM on deck A
// and 120 BPM on deck B, picked with the file input of each deck (no library). Checks that each file is
// analysed in the background, the BPM shown going from "BPM —" to the analysed value without reloading,
// the grid and BPM given to the deck, and SYNC working on them.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, sleep, tmp } from '../lib.mjs';

const SR = 44100;
const SECONDS = 30;
const TRACKS = [{ bpm: 126, firstBeat: 0.61 }, { bpm: 120, firstBeat: 0.37 }];

/** 16-bit mono WAV of `samples` (Float32Array, −1..1). */
function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

/** Silence then a 1.5 kHz click (4 ms decay) on every beat from `firstBeat`. */
function clicks({ bpm, firstBeat }) {
  const x = new Float32Array(SR * SECONDS);
  for (let t = firstBeat; t < SECONDS; t += 60 / bpm) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.02 && start + i < x.length; i++) {
      x[start + i] = 0.8 * Math.exp(-i / (SR * 0.004)) * Math.sin((2 * Math.PI * 1500 * i) / SR);
    }
  }
  return x;
}

export default async function ({ page, sim }) {
  const deck = (d) => `window.djing.engine.decks[${d}]`;
  const text = (d, sel) => page.eval(`document.querySelector('.deck[data-deck="${d}"] ${sel}').textContent`);

  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  check('deck A vide : BPM —', (await text(0, '.bpm')) === 'BPM —', await text(0, '.bpm'));

  const doc = await page.send('DOM.getDocument');
  for (const d of [0, 1]) {
    const file = join(tmp, `analysis-clicks-${TRACKS[d].bpm}.wav`);
    writeFileSync(file, wav(clicks(TRACKS[d])));
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `.deck[data-deck="${d}"] input[type=file]` });
    await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
  }

  // The deck plays while the analysis runs: wait for the BPM of both decks (20 s at most).
  let analysed = false;
  for (let i = 0; i < 100 && !analysed; i++) {
    await sleep(200);
    analysed = await page.eval(`!!(${deck(0)}.bpm && ${deck(1)}.bpm)`);
  }
  check('fichiers hors bibliothèque analysés', analysed);

  const bpm = await page.eval(`${deck(0)}.bpm`);
  check('BPM analysé 126 ±0,1', Math.abs(bpm - 126) <= 0.1, `${bpm}`);
  const grid = await page.eval(`JSON.stringify(${deck(0)}.grid)`);
  check('grille donnée au deck', JSON.parse(grid)?.bpm === bpm, grid);
  const firstBeat = await page.eval(`${deck(0)}.firstBeat`);
  check('premier temps analysé', Math.abs(firstBeat - TRACKS[0].firstBeat) < 0.03, `${firstBeat}`);
  const key = await text(0, '.key');
  check('tonalité affichée', key !== '—' && key !== '…', key);
  const shown = await text(0, '.bpm');
  check('BPM affiché sans recharger', shown.startsWith('126.0'), shown);

  // SYNC on deck B (nothing playing: A is the master): B takes the tempo of A.
  await sim.send('note 92 05 7f', 50);
  await sim.send('note 92 05 00');
  await sleep(300);
  const state = await page.eval(`JSON.stringify({ follower: window.djing.engine.sync.follower, master: window.djing.engine.sync.master, rate: ${deck(1)}.rate, bpm: ${deck(1)}.bpm })`);
  const { follower, master, rate, bpm: bpmB } = JSON.parse(state);
  check('SYNC opérant : B suit A', follower === 1 && master === 0, state);
  check('SYNC opérant : tempo de B = 126', Math.abs(bpmB * rate - bpm) < 0.05, `${(bpmB * rate).toFixed(3)}`);
}
