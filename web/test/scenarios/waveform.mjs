// Scenario of the waveforms (#35): three sines (100 Hz, 1 kHz, 8 kHz) in a directory of the origin
// private file system opened as the library, the first with a beat grid (120 BPM, first beat 0.1 s)
// written in IndexedDB beforehand. Reads the pixels of the canvases to check the overview and the
// scrolling view of each deck, the zoom (2 to 32 beats, 8 by default), the colour of each band, the
// beat lines (the first beat of each bar stronger), the CUE, hotcue and loop markers, the jump by a
// click on the overview, and that requestAnimationFrame keeps every frame under 50 ms over 3 s while
// both decks play.

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { check, sleep, tmp } from '../lib.mjs';

const LOW = 'Low - 100 Hz.wav';
const MID = 'Mid - 1 kHz.wav';
const HIGH = 'High - 8 kHz.wav';
const NO_GRID = { bpm: null, firstBeat: null, key: null };
const TRACKS = {
  [LOW]: { freq: 100, analysis: { bpm: 120, firstBeat: 0.1, key: null } },
  [MID]: { freq: 1000, analysis: NO_GRID },
  [HIGH]: { freq: 8000, analysis: NO_GRID },
};
// Colours of web/ui/waveform.js.
const COLORS = { low: '#ff4d5e', mid: '#ffb340', high: '#59d0ff', beat: '#5c636e', bar: '#d9dde3', playhead: '#ffffff', cue: '#ffcc4d', hotcue: '#c47bff', loop: '#5ad17a' };
const W = 1000;
const SCROLL_H = 120;
const OVERVIEW_H = 36;

/** 10 s stereo 16-bit WAV at 44.1 kHz, sine of `freq` Hz at -12 dBFS. */
function writeSine(path, freq) {
  const frames = 44100 * 10;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(44100 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / 44100));
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  writeFileSync(path, buf);
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const same = (px, hex) => rgb(hex).every((c, i) => Math.abs(c - px[i]) <= 8);

export default async function ({ page, sim }) {
  const files = {};
  for (const [name, { freq }] of Object.entries(TRACKS)) {
    const path = join(tmp, `waveform-${freq}.wav`);
    writeSine(path, freq);
    files[name] = readFileSync(path).toString('base64');
  }
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deck = (d) => `window.djing.engine.decks[${d}]`;
  const canvas = (d, cls) => q(`.deck[data-deck="${d}"] .waveform canvas.${cls}`);
  // Pixels [r, g, b] of row y, columns x0..x1 of a canvas, after two frames.
  const row = async (d, cls, y, x0 = 0, x1 = W - 1) => {
    await sleep(100);
    const data = await page.eval(`Array.from(${canvas(d, cls)}.getContext('2d').getImageData(${x0}, ${y}, ${x1 - x0 + 1}, 1).data)`);
    const out = [];
    for (let i = 0; i < data.length; i += 4) out.push(data.slice(i, i + 3));
    return out;
  };
  // True when one of the pixels of columns x-1..x+1 at row y has the colour `hex`.
  const near = async (d, cls, x, y, hex) => (await row(d, cls, y, Math.round(x) - 1, Math.round(x) + 1)).some((px) => same(px, hex));
  const seek = async (d, s) => { await page.eval(`${deck(d)}.seek(${s})`); await sleep(100); };
  const click = (d, act) => page.eval(`${q(`.deck[data-deck="${d}"] [data-act="${act}"]`)}.click()`);
  const zoomLabel = (d) => page.eval(`${q(`.deck[data-deck="${d}"] .zoom-label`)}.textContent`);
  const loadRow = async (path, d) => {
    await page.eval(`[...document.querySelectorAll('#library tbody tr')].find((tr) => tr.cells[2].textContent === ${JSON.stringify(path)})
      .querySelector('button[data-deck="${d}"]').click()`);
    await sleep(1500);
  };

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  // Library directory, with the analyses saved beforehand (so nothing is analysed).
  await page.eval(`(async () => {
    const files = ${JSON.stringify(files)};
    const analysis = ${JSON.stringify(Object.fromEntries(Object.entries(TRACKS).map(([n, t]) => [n, t.analysis])))};
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('waveform', { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle('waveform', { create: true });
    const records = [];
    for (const name of Object.keys(files)) {
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0)));
      await w.close();
      const f = await handle.getFile();
      records.push({ id: name + '|' + f.size + '|' + f.lastModified, path: name, analysis: analysis[name] });
    }
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('djing');
      open.onsuccess = () => {
        const tx = open.result.transaction('tracks', 'readwrite');
        for (const r of records) tx.objectStore('tracks').put(r);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    window.showDirectoryPicker = () => root.getDirectoryHandle('waveform');
  })()`);
  await page.eval(`${q('#libraryPick')}.click()`);
  await sleep(500);
  await loadRow(LOW, 0);
  await loadRow(HIGH, 1);

  check('deux vues par deck : vue d\'ensemble et vue défilante', (await page.eval(`[0, 1].map((d) => document.querySelectorAll(\`.deck[data-deck="\${d}"] .waveform canvas.overview, .deck[data-deck="\${d}"] .waveform canvas.scroll\`).length)`)).join() === '2,2');
  check('zoom par défaut : 8 temps', (await zoomLabel(0)) === '8 temps', await zoomLabel(0));

  // Deck A stopped at 5 s, 8 beats of 0.5 s: the view spans 3..7 s, 250 px per second.
  await seek(0, 5);
  const x8 = (t) => (t - 3) * 250;
  const y = Math.round(SCROLL_H * 0.2);
  check('graves (100 Hz) : couleur des graves dans la vue défilante', same((await row(0, 'scroll', y, 90, 90))[0], COLORS.low), JSON.stringify(await row(0, 'scroll', y, 90, 90)));
  // Deck B at 0 s: the track starts at the centre of its view.
  check('aigus (8 kHz) : couleur des aigus dans la vue défilante', same((await row(1, 'scroll', y, 700, 700))[0], COLORS.high), JSON.stringify(await row(1, 'scroll', y, 700, 700)));
  check('graves : couleur des graves dans la vue d\'ensemble', same((await row(0, 'overview', Math.round(OVERVIEW_H * 0.2), 800, 800))[0], COLORS.low));
  check('tête de lecture au centre de la vue défilante', await near(0, 'scroll', W / 2, y, COLORS.playhead));
  check('ligne de temps (3,6 s) à sa place', await near(0, 'scroll', x8(3.6), y, COLORS.beat));
  check('premier temps de mesure (4,1 s) plus marqué', await near(0, 'scroll', x8(4.1), y, COLORS.bar) && !(await near(0, 'scroll', x8(3.6), y, COLORS.bar)));
  check('pas de ligne entre deux temps', !(await near(0, 'scroll', x8(3.35), y, COLORS.beat)) && !(await near(0, 'scroll', x8(3.35), y, COLORS.bar)));
  const noGrid = await row(1, 'scroll', y);
  check('titre sans grille : aucune ligne de temps', !noGrid.some((px) => same(px, COLORS.beat) || same(px, COLORS.bar)));

  // Markers: CUE point, a hotcue set from the screen and an active loop.
  await page.eval(`${deck(0)}.cuePoint = 4.7`);
  await seek(0, 4.85);
  await page.eval(`${q('.deck[data-deck="0"] .hotcues button[data-led="hotcue.0"]')}.click()`);
  await page.eval(`${deck(0)}.setLoop({ start: 5.3, end: 5.8 })`);
  await seek(0, 5);
  check('repère CUE dans la vue défilante', await near(0, 'scroll', x8(4.7), y, COLORS.cue));
  check('repère de hotcue dans la vue défilante', await near(0, 'scroll', x8(4.85), y, COLORS.hotcue));
  check('bornes de la boucle active dans la vue défilante', (await near(0, 'scroll', x8(5.3), y, COLORS.loop)) && (await near(0, 'scroll', x8(5.8), y, COLORS.loop)));
  check('repères dans la vue d\'ensemble (CUE, hotcue, boucle)', (await near(0, 'overview', 470, 5, COLORS.cue)) && (await near(0, 'overview', 485, 5, COLORS.hotcue)) && (await near(0, 'overview', 530, 5, COLORS.loop)));
  await page.eval(`${deck(0)}.setLoop(null)`);

  // Zoom from 2 to 32 beats.
  for (let i = 0; i < 3; i++) await click(0, 'waveform.zoomIn');
  check('zoom avant jusqu\'à 2 temps, pas au-delà', (await zoomLabel(0)) === '2 temps', await zoomLabel(0));
  // 2 beats: 4.5..5.5 s, 1000 px per second.
  check('2 temps : ligne de temps (4,6 s) à sa place', await near(0, 'scroll', (4.6 - 4.5) * 1000, y, COLORS.beat));
  for (let i = 0; i < 5; i++) await click(0, 'waveform.zoomOut');
  check('zoom arrière jusqu\'à 32 temps, pas au-delà', (await zoomLabel(0)) === '32 temps', await zoomLabel(0));
  // 32 beats: -3..13 s, 62.5 px per second.
  check('32 temps : premier temps de mesure (2,1 s) à sa place', await near(0, 'scroll', (2.1 + 3) * 62.5, y, COLORS.bar));
  check('zoom propre à chaque deck', (await zoomLabel(1)) === '8 temps', await zoomLabel(1));

  // Click on the overview: jump to 25 % of the track.
  await page.eval(`(() => {
    const c = ${canvas(0, 'overview')};
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.25, clientY: r.top + r.height / 2 }));
  })()`);
  await sleep(100);
  const at = await page.eval(`${deck(0)}.position`);
  check('clic sur la vue d\'ensemble : saut à 25 % du titre', Math.abs(at - 2.5) < 0.05, String(at));
  check('tête de lecture à 25 % de la vue d\'ensemble', await near(0, 'overview', 250, 5, COLORS.playhead));

  // Mids, on deck B.
  await loadRow(MID, 1);
  check('médiums (1 kHz) : couleur des médiums dans la vue défilante', same((await row(1, 'scroll', y, 700, 700))[0], COLORS.mid), JSON.stringify(await row(1, 'scroll', y, 700, 700)));

  // Frame rate with both decks playing.
  await sim.send('press A play', 200);
  await sim.send('press B play', 500);
  const frames = await page.eval(`new Promise((resolve) => {
    const gaps = [];
    let last = null;
    const end = performance.now() + 3000;
    const tick = (now) => {
      if (last !== null) gaps.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick); else resolve({ count: gaps.length, max: Math.max(...gaps) });
    };
    requestAnimationFrame(tick);
  })`);
  check('deux decks en lecture : aucune trame de plus de 50 ms sur 3 s', frames.max <= 50 && frames.count >= 120, `${frames.count} trames, max ${frames.max.toFixed(1)} ms`);
  const moving = await page.eval(`${deck(0)}.playing && ${deck(1)}.playing`);
  check('les deux decks jouent pendant la mesure', moving);
  await sim.send('press A play', 100);
  await sim.send('press B play', 100);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
