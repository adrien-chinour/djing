// Tempo and beat grid of a whole track, constant tempo only. Pure functions, no DOM: runs in the
// analysis worker (worker.js). Steps:
// 1. onset envelope: rise of the log energy over 20 ms windows, every 1.5 ms;
// 2. tempo: autocorrelation of the (smoothed) envelope over the lags of BPM_MIN..BPM_MAX, the
//    shortest lag whose peak reaches 80 % of the highest one (prefers 174 over 87);
// 3. period refinement: the period whose folded envelope has the sharpest peak;
// 4. grid: least squares over the onset peak found near each beat (sub-frame BPM and phase).
// The first beat is the first beat of the grid that carries an onset.

export const BPM_MIN = 70;
export const BPM_MAX = 180;
const HOP_S = 0.0015;
const WIN_S = 0.02;
// A track has no detectable pulse when its autocorrelation peak stands less than this many robust
// standard deviations (median absolute deviation) above the median over the lag range (white
// noise: about 3 to 4; click tracks: hundreds).
const MIN_SALIENCE = 8;
// An estimate that misses the range by less than this is clamped, not folded (69.99 stays 70).
const FOLD_TOLERANCE = 0.5;

/** Folds `bpm` into BPM_MIN..BPM_MAX by doubling or halving. */
export function foldBpm(bpm) {
  while (bpm < BPM_MIN - FOLD_TOLERANCE) bpm *= 2;
  while (bpm > BPM_MAX + FOLD_TOLERANCE) bpm /= 2;
  return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
}

/** Onset envelope of mono `samples`: positive rise of log energy per frame (frame n ends at n * hop + win). */
function onsetEnvelope(samples, hop, win) {
  const n = Math.floor((samples.length - win) / hop) + 1;
  if (n < 2) return new Float32Array(0);
  const cumulative = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) cumulative[i + 1] = cumulative[i] + samples[i] * samples[i];
  const energy = new Float64Array(n);
  let mean = 0;
  for (let f = 0; f < n; f++) {
    energy[f] = (cumulative[f * hop + win] - cumulative[f * hop]) / win;
    mean += energy[f] / n;
  }
  const floor = mean * 1e-6 + 1e-20;
  const flux = new Float32Array(n);
  let previous = Math.log10(energy[0] + floor);
  for (let f = 1; f < n; f++) {
    const level = Math.log10(energy[f] + floor);
    flux[f] = Math.max(0, level - previous);
    previous = level;
  }
  return flux;
}

/** Moving average of `x` over 2 * radius + 1 values, mean removed. */
function smoothCentered(x, radius) {
  const out = new Float32Array(x.length);
  let sum = 0;
  let mean = 0;
  for (let i = 0; i < x.length + radius; i++) {
    if (i < x.length) sum += x[i];
    if (i - 2 * radius - 1 >= 0) sum -= x[i - 2 * radius - 1];
    const c = i - radius;
    if (c >= 0) { out[c] = sum / (2 * radius + 1); mean += out[c]; }
  }
  mean /= x.length;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

const medianOf = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Vertex of the parabola through (−1, a), (0, b), (1, c): offset in −0.5..0.5. */
const vertex = (a, b, c) => (a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c));

/** Height of the sharpest peak of `x` folded over `period` frames, and its phase in frames. */
function fold(x, period) {
  const bins = Math.ceil(period);
  const hist = new Float64Array(bins);
  for (let i = 0; i < x.length; i++) hist[Math.floor(i % period)] += x[i];
  let best = 0;
  for (let b = 1; b < bins; b++) if (hist[b] > hist[best]) best = b;
  return { height: hist[best], phase: best };
}

/** Onset peaks near each beat of the grid (phase, period): [{ k, at, value }], `at` in frames. */
function beatPeaks(flux, phase, period, reach) {
  const peaks = [];
  const radius = Math.max(1, Math.round(period * reach));
  for (let k = Math.ceil((radius - phase) / period); phase + k * period < flux.length - radius; k++) {
    const centre = Math.round(phase + k * period);
    let best = centre - radius;
    for (let f = centre - radius; f <= centre + radius; f++) if (flux[f] > flux[best]) best = f;
    const offset = best > 0 && best < flux.length - 1 ? vertex(flux[best - 1], flux[best], flux[best + 1]) : 0;
    peaks.push({ k, at: best + offset, value: flux[best] });
  }
  return peaks;
}

/** Least-squares line at = phase + k * period over the peaks of at least half the median value. */
function fitGrid(peaks) {
  const median = peaks.length ? medianOf(peaks.map((p) => p.value)) : 0;
  const kept = peaks.filter((p) => p.value > 0 && p.value >= median / 2);
  if (kept.length < 4) return null;
  let sk = 0, st = 0, skk = 0, skt = 0;
  for (const { k, at } of kept) { sk += k; st += at; skk += k * k; skt += k * at; }
  const n = kept.length;
  const period = (n * skt - sk * st) / (n * skk - sk * sk);
  return { period, phase: (st - period * sk) / n, firstK: kept[0].k };
}

/**
 * Analyses mono `samples` at `sampleRate`. Returns { bpm, firstBeat } (BPM in BPM_MIN..BPM_MAX,
 * first beat in seconds), or { bpm: null, firstBeat: null } when no pulse stands out.
 */
export function analyzeBeat(samples, sampleRate) {
  const unknown = { bpm: null, firstBeat: null };
  const hop = Math.max(1, Math.round(sampleRate * HOP_S));
  const win = Math.round(sampleRate * WIN_S);
  const hopS = hop / sampleRate;
  const flux = onsetEnvelope(samples, hop, win);
  const lagMin = Math.floor(60 / BPM_MAX / hopS);
  const lagMax = Math.ceil(60 / BPM_MIN / hopS);
  if (flux.length < lagMax * 4) return unknown;

  const smooth = smoothCentered(flux, 3);
  let energy = 0;
  for (const v of smooth) energy += v * v;
  if (!(energy > 0)) return unknown;
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < smooth.length; i++) sum += smooth[i] * smooth[i + lag];
    ac[lag] = sum / energy;
  }
  let best = lagMin;
  for (let lag = lagMin; lag <= lagMax; lag++) if (ac[lag] > ac[best]) best = lag;
  const range = Array.from(ac.subarray(lagMin, lagMax + 1));
  const median = medianOf(range);
  const spread = 1.4826 * medianOf(range.map((v) => Math.abs(v - median)));
  if (!(spread > 0) || (ac[best] - median) / spread < MIN_SALIENCE) return unknown;
  let lag = best;
  for (let l = lagMin; l < best; l++) {
    if (ac[l] >= 0.8 * ac[best] && ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]) { lag = l; break; }
  }
  let period = lag + vertex(ac[lag - 1], ac[lag], ac[lag + 1]);

  // Refine the period: the folded envelope is sharpest at the right period (±0.5 %).
  let sharpest = { height: -Infinity };
  for (let step = -250; step <= 250; step++) {
    const p = period * (1 + step * 2e-5);
    const f = fold(smooth, p);
    if (f.height > sharpest.height) sharpest = { ...f, period: p };
  }
  // Fit the grid on the onset peaks, then once more with a narrower search around the fit.
  let grid = fitGrid(beatPeaks(flux, sharpest.phase, sharpest.period, 0.1));
  if (grid) grid = fitGrid(beatPeaks(flux, grid.phase, grid.period, 0.03)) ?? grid;
  if (!grid || !(grid.period > 0)) return unknown;

  // Frame f covers samples [f * hop, f * hop + win): its onset lies in the last hop.
  const seconds = (frame) => (frame * hop + win - hop / 2) / sampleRate;
  const bpm = 60 / (grid.period * hopS);
  return { bpm: foldBpm(bpm), firstBeat: seconds(grid.phase + grid.firstK * grid.period) };
}
