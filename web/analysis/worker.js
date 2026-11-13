// Analysis worker: one message per track, { id, samples, sampleRate } (id: message number,
// mono Float32Array transferred), answered by { id, bpm, firstBeat } (see beat.js) or { id, error }.
import { analyzeBeat } from './beat.js';

self.onmessage = ({ data: { id, samples, sampleRate } }) => {
  try {
    self.postMessage({ id, ...analyzeBeat(samples, sampleRate) });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
