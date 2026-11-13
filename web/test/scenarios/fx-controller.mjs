// Scenario of the effects driven by the controller (#46): FX button and FX knobs of each deck, FX pad
// page (slots 1..3 on, unit applied to the deck, next effect), their LEDs and the on-screen controls.

import { check, sleep } from '../lib.mjs';

export default async function ({ page, sim }) {
  const unit = (d) => `window.djing.engine.decks[${d}].fx`;
  const state = (d) => page.eval(`(() => { const u = ${unit(d)}; return { enabled: u.enabled, mix: u.mix,
    slots: u.slots.map((s) => ({ on: s.on, type: s.type, param: s.param })) }; })()`);
  const screen = (d) => page.eval(`(() => { const deck = document.querySelector('.deck[data-deck="${d}"]');
    const slots = [...deck.querySelectorAll('.fx-slot')];
    return { mix: Number(deck.querySelector('.fx input').value), unit: deck.querySelector('[data-led="fx.unit"]').classList.contains('on'),
      slots: slots.map((s) => ({ on: s.querySelector('button').classList.contains('on'), type: s.querySelector('select').value,
        param: Number(s.querySelector('input').value) })) }; })()`);
  const tap = async (status, number) => { await sim.send(`note ${status} ${number} 7f`, 50); await sim.send(`note ${status} ${number} 00`); };
  const types = await page.eval(`import('/fx/effects.js').then((m) => Object.keys(m.EFFECTS))`);
  const next = (type) => types[(types.indexOf(type) + 1) % types.length];

  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  let a = await state(0);
  check('au démarrage : unités appliquées, LED du pad 4 FX (0x96/0x97 0x53) allumée',
    a.enabled && sim.lastLed(0x96, 0x53) === 0x7f && sim.lastLed(0x97, 0x53) === 0x7f);
  check('au démarrage : LED du bouton FX (0x91 0x00) éteinte', sim.lastLed(0x91, 0x00) !== 0x7f);

  // FX button: slot 3 on/off, LED on the button and on pad 3 of the FX page.
  await tap('91', '00');
  a = await state(0);
  let sa = await screen(0);
  check('bouton FX (0x91 0x00) : emplacement 3 du deck A actif', a.slots[2].on && !a.slots[0].on && !a.slots[1].on, JSON.stringify(a.slots));
  check('bouton FX : LED 0x91 0x00 et LED du pad 0x96 0x52 allumées', sim.lastLed(0x91, 0x00) === 0x7f && sim.lastLed(0x96, 0x52) === 0x7f);
  check('bouton FX : bouton FX 3 allumé à l\'écran', sa.slots[2].on);
  check('bouton FX du deck A : deck B intact', !(await state(1)).slots[2].on && sim.lastLed(0x92, 0x00) !== 0x7f);
  await tap('91', '00');
  check('second appui : emplacement 3 coupé, LED éteinte', !(await state(0)).slots[2].on && sim.lastLed(0x91, 0x00) === 0x00);
  await tap('92', '00');
  check('bouton FX du deck B (0x92 0x00) : emplacement 3 du deck B actif, LED 0x92 0x00',
    (await state(1)).slots[2].on && sim.lastLed(0x92, 0x00) === 0x7f && !(await state(0)).slots[2].on);

  // FX knobs: 0x06 = slot 3 parameter, 0x07 = dry/wet.
  await sim.send('cc b1 06 00');
  await sim.send('cc b1 07 40');
  a = await state(0);
  sa = await screen(0);
  check('potentiomètre 0xB1 0x06 à 0 : paramètre de l\'emplacement 3 à 0, curseur à l\'écran', a.slots[2].param === 0 && sa.slots[2].param === 0, JSON.stringify(a.slots[2]));
  check('potentiomètre 0xB1 0x07 à 0x40 : dry/wet à 0,5, curseur à l\'écran', Math.abs(a.mix - 64 / 127) < 1e-6 && Math.abs(sa.mix - 0.5) < 0.01, `${a.mix} ${sa.mix}`);
  check('potentiomètres du deck A : paramètres du deck B intacts', (await state(1)).mix === 1 && (await state(1)).slots[2].param === 0.5);
  await sim.send('cc b2 06 7f');
  await sim.send('cc b2 07 00');
  const b = await state(1);
  check('potentiomètres 0xB2 0x06 / 0x07 : paramètre 3 et dry/wet du deck B', b.slots[2].param === 1 && b.mix === 0, JSON.stringify(b));

  // FX pad page.
  await sim.send('pad A fx 1');
  await sim.send('pad A fx 2');
  a = await state(0);
  check('pads FX 1 et 2 (0x96 0x50, 0x51) : emplacements 1 et 2 actifs', a.slots[0].on && a.slots[1].on && !a.slots[2].on);
  check('pads FX 1 et 2 : LED 0x96 0x50 et 0x51 allumées, 0x52 éteinte',
    sim.lastLed(0x96, 0x50) === 0x7f && sim.lastLed(0x96, 0x51) === 0x7f && sim.lastLed(0x96, 0x52) === 0x00);
  await sim.send('pad A fx 3');
  check('pad FX 3 (0x96 0x52) : emplacement 3 actif, LED du pad et du bouton FX', (await state(0)).slots[2].on && sim.lastLed(0x96, 0x52) === 0x7f && sim.lastLed(0x91, 0x00) === 0x7f);
  await sim.send('pad A fx 1');
  check('pad FX 1 de nouveau : emplacement 1 coupé, LED éteinte', !(await state(0)).slots[0].on && sim.lastLed(0x96, 0x50) === 0x00);

  const before = (await state(0)).slots.map((s) => s.type);
  await sim.send('pad A fx 5');
  await sim.send('pad A fx 6');
  await sim.send('pad A fx 7');
  a = await state(0);
  sa = await screen(0);
  check('pads FX 5 à 7 (0x96 0x54..0x56) : effet suivant des emplacements 1 à 3',
    a.slots.every((s, i) => s.type === next(before[i])), `${before} -> ${a.slots.map((s) => s.type)}`);
  check('effet suivant : listes à l\'écran à jour', sa.slots.every((s, i) => s.type === a.slots[i].type));
  const last = types[types.length - 1];
  await page.eval(`(() => { const s = document.querySelectorAll('.deck[data-deck="0"] .fx-slot select')[0]; s.value = ${JSON.stringify(last)}; s.dispatchEvent(new Event('change')); })()`);
  await sim.send('pad A fx 5');
  check('effet suivant du dernier effet : retour au premier', (await state(0)).slots[0].type === types[0]);
  await tap('94', '00');
  check('SHIFT + FX (0x94 0x00) : effet suivant de l\'emplacement 3', (await state(0)).slots[2].type === next(a.slots[2].type));

  await sim.send('pad A fx 4');
  a = await state(0);
  check('pad FX 4 (0x96 0x53) : unité retirée du deck A, LED éteinte, bouton à l\'écran éteint',
    !a.enabled && sim.lastLed(0x96, 0x53) === 0x00 && !(await screen(0)).unit);
  check('unité retirée : deck B garde la sienne', (await state(1)).enabled && sim.lastLed(0x97, 0x53) === 0x7f);
  await page.eval(`document.querySelector('.deck[data-deck="0"] [data-act="fx.unit"]').click()`);
  await sleep(150);
  check('bouton « FX sur le deck » à l\'écran : unité réappliquée, LED 0x96 0x53 allumée', (await state(0)).enabled && sim.lastLed(0x96, 0x53) === 0x7f);
  await sim.send('pad B fx 2');
  check('pad FX 2 du deck B (0x97 0x51) : emplacement 2 du deck B, LED', (await state(1)).slots[1].on && sim.lastLed(0x97, 0x51) === 0x7f);

  // Sound: a unit not applied to its deck passes the signal dry, whatever its slots and its mix.
  const diff = await page.eval(`(async () => {
    const { FxUnit } = await import('/fx/unit.js');
    const SR = 48000;
    const signal = new Float32Array(SR);
    for (let i = 0; i < signal.length; i++) signal[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 3000 * i) / SR);
    const render = async (enabled) => {
      const ctx = new OfflineAudioContext(1, signal.length, SR);
      const buffer = ctx.createBuffer(1, signal.length, SR);
      buffer.copyToChannel(signal, 0);
      const src = new AudioBufferSourceNode(ctx, { buffer });
      const u = new FxUnit(ctx);
      for (const s of u.slots) s.setOn(true);
      u.slots[1].setParam(0);
      u.setEnabled(enabled);
      src.connect(u.input);
      u.output.connect(ctx.destination);
      src.start();
      const out = (await ctx.startRendering()).getChannelData(0);
      let sum = 0;
      for (let i = SR / 5; i < SR; i++) sum += (out[i] - signal[i]) ** 2;
      return Math.sqrt(sum / (SR * 0.8));
    };
    return { off: await render(false), on: await render(true) };
  })()`);
  check('unité retirée du deck : signal identique (écart RMS < 0,001)', diff.off < 0.001, diff.off.toExponential(2));
  check('unité appliquée, emplacements actifs : signal modifié', diff.on > 0.01, diff.on.toFixed(3));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
