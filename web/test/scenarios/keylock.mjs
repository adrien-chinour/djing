// Scenario of keylock and transposition (#39): a 440 Hz sine on deck A, its frequency measured on
// the deck's signal (after the stretch node, before the EQ), with and without keylock, transposed,
// across jumps, in reverse and beyond ±50 %; then the latency of the stretch node, shown and
// compensated in deck.position.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, sleep, tmp } from '../lib.mjs';

/** 10 s stereo 16-bit WAV, `hz` sine at -12 dBFS. */
function writeSine(path, hz) {
  const rate = 44100;
  const frames = rate * 10;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate));
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  writeFileSync(path, buf);
}

const q = (sel) => `document.querySelector(${JSON.stringify(`.deck[data-deck="0"] ${sel}`)})`;

export default async function ({ page }) {
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  const wav = join(tmp, 'sine440.wav');
  writeSine(wav, 440);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1500);
  check('titre chargé sur le deck A', await page.eval('!!window.djing.engine.decks[0].buffer'));
  check('keylock désactivé par défaut', (await page.eval('window.djing.engine.decks[0].keylock')) === false);

  // Analyser on the deck signal, and the median period of its rising zero crossings.
  await page.eval(`(() => {
    const deck = window.djing.engine.decks[0];
    const a = deck.engine.ctx.createAnalyser();
    a.fftSize = 32768;
    deck.filter.connect(a);
    window.__freq = () => {
      const x = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(x);
      const t = [];
      for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) t.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
      const periods = t.slice(1).map((v, i) => v - t[i]).sort((p, r) => p - r);
      return a.context.sampleRate / periods[periods.length >> 1];
    };
  })()`);
  // On-screen controls: the KEYLOCK button, or a knob set to v.
  const act = async (name, v) => {
    if (name === 'keylock') await page.eval(`${q('[data-act=keylock]')}.click()`);
    else await page.eval(`(() => { const i = ${q(`[data-knob=${name}]`)}; i.value = ${v}; i.dispatchEvent(new Event('input')); })()`);
  };
  const freq = async (settle = 1000) => {
    await sleep(settle);
    return page.eval('window.__freq()');
  };
  const near = (f, target, tol) => Math.abs(f - target) <= tol;
  const hz = (f) => `${f.toFixed(2)} Hz`;

  await page.eval('window.djing.engine.decks[0].play()');
  await act('rate', 1); // pitch fader at the top: +8 %
  let f = await freq();
  check('sans keylock, 440 Hz à +8 % → 475 Hz ±2', near(f, 475.2, 2), hz(f));

  await act('keylock', 1);
  check('bouton KEYLOCK allumé', await page.eval(`${q('[data-act=keylock]')}.classList.contains('on')`));
  f = await freq();
  check('avec keylock, 440 Hz à +8 % → 440 Hz ±2', near(f, 440, 2), hz(f));

  await page.eval('window.djing.engine.decks[0].seek(6)');
  f = await freq();
  check('keylock après un saut → 440 Hz ±2', near(f, 440, 2), hz(f));

  // A loop as seen from the stretch stage: the player jumps back every 250 ms.
  await page.eval(`window.__loop = setInterval(() => window.djing.engine.decks[0].seek(3), 250)`);
  f = await freq(1500);
  await page.eval('clearInterval(window.__loop)');
  check('keylock pendant des sauts répétés (boucle) → 440 Hz ±2', near(f, 440, 2), hz(f));

  await act('keylock', 1);
  await act('rate', 0);
  await act('transpose', 12);
  await sleep(200); // the deck panel redraws every 50 ms
  check('transposition +12 à l\'écran', (await page.eval(`${q('.transpose')}.textContent`)) === '+12 dt');
  f = await freq();
  check('transposition +12 : 440 Hz → 880 Hz ±4', near(f, 880, 4), hz(f));
  await act('transpose', -12);
  f = await freq();
  check('transposition −12 : 440 Hz → 220 Hz ±2', near(f, 220, 2), hz(f));

  await act('transpose', 12);
  await act('keylock', 1);
  await act('rate', 1);
  await page.eval('window.djing.engine.decks[0].seek(2)');
  f = await freq();
  check('keylock et transposition +12 à +8 %, après un saut → 880 Hz ±4', near(f, 880, 4), hz(f));
  await act('transpose', 0);

  // Bypass: beyond +50 % and in reverse the pitch follows the speed.
  await page.eval(`(() => { const d = window.djing.engine.decks[0]; d.rateRange = 0.6; d.setRate(1); })()`);
  f = await freq();
  check('keylock contourné à +60 % → 704 Hz ±3', near(f, 704, 3), hz(f));
  await page.eval(`(() => { const d = window.djing.engine.decks[0]; d.seek(9); d.rateRange = 2.08; d.setRate(-1); })()`);
  f = await freq();
  const semis = await page.eval('window.djing.engine.decks[0].semitones');
  check('keylock contourné en marche arrière (−108 %) → 475 Hz ±2', near(f, 475.2, 2) && semis === 0, `${hz(f)}, ${semis} dt`);
  await page.eval(`(() => { const d = window.djing.engine.decks[0]; d.rateRange = 0.08; d.setRate(1); })()`);

  await checkLatency(page);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

async function checkLatency(page) {
  const deck = 'window.djing.engine.decks[0]';
  const shown = await page.eval(`${q('.latency')}.textContent`);
  const latency = await page.eval(`${deck}.latency`);
  check('latence du time-stretch affichée', latency > 0 && shown === `latence ${Math.round(latency * 1000)} ms`, `${shown}, ${(latency * 1000).toFixed(1)} ms`);
  const pos = await page.eval(`(() => { const d = ${deck}; return { position: d.position, playhead: d.playhead, speed: d.speed }; })()`);
  const expected = pos.playhead - latency * pos.speed;
  check('position remontée compensée de la latence', Math.abs(pos.position - expected) < 0.002, JSON.stringify(pos));

  // The latency reported must be the delay of the stretch node: a burst at 0.5 s through it, offline.
  const measured = await page.eval(`(async () => {
    const { default: SignalsmithStretch } = await import('/vendor/signalsmith-stretch.js');
    const SR = 48000;
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const stretch = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const latency = await stretch.latency();
    stretch.start();
    const buf = ctx.createBuffer(2, SR * 2, SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = SR / 2; i < SR * 2; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    src.connect(stretch).connect(ctx.destination);
    src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    // Onset: where the output envelope reaches half its steady level.
    let i = 0;
    while (i < out.length && Math.abs(out[i]) < 0.25) i++;
    return { latency, onset: i / SR - 0.5 };
  })()`);
  check('latence annoncée = retard mesuré du time-stretch (±15 ms)', Math.abs(measured.onset - measured.latency) <= 0.015,
    `annoncée ${(measured.latency * 1000).toFixed(1)} ms, mesurée ${(measured.onset * 1000).toFixed(1)} ms`);

  await page.eval(`${q('[data-act=keylock]')}.click()`);
  await sleep(300);
  check('keylock coupé : chemin direct, latence 0 ms', (await page.eval(`${q('.latency')}.textContent`)) === 'latence 0 ms'
    && (await page.eval(`${deck}.position === ${deck}.playhead`)));
}
