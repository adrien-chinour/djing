// Scenario of the roll and beatjump pad pages (#42), from the simulated controller:
// - roll: pads 0x10..0x17 hold a loop of 1/8 to 16 beats with slip forced (SLIP off), the pad LED lit
//   while rolling; on release, playback resumes where it would have been; switching SLIP off during a
//   roll keeps its ghost position;
// - beatjump: pads 0x70..0x77 jump by -1, +1, -2, +2, -4, +4, -8, +8 beats;
// - without a beat grid, both do nothing and say so under the pads.

import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

const TOLERANCE = 0.02; // s, as for slip (#41)
const BEAT = 0.5; // s, grid of 120 BPM
const ROLL_BEATS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16];
const BEATJUMP_BEATS = [-1, 1, -2, 2, -4, 4, -8, 8];
const hex = (n) => n.toString(16).padStart(2, '0');

export default async function ({ page, sim }) {
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  const wav = join(tmp, 'roll-beatjump-tone.wav');
  writeTone(wav);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  check('titre chargé sur le deck A', await page.eval('!!window.djing.engine.decks[0].buffer'));

  await checkRoll(page, sim);
  await checkBeatjump(page, sim);
  await checkNoGrid(page, sim);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

const deck = 'window.djing.engine.decks[0]';
const fmt = (x) => x.toFixed(3);
const now = (page) => page.eval(`(() => { const d = ${deck}; return { p: d.position, head: d.playhead, t: d.engine.ctx.currentTime, loop: d.loop, slip: d.slip, ghost: d.slipPosition, playing: d.playing }; })()`);
/** Position now minus where an uninterrupted playback from `ref` would be. */
const drift = (s, ref) => s.p - (ref.p + (s.t - ref.t));
const screenLed = (page, name) => page.eval(`document.querySelector('.deck[data-deck="0"] [data-led="${name}"]').classList.contains('on')`);
const notice = (page) => page.eval(`document.querySelector('.deck[data-deck="0"] .notice').textContent`);

async function checkRoll(page, sim) {
  await page.eval(`${deck}.grid = { bpm: 120, firstBeat: 0 }; ${deck}.quantize = false; ${deck}.seek(1.2); ${deck}.play();`);
  await sleep(300);
  check('SLIP coupé au départ', !(await page.eval(`${deck}.slip`)));

  // Pad 4 (0x13): 1-beat roll held 2 s.
  const ref = await now(page);
  await sim.send('note 96 13 7f', 100);
  let s = await now(page);
  check('roll 1 temps : boucle de 0,5 s active', s.loop && Math.abs(s.loop.end - s.loop.start - BEAT) < 1e-6, JSON.stringify(s.loop));
  check('roll : LED du pad allumée (platine et écran)', sim.lastLed(0x96, 0x13) === 0x7f && (await screenLed(page, 'roll.3')));
  check('roll : slip forcé (position fantôme) sans activer SLIP', s.ghost !== null && !s.slip);
  let inLoop = true;
  for (let i = 0; i < 4; i++) {
    await sleep(450);
    s = await now(page);
    inLoop &&= s.loop && s.head >= s.loop.start - 0.01 && s.head <= s.loop.end + 0.01;
  }
  check('roll maintenu : la lecture reste dans la boucle', inLoop, `${fmt(s.head)} s`);
  await sim.send('note 96 13 00', 100);
  s = await now(page);
  check('roll relâché : boucle quittée, LED éteinte', !s.loop && sim.lastLed(0x96, 0x13) === 0x00 && !(await screenLed(page, 'roll.3')));
  check('roll relâché : reprise à ±20 ms de la position sans roll', s.playing && Math.abs(drift(s, ref)) <= TOLERANCE,
    `position ${fmt(s.p)} s, écart ${fmt(drift(s, ref))} s`);
  check('roll relâché : plus de position fantôme', s.ghost === null);

  // Every length, pads 1..8.
  const lengths = [];
  for (let n = 0; n < ROLL_BEATS.length; n++) {
    await page.eval(`${deck}.seek(0.6)`);
    await sim.send(`note 96 ${hex(0x10 + n)} 7f`, 80);
    const r = await now(page);
    lengths.push(r.loop ? (r.loop.end - r.loop.start) / BEAT : null);
    await sim.send(`note 96 ${hex(0x10 + n)} 00`, 80);
  }
  check('pads roll 1..8 : 1/8, 1/4, 1/2, 1, 2, 4, 8, 16 temps', lengths.every((l, n) => l !== null && Math.abs(l - ROLL_BEATS[n]) < 1e-6), JSON.stringify(lengths));

  // SLIP switched off during a roll: the roll still goes back to its ghost position.
  await page.eval(`${deck}.seek(1.2)`);
  await sim.send('note 91 01 7f', 30);
  await sim.send('note 91 01 00', 100);
  const ref2 = await now(page);
  await sim.send('note 96 13 7f', 600);
  await sim.send('note 91 01 7f', 30);
  await sim.send('note 91 01 00', 600);
  await sim.send('note 96 13 00', 100);
  s = await now(page);
  check('SLIP coupé pendant un roll : reprise à la position sans roll (±20 ms)', !s.slip && !s.loop && Math.abs(drift(s, ref2)) <= TOLERANCE,
    `écart ${fmt(drift(s, ref2))} s`);
  await page.eval(`${deck}.stop()`);
}

async function checkBeatjump(page, sim) {
  const moves = [];
  for (let n = 0; n < BEATJUMP_BEATS.length; n++) {
    await page.eval(`${deck}.seek(5)`);
    await sim.send(`note 96 ${hex(0x70 + n)} 7f`, 30);
    await sim.send(`note 96 ${hex(0x70 + n)} 00`, 80);
    moves.push(Number(((await page.eval(`${deck}.playhead`)) - 5).toFixed(4)) / BEAT);
  }
  check('pads beatjump 1..8 : −1, +1, −2, +2, −4, +4, −8, +8 temps (deck arrêté)',
    moves.every((m, n) => Math.abs(m - BEATJUMP_BEATS[n]) < 1e-3), JSON.stringify(moves));

  await page.eval(`${deck}.seek(3); ${deck}.play();`);
  await sleep(200);
  const before = await now(page);
  await sim.send('note 96 73 7f', 30);
  await sim.send('note 96 73 00', 30);
  const after = await now(page);
  const moved = after.p - before.p - (after.t - before.t);
  check('beatjump +2 temps en lecture', after.playing && Math.abs(moved - 2 * BEAT) <= TOLERANCE, `saut ${fmt(moved)} s`);
  await page.eval(`${deck}.stop()`);
}

async function checkNoGrid(page, sim) {
  await page.eval(`${deck}.grid = null; ${deck}.seek(4)`);
  await sim.send('note 96 13 7f', 100);
  let s = await now(page);
  const rollNotice = await notice(page);
  check('sans grille : pas de roll, LED éteinte', !s.loop && s.ghost === null && sim.lastLed(0x96, 0x13) !== 0x7f);
  check('sans grille : roll signalé à l\'écran', /Roll impossible : pas de grille/.test(rollNotice), rollNotice);
  await sim.send('note 96 13 00', 50);
  await sim.send('note 96 71 7f', 30);
  await sim.send('note 96 71 00', 80);
  s = await now(page);
  const jumpNotice = await notice(page);
  check('sans grille : pas de beatjump', Math.abs(s.head - 4) < 1e-6, `${fmt(s.head)} s`);
  check('sans grille : beatjump signalé à l\'écran', /Beatjump impossible : pas de grille/.test(jumpNotice), jumpNotice);
}
