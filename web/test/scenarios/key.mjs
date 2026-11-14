// Scenario of the key analysis (#34): chord progressions generated here (i-iv-V-i in A minor and
// F# minor, I-IV-V-I in C major) and white noise, in a directory of the origin private file system
// opened as the library, plus a C major progression whose tempo analysis (#33) is saved beforehand
// without a key, and an A minor progression saved with a key not found ("?") by an older version of the
// key analysis (#86). Checks 8A, 8B, 11A and "?" saved and shown in the library and on the decks, that
// both old tracks get their key with their tempo and grid kept and without a tempo analysis, and that
// nothing is analysed again after a reload.

import { check, sleep } from '../lib.mjs';

const SR = 22050;
const CHORD_S = 2;
const REPEATS = 3;
const OLD = 'Old - C major.wav';
const OLD_ANALYSIS = { bpm: 128.5, firstBeat: 0.25 };
const NO_KEY = 'Old - A minor without key.wav';
const NO_KEY_ANALYSIS = { bpm: 121.5, firstBeat: 0.5, key: null }; // no keyVersion: older key analysis
const KEY_VERSION = 2;
const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);
// Root in the bass, then the triad; MIDI note numbers.
const triad = (root, minor) => [root - 12, root, root + (minor ? 3 : 4), root + 7];
const PROGRESSIONS = {
  'Prog - A minor.wav': { key: '8A', chords: [triad(57, true), triad(62, true), triad(64, false), triad(57, true)] },
  'Prog - C major.wav': { key: '8B', chords: [triad(60, false), triad(65, false), triad(67, false), triad(60, false)] },
  'Prog - F sharp minor.wav': { key: '11A', chords: [triad(54, true), triad(59, true), triad(61, false), triad(54, true)] },
};
const NOISE = 'Noise - White.wav';

/** 16-bit mono WAV of `samples` (Float32Array, −1..1) at 22050 Hz; also used by key-reference.mjs. */
export function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

/** The chords played REPEATS times, CHORD_S each; every note with 3 harmonics. */
function progression(chords) {
  const len = SR * CHORD_S;
  const x = new Float32Array(len * chords.length * REPEATS);
  for (let r = 0; r < REPEATS; r++) {
    chords.forEach((notes, c) => {
      const offset = (r * chords.length + c) * len;
      for (const note of notes) {
        for (let h = 1; h <= 3; h++) {
          const w = (2 * Math.PI * freq(note) * h) / SR;
          for (let i = 0; i < len; i++) x[offset + i] += (0.08 / h) * Math.sin(w * i);
        }
      }
    });
  }
  return x;
}

const noise = () => new Float32Array(SR * 20).map(() => 0.5 * (Math.random() * 2 - 1));

export default async function ({ page }) {
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const files = {
    ...Object.fromEntries(Object.entries(PROGRESSIONS).map(([name, p]) => [name, progression(p.chords)])),
    [NOISE]: noise(),
    [OLD]: progression(PROGRESSIONS['Prog - C major.wav'].chords),
    [NO_KEY]: progression(PROGRESSIONS['Prog - A minor.wav'].chords),
  };
  const cells = () => page.eval(`Object.fromEntries([...document.querySelectorAll('#library tbody tr')]
    .map((tr) => [tr.cells[2].textContent, tr.querySelector('.key').textContent]))`);
  const deckKey = (d) => page.eval(`${q(`.deck[data-deck="${d}"] .key`)}.textContent`);
  const saved = () => page.eval(`new Promise((resolve, reject) => {
    const open = indexedDB.open('djing');
    open.onsuccess = () => {
      const req = open.result.transaction('tracks').objectStore('tracks').getAll();
      req.onsuccess = () => { resolve(Object.fromEntries(req.result.map((t) => [t.path, t.analysis]))); open.result.close(); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  })`);
  const progress = () => page.eval(`${q('#analysisProgress')}.textContent`);
  async function waitProgress(text, ms) {
    for (let t = 0; t < ms && (await progress()) !== text; t += 100) await sleep(100);
    return progress();
  }

  // Library directory; the old track gets its tempo analysis (no key) in IndexedDB beforehand.
  await page.eval(`navigator.storage.getDirectory().then((root) => root.removeEntry('key', { recursive: true })).catch(() => {})`);
  for (const [name, x] of Object.entries(files)) {
    await page.eval(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('key', { create: true });
      const w = await (await dir.getFileHandle(${JSON.stringify(name)}, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(${JSON.stringify(wav(x).toString('base64'))}), (c) => c.charCodeAt(0)));
      await w.close();
    })()`);
  }
  await page.eval(`(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('key');
    const saved = { ${JSON.stringify(OLD)}: ${JSON.stringify(OLD_ANALYSIS)}, ${JSON.stringify(NO_KEY)}: ${JSON.stringify(NO_KEY_ANALYSIS)} };
    for (const [path, analysis] of Object.entries(saved)) {
      const f = await (await dir.getFileHandle(path)).getFile();
      const record = { id: path + '|' + f.size + '|' + f.lastModified, path, analysis };
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('djing');
        open.onsuccess = () => {
          const tx = open.result.transaction('tracks', 'readwrite');
          tx.objectStore('tracks').put(record);
          tx.oncomplete = () => { open.result.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    }
    window.showDirectoryPicker = () => root.getDirectoryHandle('key');
    // Tempo flag of every track sent to the analysis worker.
    window.beatRequests = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && 'samples' in msg) beatRequests.push(msg.beat);
      return post.call(this, msg, ...rest);
    };
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  const total = Object.keys(files).length;
  const final = await waitProgress(`analyse BPM : ${total} / ${total}`, 90000);
  check(`analyse terminée (${total} / ${total})`, final === `analyse BPM : ${total} / ${total}`, final);

  const results = await saved();
  const shown = await cells();
  for (const [name, { key }] of Object.entries(PROGRESSIONS)) {
    check(`${name} : ${key} sauvegardé avec le BPM`, results[name]?.key === key && 'bpm' in results[name], JSON.stringify(results[name]));
    check(`${name} : ${key} dans la bibliothèque`, shown[name] === key, shown[name]);
  }
  check('bruit blanc : pas de tonalité, « ? » dans la bibliothèque', results[NOISE]?.key === null && shown[NOISE] === '?', `${JSON.stringify(results[NOISE])} / ${shown[NOISE]}`);
  check('titre déjà analysé : tonalité ajoutée (8B), BPM et grille gardés',
    JSON.stringify(results[OLD]) === JSON.stringify({ ...OLD_ANALYSIS, key: '8B', keyVersion: KEY_VERSION }) && shown[OLD] === '8B', `${JSON.stringify(results[OLD])} / ${shown[OLD]}`);
  check('titre « ? » d\'une ancienne analyse : tonalité réanalysée (8A), BPM et grille gardés',
    JSON.stringify(results[NO_KEY]) === JSON.stringify({ ...NO_KEY_ANALYSIS, key: '8A', keyVersion: KEY_VERSION }) && shown[NO_KEY] === '8A', `${JSON.stringify(results[NO_KEY])} / ${shown[NO_KEY]}`);
  const beats = await page.eval('beatRequests');
  check('titres déjà analysés : BPM non recalculé (deux envois sans tempo)',
    beats.length === total && beats.filter((b) => b === false).length === 2, JSON.stringify(beats));

  // Decks.
  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const loadRow = async (name, deck) => {
    await page.eval(`[...document.querySelectorAll('#library tbody tr')].find((tr) => tr.cells[2].textContent === ${JSON.stringify(name)})
      .querySelector('button[data-deck="${deck}"]').click()`);
    await sleep(1000);
  };
  check('deck vide : « — »', (await deckKey(0)) === '—', await deckKey(0));
  await loadRow(OLD, 0);
  check('tonalité sur le deck A : 8B', (await deckKey(0)) === '8B', await deckKey(0));
  await page.eval(`${q('.deck[data-deck="0"] [data-act="grid.double"]')}.click()`);
  await sleep(300);
  const edited = (await saved())[OLD];
  check('×2 sur le deck : tonalité gardée', edited?.key === '8B' && edited.bpm === OLD_ANALYSIS.bpm * 2, JSON.stringify(edited));
  await loadRow('Prog - F sharp minor.wav', 0);
  check('tonalité sur le deck A : 11A', (await deckKey(0)) === '11A', await deckKey(0));
  await loadRow(NOISE, 1);
  check('titre sans tonalité sur le deck B : « ? »', (await deckKey(1)) === '?', await deckKey(1));

  // Reload: nothing left to analyse.
  await page.reload();
  await page.eval(`${q('#libraryReopen')}.click()`);
  await sleep(1000);
  check('après rechargement : rien à réanalyser (0 / 0)', (await progress()) === 'analyse BPM : 0 / 0', await progress());
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
