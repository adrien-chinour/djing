// Scenario of the deck player (web/worklets/deck-player.js, #31):
// - the worklet alone in an OfflineAudioContext, sample-exact (pitch, seek fade, track ends);
// - the Deck of the running page (no AudioBufferSourceNode, position reports, end of track).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, sleep, tmp, WEB, writeTone } from '../lib.mjs';

export default async function ({ page }) {
  await watchBufferSources(page);
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  check('titre chargé sur le deck A', await page.eval('!!window.djing.engine.decks[0].buffer'));

  await checkPlayerOffline(page);
  await checkDeckLive(page);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}

/** Page-side helper: renders the worklet on a sine track, applying `events` at given times. */
const RENDER = `async ({ tone, trackSeconds, renderSeconds, events }) => {
  const SR = 48000;
  const ctx = new OfflineAudioContext(1, Math.round(renderSeconds * SR), SR);
  await ctx.audioWorklet.addModule('/worklets/deck-player.js');
  const node = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, outputChannelCount: [1] });
  node.connect(ctx.destination);
  const reports = [];
  node.port.onmessage = (e) => reports.push(e.data);
  const track = new Float32Array(Math.round(trackSeconds * SR));
  for (let i = 0; i < track.length; i++) track[i] = Math.sin((2 * Math.PI * tone * i) / SR);
  node.port.postMessage({ type: 'load', channels: [track] }, [track.buffer]);
  const settle = () => new Promise((r) => setTimeout(r, 50));
  for (const ev of events) {
    if (ev.at === 0) { node.port.postMessage(ev.msg); continue; }
    ctx.suspend(ev.at).then(async () => { node.port.postMessage(ev.msg); await settle(); ctx.resume(); });
  }
  await settle();
  const out = (await ctx.startRendering()).getChannelData(0);
  await settle();
  return { out, reports, SR };
}`;

/** Page-side helper: frequency from rising zero crossings (linear interpolation) in [from, to] s. */
const FREQ = `(out, SR, from, to) => {
  const t = [];
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
    if (out[i - 1] < 0 && out[i] >= 0) t.push((i - 1 + out[i - 1] / (out[i - 1] - out[i])) / SR);
  }
  return (t.length - 1) / (t[t.length - 1] - t[0]);
}`;

const run = (page, body) => page.eval(`(async () => { const render = ${RENDER}; const freq = ${FREQ}; ${body} })()`);

async function checkPlayerOffline(page) {
  const speeds = await run(page, `
    const at = async (speed, start = 0) => {
      const { out, SR } = await render({ tone: 1000, trackSeconds: 3, renderSeconds: 0.6, events: [
        { at: 0, msg: { type: 'seek', position: start } }, { at: 0, msg: { type: 'speed', speed } }, { at: 0, msg: { type: 'play' } }] });
      return freq(out, SR, 0.05, 0.55);
    };
    return { one: await at(1), two: await at(2), back: await at(-1, 2), clamp: (await at(10)) };`);
  check('worklet : sinus 1 kHz à vitesse 1 → 1 kHz ±1 Hz', Math.abs(speeds.one - 1000) <= 1, `${speeds.one.toFixed(2)} Hz`);
  check('worklet : vitesse 2 → 2 kHz', Math.abs(speeds.two - 2000) <= 2, `${speeds.two.toFixed(2)} Hz`);
  check('worklet : vitesse −1 (marche arrière) → 1 kHz', Math.abs(speeds.back - 1000) <= 1, `${speeds.back.toFixed(2)} Hz`);
  check('worklet : vitesse bornée à 4', Math.abs(speeds.clamp - 4000) <= 4, `${speeds.clamp.toFixed(2)} Hz`);

  const reverse = await run(page, `
    const { reports } = await render({ tone: 100, trackSeconds: 3, renderSeconds: 0.3, events: [
      { at: 0, msg: { type: 'seek', position: 2 } }, { at: 0, msg: { type: 'speed', speed: -1 } }, { at: 0, msg: { type: 'play' } }] });
    const p = reports.filter((r) => r.type === 'position' && r.playing).map((r) => r.position);
    return { first: p[0], last: p[p.length - 1] };`);
  check('worklet : la position recule en marche arrière', reverse.last < reverse.first - 0.2, `${reverse.first.toFixed(3)} -> ${reverse.last.toFixed(3)} s`);

  // 100 Hz sine, seek by a quarter period during playback: a 1.0 step without the fade.
  const seek = await run(page, `
    const { out, SR } = await render({ tone: 100, trackSeconds: 3, renderSeconds: 0.6, events: [
      { at: 0, msg: { type: 'play' } }, { at: 0.3, msg: { type: 'seek', position: 1.0025 } }] });
    let jump = 0;
    for (let i = 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    let sum = 0;
    for (let i = Math.round(0.4 * SR); i < out.length; i++) sum += out[i] ** 2;
    return { jump, rms: Math.sqrt(sum / (out.length - Math.round(0.4 * SR))) };`);
  check('worklet : saut en lecture sans clic (écart max < 0,2)', seek.jump < 0.2, `écart max ${seek.jump.toFixed(4)}`);
  check('worklet : la lecture continue après le saut', seek.rms > 0.5, `RMS ${seek.rms.toFixed(3)}`);

  const ends = await run(page, `
    const end = async (start, speed) => {
      const { out, reports, SR } = await render({ tone: 100, trackSeconds: 0.5, renderSeconds: 0.4, events: [
        { at: 0, msg: { type: 'seek', position: start } }, { at: 0, msg: { type: 'speed', speed } }, { at: 0, msg: { type: 'play' } }] });
      let tail = 0;
      for (let i = Math.round(0.2 * SR); i < out.length; i++) tail = Math.max(tail, Math.abs(out[i]));
      const ended = reports.filter((r) => r.type === 'ended');
      return { ended: ended.length, position: ended[0]?.position, tail };
    };
    return { fwd: await end(0.4, 1), back: await end(0.1, -1) };`);
  check('worklet : fin de titre, arrêt à la durée', ends.fwd.ended === 1 && ends.fwd.position === 0.5 && ends.fwd.tail === 0, JSON.stringify(ends.fwd));
  check('worklet : marche arrière, arrêt à 0', ends.back.ended === 1 && ends.back.position === 0 && ends.back.tail === 0, JSON.stringify(ends.back));
}

/** Call before the engine is created: counts AudioBufferSourceNode creations in the page. */
async function watchBufferSources(page) {
  await page.eval(`window.__bufferSources = 0;
    const create = BaseAudioContext.prototype.createBufferSource;
    BaseAudioContext.prototype.createBufferSource = function () { window.__bufferSources++; return create.call(this); };
    window.AudioBufferSourceNode = class extends AudioBufferSourceNode { constructor(...a) { super(...a); window.__bufferSources++; } };`);
}

/** Deck A of the page must hold a loaded track and be stopped. */
async function checkDeckLive(page) {
  check('engine.js n\'utilise plus d\'AudioBufferSourceNode', !/createBufferSource|AudioBufferSourceNode/.test(readFileSync(join(WEB, 'engine.js'), 'utf8')));
  check('aucun AudioBufferSourceNode créé dans la page', (await page.eval('window.__bufferSources')) === 0);

  const live = await page.eval(`(async () => {
    const { engine } = window.djing;
    const deck = engine.decks[0];
    const ctx = engine.ctx;
    const reports = [];
    deck.player.port.addEventListener('message', (e) => e.data.type === 'position' && e.data.playing && e.data.gen === deck.gen && reports.push(e.data));
    deck.seek(1);
    deck.play();
    await new Promise((r) => setTimeout(r, 200));
    reports.length = 0;
    const samples = [];
    const t0 = ctx.currentTime;
    await new Promise((resolve) => {
      const id = setInterval(() => {
        samples.push({ t: ctx.currentTime, p: deck.position });
        if (ctx.currentTime - t0 > 1) { clearInterval(id); resolve(); }
      }, 7);
    });
    await new Promise((r) => setTimeout(r, 100));
    const elapsed = ctx.currentTime - t0;
    deck.stop();
    // Real position at time t: linear between the two exact worklet reports around t (constant speed).
    let maxErr = 0;
    let n = 0;
    for (const s of samples) {
      const k = reports.findIndex((r) => r.time > s.t);
      if (k < 1) continue;
      const a = reports[k - 1], b = reports[k];
      const real = a.position + ((s.t - a.time) * (b.position - a.position)) / (b.time - a.time);
      maxErr = Math.max(maxErr, Math.abs(s.p - real));
      n++;
    }
    const inWindow = reports.filter((r) => r.time >= t0 && r.time <= t0 + 1).length;
    return { perSecond: inWindow, maxErr, n, elapsed };
  })()`);
  check('position remontée au moins 60 fois par seconde', live.perSecond >= 60, `${live.perSecond} / s`);
  check('deck.position à moins de 20 ms de la position réelle', live.n > 50 && live.maxErr < 0.02, `écart max ${(live.maxErr * 1000).toFixed(1)} ms sur ${live.n} mesures`);

  const end = await page.eval(`(async () => {
    const deck = window.djing.engine.decks[0];
    deck.seek(deck.duration - 0.3);
    deck.play();
    await new Promise((r) => setTimeout(r, 800));
    return { playing: deck.playing, position: deck.position, duration: deck.duration };
  })()`);
  check('fin de titre : le deck s\'arrête à la durée du titre', !end.playing && end.position === end.duration, JSON.stringify(end));
}
