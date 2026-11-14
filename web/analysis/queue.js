// Page side of the track analysis: decodes each track (off the main thread, at SAMPLE_RATE, mono)
// and hands it to the analysis worker, one track at a time. Results are saved in the "tracks"
// store under `analysis` ({ bpm, firstBeat, key }); a complete one is never computed again, and
// one saved before the key analysis only gets its key (the tempo and grid are kept). The decoded
// length is saved beside it as the track's `duration` (seconds), for the library's Duration column.
import { patch } from '../library/db.js';

const SAMPLE_RATE = 22050;
let worker = null;
const pending = new Map(); // message id -> { resolve, reject }
let lastId = 0;

function analyzeSamples(samples, beat) {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, error, ...result } }) => {
      const answer = pending.get(id);
      pending.delete(id);
      if (error) answer?.reject(new Error(error));
      else answer?.resolve(result);
    };
  }
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, samples, sampleRate: SAMPLE_RATE, beat }, [samples.buffer]);
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
  return { mono, duration: buffer.duration };
}

let run = 0;

/** True when `analysis` lacks a result: tempo and grid, or key (undefined: never analysed). */
const incomplete = (analysis) => !analysis || analysis.key === undefined;

/**
 * Analyses, in order, the `tracks` ({ id, file, analysis?, duration? }) whose analysis is missing or
 * incomplete, or whose duration is unknown (decoded again, without the worker, when only it lacks). Calls
 * onProgress(done, total) before the first and after each track, and onResult(track) once
 * track.analysis is set and saved. A new call cancels the previous one (after its current track).
 * Tracks that do not decode are skipped and left for a later run.
 */
export async function analyzeTracks(tracks, { onProgress, onResult, onError }) {
  const mine = ++run;
  const todo = tracks.filter((t) => incomplete(t.analysis) || t.duration === undefined);
  onProgress(0, todo.length);
  for (const [i, track] of todo.entries()) {
    try {
      const { mono, duration } = await decodeMono(track.file);
      const result = incomplete(track.analysis) ? await analyzeSamples(mono, !track.analysis) : {};
      if (mine !== run) return;
      // Merged into the current analysis: a grid edited meanwhile on a deck is kept.
      const analysis = { ...track.analysis, ...result };
      track.analysis = analysis;
      track.duration = duration;
      await patch('tracks', track.id, { path: track.path, analysis, duration });
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

/** Text of a key: "8A", "?" (no key stands out), "…" (not analysed yet). */
export const formatKey = (analysis) => (analysis?.key === undefined ? '…' : analysis.key ?? '?');

/** Tells the library and the decks that `track.analysis` changed (event "djing:analysis", detail: track). */
export const announce = (track) => document.dispatchEvent(new CustomEvent('djing:analysis', { detail: track }));
