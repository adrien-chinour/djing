// Scenario of the library (#32): a music directory in the origin private file system stands in for
// the one showDirectoryPicker would return. Checks the filter, the order and the columns of the list,
// the track id, loading from the screen and from the controller (encoder + LOAD), the "illisible"
// state of a file that does not decode, and the "Rouvrir" button after a reload.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

// Relative path -> content ('wav' is a valid tone, anything else is written as text).
const FILES = {
  'Zebra - Tone.WAV': 'wav',
  'Été - Soleil.flac': 'not audio',
  'ambient/broken - Bad.mp3': 'not audio',
  'ambient/deep/Only title.Opus': 'not audio',
  'ambient/readme.md': 'ignored',
  'cover.jpg': 'ignored',
  'notes.txt': 'ignored',
};
const EXPECTED = [
  ['broken', 'Bad', 'ambient/broken - Bad.mp3'],
  ['', 'Only title', 'ambient/deep/Only title.Opus'],
  ['Été', 'Soleil', 'Été - Soleil.flac'],
  ['Zebra', 'Tone', 'Zebra - Tone.WAV'],
];

export default async function ({ page, sim }) {
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const rows = () => page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => ({
    cells: [...tr.cells].slice(0, 3).map((td) => td.textContent),
    id: tr.dataset.id,
    selected: tr.classList.contains('selected'),
    unreadable: tr.classList.contains('unreadable'),
    state: tr.querySelector('.state').textContent,
  }))`);
  const deckName = (d) => page.eval(`${q(`.deck[data-deck="${d}"] .name`)}.textContent`);
  const selectedIndex = async () => (await rows()).findIndex((r) => r.selected);

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);

  // Build the directory in the OPFS and make the picker return it.
  await page.eval(`(async () => {
    const files = ${JSON.stringify(FILES)};
    const wav = Uint8Array.from(atob(${JSON.stringify(readFileSync(wav).toString('base64'))}), (c) => c.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('music', { recursive: true }).catch(() => {});
    const music = await root.getDirectoryHandle('music', { create: true });
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/');
      let dir = music;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(content === 'wav' ? wav : content);
      await w.close();
    }
    window.showDirectoryPicker = () => root.getDirectoryHandle('music');
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  await sleep(500);

  let list = await rows();
  check('fichiers audio seuls, récursif, extensions sans casse', list.length === EXPECTED.length, list.map((r) => r.cells[2]).join(', '));
  check('tri par chemin relatif, ordre français ; colonnes Artiste, Titre, Chemin',
    JSON.stringify(list.map((r) => r.cells)) === JSON.stringify(EXPECTED), JSON.stringify(list.map((r) => r.cells)));
  const zebra = await page.eval(`navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('music'))
    .then((m) => m.getFileHandle('Zebra - Tone.WAV')).then((h) => h.getFile()).then((f) => \`Zebra - Tone.WAV|\${f.size}|\${f.lastModified}\`)`);
  check('identifiant <chemin>|<taille>|<lastModified>', list[3]?.id === zebra, `${list[3]?.id} / ${zebra}`);
  check('première ligne sélectionnée', list[0]?.selected);

  await page.eval(`document.querySelectorAll('#library tbody tr')[3].querySelector('button[data-deck="0"]').click()`);
  await sleep(1000);
  check('bouton A d\'une ligne : titre chargé sur le deck A', (await deckName(0)) === 'Zebra - Tone.WAV', await deckName(0));

  check('la ligne chargée devient la sélection', (await selectedIndex()) === 3);

  await sim.send('cc b0 01 7d');
  check('encodeur de la platine, trois crans vers le haut : première ligne', (await selectedIndex()) === 0);
  await sim.send('cc b0 01 01');
  check('encodeur de la platine : sélection descend d\'une ligne', (await selectedIndex()) === 1);
  await sim.send('note 92 0d 7f');
  await sim.send('note 92 0d 00', 800);
  list = await rows();
  check('fichier que decodeAudioData refuse : grisé « illisible »', list[1].unreadable && list[1].state === 'illisible', JSON.stringify(list[1]));
  check('fichier illisible : pas chargé sur le deck B (LED CUE éteinte)',
    (await deckName(1)).endsWith('illisible') && sim.lastLed(0x92, 0x06) !== 0x7f, await deckName(1));
  check('fichier illisible : boutons A et B désactivés',
    await page.eval(`[...document.querySelectorAll('#library tbody tr')[1].querySelectorAll('button')].every((b) => b.disabled)`));

  await sim.send('cc b0 01 7f');
  check('encodeur, un cran vers le haut : sélection remonte', (await selectedIndex()) === 0);
  await sim.send('cc b0 01 03');
  check('encodeur, trois crans vers le bas : quatrième ligne', (await selectedIndex()) === 3);
  await sim.send('note 92 0d 7f');
  await sim.send('note 92 0d 00', 1000);
  check('LOAD B de la platine : titre sélectionné chargé sur le deck B', (await deckName(1)) === 'Zebra - Tone.WAV', await deckName(1));
  check('LED CUE du deck B allumée après LOAD', sim.lastLed(0x92, 0x06) === 0x7f);

  await page.reload();
  check('après rechargement : bouton « Rouvrir » affiché, liste vide',
    !(await page.eval(`${q('#libraryReopen')}.hidden`)) && (await rows()).length === 0);
  await page.eval(`${q('#libraryReopen')}.click()`);
  await sleep(500);
  list = await rows();
  check('« Rouvrir » : la liste revient', JSON.stringify(list.map((r) => r.cells)) === JSON.stringify(EXPECTED));
  check('l\'état illisible est gardé en IndexedDB', list[1]?.unreadable && !list[3]?.unreadable);

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
