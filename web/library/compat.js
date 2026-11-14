// Pure helpers of the library view: accent- and case-insensitive search, column sorting with
// missing values last, and harmonic mixing compatibility (tempo and Camelot key).

/** Lower case without diacritics: "Été" -> "ete". */
export const fold = (text) => (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** True when every word of `query` appears in the artist, title or path of `track`. */
export function matches(track, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold(`${track.artist}\n${track.title}\n${track.path}`);
  return words.every((w) => text.includes(w));
}

/** "8A" -> { n: 8, letter: 'A' }; null for anything else. */
export function parseCamelot(key) {
  const m = /^(1[0-2]|[1-9])([AB])$/.exec(key ?? '');
  return m ? { n: Number(m[1]), letter: m[2] } : null;
}

/** Sort value of a column for `track`; null when the track has none (sorted last). */
export const COLUMNS = {
  artist: (t) => t.artist || null,
  title: (t) => t.title || null,
  bpm: (t) => t.analysis?.bpm ?? null,
  key: (t) => {
    const k = parseCamelot(t.analysis?.key);
    return k && k.n * 2 + (k.letter === 'B' ? 1 : 0);
  },
  duration: (t) => t.duration ?? null,
};

/**
 * Compares tracks a and b on `column` (a key of COLUMNS), descending when `desc`; tracks without
 * a value come last in both directions.
 */
export function compare(a, b, column, desc = false) {
  const va = COLUMNS[column](a);
  const vb = COLUMNS[column](b);
  if (va === null || vb === null) return (va === null) - (vb === null);
  const order = typeof va === 'string' ? va.localeCompare(vb, 'fr', { sensitivity: 'base' }) : va - vb;
  return desc ? -order : order;
}

/** Tempo within ±tolerance of `ref`, also at double or half tempo. */
export function bpmCompatible(bpm, ref, tolerance = 0.06) {
  if (!bpm || !ref) return false;
  return [1, 2, 0.5].some((f) => Math.abs(bpm * f - ref) <= ref * tolerance);
}

/** Same Camelot key, a neighbour (±1, same letter, 12 next to 1) or the relative key (same number). */
export function keyCompatible(key, ref) {
  const a = parseCamelot(key);
  const b = parseCamelot(ref);
  if (!a || !b) return false;
  if (a.n === b.n) return true;
  const step = (a.n - b.n + 12) % 12;
  return a.letter === b.letter && (step === 1 || step === 11);
}

/** True when `track` mixes with the analysis `ref` of a deck's track: tempo and key both compatible. */
export const compatible = (track, ref) =>
  !!ref && bpmCompatible(track.analysis?.bpm, ref.bpm) && keyCompatible(track.analysis?.key, ref.key);

/** 245.3 -> "4:05"; "…" when unknown. */
export function formatDuration(seconds) {
  if (seconds == null) return '…';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
