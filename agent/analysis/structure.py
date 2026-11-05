"""From beat features to musical structure: downbeats, phrases, sections, mix points."""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from agent.analysis.features import BeatFeatures

BEATS_PER_BAR = 4
PHRASE_BARS = 8  # most electronic music is built on 8-bar (32-beat) phrases
KICK_ON = 0.35   # low-band level above which the kick is considered present


@dataclass
class Section:
    kind: str        # intro, groove, break, drop, outro
    start_bar: int
    end_bar: int     # exclusive
    start_s: float
    end_s: float
    energy: float    # mean rms 0..1
    kick: bool


@dataclass
class Structure:
    downbeat_offset: int           # index of the first downbeat in the beat grid (0..3)
    first_downbeat_s: float
    bar_s: float
    bars: int
    phrase_offset_bars: int        # bar index (0..7) where 8-bar phrases start
    bar_energy: list[float]
    bar_low: list[float]
    bar_mid: list[float]           # mids/highs energy per bar: low = drums only = DJ friendly
    intro_bars: int                # leading bars that are sparse (overlap-friendly), multiple of 4
    outro_bars: int                # trailing bars that are sparse, multiple of 4
    sections: list[Section]
    mix_in_s: float                # where to start the track when mixing it in (phrase start, kick on)
    mix_in_bar: int
    mix_out_s: float               # where to start leaving the track (last phrase before outro/break)
    mix_out_bar: int

    def to_dict(self) -> dict:
        d = asdict(self)
        d["sections"] = [asdict(s) for s in self.sections]
        return d


def _phase_scores(values: np.ndarray, period: int) -> np.ndarray:
    scores = np.zeros(period)
    for k in range(period):
        scores[k] = values[k::period].mean() if len(values[k::period]) else 0.0
    return scores


def analyse(f: BeatFeatures) -> Structure:
    n_beats = len(f.beat_times)
    # 1. downbeat: with a four-on-the-floor kick every beat looks alike, so the phase is
    #    read from the arrivals and departures instead: drops and breaks start on the one.
    #    Per beat, how much the low band and the energy depart from the previous bar's mean;
    #    squared so that the big structural events dominate the small fluctuations.
    jump = np.zeros(n_beats)
    for i in range(BEATS_PER_BAR, n_beats):
        prev = slice(i - BEATS_PER_BAR, i)
        jump[i] = abs(f.low[i] - f.low[prev].mean()) + abs(f.rms[i] - f.rms[prev].mean())
    downbeat = int(np.argmax(_phase_scores(jump ** 2, BEATS_PER_BAR)))
    bar_starts = np.arange(downbeat, n_beats - BEATS_PER_BAR + 1, BEATS_PER_BAR)
    bars = len(bar_starts)
    bar_energy = np.array([f.rms[b:b + BEATS_PER_BAR].mean() for b in bar_starts])
    bar_low = np.array([f.low[b:b + BEATS_PER_BAR].mean() for b in bar_starts])
    bar_mid = np.array([f.mid_high[b:b + BEATS_PER_BAR].mean() for b in bar_starts])
    bar_s = BEATS_PER_BAR * (f.beat_times[1] - f.beat_times[0]) if n_beats > 1 else 0.0
    bar_times = f.beat_times[bar_starts]

    # 2. phrases: 8-bar phase whose boundaries carry the most "arrivals" (kick or energy
    #    coming back, spectrum changing). Techno often drops the kick on the last bar of a
    #    phrase, so the positive low-band jump marks the phrase start.
    novelty = np.zeros(bars)
    for i in range(1, bars):
        novelty[i] = (max(0.0, bar_low[i] - bar_low[i - 1]) + max(0.0, bar_energy[i] - bar_energy[i - 1])
                      + 0.5 * abs(bar_mid[i] - bar_mid[i - 1]))
    phrase_offset = int(np.argmax(_phase_scores(novelty, PHRASE_BARS))) if bars >= PHRASE_BARS else 0

    # 3. sections from kick presence: a 1-bar kick dropout at a phrase end is not a break,
    #    so runs shorter than 2 bars are absorbed, then adjacent runs with the same kick
    #    state are merged before labelling.
    kick = bar_low >= KICK_ON
    runs: list[list[int]] = []  # [start, end, kick]
    i = 0
    while i < bars:
        j = i
        while j < bars and kick[j] == kick[i]:
            j += 1
        runs.append([i, j, int(kick[i])])
        i = j
    cleaned: list[list[int]] = []
    for r in runs:
        if cleaned and (r[1] - r[0]) < 2 and r[1] != bars:
            cleaned[-1][1] = r[1]              # absorb the short run
        elif cleaned and cleaned[-1][2] == r[2]:
            cleaned[-1][1] = r[1]              # merge same kick state
        else:
            cleaned.append(r)
    sections: list[Section] = []
    for start, end, has_kick in cleaned:
        energy = float(bar_energy[start:end].mean())
        if not has_kick:
            kind = "intro" if start == 0 else ("outro" if end == bars else "break")
        else:
            after_break = bool(sections) and sections[-1].kind in ("break", "intro")
            kind = "drop" if (after_break and energy >= 0.6) else "groove"
        sections.append(Section(kind, start, end, float(bar_times[start]),
                                float(bar_times[end]) if end < bars else f.duration, energy, bool(has_kick)))

    # 4. mix points
    def snap_phrase(bar: int, forward: bool) -> int:
        rel = (bar - phrase_offset) % PHRASE_BARS
        if rel == 0:
            return bar
        return bar + (PHRASE_BARS - rel) if forward else bar - rel

    first_kick = next((s for s in sections if s.kick), None)
    mix_in_bar = snap_phrase(first_kick.start_bar, forward=True) if first_kick else 0
    mix_in_bar = min(mix_in_bar, max(0, bars - 1))
    last_kick = next((s for s in reversed(sections) if s.kick), None)
    if last_kick:
        # leave during the last kick section: its last full phrase
        mix_out_bar = snap_phrase(last_kick.end_bar, forward=False) - PHRASE_BARS
        mix_out_bar = max(last_kick.start_bar, mix_out_bar)
    else:
        mix_out_bar = max(0, bars - 2 * PHRASE_BARS)

    # 5. DJ-friendly intro / outro: bars whose mids/highs stay under half the track's median
    sparse = bar_mid < 0.5 * (np.median(bar_mid) or 1.0)
    intro_bars = 0
    while intro_bars < bars and sparse[intro_bars]:
        intro_bars += 1
    outro_bars = 0
    while outro_bars < bars and sparse[bars - 1 - outro_bars]:
        outro_bars += 1
    intro_bars -= intro_bars % 4
    outro_bars -= outro_bars % 4

    return Structure(
        downbeat_offset=downbeat,
        first_downbeat_s=float(f.beat_times[downbeat]),
        bar_s=float(bar_s),
        bars=int(bars),
        phrase_offset_bars=phrase_offset,
        bar_energy=[round(float(v), 3) for v in bar_energy],
        bar_low=[round(float(v), 3) for v in bar_low],
        bar_mid=[round(float(v), 3) for v in bar_mid],
        intro_bars=int(intro_bars),
        outro_bars=int(outro_bars),
        sections=sections,
        mix_in_s=float(bar_times[mix_in_bar]) if bars else 0.0,
        mix_in_bar=int(mix_in_bar),
        mix_out_s=float(bar_times[mix_out_bar]) if bars else 0.0,
        mix_out_bar=int(mix_out_bar),
    )
