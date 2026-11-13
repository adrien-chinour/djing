// Waveforms of each deck: an overview of the whole track (click to jump) and a scrolling view centred
// on the position heard, 2 to 32 beats wide. Peaks of three bands (lows < 250 Hz, mids, highs > 4 kHz)
// are computed once per track when it is loaded; each frame draws only the visible window, with the
// beat grid of the track (the first beat of each bar stronger), the CUE point, the hotcues and the loop.
import { register, dispatch } from '../actions.js';

export const ZOOMS = [2, 4, 8, 16, 32]; // beats visible in the scrolling view
const DEFAULT_ZOOM = 8;
const FALLBACK_BPM = 120; // beat length of the zoom without a grid
const BEATS_PER_BAR = 4;
const RATE = 22050; // analysis sample rate, enough for the highs band
const HOP = 128; // frames per peak, about 172 peaks per second
export const COLORS = {
  bands: ['#ff4d5e', '#ffb340', '#59d0ff'], // lows, mids, highs, drawn in this order
  played: 'rgba(12, 14, 17, 0.6)',
  beat: '#5c636e',
  bar: '#d9dde3',
  playhead: '#ffffff',
  cue: '#ffcc4d',
  hotcue: '#c47bff',
  loop: '#5ad17a',
  loopFill: 'rgba(90, 209, 122, 0.22)',
};

/**
 * Peaks of the three bands of `buffer`: { bands: [Float32Array × 3], perSecond }, values in 0..1
 * relative to the loudest band (mono mix, rendered offline through 24 dB/octave filters).
 */
export async function bandPeaks(buffer) {
  const length = Math.max(1, Math.ceil(buffer.duration * RATE));
  const off = new OfflineAudioContext(3, length, RATE);
  const source = new AudioBufferSourceNode(off, { buffer });
  const merger = new ChannelMergerNode(off, { numberOfInputs: 3 });
  const mono = { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
  const chains = [
    [['lowpass', 250], ['lowpass', 250]],
    [['highpass', 250], ['highpass', 250], ['lowpass', 4000], ['lowpass', 4000]],
    [['highpass', 4000], ['highpass', 4000]],
  ];
  chains.forEach((chain, band) => {
    let node = source;
    for (const [type, frequency] of chain) node = node.connect(new BiquadFilterNode(off, { type, frequency, Q: Math.SQRT1_2, ...mono }));
    node.connect(merger, 0, band);
  });
  merger.connect(off.destination);
  source.start();
  const rendered = await off.startRendering();
  const count = Math.ceil(length / HOP);
  let loudest = 0;
  const bands = [0, 1, 2].map((band) => {
    const data = rendered.getChannelData(band);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let max = 0;
      for (let j = i * HOP, end = Math.min(j + HOP, length); j < end; j++) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > max) max = v;
      }
      out[i] = max;
      if (max > loudest) loudest = max;
    }
    return out;
  });
  if (loudest > 0) for (const b of bands) for (let i = 0; i < count; i++) b[i] /= loudest;
  return { bands, perSecond: RATE / HOP };
}

/** Adds both waveforms and the zoom buttons to every deck panel; start() runs the drawing loop. */
export function createWaveforms(ctx, panels) {
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
  const { bands, perSecond } = view.peaks;
  drawBands(g, bands, w, h, (x) => [(start + x * secondsPerPixel) * perSecond, (start + (x + 1) * secondsPerPixel) * perSecond]);

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
