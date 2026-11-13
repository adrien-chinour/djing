// Scenario of the toneplay pad page (#44), from the simulated controller, as DJCi300.toneplay of the
// Hercules script shipped with Mixxx:
// - pads 0x40..0x47 jump to hotcue 1 and transpose by +0, +1, +2, +3, -4, -3, -2, -1 semitones;
//   SHIFT + pad (0x48..0x4F) only transposes;
// - without hotcue 1, a pad sets it at the position heard, then acts;
// - the transposition goes through setTranspose (#39), keylock forced while it holds: the pitch fader
//   does not change the note; another transposition command ends it;
// - LEDs: the pad of the current transposition (clamped to -4..+3), with and without SHIFT.
// The frequency of a 220 Hz sine is measured on the deck's signal.

import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

const SEMITONES = [0, 1, 2, 3, -4, -3, -2, -1];
const BASE = 220; // Hz, writeTone
const hex = (n) => n.toString(16).padStart(2, '0');
const deck = 'window.djing.engine.decks[0]';
const q = (sel) => `document.querySelector(${JSON.stringify(`.deck[data-deck="0"] ${sel}`)})`;
const fmt = (x) => x.toFixed(3);
const hz = (f) => `${f.toFixed(2)} Hz`;
const note = (s) => BASE * 2 ** (s / 12);

export default async function ({ page, sim }) {
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  // The page sends every LED once the controller is connected: wait for them (up to 5 s).
  for (let i = 0; i < 50 && sim.lastLed(0x96, 0x48) === undefined; i++) await sleep(100);
  check('LED toneplay pad 1 allumée au démarrage (transposition 0)', sim.lastLed(0x96, 0x40) === 0x7f && sim.lastLed(0x96, 0x48) === 0x7f,
    `${sim.lastLed(0x96, 0x40)} ${sim.lastLed(0x96, 0x48)}`);
  const wav = join(tmp, 'toneplay-tone.wav');
  writeTone(wav);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1500);
  check('titre chargé sur le deck A', await page.eval(`!!${deck}.buffer`));

  // Analyser on the deck signal, and the median period of its rising zero crossings (as keylock.mjs).
  await page.eval(`(() => {
    const d = ${deck};
    const a = d.engine.ctx.createAnalyser();
    a.fftSize = 32768;
    d.filter.connect(a);
    window.__freq = () => {
      const x = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(x);
      const t = [];
      for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) t.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
      const periods = t.slice(1).map((v, i) => v - t[i]).sort((p, r) => p - r);
      return a.context.sampleRate / periods[periods.length >> 1];
    };
  })()`);
  const freq = async (settle = 1000) => {
    await sleep(settle);
    return page.eval('window.__freq()');
  };
  const state = () => page.eval(`(() => { const d = ${deck}; return { p: d.position, head: d.playhead, t: d.engine.ctx.currentTime, playing: d.playing, transpose: d.transpose, keylock: d.keylock, keylocked: d.keylocked, speed: d.speed }; })()`);
  const hotcue1 = () => page.eval(`(() => { const p = ${q('[data-led="hotcue.0"]')}.dataset.position; return p === '' ? null : Number(p); })()`);
  const pad = async (number, settle = 100) => {
    await sim.send(`note 96 ${hex(number)} 7f`, 30);
    await sim.send(`note 96 ${hex(number)} 00`, settle);
  };

  // Mode toneplay on deck A, pitch fader at the top (+8 %): without keylock the note would be higher.
  await sim.send('note 91 13 7f', 30);
  await sim.send('note 91 13 00', 100);
  await page.eval(`${deck}.setRate(1)`);
  check('keylock coupé au départ', !(await page.eval(`${deck}.keylock`)));

  // No hotcue 1: pad 3 (+2) sets it where the deck stands, then jumps there and transposes.
  await page.eval(`${deck}.seek(2)`);
  await sleep(200);
  check('pas de hotcue 1 au départ', (await hotcue1()) === null);
  await pad(0x42);
  let cue = await hotcue1();
  let s = await state();
  check('sans hotcue 1 : pad 3 le pose à la position courante (2 s)', Math.abs(cue - 2) < 0.01, `${fmt(cue)} s`);
  check('LED hotcue 1 allumée', sim.lastLed(0x96, 0x00) === 0x7f);
  check('pad 3 : transposition +2, deck arrêté reste arrêté', s.transpose === 2 && !s.playing, JSON.stringify(s));
  check('pad 3 : keylock forcé, réglage KEYLOCK inchangé, LED KEYLOCK allumée',
    s.keylocked && !s.keylock && (await page.eval(`${q('[data-led=keylock]')}.classList.contains('on')`)));
  check('pad 3 : seule la LED toneplay 3 allumée (0x42 et 0x4A)',
    SEMITONES.every((_, n) => (sim.lastLed(0x96, 0x40 + n) === 0x7f) === (n === 2) && (sim.lastLed(0x96, 0x48 + n) === 0x7f) === (n === 2)),
    SEMITONES.map((_, n) => sim.lastLed(0x96, 0x40 + n)).join(' '));
  check('pad 3 : bouton +2 allumé à l\'écran', await page.eval(`${q('[data-led="toneplay.2"]')}.classList.contains('on')`));
  check('transposition +2 affichée sous le deck', await page.eval(`${q('.transpose')}.textContent === '+2 dt' && ${q('[data-knob=transpose]')}.value === '2'`));

  await page.eval(`${deck}.play()`);
  let f = await freq();
  check(`pad 3 à +8 % : ${hz(note(2))} ±2 (keylock forcé)`, Math.abs(f - note(2)) <= 2, hz(f));

  // Pad 6 (−3) while playing: jumps back to hotcue 1.
  s = await state();
  await pad(0x45, 50);
  const after = await state();
  check('pad 6 en lecture : saut au hotcue 1', after.playing && Math.abs(after.head - cue) < 0.2, `avant ${fmt(s.head)} s, après ${fmt(after.head)} s`);
  f = await freq();
  check(`pad 6 : ${hz(note(-3))} ±2`, Math.abs(f - note(-3)) <= 2, hz(f));

  // SHIFT + pad 2 (0x49, +1): transposes without jumping.
  s = await state();
  await pad(0x49, 50);
  const shifted = await state();
  const moved = shifted.head - s.head - (shifted.t - s.t) * s.speed;
  check('SHIFT + pad 2 : pas de saut', Math.abs(moved) < 0.1, `écart ${fmt(moved)} s`);
  check('SHIFT + pad 2 : transposition +1, keylock forcé, LED 0x41 et 0x49',
    shifted.transpose === 1 && shifted.keylocked && sim.lastLed(0x96, 0x41) === 0x7f && sim.lastLed(0x96, 0x49) === 0x7f && sim.lastLed(0x96, 0x45) === 0x00);
  f = await freq();
  check(`SHIFT + pad 2 : ${hz(note(1))} ±2`, Math.abs(f - note(1)) <= 2, hz(f));

  // Every pad: its transposition and its LED.
  const got = [];
  let leds = true;
  for (let n = 0; n < SEMITONES.length; n++) {
    await pad(0x40 + n, 60);
    got.push(await page.eval(`${deck}.transpose`));
    leds &&= sim.lastLed(0x96, 0x40 + n) === 0x7f && sim.lastLed(0x96, 0x48 + n) === 0x7f;
  }
  check('pads 1..8 : +0, +1, +2, +3, −4, −3, −2, −1 demi-tons', got.every((v, n) => v === SEMITONES[n]), JSON.stringify(got));
  check('pads 1..8 : LED du pad joué (avec et sans SHIFT)', leds);

  // Another transposition command ends the forced keylock; LEDs clamp to +3.
  await page.eval(`(() => { const i = ${q('[data-knob=transpose]')}; i.value = 5; i.dispatchEvent(new Event('input')); })()`);
  await sleep(100);
  s = await state();
  check('transposition +5 au bouton à l\'écran : keylock plus forcé', s.transpose === 5 && !s.keylocked, JSON.stringify(s));
  check('transposition +5 : LED du pad 4 (+3, borne)', sim.lastLed(0x96, 0x43) === 0x7f && sim.lastLed(0x96, 0x4b) === 0x7f && sim.lastLed(0x96, 0x47) === 0x00);
  f = await freq();
  const expected = note(5) * s.speed;
  check(`sans keylock, +5 à +8 % : ${hz(expected)} ±2.5`, Math.abs(f - expected) <= 2.5, hz(f));

  // Screen buttons: click = toneplay, Maj + click = transposition only.
  await page.eval(`${q('[data-led="toneplay.4"]')}.click()`);
  await sleep(100);
  s = await state();
  check('bouton −4 à l\'écran : saut au hotcue 1, transposition −4, keylock forcé',
    s.transpose === -4 && s.keylocked && Math.abs(s.head - cue) < 0.2, JSON.stringify(s));
  await page.eval(`${deck}.stop(); ${deck}.setRate(0)`);
  await page.eval(`${deck}.seek(6)`);
  await page.eval(`${q('[data-led="toneplay.0"]')}.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))`);
  await sleep(100);
  s = await state();
  check('Maj + clic sur +0 : transposition 0 sans saut', s.transpose === 0 && Math.abs(s.head - 6) < 0.01, JSON.stringify(s));
  await page.eval(`${deck}.setTranspose(0)`);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
