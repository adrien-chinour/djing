// Scenario of the BPM and beat grid analysis (#33): click tracks at 90, 124 and 174 BPM whose first
// beat is at 0.37 s, and white noise, in a directory of the origin private file system opened as
// the library. Checks the analysis worker, the "n / total" progress, the page staying responsive,
// the accuracy of the saved results, "BPM inconnu" for the noise, the BPM in the library and on the
// deck, the ×2, ÷2 and ±10 ms buttons and that nothing is analysed again after a reload.

import { check, sleep } from '../lib.mjs';

const SR = 44100;
const SECONDS = 20;
const FIRST_BEAT = 0.37;
const CLICKS = { 'Clicks - 090.wav': 90, 'Clicks - 124.wav': 124, 'Clicks - 174.wav': 174 };
const NOISE = 'Noise - White.wav';

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

/** Silence then a 1.5 kHz click (4 ms decay) on every beat from FIRST_BEAT. */
function clicks(bpm) {
  const x = new Float32Array(SR * SECONDS);
  for (let t = FIRST_BEAT; t < SECONDS; t += 60 / bpm) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.02 && start + i < x.length; i++) {
      x[start + i] = 0.8 * Math.exp(-i / (SR * 0.004)) * Math.sin((2 * Math.PI * 1500 * i) / SR);
    }
  }
  return x;
}

const noise = () => new Float32Array(SR * SECONDS).map(() => 0.5 * (Math.random() * 2 - 1));

export default async function ({ page }) {
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const files = { ...Object.fromEntries(Object.entries(CLICKS).map(([name, bpm]) => [name, clicks(bpm)])), [NOISE]: noise() };
  const cells = () => page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => [tr.cells[2].textContent, tr.querySelector('.bpm').textContent])`);
  const cell = async (name) => (await cells()).find(([path]) => path === name)?.[1];
  const deckBpm = (d) => page.eval(`${q(`.deck[data-deck="${d}"] .bpm`)}.textContent`);
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

  await page.eval(`navigator.storage.getDirectory().then((root) => root.removeEntry('beatgrid', { recursive: true })).catch(() => {})`);
  for (const [name, x] of Object.entries(files)) {
    await page.eval(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('beatgrid', { create: true });
      const w = await (await dir.getFileHandle(${JSON.stringify(name)}, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(${JSON.stringify(wav(x).toString('base64'))}), (c) => c.charCodeAt(0)));
      await w.close();
    })()`);
  }
  await page.eval(`(async () => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = () => root.getDirectoryHandle('beatgrid');
    // Every progress text, and the longest delay of a 20 ms timer (main thread blocked).
    window.progressSeen = [];
    new MutationObserver(() => progressSeen.push(${q('#analysisProgress')}.textContent))
      .observe(${q('#analysisProgress')}, { childList: true, characterData: true, subtree: true });
    window.maxTimerLag = 0;
    let last = performance.now();
    window.lagTimer = setInterval(() => {
      const now = performance.now();
      maxTimerLag = Math.max(maxTimerLag, now - last - 20);
      last = now;
    }, 20);
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  const final = await waitProgress('analyse BPM : 4 / 4', 60000);
  await page.eval('clearInterval(lagTimer)');
  const seen = await page.eval('progressSeen');
  check('progression « n / total » affichée, de 0 / 4 à 4 / 4',
    final === 'analyse BPM : 4 / 4' && ['0', '1', '2', '3', '4'].every((n) => seen.includes(`analyse BPM : ${n} / 4`)), seen.join(' ; '));
  check('analyse dans le Web Worker analysis/worker.js',
    await page.eval(`performance.getEntriesByType('resource').some((e) => e.name.endsWith('/analysis/worker.js'))`));
  const lag = await page.eval('maxTimerLag');
  check('page réactive pendant l\'analyse (retard max d\'un timer < 150 ms)', lag < 150, `${lag.toFixed(0)} ms`);

  let results = await saved();
  for (const [name, bpm] of Object.entries(CLICKS)) {
    const r = results[name];
    check(`${name} : BPM à ±0,05 et premier temps à ±10 ms`,
      r && Math.abs(r.bpm - bpm) <= 0.05 && Math.abs(r.firstBeat - FIRST_BEAT) <= 0.01, JSON.stringify(r));
  }
  check('bruit blanc : BPM inconnu, aucune grille', results[NOISE] && results[NOISE].bpm === null && results[NOISE].firstBeat === null, JSON.stringify(results[NOISE]));
  const list = await cells();
  check('BPM dans la bibliothèque', JSON.stringify(list.map(([, bpm]) => bpm)) === JSON.stringify(['90.00', '124.00', '174.00', 'BPM inconnu']), JSON.stringify(list));

  // Decks: BPM shown, grid buttons.
  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const loadRow = async (i, deck) => {
    await page.eval(`document.querySelectorAll('#library tbody tr')[${i}].querySelector('button[data-deck="${deck}"]').click()`);
    await sleep(1000);
  };
  const press = async (deck, act) => {
    await page.eval(`${q(`.deck[data-deck="${deck}"] [data-act="${act}"]`)}.click()`);
    await sleep(200);
  };
  await loadRow(1, 0);
  check('BPM sur le deck A', (await deckBpm(0)).startsWith('124.00 BPM'), await deckBpm(0));
  await loadRow(3, 1);
  check('titre sans pulsation sur le deck B : « BPM inconnu »', (await deckBpm(1)) === 'BPM inconnu', await deckBpm(1));
  await press(1, 'grid.double');
  check('×2 sans grille : sans effet', (await deckBpm(1)) === 'BPM inconnu' && (await saved())[NOISE].bpm === null);

  const before = (await saved())['Clicks - 124.wav'];
  await press(0, 'grid.double');
  check('×2 : BPM doublé sur le deck et dans la bibliothèque',
    (await deckBpm(0)).startsWith('248.00 BPM') && (await cell('Clicks - 124.wav')) === '248.00', `${await deckBpm(0)} / ${await cell('Clicks - 124.wav')}`);
  await press(0, 'grid.half');
  await press(0, 'grid.half');
  check('÷2 deux fois après ×2 : BPM divisé par 2', (await deckBpm(0)).startsWith('62.00 BPM'), await deckBpm(0));
  await press(0, 'grid.later');
  await press(0, 'grid.later');
  await press(0, 'grid.earlier');
  let after = (await saved())['Clicks - 124.wav'];
  check('±10 ms : grille décalée et sauvegardée (+20 −10 = +10 ms)',
    Math.abs(after.firstBeat - before.firstBeat - 0.01) < 1e-9 && Math.abs(after.bpm - before.bpm / 2) < 1e-9, JSON.stringify(after));
  check('±10 ms : premier temps affiché sur le deck', (await deckBpm(0)).endsWith(`${after.firstBeat.toFixed(3)} s`), await deckBpm(0));

  // Reload: the saved values (edited by hand) come back and nothing is analysed again.
  await page.reload();
  await page.eval(`${q('#libraryReopen')}.click()`);
  await sleep(1000);
  check('après rechargement : rien à réanalyser (0 / 0)', (await progress()) === 'analyse BPM : 0 / 0', await progress());
  results = await saved();
  after = results['Clicks - 124.wav'];
  check('après rechargement : réglages manuels gardés', after.bpm === before.bpm / 2 && (await cell('Clicks - 124.wav')) === '62.00', JSON.stringify(after));
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
