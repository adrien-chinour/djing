// Display settings: the "Affichage" panel of the header chooses which blocks the page shows. Each hidden
// block is a `hide-<id>` class on <body> (style.css takes the block out of the layout); the modules
// behind a block keep running, so the controller still drives what is not on screen. The choice is the
// list of shown blocks, saved under DISPLAY_KEY in the settings store and applied again on load.
import { get, put } from '../library/db.js';

export const DISPLAY_KEY = 'display';

/** Blocks that can be hidden, in the order of the panel. */
export const BLOCKS = [
  { id: 'overview', label: 'Waveform d\'ensemble' },
  { id: 'scroll', label: 'Waveform défilante' },
  { id: 'eq', label: 'EQ et gain' },
  { id: 'filter', label: 'Filtre' },
  { id: 'transpose', label: 'Transposition et keylock' },
  { id: 'pads', label: 'Pads' },
  { id: 'fx', label: 'Effets' },
  { id: 'sampler', label: 'Sampler' },
  { id: 'headphones', label: 'Mixer casque (cue/master, split)' },
  { id: 'library', label: 'Bibliothèque' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'log', label: 'Journal MIDI' },
];

/** Shown blocks of each preset; deck headers, transport, crossfader and VU are always shown. */
export const PRESETS = {
  minimal: { label: 'Minimal', shown: ['overview', 'scroll'] },
  mix: { label: 'Mix', shown: ['overview', 'scroll', 'eq', 'filter', 'pads', 'library'] },
  complet: { label: 'Complet', shown: BLOCKS.map((b) => b.id) },
};
export const DEFAULT_PRESET = 'mix';

/** Builds the panel in `root` (details.display of index.html), applies the default then the saved choice. */
export function createDisplay(ctx, root = document.querySelector('.display')) {
  const presetRow = root.querySelector('.presets');
  const list = root.querySelector('.blocks');
  const presetButtons = Object.entries(PRESETS).map(([name, preset]) => {
    const btn = Object.assign(document.createElement('button'), { textContent: preset.label, type: 'button' });
    btn.dataset.preset = name;
    btn.addEventListener('click', () => choose(preset.shown));
    presetRow.append(btn);
    return btn;
  });
  const boxes = BLOCKS.map(({ id, label }) => {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    box.dataset.block = id;
    box.addEventListener('change', () => choose(boxes.filter((b) => b.checked).map((b) => b.dataset.block)));
    const row = Object.assign(document.createElement('label'), { className: 'check' });
    row.append(box, label);
    list.append(row);
    return box;
  });

  function apply(shown) {
    const set = new Set(shown);
    for (const box of boxes) {
      box.checked = set.has(box.dataset.block);
      document.body.classList.toggle(`hide-${box.dataset.block}`, !box.checked);
    }
    for (const btn of presetButtons) {
      const preset = PRESETS[btn.dataset.preset].shown;
      btn.classList.toggle('on', preset.length === set.size && preset.every((id) => set.has(id)));
    }
  }

  function choose(shown) {
    apply(shown);
    put('settings', shown, DISPLAY_KEY).catch((err) => ctx.log(`Affichage non enregistré : ${err.message}`));
  }

  apply(PRESETS[DEFAULT_PRESET].shown);
  get('settings', DISPLAY_KEY).then((shown) => {
    if (Array.isArray(shown)) apply(shown);
  }).catch((err) => ctx.log(`Affichage enregistré illisible : ${err.message}`));
}
