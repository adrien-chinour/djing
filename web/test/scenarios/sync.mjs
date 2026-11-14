// Scenario of the sync (#38): click tracks at 120 BPM on deck A and 126 BPM on deck B, beat grids
// given to the decks once analysed (#84). Checks the BPM shown (analysed BPM × pitch), SYNC refused without a BPM, the
// master (only deck playing, SHIFT + SYNC, else the other deck), the SYNC LED, the click phase of
// both decks recorded together in the page 10 s after SYNC (also after a tempo change of the master
// and with keylock on the follower, whose audio is then 120 ms late), the pickup of the follower's
// pitch fader and the pitch ranges of SHIFT + Q.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, sleep, tmp } from '../lib.mjs';

const SR = 44100;
const SECONDS = 60;
const TRACKS = [{ bpm: 120, firstBeat: 0.37 }, { bpm: 126, firstBeat: 0.61 }];
const NOTE = [0x91, 0x92];
const SYNC = 0x05;

/** 16-bit mono WAV of `samples` (Float32Array, −1..1). */
function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

/** Silence then a 1.5 kHz click (4 ms decay) on every beat from `firstBeat`. */
function clicks({ bpm, firstBeat }) {
  const x = new Float32Array(SR * SECONDS);
  for (let t = firstBeat; t < SECONDS; t += 60 / bpm) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.02 && start + i < x.length; i++) {
      x[start + i] = 0.8 * Math.exp(-i / (SR * 0.004)) * Math.sin((2 * Math.PI * 1500 * i) / SR);
    }
  }
  return x;
}

export default async function ({ page, sim }) {
  const deck = (d) => `window.djing.engine.decks[${d}]`;
  const sync = 'window.djing.engine.sync';
  const text = (d, sel) => page.eval(`document.querySelector('.deck[data-deck="${d}"] ${sel}').textContent`);
  const note = async (status, number) => {
    await sim.send(`note ${status.toString(16)} ${number.toString(16).padStart(2, '0')} 7f`, 50);
    await sim.send(`note ${status.toString(16)} ${number.toString(16).padStart(2, '0')} 00`);
  };
  const press = (d, shift = false) => note((shift ? [0x94, 0x95] : NOTE)[d], SYNC);
  const syncLed = (d) => sim.lastLed(NOTE[d], SYNC);

  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);

  // No BPM yet (empty decks): SYNC is refused, with a message, and nothing changes.
  await press(1);
  await sleep(200);
  const refused = await text(1, '.master');
  check('sync sans BPM : message à l\'écran', refused.startsWith('Sync impossible'), refused);
  check('sync sans BPM : état inchangé', (await page.eval(`${sync}.follower === null && ${deck(1)}.rate === 1`)) && syncLed(1) !== 0x7f);

  const doc = await page.send('DOM.getDocument');
  for (const d of [0, 1]) {
    const file = join(tmp, `clicks-${TRACKS[d].bpm}.wav`);
    writeFileSync(file, wav(clicks(TRACKS[d])));
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `.deck[data-deck="${d}"] input[type=file]` });
    await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
  }
  await sleep(2500);
  check('pistes de clics chargées sur A et B', await page.eval(`!!(${deck(0)}.buffer && ${deck(1)}.buffer)`));
  // Files picked on the decks are analysed in the background: wait for it, so it does not replace the grids below.
  for (let i = 0; i < 100 && !(await page.eval(`!!(${deck(0)}.bpm && ${deck(1)}.bpm)`)); i++) await sleep(200);

  // Recorder of both deck signals (after the stretch node, before the fader), sample-aligned.
  await page.eval(`(() => {
    for (const [d, t] of ${JSON.stringify(TRACKS.map((t) => [t.bpm, t.firstBeat]))}.entries()) ${deck('d')}.setBpm(t[0], t[1]);
    const ctx = window.djing.engine.ctx;
    const merger = ctx.createChannelMerger(2);
    window.djing.engine.decks.forEach((deck, d) => deck.filter.connect(merger, 0, d));
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    merger.connect(proc).connect(mute).connect(ctx.destination);
    let take = null;
    proc.onaudioprocess = (e) => {
      if (!take) return;
      for (let c = 0; c < 2; c++) take.chunks[c].push(e.inputBuffer.getChannelData(c).slice());
      if ((take.frames += e.inputBuffer.length) >= take.wanted) { take.done(take); take = null; }
    };
    // Records \`seconds\` of both decks; returns, per beat of A, the offset of the nearest click of B (ms).
    window.__phase = (seconds) => new Promise((resolve) => {
      take = { chunks: [[], []], frames: 0, wanted: seconds * ctx.sampleRate, done: (t) => {
        const onsets = t.chunks.map((chunks) => {
          const out = [];
          let i = 0, last = -Infinity;
          for (const chunk of chunks) for (const v of chunk) {
            if (Math.abs(v) > 0.3 && i - last > 0.2 * ctx.sampleRate) { out.push(i / ctx.sampleRate); last = i; }
            i++;
          }
          return out;
        });
        resolve(onsets[0].map((a) => Math.min(...onsets[1].map((b) => Math.abs(b - a))) * 1000));
      } };
    });
  })()`);
  const phase = async () => {
    const offsets = await page.eval('window.__phase(3)');
    return { ok: offsets.length >= 4 && Math.max(...offsets) < 5, detail: `${offsets.length} temps, écart max ${Math.max(...offsets).toFixed(2)} ms` };
  };

  // BPM shown = analysed BPM × pitch.
  await sim.send('rate A 0.5');
  await sleep(200);
  const rateA = await page.eval(`${deck(0)}.rate`);
  const shown = await text(0, '.bpm');
  check('BPM affiché = BPM analysé × vitesse (±0,01)', rateA !== 1 && Math.abs(parseFloat(shown) - 120 * rateA) <= 0.01, `${shown}, vitesse ${rateA}`);
  await sim.send('rate A 0');

  // Master: the only deck playing.
  await page.eval(`${deck(0)}.play()`);
  await sleep(200);
  check('maître affiché : le seul deck en lecture (A)', (await text(0, '.master')) === 'MAÎTRE' && (await text(1, '.master')) !== 'MAÎTRE');
  await page.eval(`(() => { ${deck(1)}.seek(7.3); ${deck(1)}.play(); })()`);
  await press(1);
  await sleep(200);
  check('SYNC sur B : B suit A', await page.eval(`${sync}.follower === 1 && ${sync}.master === 0`));
  check('LED SYNC de B allumée', syncLed(1) === 0x7f && syncLed(0) !== 0x7f);
  check('écran : A maître, B synchronisé', (await text(0, '.master')) === 'MAÎTRE' && (await text(1, '.master')) === 'SYNC → A');
  const [rateA0, rateB] = await page.eval(`[${deck(0)}.rate, ${deck(1)}.rate]`);
  check('tempo de B calé sur A : 126 × vitesse B = 120 × vitesse A', Math.abs(126 * rateB - 120 * rateA0) < 1e-6, `vitesses ${rateA0}, ${rateB}`);
  await sleep(10000);
  let p = await phase();
  check('écart de phase des clics < 5 ms, 10 s après SYNC', p.ok, p.detail);

  // The master's tempo changes: the follower follows, in phase.
  await sim.send('rate A -0.25');
  const rates = await page.eval(`[${deck(0)}.rate, ${deck(1)}.rate]`);
  check('changement de tempo du maître suivi', rates[0] !== 1 && Math.abs(126 * rates[1] - 120 * rates[0]) < 1e-6, rates.join(', '));
  await sleep(2000);
  p = await phase();
  check('en phase après le changement de tempo du maître', p.ok, p.detail);
  await sim.send('rate A 0');

  // Keylock on the follower: its audio comes 120 ms later, the sync compensates it.
  await page.eval(`document.querySelector('.deck[data-deck="1"] [data-act=keylock]').click()`);
  await sleep(2000);
  p = await phase();
  const delay = await page.eval(`${deck(1)}.delay`);
  check('en phase avec keylock sur le suiveur', delay > 0.1 && p.ok, `latence ${(delay * 1000).toFixed(0)} ms, ${p.detail}`);
  await page.eval(`document.querySelector('.deck[data-deck="1"] [data-act=keylock]').click()`);

  // Pickup: the follower's pitch fader (inverted) is ignored until it reaches the synced value.
  const synced = await page.eval(`(${deck(1)}.rate - 1) / ${deck(1)}.rateRange`);
  await sim.send('rate B -0.2'); // fader +0.2: same side as 0
  await sim.send('rate B 0.3'); // fader −0.3: not yet at the synced value
  check('pitch fader du suiveur ignoré avant la valeur synchronisée', await page.eval(`${sync}.follower === 1 && Math.abs(126 * ${deck(1)}.rate - 120 * ${deck(0)}.rate) < 1e-6`), `valeur synchronisée ${synced.toFixed(3)}`);
  await sim.send('rate B 0.7'); // fader −0.7: crosses it
  const after = await page.eval(`[${sync}.follower, ${deck(1)}.rate]`);
  check('pitch fader repris après la valeur synchronisée, sync relâchée', after[0] === null && Math.abs(after[1] - (1 - 0.7 * 0.08)) < 0.001, after.join(', '));
  check('LED SYNC de B éteinte', syncLed(1) === 0);

  // SHIFT + SYNC chooses the master.
  await press(1, true);
  await sleep(200);
  check('SHIFT + SYNC sur B : B maître à l\'écran', (await text(1, '.master')) === 'MAÎTRE' && (await text(0, '.master')) === '');
  await press(0);
  check('SYNC sur A : A suit le maître choisi (B)', await page.eval(`${sync}.follower === 0 && ${sync}.master === 1`) && syncLed(0) === 0x7f);
  await press(0);
  await press(1, true);
  check('SYNC à nouveau : sync coupée ; SHIFT + SYNC à nouveau : plus de maître choisi', await page.eval(`${sync}.follower === null && ${sync}.leader === null`) && syncLed(0) === 0);
  // Neither chosen nor alone playing: the other deck.
  await page.eval(`(() => { ${deck(0)}.stop(); ${deck(1)}.stop(); })()`);
  await press(0);
  check('decks arrêtés : SYNC sur A prend B comme maître', await page.eval(`${sync}.follower === 0 && ${sync}.master === 1`));
  await press(0);

  // SHIFT + Q: pitch range 8 → 16 → 50 → 8 %.
  const ranges = [await text(0, '.range')];
  for (let i = 0; i < 3; i++) {
    await note(0x94, 0x02);
    ranges.push(await text(0, '.range'));
  }
  check('SHIFT + Q : plages 8, 16, 50 %, défaut 8 %', ranges.join(' ') === '±8 % ±16 % ±50 % ±8 %', ranges.join(' '));
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
