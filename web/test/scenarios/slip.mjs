// Scenario of the slip mode (#41):
// - the deck worklet alone in an OfflineAudioContext: after a jump away and back to the ghost position,
//   the output is sample-exact the track as if nothing had happened;
// - the deck of the page from the simulated controller: SLIP and its LED, a 1-beat loop held 4 s, a
//   scratch and a held hotcue all resume where playback would have been; without slip, unchanged.

import { join } from 'node:path';
import { check, pickFile, sleep, tmp, writeTone } from '../lib.mjs';

const TOLERANCE = 0.02; // s, criterion of the issue

export default async function ({ page, sim }) {
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  const wav = join(tmp, 'slip-tone.wav');
  writeTone(wav);
  await pickFile(page, 0, wav); // waits for the analysis, which would replace the grids set below
  check('titre chargé sur le deck A', await page.eval('!!window.djing.engine.decks[0].buffer'));

  await checkWorklet(page);
  await checkDeck(page, sim);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

async function checkWorklet(page) {
  // A ramp (value = frame index / 1e6) played from 0 with a ghost at speed 1; at 0.1 s the playback
  // jumps to 1 s, at 0.3 s back to the ghost. Outside the 5 ms fades, sample k must be frame k.
  const r = await page.eval(`(async () => {
    const SR = 48000;
    const ctx = new OfflineAudioContext(1, Math.round(0.5 * SR), SR);
    await ctx.audioWorklet.addModule('/worklets/deck-player.js');
    const node = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, outputChannelCount: [1] });
    node.connect(ctx.destination);
    const reports = [];
    node.port.onmessage = (e) => reports.push(e.data);
    const track = new Float32Array(96000).map((_, i) => i / 1e6);
    node.port.postMessage({ type: 'load', channels: [track] }, [track.buffer]);
    node.port.postMessage({ type: 'play' });
    node.port.postMessage({ type: 'ghost', speed: 1 });
    // Suspend times are rounded to render quanta (128 frames): 0.1 s is frame 4864, 0.3 s frame 14336.
    ctx.suspend(0.1).then(() => { node.port.postMessage({ type: 'seek', position: 1 }); ctx.resume(); });
    ctx.suspend(0.3).then(() => { node.port.postMessage({ type: 'ghost', speed: null, jump: true }); ctx.resume(); });
    await new Promise((r) => setTimeout(r, 50));
    const out = (await ctx.startRendering()).getChannelData(0);
    await new Promise((r) => setTimeout(r, 50));
    const back = Math.round(0.3 * SR / 128) * 128;
    let maxErr = 0;
    let checked = 0;
    for (let k = back + 240; k < out.length; k++, checked++) maxErr = Math.max(maxErr, Math.abs(out[k] - k / 1e6));
    const away = out[Math.round(0.2 * SR)];
    const ghosts = reports.filter((m) => m.ghost !== null && m.ghost !== undefined).length;
    return { maxErr, checked, away, ghosts };
  })()`);
  check('worklet : position fantôme remontée avec la position', r.ghosts > 10, `${r.ghosts} rapports`);
  check('worklet : saut loin de la fantôme effectif', r.away > 0.048, `échantillon à 0,2 s : ${r.away}`);
  check('worklet : retour à la fantôme exact à l\'échantillon', r.checked > 9000 && r.maxErr < 1e-7,
    `écart max ${r.maxErr.toExponential(2)} sur ${r.checked} échantillons`);
}

async function checkDeck(page, sim) {
  const deck = 'window.djing.engine.decks[0]';
  const now = () => page.eval(`(() => { const d = ${deck}; return { p: d.position, t: d.engine.ctx.currentTime, ghost: d.slipPosition, loop: d.loop, playing: d.playing }; })()`);
  const press = async (status, number) => { await sim.send(`note ${status} ${number} 7f`, 30); await sim.send(`note ${status} ${number} 00`); };
  const screenLed = () => page.eval(`document.querySelector('.deck[data-deck="0"] [data-led="slip"]').classList.contains('on')`);
  const fmt = (x) => x.toFixed(3);
  /** Position now minus where an uninterrupted playback from `ref` would be. */
  const drift = (s, ref) => s.p - (ref.p + (s.t - ref.t));

  await press('91', '01');
  check('SLIP active le slip, LED allumée (platine et écran)', (await page.eval(`${deck}.slip`)) && sim.lastLed(0x91, 0x01) === 0x7f && (await screenLed()));

  // 1-beat loop (120 BPM: 0.5 s) held 4 s.
  await page.eval(`${deck}.grid = { bpm: 120, firstBeat: 0 }; ${deck}.seek(1.2); ${deck}.play();`);
  await sleep(300);
  await page.eval(`document.querySelector('.deck[data-deck="0"] [data-act="autoLoop.1"]').click()`);
  const ref = await now();
  check('boucle de 1 temps active', ref.loop && Math.abs(ref.loop.end - ref.loop.start - 0.5) < 1e-6, JSON.stringify(ref.loop));
  let ghostOk = true;
  let worst = 0;
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    const s = await now();
    const err = Math.abs(s.ghost - (ref.p + (s.t - ref.t)));
    worst = Math.max(worst, err);
    ghostOk &&= s.loop && s.p >= s.loop.start - 0.01 && s.p <= s.loop.end + 0.01 && err < TOLERANCE;
  }
  check('boucle : la position fantôme avance à vitesse normale, la lecture reste dans la boucle', ghostOk, `écart max ${fmt(worst)} s`);
  await press('91', '0a');
  await sleep(100);
  let s = await now();
  check('sortie de boucle après 4 s : position à ±20 ms de celle sans boucle', !s.loop && s.playing && Math.abs(drift(s, ref)) <= TOLERANCE,
    `position ${fmt(s.p)} s, écart ${fmt(drift(s, ref))} s`);
  check('plus de position fantôme hors maintien', s.ghost === null);
  await sleep(300);
  s = await now();
  check('la lecture continue après la sortie', Math.abs(drift(s, ref)) <= TOLERANCE, `écart ${fmt(drift(s, ref))} s`);

  // Scratch backwards while the deck plays.
  await page.eval(`${deck}.seek(2)`);
  await sleep(200);
  const before = await now();
  await sim.send('touch A on', 30);
  await sim.send('jog A -150 touched 600', 900);
  const scratched = await now();
  await sim.send('touch A off', 150);
  s = await now();
  check('scratch : la lecture a reculé pendant le scratch', scratched.p < before.p + 0.3, `${fmt(before.p)} → ${fmt(scratched.p)} s`);
  check('scratch : reprise à la position fantôme (±20 ms)', Math.abs(drift(s, before)) <= TOLERANCE, `écart ${fmt(drift(s, before))} s`);

  // Hotcue 1 at 1 s, jumped to from 5 s and held 1 s.
  await page.eval(`${deck}.seek(1)`);
  await sleep(50);
  await press('96', '00');
  const cue = Number(await page.eval(`document.querySelector('.deck[data-deck="0"] .hotcues button[data-led="hotcue.0"]').dataset.position`));
  await page.eval(`${deck}.seek(5)`);
  await sleep(200);
  const from = await now();
  await sim.send('note 96 00 7f', 1000);
  const held = await now();
  await sim.send('note 96 00 00', 100);
  s = await now();
  const cueAt = cue;
  check('hotcue 1 posé vers 1 s', Math.abs(cue - 1) < 0.1, `${cue} s`);
  check('hotcue maintenu : la lecture part du hotcue', held.p > cueAt && held.p < cueAt + 1.3, `${fmt(held.p)} s, hotcue ${fmt(cueAt)} s`);
  check('hotcue relâché : reprise à la position fantôme (±20 ms)', Math.abs(drift(s, from)) <= TOLERANCE, `écart ${fmt(drift(s, from))} s`);

  // Without slip: the hotcue jump stays, the loop exit goes on from the loop.
  await press('91', '01');
  check('SLIP coupé, LED éteinte', !(await page.eval(`${deck}.slip`)) && sim.lastLed(0x91, 0x01) === 0x00 && !(await screenLed()));
  await page.eval(`${deck}.seek(5)`);
  await sleep(200);
  await press('96', '00');
  await sleep(500);
  s = await now();
  check('sans slip : le hotcue reste après le relâchement', s.p > cueAt && s.p < cueAt + 0.8, `${fmt(s.p)} s`);
  await page.eval(`${deck}.seek(1.2)`);
  await page.eval(`document.querySelector('.deck[data-deck="0"] [data-act="autoLoop.1"]').click()`);
  await sleep(1200);
  await press('91', '0a');
  s = await now();
  check('sans slip : la sortie de boucle continue depuis la boucle', !s.loop && s.p >= 1.2 && s.p < 1.9, `${fmt(s.p)} s`);
  await page.eval(`${deck}.stop()`);
}
