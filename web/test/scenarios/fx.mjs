// Scenario of the deck effect units (web/fx/, #45):
// - the FxUnit alone in an OfflineAudioContext, sample-exact: a slot off or a dry/wet at 0 leaves the
//   signal untouched, every effect changes it once on, the echo repeats one beat later;
// - the units of the running page, driven by the on-screen controls of deck A, measured on MAIN.

import { join } from 'node:path';
import { check, pickFile, recordRms, sleep, tmp, writeTone } from '../lib.mjs';

export default async function ({ page }) {
  await checkUnitOffline(page);
  await checkUnitLive(page);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

/** Page-side helpers: render a mono signal through a fresh FxUnit configured by `setup(unit)`. */
const HELPERS = `
  const { FxUnit } = await import('/fx/unit.js');
  const { EFFECTS } = await import('/fx/effects.js');
  const SR = 48000;
  const render = async (signal, setup, tempo = null) => {
    const ctx = new OfflineAudioContext(1, signal.length, SR);
    const buffer = ctx.createBuffer(1, signal.length, SR);
    buffer.copyToChannel(signal, 0);
    const src = new AudioBufferSourceNode(ctx, { buffer });
    const unit = new FxUnit(ctx, { tempo: () => tempo });
    setup(unit);
    src.connect(unit.input);
    unit.output.connect(ctx.destination);
    src.start();
    return (await ctx.startRendering()).getChannelData(0);
  };
  // RMS of (out - in) after the first 0.2 s (parameter glides settle within 50 ms).
  const rmsDiff = (out, input) => {
    let sum = 0;
    const from = Math.round(0.2 * SR);
    for (let i = from; i < input.length; i++) sum += (out[i] - input[i]) ** 2;
    return Math.sqrt(sum / (input.length - from));
  };
  // Music-like test signal: two sines and some noise, 2 s.
  const music = new Float32Array(2 * SR);
  for (let i = 0; i < music.length; i++) {
    music[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 3000 * i) / SR) + 0.1 * (Math.random() * 2 - 1);
  }
  // Click track: a 1 ms click every beat from 0.1 s.
  const clicks = (bpm, seconds) => {
    const out = new Float32Array(Math.round(seconds * SR));
    for (let t = 0.1; t < seconds; t += 60 / bpm) for (let j = 0; j < 48; j++) out[Math.round(t * SR) + j] = 0.8;
    return out;
  };
  // Seconds between the first click (0.1 s) and the first sample of its first repeat (out - in).
  const repeatAfter = (out, input) => {
    for (let i = 0; i < input.length; i++) if (Math.abs(out[i] - input[i]) > 0.05) return i / SR - 0.1;
    return null;
  };
`;

const run = (page, body) => page.eval(`(async () => { ${HELPERS} ${body} })()`);

async function checkUnitOffline(page) {
  const identity = await run(page, `
    const result = {};
    for (const type of Object.keys(EFFECTS)) {
      const off = await render(music, (u) => { u.slots[0].setEffect(type); u.slots[0].setParam(0.8); });
      const dry = await render(music, (u) => { u.slots[0].setEffect(type); u.slots[0].setParam(0.8); u.slots[0].setOn(true); u.setMix(0); });
      const wet = await render(music, (u) => { u.slots[0].setEffect(type); u.slots[0].setParam(0.8); u.slots[0].setOn(true); });
      result[type] = { off: rmsDiff(off, music), dry: rmsDiff(dry, music), wet: rmsDiff(wet, music) };
    }
    return result;`);
  for (const [type, r] of Object.entries(identity)) {
    check(`${type} coupé : signal identique (écart RMS < 0,001)`, r.off < 0.001, r.off.toExponential(2));
    check(`${type} actif, dry/wet à 0 : signal identique (écart RMS < 0,001)`, r.dry < 0.001, r.dry.toExponential(2));
    check(`${type} actif, dry/wet à 1 : signal modifié`, r.wet > 0.01, r.wet.toFixed(3));
  }

  const echo = await run(page, `
    const at = async (bpm, tempo, param) => {
      const input = clicks(bpm, 3);
      const out = await render(input, (u) => { u.slots[0].setEffect('echo'); u.slots[0].setParam(param); u.slots[0].setOn(true); }, tempo);
      return repeatAfter(out, input);
    };
    return { beat120: await at(120, 120, 0.5), noBpm: await at(120, null, 0.5), beat100: await at(100, 100, 0.5),
      quarter: await at(120, 120, 0), two: await at(120, 120, 1) };`);
  const ms = (s) => (s === null ? 'aucune' : `${(s * 1000).toFixed(2)} ms`);
  check('écho 1 temps, clics à 120 BPM : répétition à 500 ms ±5 ms', echo.beat120 !== null && Math.abs(echo.beat120 - 0.5) <= 0.005, ms(echo.beat120));
  check('écho sans BPM : 500 ms', echo.noBpm !== null && Math.abs(echo.noBpm - 0.5) <= 0.005, ms(echo.noBpm));
  check('écho 1 temps à 100 BPM : 600 ms', echo.beat100 !== null && Math.abs(echo.beat100 - 0.6) <= 0.005, ms(echo.beat100));
  check('écho 1/4 de temps à 120 BPM : 125 ms', echo.quarter !== null && Math.abs(echo.quarter - 0.125) <= 0.005, ms(echo.quarter));
  check('écho 2 temps à 120 BPM : 1 s', echo.two !== null && Math.abs(echo.two - 1) <= 0.005, ms(echo.two));
}

async function checkUnitLive(page) {
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deckA = (sel) => q(`.deck[data-deck="0"] ${sel}`);
  const slot = (i, sel) => `document.querySelectorAll('.deck[data-deck="0"] .fx-slot')[${i}].querySelector(${JSON.stringify(sel)})`;
  const slide = (input, v) => page.eval(`(() => { const el = ${input}; el.value = ${v}; el.dispatchEvent(new Event('input')); })()`);

  check('deux unités de 3 emplacements à l\'écran', await page.eval(`[0, 1].every((d) => document.querySelectorAll('.deck[data-deck="' + d + '"] .fx-slot').length === 3)`));
  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  await pickFile(page, 0, wav); // waits for the analysis, which would replace the BPM set below
  await page.eval(`window.djing.engine.setCrossfader(0)`);
  await page.eval(`${deckA('[data-act=play]')}.click()`);
  await sleep(300);
  const fmt = (rms) => rms.map((v) => v.toFixed(3)).join(' ');
  const base = await recordRms(1000);
  check('deck A sur MAIN, effets coupés', base[0] > 0.05, fmt(base));

  // Slot 2: resonant filter, lowpass at the bottom of its range, on a 220 Hz tone.
  await page.eval(`(() => { const s = ${slot(1, 'select')}; s.value = 'filter'; s.dispatchEvent(new Event('change')); })()`);
  await slide(slot(1, 'input'), 0);
  await page.eval(`${slot(1, 'button')}.click()`);
  await sleep(200);
  check('bouton FX 2 allumé', await page.eval(`${slot(1, 'button')}.classList.contains('on')`));
  const filtered = await recordRms(1000);
  check('filtre passe-bas actif : MAIN atténué', filtered[0] < base[0] * 0.2, fmt(filtered));

  await slide(deckA('.fx input'), 0);
  await sleep(200);
  const dry = await recordRms(1000);
  check('dry/wet à 0 : MAIN comme sans effet', Math.abs(dry[0] - base[0]) < base[0] * 0.05, fmt(dry));

  await slide(deckA('.fx input'), 1);
  await page.eval(`${slot(1, 'button')}.click()`);
  await sleep(200);
  const off = await recordRms(1000);
  check('filtre coupé : MAIN comme sans effet', Math.abs(off[0] - base[0]) < base[0] * 0.05, fmt(off));
  await page.eval(`${deckA('[data-act=play]')}.click()`);

  const tempo = await page.eval(`(() => { const deck = window.djing.engine.decks[0]; const before = deck.fx.tempo(); deck.setBpm(120); deck.setRate(1); return { before, after: deck.fx.tempo() }; })()`);
  check('tempo des effets : aucun sans BPM, BPM × pitch sinon', tempo.before === null && Math.abs(tempo.after - 120 * 1.08) < 1e-9, JSON.stringify(tempo));
}
