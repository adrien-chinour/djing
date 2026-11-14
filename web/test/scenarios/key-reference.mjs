// Scenario of the key analysis on music-like tracks (#86): a reference set of 10 tracks generated
// here, each in a known key (kick on every beat, clap, hi-hats, sub-bass, bass, pad and arpeggio over
// a chord progression, drums louder than the harmony as on a real mix), and white noise, opened as
// the library. Checks that at least 7 of the 10 keys found are right or one Camelot step away
// (relative key or neighbour, as the library's compatibility) and that the noise stays "?".

import { keyCompatible } from '../../library/compat.js';
import { check, sleep } from '../lib.mjs';
import { wav } from './key.mjs';

const SR = 22050;
const BPM = 128;
const BARS = 16; // 30 s
const DIR = 'key-reference';
const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
// tonic: MIDI note of the bass tonic; degrees: chord of each bar, 0-based scale degree of its root.
const REFERENCE = [
  { name: 'A minor', key: '8A', tonic: 45, minor: true, degrees: [0, 5, 2, 6] },
  { name: 'C major', key: '8B', tonic: 48, minor: false, degrees: [0, 4, 5, 3] },
  { name: 'F sharp minor', key: '11A', tonic: 54, minor: true, degrees: [0, 3, 4, 0] },
  { name: 'D minor', key: '7A', tonic: 50, minor: true, degrees: [0, 0, 5, 6] },
  { name: 'G major', key: '9B', tonic: 55, minor: false, degrees: [0, 3, 4, 0] },
  { name: 'E minor', key: '9A', tonic: 52, minor: true, degrees: [0, 5, 3, 4] },
  { name: 'B flat major', key: '6B', tonic: 46, minor: false, degrees: [0, 5, 3, 4] },
  { name: 'C sharp minor', key: '12A', tonic: 49, minor: true, degrees: [0, 0, 0, 0] },
  { name: 'E flat major', key: '5B', tonic: 51, minor: false, degrees: [0, 3, 0, 4] },
  { name: 'G minor', key: '6A', tonic: 55, minor: true, degrees: [0, 6, 5, 4] },
];
const NOISE = 'Noise - White.wav';
const fileName = (r) => `Reference - ${r.name}.wav`;

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** Adds `gain` × the `harmonics` first harmonics of `midi` to x[from, from + length), decaying by `decay`/s. */
function note(x, midi, from, length, { gain, harmonics, decay = 0, detune = 0 }) {
  for (let h = 1; h <= harmonics; h++) {
    const w = (2 * Math.PI * freq(midi) * h * (1 + detune)) / SR;
    for (let i = 0; i < length && from + i < x.length; i++) x[from + i] += (gain / h) * Math.exp((-i / SR) * decay) * Math.sin(w * i);
  }
}

/** One reference track: BARS bars at BPM. */
function track({ tonic, minor, degrees }, seed) {
  const rand = random(seed);
  const scale = minor ? MINOR : MAJOR;
  const pitch = (degree) => tonic + scale[degree % 7] + 12 * Math.floor(degree / 7);
  const beat = (60 / BPM) * SR;
  const bar = 4 * beat;
  const x = new Float32Array(Math.round(bar * BARS));
  for (let b = 0; b < BARS * 4; b++) {
    const o = Math.round(b * beat);
    // Kick: pitch sweep from 160 to 45 Hz.
    let phase = 0;
    for (let i = 0; i < SR * 0.35 && o + i < x.length; i++) {
      const t = i / SR;
      phase += (2 * Math.PI * (45 + 115 * Math.exp(-t * 30))) / SR;
      x[o + i] += 0.9 * Math.exp(-t * 9) * Math.sin(phase);
    }
    // Clap on 2 and 4, hi-hat on the off-beats.
    if (b % 2) for (let i = 0; i < SR * 0.15 && o + i < x.length; i++) x[o + i] += 0.35 * Math.exp((-i / SR) * 25) * (rand() * 2 - 1);
    const hat = Math.round(o + beat / 2);
    let previous = 0;
    for (let i = 0; i < SR * 0.05 && hat + i < x.length; i++) {
      const n = rand() * 2 - 1;
      x[hat + i] += 0.25 * Math.exp((-i / SR) * 80) * (n - previous);
      previous = n;
    }
  }
  for (let m = 0; m < BARS; m++) {
    const degree = degrees[m % degrees.length];
    const chord = [degree, degree + 2, degree + 4].map(pitch);
    const o = Math.round(m * bar);
    for (const p of chord) note(x, p + 12, o, bar, { gain: 0.025, harmonics: 4, detune: 0.001 * (rand() - 0.5) }); // pad
    note(x, chord[0] - 24, o, bar, { gain: 0.3, harmonics: 1 }); // sub-bass
    for (let e = 1; e < 8; e += 2) note(x, chord[0] - 12, Math.round(o + (e * bar) / 8), bar / 8, { gain: 0.125, harmonics: 6, decay: 6 }); // bass
    for (let e = 0; e < 16; e++) { // arpeggio: chord notes and a few scale notes
      if (rand() < 0.4) continue;
      const p = rand() < 0.7 ? chord[Math.floor(rand() * 3)] : pitch(Math.floor(rand() * 7));
      note(x, p + 24, Math.round(o + (e * bar) / 16), bar / 16, { gain: 0.03, harmonics: 3, decay: 12 });
    }
  }
  return x;
}

export default async function ({ page }) {
  const rand = random(99);
  const files = {
    ...Object.fromEntries(REFERENCE.map((r, i) => [fileName(r), track(r, i + 1)])),
    [NOISE]: new Float32Array(SR * 20).map(() => 0.5 * (rand() * 2 - 1)),
  };
  await page.eval(`navigator.storage.getDirectory().then((root) => root.removeEntry(${JSON.stringify(DIR)}, { recursive: true })).catch(() => {})`);
  for (const [name, x] of Object.entries(files)) {
    await page.eval(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(${JSON.stringify(DIR)}, { create: true });
      const w = await (await dir.getFileHandle(${JSON.stringify(name)}, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(${JSON.stringify(wav(x).toString('base64'))}), (c) => c.charCodeAt(0)));
      await w.close();
    })()`);
  }
  await page.eval(`navigator.storage.getDirectory().then((root) => { window.showDirectoryPicker = () => root.getDirectoryHandle(${JSON.stringify(DIR)}); })`);
  await page.eval(`document.querySelector('#libraryPick').click()`);
  const total = Object.keys(files).length;
  const done = `analyse BPM : ${total} / ${total}`;
  const progress = () => page.eval(`document.querySelector('#analysisProgress').textContent`);
  for (let t = 0; t < 180000 && (await progress()) !== done; t += 200) await sleep(200);
  check(`analyse terminée (${total} / ${total})`, (await progress()) === done, await progress());

  const shown = await page.eval(`Object.fromEntries([...document.querySelectorAll('#library tbody tr')]
    .map((tr) => [tr.cells[2].textContent, tr.querySelector('.key').textContent]))`);
  const found = REFERENCE.map((r) => `${r.key}→${shown[fileName(r)]}`);
  const right = REFERENCE.filter((r) => shown[fileName(r)] === r.key).length;
  const close = REFERENCE.filter((r) => keyCompatible(shown[fileName(r)], r.key)).length;
  check(`jeu de référence : au moins 7 / 10 justes ou à une case Camelot (${close} / 10, dont ${right} justes)`, close >= 7, found.join(' '));
  check('bruit blanc : « ? »', shown[NOISE] === '?', shown[NOISE]);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
