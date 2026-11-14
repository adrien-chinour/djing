// Musical key of a whole track, in Camelot notation (8A = A minor, 8B = C major). Pure functions,
// no DOM: runs in the analysis worker (worker.js). Steps:
// 1. chromagram: magnitude spectrum of ~0.37 s frames (Hann window, same frequency resolution at any
//    sample rate); only spectral peaks count, each added to its nearest semitone (weighted by how close
//    it is to the semitone's centre). Each semitone is divided by the mean of the semitones around it
//    (spectral whitening: the overall slope of the spectrum favours no pitch class), then the four
//    octaves from A2 to G#6 are folded into 12 pitch classes, scaled so that the frame's strongest is 1
//    (a loud passage weighs no more than a quiet one), and summed over the track. Below A2 lie the kick
//    and the sub-bass, whose pitch sweeps blur the pitch classes;
// 2. key: Pearson correlation of the chroma with the 24 rotations of the Krumhansl-Schmuckler
//    major and minor profiles, the highest wins;
// 3. no key ("?") when the chroma is too flat (noise, silence) or the winner is too weak.
// A single key for the whole track: key changes are not detected.

const FRAME_S = 0.37; // frame length in seconds, rounded to a power of two of samples (8192 at 22050 Hz)
const LOW = 45; // MIDI A2 (110 Hz): first semitone of the folded range
const OCTAVES = 4; // up to G#6 (1661 Hz): every pitch class covers as many semitones
const WHITEN = 6; // semitones on each side of the mean that whitens a semitone
// Krumhansl-Kessler probe-tone profiles, index 0 = tonic.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Below this correlation the best key is not trusted (real tracks: 0.6 and above; noise can reach 0.7,
// it is told apart by the contrast).
const MIN_CORRELATION = 0.5;
// Chroma whose strongest pitch class is less than this above the mean is too flat. The flatness of
// noise varies with its number of frames n: at most 1 + 0.85 / sqrt(n) in practice (white or red
// noise, 13 to 215 frames), hence a threshold of 1 + NOISE_SPREAD / sqrt(n), and never below
// MIN_CONTRAST. Real tracks: 1.2 and above; chord progressions: above 1.5.
const NOISE_SPREAD = 1.5;
const MIN_CONTRAST = 1.1;

const frameLength = (sampleRate) => 2 ** Math.round(Math.log2(FRAME_S * sampleRate));

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

/** Chroma of mono `samples`: 12 sums of per-frame pitch class weights (0..1), index 0 = C. */
export function chromagram(samples, sampleRate) {
  const frame = frameLength(sampleRate);
  const window = Float64Array.from({ length: frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame));
  // Semitones [first, first + count): the folded range and WHITEN more on each side.
  const first = LOW - WHITEN;
  const count = 12 * OCTAVES + 2 * WHITEN;
  const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
  const lo = Math.max(1, Math.ceil((hz(first - 0.5) * frame) / sampleRate));
  const hi = Math.min(frame / 2 - 2, Math.floor((hz(first + count - 0.5) * frame) / sampleRate));
  const semitoneOfBin = new Int16Array(hi + 1);
  const weightOfBin = new Float64Array(hi + 1);
  for (let k = lo; k <= hi; k++) {
    const midi = 69 + 12 * Math.log2((k * sampleRate) / frame / 440);
    const nearest = Math.round(midi);
    semitoneOfBin[k] = Math.min(count - 1, Math.max(0, nearest - first));
    weightOfBin[k] = Math.cos(Math.PI * (midi - nearest)) ** 2;
  }
  const chroma = new Float64Array(12);
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const mag = new Float64Array(hi + 2);
  const semitones = new Float64Array(count);
  const frameChroma = new Float64Array(12);
  for (let start = 0; start + frame <= samples.length; start += frame) {
    for (let i = 0; i < frame; i++) re[i] = samples[start + i] * window[i];
    im.fill(0);
    fft(re, im);
    for (let k = lo - 1; k <= hi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    semitones.fill(0);
    for (let k = lo; k <= hi; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) semitones[semitoneOfBin[k]] += mag[k] * weightOfBin[k];
    }
    frameChroma.fill(0);
    for (let n = WHITEN; n < count - WHITEN; n++) {
      let around = 0;
      for (let j = n - WHITEN; j <= n + WHITEN; j++) around += semitones[j];
      if (around > 0) frameChroma[(first + n) % 12] += (semitones[n] * (2 * WHITEN + 1)) / around;
    }
    const max = Math.max(...frameChroma);
    if (max > 0) for (let pc = 0; pc < 12; pc++) chroma[pc] += frameChroma[pc] / max;
  }
  return chroma;
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
  const frames = Math.floor(samples.length / frameLength(sampleRate));
  const minContrast = Math.max(MIN_CONTRAST, 1 + NOISE_SPREAD / Math.sqrt(frames));
  if (!(mean > 0) || Math.max(...chroma) < minContrast * mean) return { key: null };
  let best = { r: -Infinity, key: null };
  for (let pc = 0; pc < 12; pc++) {
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const r = correlation(chroma, profile, pc);
      if (r > best.r) best = { r, key: camelot(pc, mode) };
    }
  }
  return { key: best.r >= MIN_CORRELATION ? best.key : null };
}
