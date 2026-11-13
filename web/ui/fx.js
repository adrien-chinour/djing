// Effect units on screen: in each deck panel, a dry/wet slider and three slots (effect, on/off,
// main parameter). Every control goes through the action registry (fx.mix, fx.<slot>.effect,
// fx.<slot>.on, fx.<slot>.param, fx.<slot>.next, fx.unit), also mapped on the controller (mapping.js):
// FX button, FX knobs and the FX pad page, with their LEDs.
import { register, dispatch, led } from '../actions.js';
import { EFFECTS } from '../fx/effects.js';
import { DEFAULT_EFFECTS, SLOTS } from '../fx/unit.js';

/** Adds the FX block to every deck panel and registers its actions. */
export function createFx(ctx, panels) {
  const unitOf = (d) => ctx.engine?.decks[d].fx;
  const blocks = panels.map((ui, d) => buildBlock(ui.section, d));

  register('fx.mix', (d, v) => {
    const unit = unitOf(d);
    if (!unit) return;
    unit.setMix(v);
    blocks[d].mix.value = v;
  });
  register('fx.unit', (d, v) => {
    const unit = unitOf(d);
    if (unit && v > 0) unit.setEnabled(!unit.enabled);
  });
  panels.forEach((_, d) => {
    led('fx.unit', d, () => unitOf(d)?.enabled);
    led(`fxPad.${SLOTS}`, d, () => unitOf(d)?.enabled);
    led('fx.button', d, () => unitOf(d)?.slots[SLOTS - 1].on);
  });
  const types = Object.keys(EFFECTS);
  for (let i = 0; i < SLOTS; i++) {
    register(`fx.${i}.next`, (d, v) => {
      const unit = unitOf(d);
      if (unit && v > 0) dispatch(`fx.${i}.effect`, d, types[(types.indexOf(unit.slots[i].type) + 1) % types.length]);
    });
    register(`fx.${i}.effect`, (d, type) => {
      const unit = unitOf(d);
      if (!unit || !EFFECTS[type]) return;
      unit.slots[i].setEffect(type);
      blocks[d].slots[i].select.value = type;
    });
    register(`fx.${i}.on`, (d, v) => {
      const unit = unitOf(d);
      if (unit && v > 0) unit.slots[i].setOn(!unit.slots[i].on);
    });
    register(`fx.${i}.param`, (d, v) => {
      const unit = unitOf(d);
      if (!unit) return;
      unit.slots[i].setParam(v);
      blocks[d].slots[i].param.value = v;
    });
    panels.forEach((_, d) => {
      led(`fx.${i}.on`, d, () => unitOf(d)?.slots[i].on);
      led(`fxPad.${i}`, d, () => unitOf(d)?.slots[i].on);
    });
  }
}

function buildBlock(section, d) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const range = (value) => el('input', { type: 'range', min: 0, max: 1, step: 0.01, value });
  const head = el('div', { className: 'row fx' });
  const mix = range(1);
  mix.addEventListener('input', () => dispatch('fx.mix', d, Number(mix.value)));
  const label = el('label', { textContent: 'FX dry/wet' });
  label.append(mix);
  // Clicks on [data-act] are dispatched by the deck panel (ui/decks.js); its LED lights the button.
  const unit = el('button', { textContent: 'FX sur le deck' });
  unit.dataset.act = unit.dataset.led = 'fx.unit';
  head.append(label, unit);
  section.append(head);

  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    const row = el('div', { className: 'row fx-slot' });
    const select = el('select');
    for (const [type, { label: text }] of Object.entries(EFFECTS)) select.add(new Option(text, type));
    select.value = DEFAULT_EFFECTS[i];
    select.addEventListener('change', () => dispatch(`fx.${i}.effect`, d, select.value));
    // Clicks on [data-act] are dispatched by the deck panel (ui/decks.js); its LED lights the button.
    const on = el('button', { textContent: `FX ${i + 1}` });
    on.dataset.act = on.dataset.led = `fx.${i}.on`;
    const param = range(0.5);
    param.addEventListener('input', () => dispatch(`fx.${i}.param`, d, Number(param.value)));
    const paramLabel = el('label', { textContent: 'Paramètre' });
    paramLabel.append(param);
    row.append(select, on, paramLabel);
    section.append(row);
    slots.push({ select, param });
  }
  return { mix, slots };
}
