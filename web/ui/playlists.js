// Playlist panel: playlists of the IndexedDB store "playlists" ({ id, name, items: [track id…] }),
// filled by dragging rows of the library, reordered by dragging their own rows, exported as M3U8.
// A track id missing from the last library listing stays in the playlist, greyed "introuvable".
import { getAll, put, remove } from '../library/db.js';
import { idLabel, idPath, insert, m3u8Name, move, removeAt, toM3u8 } from '../library/playlists.js';
import { TRACK_TYPE } from './library.js';

const $ = (sel) => document.querySelector(sel);
const ITEM_TYPE = 'application/x-djing-item';

export function createPlaylists(ctx) {
  const select = $('#playlistSelect');
  const body = $('#playlists tbody');
  const drop = $('#playlistDrop');
  const hint = $('#playlistHint');
  const edit = $('#playlistEdit');
  const nameInput = $('#playlistName');
  const confirm = $('#playlistConfirm');
  const buttons = ['#playlistRename', '#playlistDelete', '#playlistExport'].map($);
  let playlists = [];
  let current = null; // the shown playlist
  let known = null; // ids of the last library listing; null before any listing
  let renaming = null; // playlist being renamed, null when creating

  const fail = (err) => ctx.log(`Playlists indisponibles : ${err.message}`);

  function renderSelect() {
    select.replaceChildren(...playlists.map((p) => new Option(p.name, p.id, false, p === current)));
    select.disabled = !playlists.length;
    for (const btn of buttons) btn.disabled = !current;
  }

  /** Index where a drop at clientY lands: before the row under the pointer, or after it past its middle. */
  function dropIndex(e) {
    const tr = e.target.closest?.('#playlists tbody tr');
    if (!tr) return current.items.length;
    const r = tr.getBoundingClientRect();
    return Number(tr.dataset.index) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
  }

  function renderItems() {
    hint.hidden = !!current?.items.length;
    hint.textContent = current ? 'Glisser des titres de la bibliothèque ici' : 'Aucune playlist : « Nouvelle » pour en créer une';
    body.replaceChildren(...(current?.items ?? []).map((id, i) => {
      const tr = document.createElement('tr');
      tr.dataset.id = id;
      tr.dataset.index = i;
      tr.draggable = true;
      const missing = known && !known.has(id);
      tr.classList.toggle('unreadable', !!missing);
      for (const text of [i + 1, idLabel(id), idPath(id)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      const actions = document.createElement('td');
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = missing ? 'introuvable' : '';
      const btn = document.createElement('button');
      btn.textContent = 'Retirer';
      btn.dataset.act = 'remove';
      btn.addEventListener('click', () => update(removeAt(current.items, i)));
      actions.append(state, btn);
      tr.append(actions);
      tr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(ITEM_TYPE, String(i));
        e.dataTransfer.effectAllowed = 'move';
      });
      return tr;
    }));
  }

  function show(playlist) {
    current = playlist;
    renderSelect();
    renderItems();
  }

  async function update(items) {
    const playlist = current;
    playlist.items = items;
    renderItems();
    await put('playlists', playlist).catch(fail);
  }

  function hidePrompts() {
    edit.hidden = true;
    confirm.hidden = true;
  }

  function askName(playlist) {
    hidePrompts();
    renaming = playlist;
    nameInput.value = playlist?.name ?? `Playlist ${playlists.length + 1}`;
    edit.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  async function commitName() {
    const name = nameInput.value.trim();
    if (!name) return;
    edit.hidden = true;
    if (renaming) {
      renaming.name = name;
      await put('playlists', renaming).catch(fail);
      return show(renaming);
    }
    const playlist = { name, items: [] };
    try {
      playlist.id = await put('playlists', playlist);
    } catch (err) {
      return fail(err);
    }
    playlists.push(playlist);
    show(playlist);
  }

  $('#playlistNew').addEventListener('click', () => askName(null));
  $('#playlistRename').addEventListener('click', () => current && askName(current));
  $('#playlistNameOk').addEventListener('click', commitName);
  $('#playlistNameCancel').addEventListener('click', () => { edit.hidden = true; });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitName();
    if (e.key === 'Escape') edit.hidden = true;
  });

  // Deletion is confirmed in the panel, never with the native confirm().
  $('#playlistDelete').addEventListener('click', () => {
    if (!current) return;
    hidePrompts();
    $('#playlistConfirm span').textContent = `Supprimer « ${current.name} » ?`;
    confirm.hidden = false;
  });
  $('#playlistConfirmNo').addEventListener('click', () => { confirm.hidden = true; });
  $('#playlistConfirmYes').addEventListener('click', async () => {
    confirm.hidden = true;
    const playlist = current;
    await remove('playlists', playlist.id).catch(fail);
    playlists = playlists.filter((p) => p !== playlist);
    show(playlists[0] ?? null);
  });

  select.addEventListener('change', () => {
    hidePrompts();
    show(playlists.find((p) => String(p.id) === select.value) ?? null);
  });

  $('#playlistExport').addEventListener('click', () => {
    if (!current) return;
    const blob = new Blob([toM3u8(current.items)], { type: 'audio/x-mpegurl;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m3u8Name(current.name);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // Drops: a library row inserts its track, a playlist row moves to the drop place.
  drop.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (!current || !(types.includes(TRACK_TYPE) || types.includes(ITEM_TYPE))) return;
    e.preventDefault();
    drop.classList.add('drop');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
  drop.addEventListener('drop', (e) => {
    drop.classList.remove('drop');
    if (!current) return;
    e.preventDefault();
    const at = dropIndex(e);
    const id = e.dataTransfer.getData(TRACK_TYPE);
    const from = e.dataTransfer.getData(ITEM_TYPE);
    if (id) update(insert(current.items, [id], at));
    else if (from !== '') update(move(current.items, Number(from), at));
  });

  document.addEventListener('djing:library', ({ detail: { tracks } }) => {
    known = new Set(tracks.map((t) => t.id));
    renderItems();
  });

  getAll('playlists').then((all) => {
    playlists = all;
    show(playlists[0] ?? null);
  }).catch(fail);
}
