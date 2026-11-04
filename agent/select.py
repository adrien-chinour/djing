"""Pick the next track: tight tempo, harmonic compatibility required, not yet played."""

from __future__ import annotations

from agent.analysis.camelot import compatible
from agent.catalog import Catalog, Track

MAX_BPM_DIFF = 0.03   # 3 %: beyond that the stretch is audible
RELAXED_BPM_DIFF = 0.05
MIN_BPM = 110         # below that Mixxx probably detected half tempo (e.g. 98 bpm): keep out


def choose_next(catalog: Catalog, current: Track, current_bpm: float, played: set[str]) -> Track | None:
    def bpm_diff(t: Track) -> float:
        return abs(t.bpm - current_bpm) / current_bpm

    def score(t: Track) -> tuple[int, int, float]:
        # harmonic first, then a usable intro, then the closest tempo
        return compatible(current.camelot, t.camelot), min(t.structure.get("intro_bars", 0), 16), -bpm_diff(t)

    pool = [t for t in catalog.tracks if t.id != current.id and t.id not in played and t.bpm >= MIN_BPM]
    for max_diff, min_harmony in ((MAX_BPM_DIFF, 2), (MAX_BPM_DIFF, 1), (RELAXED_BPM_DIFF, 2)):
        candidates = [t for t in pool if bpm_diff(t) <= max_diff and compatible(current.camelot, t.camelot) >= min_harmony]
        if candidates:
            return max(candidates, key=score)
    return None
