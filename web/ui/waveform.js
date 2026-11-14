// Waveforms of each deck: an overview of the whole track (click to jump) and a scrolling view centred
// on the position heard, 2 to 32 beats wide. Peaks of three bands (lows < 250 Hz, mids, highs > 4 kHz)
// are computed once per track when it is loaded; each frame draws only the visible window, with the
// beat grid of the track (the first beat of each bar stronger), the CUE point, the hotcues and the loop.
import { register, dispatch } from '../actions.js';

export const ZOOMS = [2, 4, 8, 16, 32]; // beats visible in the scrolling view
const DEFAULT_ZOOM = 8;
const FALLBACK_BPM = 120; // beat length of the zoom without a grid
const BEATS_PER_BAR = 4;
// Colours: the --wave-* tokens of style.css, read once the page is styled (createWaveforms).
export const COLORS = {};
function readColors() {
  const style = getComputedStyle(document.documentElement);
  const token = (name) => style.getPropertyValue(`--wave-${name}`).trim();
  Object.assign(COLORS, {
    bands: [token('low'), token('mid'), token('high')], // drawn in this order
    played: token('played'),
    beat: token('beat'),
    bar: token('bar'),
    playhead: token('playhead'),
    cue: token('cue'),
    hotcue: token('hotcue'),
    loop: token('loop'),
    loopFill: token('loop-fill'),
  });
}

let worker = null;
let messages = 0;
const pending = new Map();

/**
 * Peaks of the three bands of `buffer`, computed in waveform-worker.js: { bands: [Float32Array × 3],
 * perSecond }, values in 0..1 relative to the loudest band.
 */
export function bandPeaks(buffer) {
  if (!worker) {
    worker = new Worker(new URL('./waveform-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error)); else resolve(data);
    };
  }
  const id = ++messages;
  // Copies, so the AudioBuffer stays whole; sent by transfer.
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((ch) => ch.buffer));
  });
}

/** Adds both waveforms and the zoom buttons to every deck panel; start() runs the drawing loop. */
export function createWaveforms(ctx, panels) {
  readColors();
  const views = panels.map((ui, d) => createView(ui, d));
  const deckOf = (d) => (ctx.engine?.decks[d]?.buffer ? ctx.engine.decks[d] : null);

  const zoom = (step) => (d, v) => {
    if (v <= 0) return;
    const i = ZOOMS.indexOf(views[d].zoom) + step;
    if (i >= 0 && i < ZOOMS.length) views[d].zoom = ZOOMS[i];
    views[d].zoomLabel.textContent = `${views[d].zoom} temps`;
  };
  register('waveform.zoomIn', zoom(-1));
  register('waveform.zoomOut', zoom(1));

  // Band peaks of the new track, unless another one was loaded meanwhile.
  document.addEventListener('djing:load', async ({ detail: { deck: d } }) => {
    const view = views[d];
    const buffer = ctx.engine.decks[d].buffer;
    view.peaks = null;
    view.overview = null;
    try {
      const peaks = await bandPeaks(buffer);
      if (ctx.engine.decks[d].buffer !== buffer) return;
      view.peaks = peaks;
      view.overview = renderOverview(peaks, view.overviewCanvas, buffer.duration);
    } catch (err) {
      ctx.log(`Waveform non calculée : ${err.message}`);
    }
  });

  function frame() {
    views.forEach((view, d) => {
      const deck = deckOf(d);
      const marks = deck ? markers(deck, ctx.hotcues?.[d] ?? []) : null;
      drawOverview(view, deck, marks);
      drawScroll(view, deck, marks, panels[d].track?.analysis);
    });
    requestAnimationFrame(frame);
  }
  return { views, start: () => requestAnimationFrame(frame) };
}

function createView(ui, d) {
  const box = ui.section.querySelector('.waveform');
  const view = {
    overviewCanvas: box.querySelector('.overview'),
    scrollCanvas: box.querySelector('.scroll'),
    zoomLabel: box.querySelector('.zoom-label'),
    zoom: DEFAULT_ZOOM,
    peaks: null,
    overview: null,
  };
  view.overviewCanvas.addEventListener('click', (e) => {
    const r = view.overviewCanvas.getBoundingClientRect();
    dispatch('seek', d, (e.clientX - r.left) / r.width);
  });
  return view;
}

/** Cue point, hotcues and loop of `deck`, in seconds. */
function markers(deck, hotcues) {
  return {
    cue: deck.cuePoint,
    hotcues: hotcues.filter((at) => at !== null),
    loop: deck.loop,
    loopStart: deck.loop ? null : deck.loopStart,
  };
}

/** Peak of `band` over [from, to) peak indices, at least the peak at `from`. */
function peakAt(band, from, to) {
  const n = band.length;
  let i = Math.floor(from);
  if (i >= n || to <= 0) return 0;
  let max = i >= 0 ? band[i] : 0;
  for (i = Math.max(0, i + 1); i < to && i < n; i++) if (band[i] > max) max = band[i];
  return max;
}

/** Draws the three bands, one fill each, for columns 0..w whose peak range is span(x) = [from, to). */
function drawBands(g, bands, w, h, span) {
  bands.forEach((band, b) => {
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const [from, to] = span(x);
      const v = peakAt(band, from, to) * h * 0.48;
      if (v > 0.25) g.rect(x, h / 2 - v, 1, v * 2);
    }
    g.fillStyle = COLORS.bands[b];
    g.fill();
  });
}

/** Static image of the whole track for the overview, drawn once per track. */
function renderOverview(peaks, canvas, duration) {
  const image = document.createElement('canvas');
  image.width = canvas.width;
  image.height = canvas.height;
  const perPixel = (duration * peaks.perSecond) / image.width;
  drawBands(image.getContext('2d'), peaks.bands, image.width, image.height, (x) => [x * perPixel, (x + 1) * perPixel]);
  return image;
}

const line = (g, x, h, width, color) => {
  g.fillStyle = color;
  g.fillRect(Math.round(x - width / 2), 0, width, h);
};

function drawMarkers(g, marks, xOf, w, h) {
  if (marks.loop) {
    const [a, b] = [xOf(marks.loop.start), xOf(marks.loop.end)];
    if (b >= 0 && a <= w) {
      g.fillStyle = COLORS.loopFill;
      g.fillRect(a, 0, b - a, h);
      line(g, a, h, 2, COLORS.loop);
      line(g, b, h, 2, COLORS.loop);
    }
  } else if (marks.loopStart !== null) line(g, xOf(marks.loopStart), h, 2, COLORS.loop);
  for (const at of marks.hotcues) line(g, xOf(at), h, 2, COLORS.hotcue);
  line(g, xOf(marks.cue), h, 2, COLORS.cue);
}

function drawOverview(view, deck, marks) {
  const canvas = view.overviewCanvas;
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  if (!deck || !view.overview) return;
  const xOf = (t) => (t / deck.duration) * w;
  const position = deck.position;
  g.drawImage(view.overview, 0, 0);
  g.fillStyle = COLORS.played;
  g.fillRect(0, 0, xOf(position), h);
  drawMarkers(g, marks, xOf, w, h);
  line(g, xOf(position), h, 2, COLORS.playhead);
}

/**
 * Bands of the scrolling view, drawn on a strip three views wide whose columns sit on a fixed grid of
 * the track (column k covers [k, k + 1) × secondsPerPixel), redrawn only when the view leaves it or
 * the scale changes. Returns the drawImage() arguments that put the strip under the view at `start`.
 */
function strip(view, start, secondsPerPixel, w, h) {
  const first = Math.floor(start / secondsPerPixel);
  let s = view.strip;
  if (!s || s.peaks !== view.peaks || s.secondsPerPixel !== secondsPerPixel || first < s.first || first + w > s.first + s.canvas.width) {
    s = view.strip ??= { canvas: document.createElement('canvas') };
    s.canvas.width = 3 * w;
    s.canvas.height = h;
    s.first = first - w;
    s.peaks = view.peaks;
    s.secondsPerPixel = secondsPerPixel;
    const { bands, perSecond } = view.peaks;
    const step = secondsPerPixel * perSecond;
    drawBands(s.canvas.getContext('2d'), bands, s.canvas.width, h, (x) => [(s.first + x) * step, (s.first + x + 1) * step]);
  }
  return [s.canvas, Math.round(s.first - start / secondsPerPixel), 0];
}

function drawScroll(view, deck, marks, analysis) {
  const canvas = view.scrollCanvas;
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  if (!deck || !view.peaks) return;
  const position = deck.position; // what is heard, behind the playhead by the keylock latency
  const beat = 60 / (analysis?.bpm || FALLBACK_BPM);
  const secondsPerPixel = (view.zoom * beat) / w;
  const start = position - (w / 2) * secondsPerPixel;
  const xOf = (t) => (t - start) / secondsPerPixel;
  g.drawImage(...strip(view, start, secondsPerPixel, w, h));

  if (analysis?.bpm) {
    const first = Math.ceil((start - analysis.firstBeat) / beat);
    const last = Math.floor((start + w * secondsPerPixel - analysis.firstBeat) / beat);
    for (let k = first; k <= last; k++) {
      const t = analysis.firstBeat + k * beat;
      if (t < 0 || t > deck.duration) continue;
      const bar = ((k % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
      line(g, xOf(t), h, bar ? 2 : 1, bar ? COLORS.bar : COLORS.beat);
    }
  }
  drawMarkers(g, marks, xOf, w, h);
  line(g, w / 2, h, 2, COLORS.playhead);
}
