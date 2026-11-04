"""Pick the next track: tempo within reach of the sync, harmonic compatibility, not yet played."""

from __future__ import annotations

from agent.analysis.camelot import compatible
from agent.catalog import Catalog, Track

MAX_BPM_DIFF = 0.08   # 8 %: what the sync can bridge without sounding pitched
MIN_BPM = 110         # below that Mixxx probably detected half tempo (e.g. 98 bpm): keep out


def choose_next(catalog: Catalog, current: Track, current_bpm: float, played: set[str]) -> Track | None:
    def score(t: Track) -> tuple[int, float]:
        return compatible(current.camelot, t.camelot), -abs(t.bpm - current_bpm) / current_bpm

    candidates = [t for t in catalog.tracks
                  if t.id != current.id and t.id not in played and t.bpm >= MIN_BPM
                  and abs(t.bpm - current_bpm) / current_bpm <= MAX_BPM_DIFF]
    harmonic = [t for t in candidates if compatible(current.camelot, t.camelot) >= 1]
    pool = harmonic or candidates
    return max(pool, key=score) if pool else None
