// Scenario of the playlists (#52): a music directory in the origin private file system stands in for
// the one showDirectoryPicker would return. Checks create / rename / delete (confirmed on screen,
// never with confirm()), drag and drop from the library (duplicates allowed), reordering and removal,
// persistence by track id across a reload, the "introuvable" state of a track gone from the
// directory, and the M3U8 export (relative paths, UTF-8). Visibility is the rendered one (#87): a
// `hidden` element must not be displayed whatever its class.

import { check, sleep } from '../lib.mjs';

const FILES = ['Zebra - Tone.wav', 'Été - Soleil.flac', 'sous dossier/Ünï - Ça va.mp3'];

export default async function ({ page }) {
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const click = (sel) => page.eval(`${q(sel)}.click()`);
  const items = () => page.eval(`[...document.querySelectorAll('#playlists tbody tr')].map((tr) => ({
    id: tr.dataset.id, cells: [...tr.cells].slice(0, 3).map((td) => td.textContent),
    missing: tr.classList.contains('unreadable'), state: tr.querySelector('.state').textContent,
  }))`);
  const ids = async () => (await items()).map((r) => r.id);
  const names = () => page.eval(`[...${q('#playlistSelect')}.options].map((o) => o.textContent)`);
  // Rendered visibility, not the attribute: a class setting `display` must not defeat `hidden` (#87).
  const shown = (sel) => page.eval(`(() => { const el = ${q(sel)}; return el.offsetParent !== null && getComputedStyle(el).display !== 'none'; })()`);
  // Every element of the page carrying `hidden` is really not displayed.
  const hiddenDisplayed = () => page.eval(`[...document.querySelectorAll('[hidden]')]
    .filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id || el.className || el.tagName)`);
  // Drags `source` (a CSS selector) and drops it on the playlist row `row` (before its middle, or after
  // it when `after`), or on the empty area of the playlist when row is null.
  const drag = (source, row, after = false) => page.eval(`(() => {
    const dt = new DataTransfer();
    const src = document.querySelector(${JSON.stringify(source)});
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const rows = document.querySelectorAll('#playlists tbody tr');
    const target = ${row === null ? 'null' : `rows[${row}]`} ?? document.querySelector('#playlistHint');
    const r = target.getBoundingClientRect();
    const clientY = ${after} ? r.bottom - 1 : r.top + 1;
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY });
    target.dispatchEvent(over);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return over.defaultPrevented;
  })()`);
  const lib = (i) => `#library tbody tr:nth-child(${i + 1})`;
  const trap = `window.confirm = () => { window.nativeConfirms = (window.nativeConfirms || 0) + 1; return true; };`;

  // Fresh database and directory, picker returning the directory.
  await page.eval(`new Promise((r) => { const q = indexedDB.deleteDatabase('djing'); q.onsuccess = q.onerror = q.onblocked = r; })`);
  await page.reload();
  await page.eval(`(async () => {
    ${trap}
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('music', { recursive: true }).catch(() => {});
    const music = await root.getDirectoryHandle('music', { create: true });
    for (const path of ${JSON.stringify(FILES)}) {
      const parts = path.split('/');
      let dir = music;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write('not audio ' + path);
      await w.close();
    }
    window.showDirectoryPicker = () => root.getDirectoryHandle('music');
  })()`);
  await click('#libraryPick');
  await sleep(500);
  const libIds = await page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => tr.dataset.id)`);
  const libPaths = await page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => tr.cells[2].textContent)`);
  check('bibliothèque listée', libIds.length === 3, libPaths.join(', '));
  check('lignes de la bibliothèque glissables', await page.eval(`[...document.querySelectorAll('#library tbody tr')].every((tr) => tr.draggable)`));
  check('au chargement : renommage et confirmation non affichés', !(await shown('#playlistEdit')) && !(await shown('#playlistConfirm')));
  check('aucun élément hidden affiché', (await hiddenDisplayed()).length === 0, JSON.stringify(await hiddenDisplayed()));
  check('aucune playlist : boutons Renommer, Supprimer, Exporter désactivés',
    await page.eval(`['#playlistRename', '#playlistDelete', '#playlistExport'].every((s) => document.querySelector(s).disabled)`));

  // Create.
  await click('#playlistNew');
  check('« Nouvelle » : champ du nom affiché, nom proposé', (await shown('#playlistEdit')) && (await page.eval(`${q('#playlistName')}.value`)) === 'Playlist 1');
  await page.eval(`${q('#playlistName')}.value = 'Set du soir'`);
  await click('#playlistNameOk');
  await sleep(200);
  check('playlist créée et affichée', JSON.stringify(await names()) === '["Set du soir"]' && !(await shown('#playlistEdit')), JSON.stringify(await names()));

  // Drag and drop from the library, duplicates, insertion place.
  check('dépôt accepté sur la playlist', await drag(lib(0), null));
  await drag(lib(1), null);
  await drag(lib(0), null);
  await sleep(100);
  check('glisser-déposer depuis la bibliothèque, un titre deux fois',
    JSON.stringify(await ids()) === JSON.stringify([libIds[0], libIds[1], libIds[0]]), JSON.stringify(await ids()));
  await drag(lib(2), 0);
  await sleep(100);
  check('dépôt sur la première ligne : inséré avant elle',
    JSON.stringify(await ids()) === JSON.stringify([libIds[2], libIds[0], libIds[1], libIds[0]]), JSON.stringify(await ids()));

  // Reorder and remove.
  await drag('#playlists tbody tr:nth-child(1)', 3, true);
  await sleep(100);
  check('réordonner : première ligne glissée après la dernière',
    JSON.stringify(await ids()) === JSON.stringify([libIds[0], libIds[1], libIds[0], libIds[2]]), JSON.stringify(await ids()));
  await drag('#playlists tbody tr:nth-child(4)', 1);
  await sleep(100);
  check('réordonner : dernière ligne glissée avant la deuxième',
    JSON.stringify(await ids()) === JSON.stringify([libIds[0], libIds[2], libIds[1], libIds[0]]), JSON.stringify(await ids()));
  await page.eval(`document.querySelectorAll('#playlists tbody tr')[2].querySelector('[data-act="remove"]').click()`);
  await sleep(100);
  const expected = [libIds[0], libIds[2], libIds[0]];
  check('« Retirer » enlève cette ligne seule', JSON.stringify(await ids()) === JSON.stringify(expected), JSON.stringify(await ids()));
  const firstRow = (await items())[0];
  check('colonnes numéro, titre, chemin', JSON.stringify(firstRow.cells) === JSON.stringify(['1', libPaths[0].replace(/\.[^.]+$/, '').split('/').at(-1), libPaths[0]]), JSON.stringify(firstRow.cells));

  // Rename (Enter validates).
  await click('#playlistRename');
  check('« Renommer » : champ du nom affiché', await shown('#playlistEdit'));
  await click('#playlistNameCancel');
  check('« Annuler » : champ du nom masqué', !(await shown('#playlistEdit')));
  await click('#playlistRename');
  await page.eval(`(() => { const i = ${q('#playlistName')}; i.value = 'Soirée « été »'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await sleep(200);
  check('renommer, champ du nom masqué', JSON.stringify(await names()) === '["Soirée « été »"]' && !(await shown('#playlistEdit')), JSON.stringify(await names()));

  // A second playlist, then its deletion, confirmed on screen.
  await click('#playlistNew');
  await page.eval(`${q('#playlistName')}.value = 'À jeter'`);
  await click('#playlistNameOk');
  await sleep(200);
  check('deuxième playlist créée, vide et affichée', (await names()).length === 2 && (await ids()).length === 0
    && (await page.eval(`${q('#playlistSelect')}.selectedOptions[0].textContent`)) === 'À jeter');
  await click('#playlistDelete');
  check('« Supprimer » : demande de confirmation à l\'écran',
    (await shown('#playlistConfirm')) && (await page.eval(`${q('#playlistConfirm span')}.textContent`)) === 'Supprimer « À jeter » ?');
  await click('#playlistConfirmNo');
  check('« Annuler » : la playlist reste', !(await shown('#playlistConfirm')) && (await names()).length === 2);
  await click('#playlistDelete');
  await click('#playlistConfirmYes');
  await sleep(200);
  check('« Supprimer » confirmé : playlist supprimée, la précédente affichée',
    JSON.stringify(await names()) === '["Soirée « été »"]' && JSON.stringify(await ids()) === JSON.stringify(expected) && !(await shown('#playlistConfirm')), JSON.stringify(await names()));
  check('aucun élément hidden affiché après les manipulations', (await hiddenDisplayed()).length === 0, JSON.stringify(await hiddenDisplayed()));
  check('aucun confirm() natif', !(await page.eval('window.nativeConfirms')));

  // Export.
  const exported = await page.eval(`new Promise((resolve) => {
    const create = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    let blob;
    URL.createObjectURL = (b) => { blob = b; return create.call(URL, b); };
    HTMLAnchorElement.prototype.click = async function () {
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = click;
      const bytes = [...new Uint8Array(await blob.arrayBuffer())];
      resolve({ name: this.download, type: blob.type, text: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)), bytes });
    };
    document.querySelector('#playlistExport').click();
  })`);
  const label = (path) => path.split('/').at(-1).replace(/\.[^.]+$/, '');
  const m3u = ['#EXTM3U', ...expected.flatMap((id) => {
    const path = libPaths[libIds.indexOf(id)];
    return [`#EXTINF:-1,${label(path)}`, path];
  })].join('\n') + '\n';
  check('export : fichier « Soirée « été ».m3u8 »', exported.name === 'Soirée « été ».m3u8', exported.name);
  check('export : en-tête #EXTM3U, un #EXTINF et un chemin relatif par ligne, ordre de la playlist', exported.text === m3u, JSON.stringify(exported.text));
  const utf8 = [...Buffer.from(m3u, 'utf8')];
  check('export : encodé en UTF-8 sans BOM', JSON.stringify(exported.bytes) === JSON.stringify(utf8) && /utf-8/i.test(exported.type), exported.type);

  // Persistence, and a track gone from the directory.
  await page.reload();
  await page.eval(trap);
  check('après rechargement : playlist et titres relus', JSON.stringify(await names()) === '["Soirée « été »"]'
    && JSON.stringify(await ids()) === JSON.stringify(expected), JSON.stringify(await ids()));
  const gone = libPaths[0];
  await page.eval(`(async () => {
    const parts = ${JSON.stringify(gone.split('/'))};
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('music');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts.at(-1));
  })()`);
  await click('#libraryReopen');
  await sleep(500);
  const after = await items();
  check('titre disparu du dossier : listé, grisé « introuvable »',
    after.length === 3 && after[0].missing && after[2].missing && after[0].state === 'introuvable', JSON.stringify(after));
  check('titre encore présent : pas grisé', !after[1].missing && after[1].state === '', JSON.stringify(after[1]));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
