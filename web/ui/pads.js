// Pad modes: the eight mode buttons choose the active pad page of each deck and light its LED. On screen they
// are tabs: the deck shows only the page of its current mode (data-pad-mode on the deck, style.css).
import { register, led } from '../actions.js';
import { PAD_MODES, DEFAULT_PAD_MODE } from '../mapping.js';

const LABELS = { hotcue: 'Hot cue', roll: 'Roll', slicer: 'Slicer', sampler: 'Sampler', toneplay: 'Toneplay', fx: 'FX', slicerloop: 'Slicer loop', beatjump: 'Beatjump' };

/**
 * Adds the mode buttons to every deck panel; ctx.padMode[deck] holds the active mode. Every press of a
 * mode button is announced with a `djing:padMode` event ({ deck, mode, old }), even on the active mode.
 */
/** Container of the pad pages of a deck panel (index.html, .pad-pages): each pad module adds its page there. */
export const padPages = (ui) => ui.section.querySelector('.pad-pages');

export function createPads(ctx, panels) {
  ctx.padMode = panels.map(() => DEFAULT_PAD_MODE);
  panels.forEach((ui) => { ui.section.dataset.padMode = DEFAULT_PAD_MODE; });
  for (const mode of PAD_MODES) {
    register(`padMode.${mode}`, (d, v) => {
      if (v <= 0) return;
      const old = ctx.padMode[d];
      ctx.padMode[d] = mode;
      panels[d].section.dataset.padMode = mode;
      document.dispatchEvent(new CustomEvent('djing:padMode', { detail: { deck: d, mode, old } }));
    });
  }
  panels.forEach((ui, d) => {
    const row = document.createElement('div');
    row.className = 'pad-modes';
    row.setAttribute('role', 'tablist');
    for (const mode of PAD_MODES) {
      const btn = document.createElement('button');
      btn.textContent = LABELS[mode];
      btn.dataset.act = btn.dataset.led = `padMode.${mode}`;
      row.append(btn);
      led(`padMode.${mode}`, d, () => ctx.padMode[d] === mode);
    }
    // The sampler page has no pads of its own on screen: its slots are under the decks.
    const sampler = document.createElement('div');
    sampler.className = 'sampler-page';
    sampler.textContent = `Pads : emplacements ${d ? '9 à 16' : '1 à 8'} du sampler (sous les decks)`;
    padPages(ui).before(row);
    padPages(ui).append(sampler);
  });
}
