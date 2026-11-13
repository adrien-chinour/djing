// Pad modes: the eight mode buttons choose the active pad page of each deck and light its LED.
import { register, led } from '../actions.js';
import { PAD_MODES, DEFAULT_PAD_MODE } from '../mapping.js';

const LABELS = { hotcue: 'Hot cue', roll: 'Roll', slicer: 'Slicer', sampler: 'Sampler', toneplay: 'Toneplay', fx: 'FX', slicerloop: 'Slicer loop', beatjump: 'Beatjump' };

/** Adds the mode buttons to every deck panel; ctx.padMode[deck] holds the active mode. */
export function createPads(ctx, panels) {
  ctx.padMode = panels.map(() => DEFAULT_PAD_MODE);
  for (const mode of PAD_MODES) {
    register(`padMode.${mode}`, (d, v) => {
      if (v > 0) ctx.padMode[d] = mode;
    });
  }
  panels.forEach((ui, d) => {
    const row = document.createElement('div');
    row.className = 'row pads';
    for (const mode of PAD_MODES) {
      const btn = document.createElement('button');
      btn.textContent = LABELS[mode];
      btn.dataset.act = btn.dataset.led = `padMode.${mode}`;
      row.append(btn);
      led(`padMode.${mode}`, d, () => ctx.padMode[d] === mode);
    }
    ui.section.append(row);
  });
}
