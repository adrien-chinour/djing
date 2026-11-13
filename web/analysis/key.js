// Musical key of a whole track, in Camelot notation (8A = A minor, 8B = C major). Pure functions,
// no DOM: runs in the analysis worker (worker.js). Steps:
// 1. chromagram: magnitude spectrum of FRAME-sample frames (Hann window), each bin between F_MIN
//    and F_MAX added to its pitch class, summed over the track;
// 2. key: Pearson correlation of the chroma with the 24 rotations of the Krumhansl-Schmuckler
//    major and minor profiles, the highest wins;
// 3. no key ("?") when the chroma is too flat (noise, silence) or the winner is too weak.
// A single key for the whole track: key changes are not detected.

const FRAME = 8192;
const F_MIN = 55; // A1
const F_MAX = 1760; // A6: five whole octaves, so that every pitch class gets as many bins
// Krumhansl-Kessler probe-tone profiles, index 0 = tonic.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Below this correlation the best key is not trusted.
const MIN_CORRELATION = 0.6;
// Chroma whose strongest pitch class is less than this above the mean is too flat (white noise:
// about 1.05; a chord progression: above 2).
const MIN_CONTRAST = 1.3;

/** Camelot code of the key whose tonic is pitch class `pc` (0 = C) in `mode` ("major" | "minor"). */
export function camelot(pc, mode) {
  const major = mode === 'major' ? pc : (pc + 3) % 12; // a minor key shares the number of its relative major
  return `${((7 * major + 7) % 12) + 1}${mode === 'major' ? 'B' : 'A'}`;
}

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Chroma of mono `samples`: 12 mean spectral magnitudes, index 0 = C. */
export function chromagram(samples, sampleRate) {
  const chroma = new Float64Array(12);
  const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const lo = Math.ceil((F_MIN * FRAME) / sampleRate);
  const hi = Math.min(FRAME / 2 - 1, Math.floor((F_MAX * FRAME) / sampleRate));
  const pcOfBin = new Int8Array(hi + 1);
  const bins = new Float64Array(12);
  for (let k = lo; k <= hi; k++) {
    const midi = 69 + 12 * Math.log2((k * sampleRate) / FRAME / 440);
    pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
    bins[pcOfBin[k]]++;
  }
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
    for (let i = 0; i < FRAME; i++) re[i] = samples[start + i] * window[i];
    im.fill(0);
    fft(re, im);
    for (let k = lo; k <= hi; k++) chroma[pcOfBin[k]] += Math.hypot(re[k], im[k]);
  }
  // Mean per bin: a pitch class does not weigh more because it covers more bins (white noise is flat).
  return chroma.map((v, pc) => v / bins[pc]);
}

function correlation(x, profile, shift) {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 12; i++) { mx += x[i] / 12; my += profile[i] / 12; }
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < 12; i++) {
    const dx = x[(i + shift) % 12] - mx;
    const dy = profile[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Key of mono `samples`: { key: Camelot code, or null when no key stands out }. */
export function analyzeKey(samples, sampleRate) {
  const chroma = chromagram(samples, sampleRate);
  const mean = chroma.reduce((s, v) => s + v, 0) / 12;
  if (!(mean > 0) || Math.max(...chroma) < MIN_CONTRAST * mean) return { key: null };
  let best = { r: -Infinity, key: null };
  for (let pc = 0; pc < 12; pc++) {
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const r = correlation(chroma, profile, pc);
      if (r > best.r) best = { r, key: camelot(pc, mode) };
    }
  }
  return { key: best.r >= MIN_CORRELATION ? best.key : null };
}
