// Scenario of scratch and vinyl mode (#40): VINYL button and LED, scratch with the touched wheel
// (speed follows the wheel, stops with it, back to the pitch fader on release), POC nudge outside
// vinyl mode or on the wheel edge, SHIFT + wheel as a search 4 times faster than a scratch.

import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

export default async function ({ page, sim }) {
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deck = 'window.djing.engine.decks[0]';
  const get = (expr) => page.eval(`(() => { const d = ${deck}; return ${expr}; })()`);
  const position = () => get('d.position');

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  check('titre chargé sur le deck A', await get('!!d.buffer'));

  const { ticksPerRev, tick, seekMultiplier } = await page.eval(`import('/engine.js').then((m) => ({ ticksPerRev: m.TICKS_PER_REV, tick: m.TICK_SECONDS, seekMultiplier: m.SEEK_MULTIPLIER }))`);
  check('constantes de Mixxx : 248 tics par tour, 33 ⅓ tr/min, SHIFT ×4', ticksPerRev === 248 && Math.abs(tick * 248 - 1.8) < 1e-9 && seekMultiplier === 4);

  // VINYL: on at start, toggled by the button, LED follows.
  check('mode vinyle actif au démarrage', await get('d.vinyl') && await page.eval('window.djing.engine.decks[1].vinyl'));
  check('LED VINYL allumée au démarrage sur les deux decks', sim.lastLed(0x91, 0x03) === 0x7f && sim.lastLed(0x92, 0x03) === 0x7f);
  await sim.send('press A vinyl');
  check('VINYL coupe le mode vinyle du deck A, LED éteinte', !(await get('d.vinyl')) && sim.lastLed(0x91, 0x03) === 0x00);
  check('le deck B garde son mode vinyle', sim.lastLed(0x92, 0x03) === 0x7f);
  await sim.send('press A vinyl');
  check('VINYL le réactive, LED allumée', await get('d.vinyl') && sim.lastLed(0x91, 0x03) === 0x7f);

  // Scratch on a stopped deck: 100 ticks in 0.5 s, then the wheel stays still under the hand.
  await page.eval(`${deck}.seek(2)`);
  await sleep(100);
  const p0 = await position();
  await sim.send('touch A on', 50);
  await page.eval(`window.__scratch40 = []; window.__scratch40Timer = setInterval(() => window.__scratch40.push(${deck}.speed), 10)`);
  await sim.send('jog A 100 touched 500', 900);
  const p1 = await position();
  await sleep(200);
  const p2 = await position();
  const speeds = await page.eval('clearInterval(window.__scratch40Timer), window.__scratch40');
  const moved = p1 - p0;
  const expected = 100 * tick;
  check('100 tics en 0,5 s jog touché : déplacement de 100/248 tour à 5 % près', Math.abs(moved - expected) <= 0.05 * expected,
    `${moved.toFixed(4)} s pour ${expected.toFixed(4)} s attendues`);
  const peak = Math.max(...speeds);
  check('la vitesse suit la roue (environ 200 tics/s → ×1,45)', peak > 1.2 && peak < 2, `vitesse max ${peak.toFixed(2)}`);
  check('roue arrêtée sous la main : lecture arrêtée', Math.abs(p2 - p1) < 0.002 && (await get('d.speed')) === 0, `${p1.toFixed(4)} -> ${p2.toFixed(4)}`);
  await sim.send('jog A -50 touched 250', 600);
  const p3 = await position();
  check('scratch en arrière', Math.abs(p2 - p3 - 50 * tick) <= 0.05 * 50 * tick, `${(p2 - p3).toFixed(4)} s pour ${(50 * tick).toFixed(4)} s`);
  await sim.send('touch A off', 200);
  check('relâché à l\'arrêt : le deck reste arrêté là où la roue l\'a laissé', !(await get('d.playing')) && !(await get('d.running')) && Math.abs((await position()) - p3) < 0.002);

  // Playing deck: touching the wheel holds the track, releasing it resumes at the pitch fader speed.
  await sim.send('rate A 1');
  const rate = await get('d.rate');
  await sim.send('press A play', 300);
  await sim.send('touch A on', 200);
  const h0 = await position();
  await sleep(300);
  const h1 = await position();
  check('deck en lecture, jog touché immobile : la lecture s\'arrête', Math.abs(h1 - h0) < 0.002, `${h0.toFixed(4)} -> ${h1.toFixed(4)}`);
  check('la LED PLAY reste allumée pendant le scratch', sim.lastLed(0x91, 0x07) === 0x7f);
  await sim.send('touch A off', 100);
  const r0 = await position();
  await sleep(500);
  const r1 = await position();
  check('relâché : reprise à la vitesse du pitch fader', (await get('d.speed')) === rate && rate !== 1 && Math.abs((r1 - r0) / 0.5 - rate) < 0.1,
    `vitesse ${await get('d.speed')}, pitch ${rate}, ${((r1 - r0) / 0.5).toFixed(3)} s/s mesurés`);
  await sim.send('rate A 0');

  // Wheel edge (0x09) in vinyl mode: POC nudge (bend), no scratch.
  await page.eval(`window.__bend40 = 0; window.__bend40Timer = setInterval(() => { window.__bend40 = Math.max(window.__bend40, ${deck}.bend); }, 2)`);
  await sim.send('jog A 10', 100);
  const bend = await page.eval('clearInterval(window.__bend40Timer), window.__bend40');
  check('tranche du jog en mode vinyle : nudge du POC', bend > 0 && !(await get('d.scratch')), `bend max ${bend}`);

  // Vinyl off: touched wheel does the POC jog (search by 0.02 s per tick), no scratch.
  await sim.send('press A vinyl');
  await sim.send('touch A on', 50);
  const v0 = await position();
  await sim.send('jog A 10 touched', 100);
  const v1 = await position();
  check('hors mode vinyle, jog touché : comportement du POC, pas de scratch', !(await get('d.scratch')) && v1 - v0 > 0.2 && v1 - v0 < 0.4 && (await get('d.playing')),
    `${(v1 - v0).toFixed(3)} s`);
  await sim.send('touch A off', 50);
  await sim.send('press A vinyl');
  await sim.send('press A play', 200);

  // SHIFT + wheel: 25 ticks move as far as 100 scratch ticks (over 0.5 s: the worklet caps speed at 4).
  const s0 = await position();
  await sim.send('jog A 25 shift 500', 900);
  const s1 = await position();
  check('SHIFT + jog : 4 fois plus vite qu\'un scratch (25 tics = 100 tics de scratch, à 5 % près)',
    Math.abs(s1 - s0 - expected) <= 0.05 * expected, `${(s1 - s0).toFixed(4)} s pour ${expected.toFixed(4)} s`);
  check('SHIFT + jog : la recherche se termine quand la roue s\'arrête', !(await get('d.scratch')) && !(await get('d.playing')));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
