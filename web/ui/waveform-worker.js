// Waveform worker: one message per track, { id, channels, sampleRate } (Float32Array channels,
// transferred), answered by { id, bands, perSecond } (see bandPeaks) or { id, error }.

const PER_SECOND = 172; // peaks per second, about one every 5.8 ms
const BANDS = [
  [['lowpass', 250], ['lowpass', 250]], // lows < 250 Hz
  [['highpass', 250], ['highpass', 250], ['lowpass', 4000], ['lowpass', 4000]], // mids
  [['highpass', 4000], ['highpass', 4000]], // highs > 4 kHz
];

/** In-place biquad of the Audio EQ Cookbook (Q = 1/√2), `type` lowpass or highpass at `freq` Hz. */
function biquad(x, sampleRate, type, freq) {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (type === 'lowpass' ? 1 - cos : -(1 + cos)) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
}

/**
 * Peaks of the three bands of the mono mix of `channels`: { bands: [Float32Array × 3], perSecond },
 * values in 0..1 relative to the loudest band (24 dB/octave filters).
 */
export function bandPeaks(channels, sampleRate) {
  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] += ch[i] / channels.length;
  const hop = Math.max(1, Math.round(sampleRate / PER_SECOND));
  const count = Math.ceil(length / hop);
  let loudest = 0;
  const bands = BANDS.map((chain) => {
    const x = Float32Array.from(mono);
    for (const [type, freq] of chain) biquad(x, sampleRate, type, freq);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let max = 0;
      for (let j = i * hop, end = Math.min(j + hop, length); j < end; j++) {
        const v = x[j] < 0 ? -x[j] : x[j];
        if (v > max) max = v;
      }
      out[i] = max;
      if (max > loudest) loudest = max;
    }
    return out;
  });
  if (loudest > 0) for (const b of bands) for (let i = 0; i < count; i++) b[i] /= loudest;
  return { bands, perSecond: sampleRate / hop };
}

self.onmessage = ({ data: { id, channels, sampleRate } }) => {
  try {
    const { bands, perSecond } = bandPeaks(channels, sampleRate);
    self.postMessage({ id, bands, perSecond }, bands.map((b) => b.buffer));
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
