// Library panel: one music directory, chosen once and kept in IndexedDB, listed as a table whose
// tracks load on deck A or B from the screen or from the controller (browser encoder + LOAD).
// Tracks are analysed (BPM, beat grid, key) in the background once listed. Each listing is
// announced by a `djing:library` event ({ tracks }); rows can be dragged onto a playlist.
import { register } from '../actions.js';
import { get, getAll, patch, put } from '../library/db.js';
import { scanDirectory } from '../library/scan.js';
import { analyzeTracks, announce, formatBpm, formatKey } from '../analysis/queue.js';

const $ = (sel) => document.querySelector(sel);
const DIR_KEY = 'libraryDir';
/** Drag data type of a library row: its track id. */
export const TRACK_TYPE = 'application/x-djing-track';

/** `loadOnDeck(deck, file)` resolves to true when the deck took the file (createDecks().load). */
export function createLibrary(ctx, loadOnDeck) {
  const body = $('#library tbody');
  const status = $('#libraryStatus');
  const reopen = $('#libraryReopen');
  const progress = $('#analysisProgress');
  let tracks = [];
  let rows = [];
  let selected = -1;

  function select(i) {
    if (!rows.length) return;
    selected = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((tr, j) => tr.classList.toggle('selected', j === selected));
    rows[selected].scrollIntoView({ block: 'nearest' });
  }

  function markUnreadable(i) {
    tracks[i].unreadable = true;
    rows[i].classList.add('unreadable');
    rows[i].querySelector('.state').textContent = 'illisible';
    for (const btn of rows[i].querySelectorAll('button')) btn.disabled = true;
  }

  async function load(i, deck) {
    const track = tracks[i];
    if (!track || track.unreadable) return;
    if (await loadOnDeck(deck, track.file, track)) return;
    if (!ctx.engine) return; // audio not started: not the file's fault
    markUnreadable(i);
    await patch('tracks', track.id, { path: track.path, unreadable: true });
  }

  function render() {
    body.replaceChildren();
    rows = tracks.map((t, i) => {
      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      tr.draggable = true; // onto a playlist (ui/playlists.js)
      tr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(TRACK_TYPE, t.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      for (const text of [t.artist, t.title, t.path]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      const bpm = document.createElement('td');
      bpm.className = 'bpm';
      bpm.textContent = formatBpm(t.analysis);
      tr.append(bpm);
      const key = document.createElement('td');
      key.className = 'key';
      key.textContent = formatKey(t.analysis);
      tr.append(key);
      const actions = document.createElement('td');
      const state = document.createElement('span');
      state.className = 'state';
      actions.append(state);
      ['A', 'B'].forEach((name, deck) => {
        const btn = document.createElement('button');
        btn.textContent = name;
        btn.dataset.deck = deck;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          select(i);
          load(i, deck);
        });
        actions.append(btn);
      });
      tr.append(actions);
      tr.addEventListener('click', () => select(i));
      body.append(tr);
      return tr;
    });
    tracks.forEach((t, i) => t.unreadable && markUnreadable(i));
    selected = -1;
    if (rows.length) select(0);
  }

  /** Lists `dir` (any FileSystemDirectoryHandle) and keeps it as the library directory. */
  async function open(dir) {
    status.textContent = `lecture de « ${dir.name || 'dossier'} »…`;
    const [found, known] = await Promise.all([scanDirectory(dir), getAll('tracks')]);
    const records = new Map(known.map((t) => [t.id, t]));
    tracks = found.map((t) => ({ ...t, unreadable: !!records.get(t.id)?.unreadable, analysis: records.get(t.id)?.analysis }));
    await put('settings', dir, DIR_KEY);
    reopen.hidden = true;
    status.textContent = `« ${dir.name || 'dossier'} » : ${tracks.length} titre(s)`;
    render();
    document.dispatchEvent(new CustomEvent('djing:library', { detail: { tracks } }));
    analyzeTracks(tracks.filter((t) => !t.unreadable), {
      onProgress: (done, total) => { progress.textContent = `analyse BPM : ${done} / ${total}`; },
      onResult: announce,
      onError: (t, err) => ctx.log(`${t.path} : analyse impossible (${err.message})`),
    });
  }

  // Analysis results and grid edits from the decks (same track objects).
  document.addEventListener('djing:analysis', ({ detail: track }) => {
    const i = tracks.indexOf(track);
    if (i < 0) return;
    rows[i].querySelector('.bpm').textContent = formatBpm(track.analysis);
    rows[i].querySelector('.key').textContent = formatKey(track.analysis);
  });

  $('#libraryPick').addEventListener('click', async () => {
    if (!window.showDirectoryPicker) return ctx.log('Choix de dossier indisponible (utiliser Chrome ou Edge)');
    try {
      await open(await window.showDirectoryPicker({ id: 'djing-library', mode: 'read' }));
    } catch (err) {
      if (err.name !== 'AbortError') ctx.log(`Dossier non lu : ${err.message}`);
    }
  });

  // On reload the handle survives in IndexedDB but its permission must be asked again by a click.
  reopen.addEventListener('click', async () => {
    const dir = await get('settings', DIR_KEY);
    if (!dir) return;
    try {
      if ((await dir.requestPermission({ mode: 'read' })) !== 'granted') return ctx.log('Accès au dossier refusé');
      await open(dir);
    } catch (err) {
      ctx.log(`Dossier non lu : ${err.message}`);
    }
  });
  get('settings', DIR_KEY).then((dir) => {
    if (!dir) return;
    reopen.hidden = false;
    reopen.textContent = `Rouvrir « ${dir.name || 'dossier'} »`;
  }).catch((err) => ctx.log(`Bibliothèque indisponible : ${err.message}`));

  // Browser encoder: relative ticks move the selection; LOAD loads it on its deck.
  register('browse', (_d, ticks) => select(selected + ticks));
  register('loadSelected', (d, v) => {
    if (v > 0 && selected >= 0) load(selected, d);
  });

  return { open };
}
