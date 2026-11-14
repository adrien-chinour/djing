// Scenario of the library search, sort and compatible tracks (#51): a directory of the origin
// private file system whose analyses (BPM, Camelot key, duration) are saved in IndexedDB beforehand.
// Checks the accent- and case-insensitive search on artist, title and path, sorting by column (second
// click reverses, missing values last), the tracks that mix with the selected deck's track, the
// duration of an analysed track, and browsing with the arrows and Enter.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

const TONE = 'Zebra - Tone.wav';
// Relative path -> saved record fields (no entry: never analysed). Only TONE decodes.
const RECORDS = {
  [TONE]: { analysis: { bpm: 124, firstBeat: 0, key: '8A' } }, // duration computed by the analysis
  'Été - Soleil.flac': { analysis: { bpm: 126, firstBeat: 0, key: '9A' }, duration: 200 },
  'Ete/Ancien - Relative.mp3': { analysis: { bpm: 62, firstBeat: 0, key: '8B' }, duration: 300 },
  'beta - Double.mp3': { analysis: { bpm: 247, firstBeat: 0, key: '7A' }, duration: 100 },
  'Charlie - Far.mp3': { analysis: { bpm: 132, firstBeat: 0, key: '9B' }, duration: 250 },
  'Delta - Clash.mp3': { analysis: { bpm: 125, firstBeat: 0, key: '3A' }, duration: 180 },
  'Only title.mp3': { analysis: { bpm: null, firstBeat: null, key: null, keyVersion: 2 }, duration: 50 },
  'Echo - Unknown.mp3': null,
};
const MISSING_LAST = ['', 'Echo'].sort().join();

export default async function ({ page }) {
  const wav = join(tmp, 'tone-51.wav');
  writeTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const rows = () => page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => ({
    artist: tr.cells[0].textContent, path: tr.cells[2].textContent, duration: tr.querySelector('.duration').textContent,
    selected: tr.classList.contains('selected'), compatible: tr.classList.contains('compatible'),
  }))`);
  const artists = async () => (await rows()).map((r) => r.artist);
  const compatibles = async () => (await rows()).filter((r) => r.compatible).map((r) => r.artist).sort().join();
  const sortBy = (column) => page.eval(`${q(`#library th[data-sort="${column}"]`)}.click()`);
  const key = async (name, code) => {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
    }
    await sleep(100);
  };
  const type = async (text) => {
    await page.eval(`(${q('#librarySearch')}.focus(), ${q('#librarySearch')}.select())`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    if (text) await page.send('Input.insertText', { text });
    await sleep(100);
  };
  // Sorted check: the values present in order, then the missing ones in any order.
  const sortedAs = async (name, expected) => {
    const list = await artists();
    const head = list.slice(0, expected.length);
    check(name, JSON.stringify(head) === JSON.stringify(expected) && list.slice(expected.length).sort().join() === MISSING_LAST,
      JSON.stringify(list));
  };

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);

  // Directory and saved records.
  await page.eval(`(async () => {
    const records = ${JSON.stringify(RECORDS)};
    const wav = Uint8Array.from(atob(${JSON.stringify(readFileSync(wav).toString('base64'))}), (c) => c.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('search51', { recursive: true }).catch(() => {});
    const music = await root.getDirectoryHandle('search51', { create: true });
    const saved = [];
    for (const [path, record] of Object.entries(records)) {
      const parts = path.split('/');
      let dir = music;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const handle = await dir.getFileHandle(parts.at(-1), { create: true });
      const w = await handle.createWritable();
      await w.write(path === ${JSON.stringify(TONE)} ? wav : 'not audio');
      await w.close();
      const f = await handle.getFile();
      if (record) saved.push({ id: path + '|' + f.size + '|' + f.lastModified, path, ...record });
    }
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('djing');
      open.onsuccess = () => {
        const tx = open.result.transaction('tracks', 'readwrite');
        for (const record of saved) tx.objectStore('tracks').put(record);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    window.showDirectoryPicker = () => root.getDirectoryHandle('search51');
    window.beatRequests = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && 'samples' in msg) beatRequests++;
      return post.call(this, msg, ...rest);
    };
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  const progress = () => page.eval(`${q('#analysisProgress')}.textContent`);
  for (let t = 0; t < 20000 && (await progress()) !== 'analyse BPM : 2 / 2'; t += 100) await sleep(100);
  check('analyse : durée manquante et titre jamais analysé (2 / 2)', (await progress()) === 'analyse BPM : 2 / 2', await progress());
  const tone = (await rows()).find((r) => r.path === TONE);
  check('durée calculée d\'un titre déjà analysé : 0:10, sans repasser par le worker',
    tone?.duration === '0:10' && (await page.eval('beatRequests')) === 0, `${tone?.duration} / ${await page.eval('beatRequests')}`);
  check('colonne Durée : 3:20 (200 s), « … » sans durée',
    (await rows()).find((r) => r.artist === 'Été')?.duration === '3:20' && (await rows()).find((r) => r.artist === 'Echo')?.duration === '…');

  // Search.
  await type('ete');
  check('recherche « ete » : artiste « Été » et chemin « Ete/… », sans accents',
    (await artists()).sort().join() === 'Ancien,Été', JSON.stringify(await artists()));
  await type('ÉTÉ SOLEIL');
  check('recherche « ÉTÉ SOLEIL » : sans casse, sur artiste et titre', (await artists()).join() === 'Été', JSON.stringify(await artists()));
  await type('ete/');
  check('recherche « ete/ » : sur le chemin', (await artists()).join() === 'Ancien', JSON.stringify(await artists()));
  await type('relative');
  check('recherche « relative » : sur le titre', (await artists()).join() === 'Ancien', JSON.stringify(await artists()));
  check('recherche : la première ligne affichée est sélectionnée', (await rows())[0]?.selected);
  await type('');
  check('recherche vide : tous les titres', (await rows()).length === Object.keys(RECORDS).length);

  // Sort.
  await sortBy('artist');
  await sortBy('artist');
  await sortBy('title');
  await sortBy('artist');
  const byArtist = await artists();
  check('tri par artiste (autre colonne puis retour : croissant), sans artiste en dernier',
    JSON.stringify(byArtist) === JSON.stringify(['Ancien', 'beta', 'Charlie', 'Delta', 'Echo', 'Été', 'Zebra', '']), JSON.stringify(byArtist));
  await sortBy('artist');
  check('second clic : ordre inverse, sans artiste toujours en dernier',
    JSON.stringify(await artists()) === JSON.stringify(['Zebra', 'Été', 'Echo', 'Delta', 'Charlie', 'beta', 'Ancien', '']), JSON.stringify(await artists()));
  check('en-tête trié marqué ▼', (await page.eval(`${q('#library th[data-sort="artist"]')}.dataset.order`)) === 'desc');
  await sortBy('bpm');
  await sortedAs('tri par BPM croissant, sans BPM en dernier', ['Ancien', 'Zebra', 'Delta', 'Été', 'Charlie', 'beta']);
  await sortBy('bpm');
  await sortedAs('tri par BPM décroissant, sans BPM en dernier', ['beta', 'Charlie', 'Été', 'Delta', 'Zebra', 'Ancien']);
  await sortBy('key');
  await sortedAs('tri par tonalité (ordre Camelot), sans tonalité en dernier', ['Delta', 'beta', 'Zebra', 'Ancien', 'Été', 'Charlie']);
  await sortBy('key');
  await sortedAs('tri par tonalité inverse', ['Charlie', 'Été', 'Ancien', 'Zebra', 'beta', 'Delta']);
  await sortBy('duration');
  const byDuration = await artists();
  check('tri par durée croissante, sans durée en dernier',
    JSON.stringify(byDuration) === JSON.stringify(['Zebra', '', 'beta', 'Delta', 'Été', 'Charlie', 'Ancien', 'Echo']), JSON.stringify(byDuration));
  await sortBy('duration');
  check('tri par durée décroissante, sans durée en dernier',
    JSON.stringify(await artists()) === JSON.stringify(['Ancien', 'Charlie', 'Été', 'Delta', 'beta', '', 'Zebra', 'Echo']), JSON.stringify(await artists()));

  // Compatible tracks.
  check('deck vide : aucun titre mis en évidence', (await compatibles()) === '');
  await page.eval(`[...document.querySelectorAll('#library tbody tr')].find((tr) => tr.cells[2].textContent === ${JSON.stringify(TONE)})
    .querySelector('button[data-deck="0"]').click()`);
  await sleep(1000);
  check('124 BPM 8A sur le deck A : 126 BPM 9A, 62 BPM (×2) 8B, 247 BPM (÷2) 7A compatibles ; 132 BPM (+6,5 %) et 3A non',
    (await compatibles()) === ['Ancien', 'beta', 'Été', 'Zebra'].sort().join(), await compatibles());
  await page.eval(`(${q('#libraryDeck')}.value = '1', ${q('#libraryDeck')}.dispatchEvent(new Event('change')))`);
  check('deck B sélectionné, vide : aucun titre mis en évidence', (await compatibles()) === '', await compatibles());
  await page.eval(`(${q('#libraryDeck')}.value = '0', ${q('#libraryDeck')}.dispatchEvent(new Event('change')))`);
  await page.eval(`${q('.deck[data-deck="0"] [data-act="grid.double"]')}.click()`);
  await sleep(300);
  check('×2 sur le deck A (248 BPM) : mise en évidence recalculée', (await compatibles()) === ['beta', 'Été', 'Zebra'].sort().join(), await compatibles());

  // Keyboard.
  await sortBy('artist');
  if ((await page.eval(`${q('#library th[data-sort="artist"]')}.dataset.order`)) !== 'asc') await sortBy('artist');
  await page.eval(`(document.querySelectorAll('#library tbody tr')[0].click(), ${q('#library .tracks')}.focus())`);
  const selectedArtist = async () => (await rows()).find((r) => r.selected)?.artist;
  await key('ArrowDown', 40);
  await key('ArrowDown', 40);
  check('flèche bas deux fois : troisième ligne', (await selectedArtist()) === 'Charlie', await selectedArtist());
  await key('ArrowUp', 38);
  check('flèche haut : deuxième ligne', (await selectedArtist()) === 'beta', await selectedArtist());
  await page.eval(`(${q('#libraryDeck')}.value = '1', ${q('#libraryDeck')}.dispatchEvent(new Event('change')))`);
  await type('zebra');
  await key('Enter', 13);
  await sleep(1000);
  const deckB = await page.eval(`${q('.deck[data-deck="1"] .name')}.textContent`);
  check('Entrée dans la recherche : titre sélectionné chargé sur le deck sélectionné (B)', deckB === TONE, deckB);
  await type('');
  check('deck B sélectionné, titre chargé : mise en évidence d\'après le deck B', (await compatibles()) === ['beta', 'Été', 'Zebra'].sort().join(), await compatibles());

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
