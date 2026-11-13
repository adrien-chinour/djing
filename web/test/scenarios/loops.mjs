// Scenario of the loops (#37):
// - the deck worklet alone in an OfflineAudioContext: sample-exact return to the loop start, no click
//   beyond the 5 ms seek fade of #31 on a sine;
// - the deck of the page from the simulated controller and the screen: LOOP IN / LOOP OUT, the LOOP IN
//   LED, leaving a loop, SHIFT halve / double and their bounds, auto loops with and without quantize,
//   and manual loops only without a beat grid.

import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

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

  await checkWorklet(page);
  await checkDeck(page, sim);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

/** Page-side helper: renders the worklet on `track` (built page-side), applying `events` at time 0. */
const RENDER = `async ({ track, renderSeconds, events }) => {
  const SR = 48000;
  const ctx = new OfflineAudioContext(1, Math.round(renderSeconds * SR), SR);
  await ctx.audioWorklet.addModule('/worklets/deck-player.js');
  const node = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, outputChannelCount: [1] });
  node.connect(ctx.destination);
  const reports = [];
  node.port.onmessage = (e) => reports.push(e.data);
  node.port.postMessage({ type: 'load', channels: [track] }, [track.buffer]);
  for (const msg of events) node.port.postMessage(msg);
  await new Promise((r) => setTimeout(r, 50));
  const out = (await ctx.startRendering()).getChannelData(0);
  await new Promise((r) => setTimeout(r, 50));
  return { out, reports, SR };
}`;

const run = (page, body) => page.eval(`(async () => { const render = ${RENDER}; ${body} })()`);

async function checkWorklet(page) {
  // A ramp (value = frame index / 1e6): outside the fade windows, each output sample must be exactly the
  // source frame expected from a wrap by the loop length (4800 frames from frame 24000).
  const exact = await run(page, `
    const track = new Float32Array(96000).map((_, i) => i / 1e6);
    const { out, reports } = await render({ track, renderSeconds: 0.6, events: [
      { type: 'seek', position: 0.5 }, { type: 'loop', start: 0.5, end: 0.6 }, { type: 'play' }] });
    let maxErr = 0;
    let checked = 0;
    for (let k = 4800; k < out.length; k++) {
      if (k % 4800 < 240) continue; // 5 ms crossfade after each wrap
      maxErr = Math.max(maxErr, Math.abs(out[k] - (24000 + (k % 4800)) / 1e6));
      checked++;
    }
    const positions = reports.filter((r) => r.type === 'position' && r.playing).map((r) => r.position);
    return { maxErr, checked, min: Math.min(...positions), max: Math.max(...positions) };`);
  check('worklet : retour au début de boucle exact à l\'échantillon (5 tours)', exact.checked > 20000 && exact.maxErr < 1e-7,
    `écart max ${exact.maxErr.toExponential(2)} sur ${exact.checked} échantillons`);
  check('worklet : position remontée bornée à la boucle', exact.min >= 0.5 && exact.max <= 0.6, `${exact.min.toFixed(4)}..${exact.max.toFixed(4)} s`);

  // 100 Hz sine, loop of 10.25 periods: a quarter-period step (1.0) at every wrap without the fade.
  // Reference: the largest step of a quarter-period seek, made with the same 5 ms fade (#31).
  const sine = await run(page, `
    const sine = () => new Float32Array(144000).map((_, i) => Math.sin((2 * Math.PI * 100 * i) / 48000));
    const maxStep = (out) => { let m = 0; for (let i = 1; i < out.length; i++) m = Math.max(m, Math.abs(out[i] - out[i - 1])); return m; };
    const loop = await render({ track: sine(), renderSeconds: 0.6, events: [
      { type: 'seek', position: 1 }, { type: 'loop', start: 1, end: 1.1025 }, { type: 'play' }] });
    const seek = await render({ track: sine(), renderSeconds: 0.2, events: [{ type: 'play' }, { type: 'seek', position: 1.0025 }] });
    let sum = 0;
    for (const v of loop.out) sum += v * v;
    return { loop: maxStep(loop.out), seek: maxStep(seek.out), rms: Math.sqrt(sum / loop.out.length) };`);
  check('worklet : boucle sur un sinus sans discontinuité au-delà du fondu de 5 ms', sine.loop <= sine.seek + 0.005 && sine.loop < 0.2,
    `écart max ${sine.loop.toFixed(4)}, saut fondu de référence ${sine.seek.toFixed(4)}`);
  check('worklet : la boucle joue sans trou', sine.rms > 0.6, `RMS ${sine.rms.toFixed(3)}`);
}

async function checkDeck(page, sim) {
  const deck = 'window.djing.engine.decks[0]';
  const state = () => page.eval(`(() => { const d = ${deck}; return { loop: d.loop, position: d.position, playing: d.playing }; })()`);
  const length = (s) => (s.loop ? s.loop.end - s.loop.start : null);
  const press = async (status, number) => { await sim.send(`note ${status} ${number} 7f`, 30); await sim.send(`note ${status} ${number} 00`); };
  const click = async (act) => { await page.eval(`document.querySelector('.deck[data-deck="0"] [data-act="${act}"]').click()`); await sleep(100); };
  const screenLed = () => page.eval(`document.querySelector('.deck[data-deck="0"] [data-led="loopIn"]').classList.contains('on')`);
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

  // Manual loop, 120 BPM grid.
  await page.eval(`${deck}.grid = { bpm: 120, firstBeat: 0.1 }; ${deck}.seek(1); ${deck}.play();`);
  await sleep(300);
  const pos = async () => (await state()).position;
  const inBefore = await pos();
  await press('91', '09');
  const inAfter = await pos();
  await sleep(500);
  const outBefore = await pos();
  await press('91', '0a');
  let s = await state();
  check('LOOP IN pose le début, LOOP OUT la fin et active la boucle',
    s.loop && s.loop.start >= inBefore && s.loop.start <= inAfter && s.loop.end >= outBefore && s.loop.end <= outBefore + 0.3,
    `IN entre ${inBefore.toFixed(3)} et ${inAfter.toFixed(3)} s, OUT après ${outBefore.toFixed(3)} s : ${JSON.stringify(s.loop)}`);
  check('LED LOOP IN allumée (platine et écran)', sim.lastLed(0x91, 0x09) === 0x7f && (await screenLed()));
  const loop = s.loop;
  let inside = true;
  for (let i = 0; i < 12; i++) {
    await sleep(100);
    const p = (await state()).position;
    inside &&= p >= loop.start - 0.01 && p <= loop.end + 0.01;
  }
  check('la lecture reste dans la boucle (1,2 s, plus de deux tours)', inside);
  // Keylock: the stretch node delays the audio; the position heard must stay in the loop too.
  await page.eval(`${deck}.setKeylock(true)`);
  inside = true;
  for (let i = 0; i < 12; i++) {
    await sleep(100);
    const p = (await state()).position;
    inside &&= p >= loop.start - 0.01 && p <= loop.end + 0.01;
  }
  await page.eval(`${deck}.setKeylock(false)`);
  check('keylock : la position entendue reste dans la boucle', inside);

  await press('94', '09');
  s = await state();
  check('SHIFT + LOOP IN : longueur divisée par deux', near(length(s), (loop.end - loop.start) / 2) && near(s.loop.start, loop.start), JSON.stringify(s.loop));
  await press('94', '0a');
  s = await state();
  check('SHIFT + LOOP OUT : longueur doublée', near(length(s), loop.end - loop.start), JSON.stringify(s.loop));

  await press('91', '0a');
  s = await state();
  await sleep(1000);
  const after = await state();
  check('LOOP OUT sur une boucle active : sortie, la lecture continue', !s.loop && after.playing && after.position > loop.end + 0.3,
    `position ${after.position.toFixed(3)} s, fin de boucle ${loop.end.toFixed(3)} s`);
  check('LED LOOP IN éteinte hors boucle', sim.lastLed(0x91, 0x09) === 0x00 && !(await screenLed()));

  // Bounds, 480 BPM grid (a beat is 0.125 s, 64 beats fit in the 10 s track).
  await page.eval(`${deck}.grid = { bpm: 480, firstBeat: 0 }; ${deck}.seek(0.5);`);
  await sleep(100);
  await click('autoLoop.0.5');
  for (let i = 0; i < 5; i++) await press('94', '09');
  s = await state();
  check('moitié bornée à 1/32 de temps', near(length(s), 0.125 / 32), `${length(s)} s`);
  await click('loopOut');
  await page.eval(`${deck}.seek(0.5);`);
  await click('autoLoop.16');
  for (let i = 0; i < 3; i++) await press('94', '0a');
  s = await state();
  check('double borné à 64 temps', near(length(s), 0.125 * 64), `${length(s)} s`);
  await click('loopOut');

  // Auto loops, 120 BPM grid from 0.1 s.
  await page.eval(`${deck}.grid = { bpm: 120, firstBeat: 0.1 };`);
  const lengths = {};
  for (const beats of [0.5, 1, 2, 4, 8, 16]) {
    await page.eval(`${deck}.seek(1);`);
    await click(`autoLoop.${beats}`);
    lengths[beats] = length(await state());
    await click('loopOut');
  }
  check('boucles automatiques de 1/2, 1, 2, 4, 8 et 16 temps', Object.entries(lengths).every(([b, l]) => near(l, b * 0.5)), JSON.stringify(lengths));

  await page.eval(`${deck}.seek(2.37);`);
  await click('autoLoop.4');
  s = await state();
  check('sans quantize : la boucle démarre à la position courante', Math.abs(s.loop.start - 2.37) < 0.05, `début ${s.loop.start.toFixed(3)} s`);
  await click('loopOut');
  await press('91', '02');
  check('QUANTIZE : LED allumée', sim.lastLed(0x91, 0x02) === 0x7f && (await page.eval(`${deck}.quantize`)));
  await page.eval(`${deck}.seek(2.37);`);
  await click('autoLoop.4');
  s = await state();
  check('quantize : la boucle démarre au temps courant (2,1 s)', near(s.loop.start, 2.1) && near(length(s), 2), JSON.stringify(s.loop));
  await click('loopOut');

  // No beat grid: manual loops only, halve / double in seconds.
  await page.eval(`${deck}.grid = null; ${deck}.seek(3);`);
  await click('autoLoop.4');
  check('sans grille : pas de boucle automatique', !(await state()).loop);
  await click('loopIn');
  await sleep(400);
  await click('loopOut');
  s = await state();
  const manual = length(s);
  check('sans grille : boucle manuelle', s.loop && manual >= 0.4 && manual < 0.7, JSON.stringify(s.loop));
  await press('94', '09');
  const half = length(await state());
  await press('94', '0a');
  await press('94', '0a');
  const twice = length(await state());
  check('sans grille : moitié et double en secondes', near(half, manual / 2) && near(twice, manual * 2), `${manual.toFixed(3)} → ${half.toFixed(3)} → ${twice.toFixed(3)} s`);
  await click('loopOut');
  await page.eval(`${deck}.stop()`);
}
