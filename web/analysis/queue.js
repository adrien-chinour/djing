// Page side of the track analysis: decodes each track (off the main thread, at SAMPLE_RATE, mono)
// and hands it to the analysis worker, one track at a time. Results are saved in the "tracks"
// store under `analysis`; a track that already has one is never analysed again.
import { patch } from '../library/db.js';

const SAMPLE_RATE = 22050;
let worker = null;
const pending = new Map(); // message id -> { resolve, reject }
let lastId = 0;

function analyzeSamples(samples) {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, error, bpm, firstBeat } }) => {
      const answer = pending.get(id);
      pending.delete(id);
      if (error) answer?.reject(new Error(error));
      else answer?.resolve({ bpm, firstBeat });
    };
  }
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, samples, sampleRate: SAMPLE_RATE }, [samples.buffer]);
  });
}

async function decodeMono(file) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

let run = 0;

/**
 * Analyses, in order, the `tracks` ({ id, file, analysis? }) that have no analysis yet. Calls
 * onProgress(done, total) before the first and after each track, and onResult(track) once
 * track.analysis is set and saved. A new call cancels the previous one (after its current track).
 * Tracks that do not decode are skipped and left for a later run.
 */
export async function analyzeTracks(tracks, { onProgress, onResult, onError }) {
  const mine = ++run;
  const todo = tracks.filter((t) => !t.analysis);
  onProgress(0, todo.length);
  for (const [i, track] of todo.entries()) {
    try {
      const analysis = await analyzeSamples(await decodeMono(track.file));
      if (mine !== run) return;
      track.analysis = analysis;
      await patch('tracks', track.id, { path: track.path, analysis });
      onResult(track);
    } catch (err) {
      if (mine !== run) return;
      onError?.(track, err);
    }
    onProgress(i + 1, todo.length);
  }
}

/** Text of a BPM: "124.00", "BPM inconnu" (no pulse), "…" (not analysed yet). */
export const formatBpm = (analysis) => (!analysis ? '…' : analysis.bpm === null ? 'BPM inconnu' : analysis.bpm.toFixed(2));

/** Tells the library and the decks that `track.analysis` changed (event "djing:analysis", detail: track). */
export const announce = (track) => document.dispatchEvent(new CustomEvent('djing:analysis', { detail: track }));
