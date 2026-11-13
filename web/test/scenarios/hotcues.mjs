// Scenario of the hotcues (#36): two tones in a directory of the origin private file system opened as
// the library, one with a beat grid (120 BPM, first beat 0.1 s) written in IndexedDB beforehand, one
// without. Checks setting, jumping (playing and stopped), clearing with SHIFT, the snap of Q with and
// without a grid, the pad and Q LEDs, the screen buttons and the cue points read back after a reload.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

const GRID = 'Grid - 120.wav';
const NO_GRID = 'NoGrid - Tone.wav';
const ANALYSIS = { [GRID]: { bpm: 120, firstBeat: 0.1 }, [NO_GRID]: { bpm: null, firstBeat: null } };
const near = (a, b, tol = 0.002) => typeof a === 'number' && Math.abs(a - b) <= tol;

export default async function ({ page, sim }) {
  const wav = join(tmp, 'hotcues-tone.wav');
  writeTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deck = (d) => `window.djing.engine.decks[${d}]`;
  const position = (d) => page.eval(`${deck(d)}.position`);
  const playing = (d) => page.eval(`${deck(d)}.playing`);
  const seek = (d, s) => page.eval(`${deck(d)}.seek(${s})`);
  const button = (d, n) => q(`.deck[data-deck="${d}"] .hotcues button[data-led="hotcue.${n}"]`);
  const screen = (d, n) => page.eval(`(() => { const b = ${button(d, n)}; return { on: b.classList.contains('on'), position: b.dataset.position }; })()`);
  const click = async (d, n, shiftKey = false) => {
    await page.eval(`${button(d, n)}.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${shiftKey} }))`);
    await sleep(200);
  };
  const saved = (path) => page.eval(`new Promise((resolve, reject) => {
    const open = indexedDB.open('djing');
    open.onsuccess = () => {
      const tx = open.result.transaction(['tracks', 'cues']);
      const tracks = tx.objectStore('tracks').getAll();
      tracks.onsuccess = () => {
        const id = tracks.result.find((t) => t.path === ${JSON.stringify(path)})?.id;
        const cues = tx.objectStore('cues').get(id ?? '');
        cues.onsuccess = () => { resolve(cues.result?.hotcues ?? null); open.result.close(); };
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  })`);
  const loadRow = async (path, d) => {
    await page.eval(`[...document.querySelectorAll('#library tbody tr')].find((tr) => tr.cells[2].textContent === ${JSON.stringify(path)})
      .querySelector('button[data-deck="${d}"]').click()`);
    await sleep(1000);
  };
  const start = async () => {
    await page.eval(`${q('#start')}.click()`);
    await sleep(2000);
  };

  await start();
  // Library directory, with the grid analysis saved beforehand (so nothing is analysed).
  await page.eval(`(async () => {
    const wav = Uint8Array.from(atob(${JSON.stringify(readFileSync(wav).toString('base64'))}), (c) => c.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('hotcues', { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle('hotcues', { create: true });
    const analysis = ${JSON.stringify(ANALYSIS)};
    const records = [];
    for (const name of Object.keys(analysis)) {
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(wav);
      await w.close();
      const f = await handle.getFile();
      records.push({ id: name + '|' + f.size + '|' + f.lastModified, path: name, analysis: analysis[name] });
    }
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('djing');
      open.onsuccess = () => {
        const tx = open.result.transaction('tracks', 'readwrite');
        for (const r of records) tx.objectStore('tracks').put(r);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    window.showDirectoryPicker = () => root.getDirectoryHandle('hotcues');
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  await sleep(500);
  await loadRow(GRID, 0);

  check('8 boutons hotcue par deck à l\'écran', (await page.eval(`[0, 1].map((d) => document.querySelectorAll(\`.deck[data-deck="\${d}"] .hotcues button\`).length)`)).join() === '8,8');

  // Q on the controller, LED and screen.
  await sim.send('note 91 02 7f');
  await sim.send('note 91 02 00');
  check('Q (0x91 0x02) : quantize actif, LED allumée sur la platine et à l\'écran',
    (await page.eval(`${deck(0)}.quantize`)) && sim.lastLed(0x91, 0x02) === 0x7f
      && (await page.eval(`${q('.deck[data-deck="0"] [data-act="quantize"]')}.classList.contains('on')`)));

  // Set with a grid: 1.23 s snaps to the beat at 1.1 s (0.1 + 2 × 0.5).
  await seek(0, 1.23);
  await sleep(100);
  await sim.send('pad A hotcue 1', 300);
  let pad = await screen(0, 0);
  check('pad 1 vide : hotcue posé, calé sur le temps le plus proche (1,23 s → 1,1 s)', near(Number(pad.position), 1.1), pad.position);
  check('LED du pad 1 (0x96 0x00) allumée, bouton allumé à l\'écran', sim.lastLed(0x96, 0x00) === 0x7f && pad.on);
  check('LED du pad 2 éteinte', sim.lastLed(0x96, 0x01) !== 0x7f && !(await screen(0, 1)).on);

  // Jump while stopped.
  await seek(0, 4);
  await sleep(100);
  await sim.send('pad A hotcue 1', 300);
  check('pad 1 posé, deck arrêté : saut au hotcue, reste à l\'arrêt', near(await position(0), 1.1) && !(await playing(0)), String(await position(0)));

  // Jump while playing.
  await sim.send('press A play', 500);
  await sim.send('pad A hotcue 1', 100);
  const p = await position(0);
  check('pad 1 posé, deck en lecture : saut au hotcue, lecture continue', p >= 1.1 && p < 1.5 && (await playing(0)), String(p));
  await sim.send('press A play', 200);

  // Clear with SHIFT.
  await sim.send('pad A hotcue 1 shift', 300);
  pad = await screen(0, 0);
  check('SHIFT + pad 1 (0x96 0x08) : hotcue effacé, LED éteinte', pad.position === '' && !pad.on && sim.lastLed(0x96, 0x00) === 0x00, JSON.stringify(pad));
  check('effacement sauvegardé', (await saved(GRID))?.[0] === null, JSON.stringify(await saved(GRID)));

  // Q off: no snap.
  await sim.send('note 91 02 7f');
  await sim.send('note 91 02 00');
  await seek(0, 2.345);
  await sleep(100);
  await sim.send('pad A hotcue 2', 300);
  check('Q éteint : LED Q éteinte, hotcue 2 à la position exacte (2,345 s)',
    sim.lastLed(0x91, 0x02) === 0x00 && near(Number((await screen(0, 1)).position), 2.345, 0.001), (await screen(0, 1)).position);

  // Q on, track without a grid: no snap.
  await loadRow(NO_GRID, 1);
  await sim.send('note 92 02 7f');
  await sim.send('note 92 02 00');
  await seek(1, 0.777);
  await sleep(100);
  await sim.send('pad B hotcue 8', 300);
  check('Q actif, titre sans grille : pas de calage (0,777 s), LED 0x97 0x07 allumée',
    near(Number((await screen(1, 7)).position), 0.777, 0.001) && sim.lastLed(0x97, 0x07) === 0x7f, (await screen(1, 7)).position);

  // Screen buttons: click sets, then jumps; SHIFT + click clears.
  await seek(0, 5);
  await sleep(100);
  await click(0, 2);
  check('écran, bouton 3 : hotcue posé, LED du pad 3 allumée', near(Number((await screen(0, 2)).position), 5, 0.001) && sim.lastLed(0x96, 0x02) === 0x7f);
  await seek(0, 7);
  await click(0, 2);
  check('écran, bouton 3 posé : saut', near(await position(0), 5, 0.001), String(await position(0)));
  await click(0, 2, true);
  check('écran, Maj + clic : hotcue effacé', !(await screen(0, 2)).on && sim.lastLed(0x96, 0x02) === 0x00);

  const stored = await saved(GRID);
  check('hotcues sauvegardés par identifiant de titre (magasin cues)', stored?.length === 8 && near(stored[1], 2.345, 0.001) && stored.filter((x) => x !== null).length === 1, JSON.stringify(stored));
  check('analyse BPM du titre intacte', JSON.stringify(await page.eval(`new Promise((resolve) => {
    const open = indexedDB.open('djing');
    open.onsuccess = () => {
      const r = open.result.transaction('tracks').objectStore('tracks').getAll();
      r.onsuccess = () => { resolve(r.result.find((t) => t.path === ${JSON.stringify(GRID)})?.analysis); open.result.close(); };
    };
  })`)) === JSON.stringify(ANALYSIS[GRID]));

  // Reload: the cue points come back with the track.
  await page.reload();
  await start();
  await page.eval(`${q('#libraryReopen')}.click()`);
  await sleep(500);
  await loadRow(GRID, 1);
  const back = await page.eval(`[...document.querySelectorAll('.deck[data-deck="1"] .hotcues button')].map((b) => b.dataset.position)`);
  check('après rechargement : hotcues relus avec le titre (deck B)', near(Number(back[1]), 2.345, 0.001) && back.filter(Boolean).length === 1, JSON.stringify(back));
  check('après rechargement : LED du pad 2 du deck B allumée', sim.lastLed(0x97, 0x01) === 0x7f && (await screen(1, 1)).on);
  await sim.send('pad B hotcue 2', 300);
  check('après rechargement : le pad 2 saute au hotcue relu', near(await position(1), 2.345, 0.001), String(await position(1)));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
