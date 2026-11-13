// Scenario of the AutoDJ (#53): a playlist of three 20 s tracks (click tracks at 120 and 126 BPM,
// white noise without BPM) in a directory of the origin private file system opened as the library.
// Checks AUTODJ (0x90 0x03) and the screen button with their LED, the next track loaded on the free
// deck, its start 10 s before the end with a 10 s crossfader glide, the sync of two tracks with a BPM
// (and none when one has no BPM), switching off mid-glide (crossfader left where it is), and the
// stop after the last track.

import { check, sleep } from '../lib.mjs';

const SR = 44100;
const SECONDS = 20;
const FIRST_BEAT = 0.37;
const FILES = { '1 - Clicks 120.wav': 120, '2 - Clicks 126.wav': 126, '3 - Noise.wav': null };
const AUTODJ = [0x90, 0x03];

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

/** A 1.5 kHz click (4 ms decay) on every beat from FIRST_BEAT; white noise when bpm is null. */
function track(bpm) {
  if (bpm === null) return new Float32Array(SR * SECONDS).map(() => 0.5 * (Math.random() * 2 - 1));
  const x = new Float32Array(SR * SECONDS);
  for (let t = FIRST_BEAT; t < SECONDS; t += 60 / bpm) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.02 && start + i < x.length; i++) {
      x[start + i] = 0.8 * Math.exp(-i / (SR * 0.004)) * Math.sin((2 * Math.PI * 1500 * i) / SR);
    }
  }
  return x;
}

export default async function ({ page, sim }) {
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const engine = 'window.djing.engine';
  const deck = (d) => `${engine}.decks[${d}]`;
  const names = Object.keys(FILES);
  const state = () => page.eval(`(() => {
    const e = ${engine};
    const name = (d) => document.querySelector('.deck[data-deck="' + d + '"] .name').textContent;
    return {
      xfader: e.crossfader, follower: e.sync.follower, button: ${q('#autoDj')}.classList.contains('on'),
      status: ${q('#autoDjStatus')}.textContent,
      decks: e.decks.map((k, d) => ({ name: name(d), playing: k.playing, position: k.position, duration: k.duration, rate: k.rate, bpm: k.bpm })),
    };
  })()`);
  const led = () => sim.lastLed(...AUTODJ);
  const press = async () => {
    await sim.send('note 90 03 7f', 50);
    await sim.send('note 90 03 00');
  };
  /** Polls until deck d plays; returns the state at that moment (null after `ms`). */
  async function waitPlaying(d, ms) {
    for (let t = 0; t < ms; t += 50) {
      const s = await state();
      if (s.decks[d].playing) return s;
      await sleep(50);
    }
    return null;
  }

  // Library of three tracks, analysed; a playlist of the three in order.
  await page.eval(`new Promise((r) => { const q = indexedDB.deleteDatabase('djing'); q.onsuccess = q.onerror = q.onblocked = r; })`);
  await page.reload();
  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  await page.eval(`navigator.storage.getDirectory().then((root) => root.removeEntry('autodj', { recursive: true })).catch(() => {})`);
  for (const [name, bpm] of Object.entries(FILES)) {
    await page.eval(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('autodj', { create: true });
      const w = await (await dir.getFileHandle(${JSON.stringify(name)}, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(${JSON.stringify(wav(track(bpm)).toString('base64'))}), (c) => c.charCodeAt(0)));
      await w.close();
    })()`);
  }
  await page.eval(`(async () => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = () => root.getDirectoryHandle('autodj');
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  for (let t = 0; t < 60000 && (await page.eval(`${q('#analysisProgress')}.textContent`)) !== 'analyse BPM : 3 / 3'; t += 200) await sleep(200);
  const bpms = await page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => tr.querySelector('.bpm').textContent)`);
  check('bibliothèque analysée : 120, 126, BPM inconnu', JSON.stringify(bpms) === '["120.00","126.00","BPM inconnu"]', JSON.stringify(bpms));

  await page.eval(`${q('#playlistNew')}.click()`);
  await page.eval(`${q('#playlistName')}.value = 'AutoDJ'`);
  await page.eval(`${q('#playlistNameOk')}.click()`);
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    await page.eval(`(() => {
      const dt = new DataTransfer();
      const src = document.querySelector('#library tbody tr:nth-child(${i + 1})');
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const target = document.querySelector('#playlistHint');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await sleep(100);
  }
  check('playlist de trois titres', (await page.eval(`document.querySelectorAll('#playlists tbody tr').length`)) === 3);

  // AUTODJ on the controller: first track plays on A, crossfader on A, second waits on B.
  check('LED AUTODJ éteinte au départ', led() !== 0x7f);
  await press();
  await sleep(1500);
  let s = await state();
  check('AUTODJ de la platine : LED allumée, bouton à l\'écran allumé', led() === 0x7f && s.button, `led ${led()}`);
  check('premier titre lancé sur le deck A, crossfader sur A', s.decks[0].name === names[0] && s.decks[0].playing && s.xfader === 0, JSON.stringify(s));
  check('titre suivant chargé sur le deck libre (B), à l\'arrêt', s.decks[1].name === names[1] && !s.decks[1].playing, JSON.stringify(s.decks[1]));

  // 13 s before the end, the incoming deck still waits; it starts at 10 s.
  await page.eval(`${deck(0)}.seek(7)`);
  await sleep(1000);
  check('à plus de 10 s de la fin, le deck B attend', !(await state()).decks[1].playing);
  s = await waitPlaying(1, 5000);
  const left = s && s.decks[0].duration - s.decks[0].position;
  check('le deck B démarre à 10 s de la fin du titre en cours', s && Math.abs(left - 10) < 0.3, left?.toFixed(2));
  check('deux BPM : deck B synchronisé sur A avant de démarrer (vitesse 120/126)',
    s && s.follower === 1 && Math.abs(s.decks[1].rate - 120 / 126) < 1e-3, JSON.stringify(s && { follower: s.follower, rate: s.decks[1].rate }));
  await sleep(5000);
  s = await state();
  check('crossfader à mi-chemin après 5 s', Math.abs(s.xfader - 0.5) < 0.05, s.xfader.toFixed(3));
  await sleep(5500);
  s = await state();
  check('crossfader sur B après 10 s', s.xfader === 1, s.xfader.toFixed(3));

  // Track A over: the third track (no BPM) loads on A; B having 10 s left (20 s tracks), A starts
  // at once, without sync.
  s = await waitPlaying(0, 4000);
  const leftB = s && (s.decks[1].duration - s.decks[1].position) / s.decks[1].rate;
  check('titre A fini : troisième titre chargé sur A', s && s.decks[0].name === names[2] && s.decks[1].playing, JSON.stringify(s?.decks));
  check('deck A démarre à 10 s de la fin de B', s && Math.abs(leftB - 10) < 0.3, leftB?.toFixed(2));
  check('un titre sans BPM : pas de synchro (celle de la transition précédente relâchée)', s && s.follower === null, String(s?.follower));
  await sleep(3000);
  await page.eval(`${q('#autoDj')}.click()`);
  await sleep(200);
  const frozen = (await state()).xfader;
  await sleep(1500);
  s = await state();
  check('bouton à l\'écran : AutoDJ coupé, LED éteinte', led() === 0x00 && !s.button, `led ${led()}`);
  check('coupé en plein fondu : le crossfader reste où il est', frozen > 0.4 && frozen < 0.85 && s.xfader === frozen, `${frozen} -> ${s.xfader}`);
  check('coupé : les decks continuent de jouer', s.decks[0].playing && s.decks[1].playing);

  // Again from the screen while A plays the last track: stops after it.
  await sleep(8000); // B over
  await page.eval(`${q('#autoDj')}.click()`);
  await sleep(500);
  s = await state();
  check('réactivé sur le dernier titre : LED allumée, rien de plus à charger', led() === 0x7f && s.button && s.status === 'AutoDJ : dernier titre', JSON.stringify(s.status));
  await page.eval(`${deck(0)}.seek(${SECONDS - 1})`);
  await sleep(2000);
  s = await state();
  check('fin de playlist : AutoDJ arrêté après le dernier titre, LED éteinte',
    led() === 0x00 && !s.button && !s.decks[0].playing && s.status === 'AutoDJ : fin de la playlist', JSON.stringify(s.status));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
