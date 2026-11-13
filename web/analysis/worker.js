// Analysis worker: one message per track, { id, samples, sampleRate, beat } (id: message number,
// mono Float32Array transferred, beat: false to skip the tempo of a track that already has one),
// answered by { id, bpm, firstBeat, key } (see beat.js and key.js; no bpm/firstBeat when
// beat is false) or { id, error }.
import { analyzeBeat } from './beat.js';
import { analyzeKey } from './key.js';

self.onmessage = ({ data: { id, samples, sampleRate, beat = true } }) => {
  try {
    self.postMessage({ id, ...(beat ? analyzeBeat(samples, sampleRate) : {}), ...analyzeKey(samples, sampleRate) });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
