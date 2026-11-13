// Scenario of the slicer and slicer loop pad modes (#43), as DJCi300.deck[n].slicerPad of the Hercules
// script shipped with Mixxx:
// - without a beat grid, SLICER does nothing and the deck says "pas de grille";
// - SLICER (0x91 0x11) turns the slicer on: window of 8 beats from the beat nearest to the position,
//   8 slices of one beat, loop off; the LED of the current slice (0x96 0x20..0x27) follows playback,
//   and the window moves 8 beats forward once playback leaves it;
// - pads held (0x20..0x27): loop from the first to the last held slice, jump to its start, held pads
//   lit; all released: loop off, playback goes on, LED back on the current slice;
// - SLICER LOOP (0x91 0x15) while the slicer is on turns it off (changeMode of the script); pressed again:
//   the window is the active loop and playback stays in it, LEDs on 0x60..0x67, slicer page off;
//   a pad (0x60..0x67) released brings the loop back to the window;
// - a loop set by another control (LOOP OUT) or another pad mode turns the slicer off.

import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

const SLICER = '11';
const SLICER_LOOP = '15';
const HOTCUE = '0f';
const BEAT = 0.25; // 240 BPM
const FIRST_BEAT = 0.1;

export default async function ({ page, sim }) {
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  check('titre chargé sur le deck A', await page.eval('!!window.djing.engine.decks[0].buffer'));

  const deck = 'window.djing.engine.decks[0]';
  const state = () => page.eval(`(() => { const d = ${deck}; const s = window.djing.ctx.slicer[0];
    return { loop: d.loop, position: d.position, playing: d.playing, slices: s.slices, beat: s.beat,
      status: document.querySelector('.deck[data-deck="0"] .slicer-status').textContent,
      screen: [...document.querySelectorAll('.deck[data-deck="0"] .slicer button')].map((b) => b.classList.contains('on')) }; })()`);
  const mode = (number) => sim.send(`note 91 ${number} 7f`, 30).then(() => sim.send(`note 91 ${number} 00`));
  const pad = (number, down) => sim.send(`note 96 ${number} ${down ? '7f' : '00'}`);
  const hex = (n) => n.toString(16).padStart(2, '0');
  /** Pads lit on the controller page starting at `first` (0x20 slicer, 0x60 slicer loop). */
  const litPads = (first) => Array.from({ length: 8 }, (_, n) => n).filter((n) => sim.lastLed(0x96, first + n) === 0x7f);
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

  // No beat grid: the mode stays off and says so.
  await page.eval(`${deck}.grid = null; ${deck}.seek(1.02);`);
  await mode(SLICER);
  let s = await state();
  check('sans grille : slicer inactif, signalé à l\'écran', !s.slices && /pas de grille/.test(s.status) && litPads(0x20).length === 0, s.status);

  // Slicer: window and slices from the nearest beat (1.02 s -> 1.1 s).
  await page.eval(`${deck}.grid = { bpm: 240, firstBeat: ${FIRST_BEAT} };`);
  await mode(SLICER);
  s = await state();
  const expected = Array.from({ length: 8 }, (_, n) => ({ start: 1.1 + n * BEAT, end: 1.1 + (n + 1) * BEAT }));
  check('slicer : fenêtre de 8 temps depuis le temps le plus proche, 8 tranches d\'un temps',
    s.slices?.length === 8 && s.slices.every((sl, n) => near(sl.start, expected[n].start) && near(sl.end, expected[n].end)),
    JSON.stringify(s.slices?.map((sl) => sl.start.toFixed(3))));
  check('slicer : pas de boucle', !s.loop);
  check('slicer : LED de la première tranche (platine et écran)', litPads(0x20).join() === '0' && s.screen.join() === [true, ...Array(7).fill(false)].join(),
    `platine ${litPads(0x20)}, écran ${s.screen}`);

  // Playback: the lit pad is the slice heard, then the window moves forward.
  await page.eval(`${deck}.play()`);
  const seen = [];
  let matches = 0;
  let samples = 0;
  const windowStart = 1.1;
  for (let i = 0; i < 16; i++) {
    await sleep(110);
    const { position } = await state();
    const lit = litPads(0x20);
    const offset = position - windowStart;
    const expectedPad = Math.max(0, Math.min(7, Math.floor(offset / BEAT)));
    const edge = Math.abs(offset / BEAT - Math.round(offset / BEAT)) * BEAT < 0.04; // close to a slice boundary
    if (position < windowStart + 8 * BEAT && !edge) {
      samples++;
      if (lit.length === 1 && lit[0] === expectedPad) matches++;
    }
    if (lit.length === 1 && seen.at(-1) !== lit[0]) seen.push(lit[0]);
  }
  check('la LED de la tranche en cours suit la lecture', samples >= 8 && matches === samples, `${matches}/${samples} relevés, suite ${seen.join(' ')}`);
  check('LED des tranches dans l\'ordre', seen.slice(0, 6).every((n, i) => n === i), seen.join(' '));
  await sleep(600);
  s = await state();
  check('slicer : la fenêtre avance de 8 temps en sortant', s.slices && near(s.slices[0].start, 3.1) && s.position >= 3.1 && s.position < 5.1 && !s.loop,
    `fenêtre ${s.slices?.[0].start.toFixed(3)} s, position ${s.position.toFixed(3)} s`);

  // Pads held: loop over the held slices.
  const win = s.slices;
  // Pad 1: its slice is behind the position heard (past it), so staying in it proves the jump.
  const before = (await state()).position;
  await pad('20', true);
  s = await state();
  check('pad tenu : boucle sur sa tranche, saut en arrière dans la tranche',
    before > win[0].end && s.loop && near(s.loop.start, win[0].start) && near(s.loop.end, win[0].end)
    && s.position >= win[0].start - 0.01 && s.position <= win[0].end + 0.01 && litPads(0x20).join() === '0',
    `${JSON.stringify(s.loop)}, position ${before.toFixed(3)} → ${s.position.toFixed(3)} s, LED ${litPads(0x20)}`);
  await pad('22', true);
  s = await state();
  check('deux pads tenus : boucle de la première à la dernière tranche, pads allumés entre les deux',
    s.loop && near(s.loop.start, win[0].start) && near(s.loop.end, win[2].end) && litPads(0x20).join() === '0,1,2',
    `${JSON.stringify(s.loop)}, LED ${litPads(0x20)}`);
  let inside = true;
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const p = (await state()).position;
    inside &&= p >= win[0].start - 0.01 && p <= win[2].end + 0.01;
  }
  check('pads tenus : la lecture reste dans les tranches tenues (1 s)', inside);
  await pad('20', false);
  await pad('22', false);
  s = await state();
  await sleep(300);
  const after = await state();
  check('pads relâchés : plus de boucle, la lecture continue, LED sur la tranche en cours',
    !s.loop && after.playing && litPads(0x20).length === 1
    && [0, 0.04].some((lag) => litPads(0x20)[0] === Math.min(7, Math.floor((after.position - lag - win[0].start) / BEAT))),
    `position ${after.position.toFixed(3)} s, LED ${litPads(0x20)}`);

  // Slicer loop: SLICER LOOP while on turns the slicer off (changeMode), pressed again it loops the window.
  await mode(SLICER_LOOP);
  s = await state();
  check('SLICER LOOP pendant le slicer : slicer coupé (comme le script)', !s.slices && !s.loop && litPads(0x20).length === 0 && litPads(0x60).length === 0);
  await page.eval(`${deck}.seek(5.02)`);
  await mode(SLICER_LOOP);
  s = await state();
  check('slicer loop : la fenêtre de 8 temps est la boucle active', s.loop && near(s.loop.start, 5.1) && near(s.loop.end, 7.1)
    && s.slices && near(s.slices[7].end, 7.1), JSON.stringify(s.loop));
  inside = true;
  const loopSeen = [];
  for (let i = 0; i < 24; i++) {
    await sleep(110);
    const p = (await state()).position;
    inside &&= p >= 5.02 - 0.01 && p <= 7.1 + 0.01;
    const lit = litPads(0x60);
    if (lit.length === 1 && loopSeen.at(-1) !== lit[0]) loopSeen.push(lit[0]);
  }
  check('slicer loop : la lecture boucle sur la fenêtre (2,6 s, plus d\'un tour)', inside);
  check('slicer loop : la LED suit la lecture et revient à la première tranche', loopSeen.includes(7) && loopSeen.lastIndexOf(0) > loopSeen.indexOf(7), loopSeen.join(' '));
  check('slicer loop : page slicer éteinte', litPads(0x20).length === 0, `${litPads(0x20)}`);
  await pad('61', true);
  s = await state();
  check('slicer loop : pad tenu, boucle sur sa tranche', s.loop && near(s.loop.start, 5.35) && near(s.loop.end, 5.6) && litPads(0x60).join() === '1',
    `${JSON.stringify(s.loop)}, LED ${litPads(0x60)}`);
  await pad('61', false);
  s = await state();
  check('slicer loop : pad relâché, retour à la boucle de la fenêtre', s.loop && near(s.loop.start, 5.1) && near(s.loop.end, 7.1), JSON.stringify(s.loop));

  // Another control takes the loop: LOOP OUT leaves it, the slicer goes off.
  await sim.send('note 91 0a 7f', 30);
  await sim.send('note 91 0a 00');
  s = await state();
  check('LOOP OUT : boucle quittée, slicer coupé, LED éteintes', !s.loop && !s.slices && litPads(0x60).length === 0,
    `${JSON.stringify(s.loop)}, LED ${litPads(0x60)}`);

  // Another pad mode turns it off with its loop.
  await mode(SLICER_LOOP);
  s = await state();
  check('slicer loop réactivé', !!s.slices && !!s.loop);
  await mode(HOTCUE);
  s = await state();
  check('mode hotcue : slicer coupé avec sa boucle, LED éteintes', !s.slices && !s.loop && litPads(0x60).length === 0 && s.status === '',
    `${hex(0x60)}: ${litPads(0x60)}`);

  await page.eval(`${deck}.stop()`);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
