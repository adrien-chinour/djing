"""Transition patterns: the agent's vocabulary. Each pattern proposes, for a pair (A, B) and
A's current position, a Plan with a fitness score, or nothing when its preconditions fail.

Patterns are validated with the listener one at a time (see agent.rate); the choice at mix
time is improvised among them (agent.mix picks the best scored (B, pattern) couple).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from agent.catalog import Track

KICK_ON = 0.35
SPARSE_MIDS = 0.2
TEASER_BARS = 4
MAX_OVERLAP = 16
MIN_BREAK = 4
KEYLOCK_THRESHOLD = 0.02
PHRASE = 8


@dataclass
class Plan:
    pattern: str
    a_start_bar: int      # A bar where B starts playing
    a_cut_bar: int        # A bar where A is cut and B is fully in
    b_start_bar: int      # B bar to cue B at
    entry: str            # "bass" | "tops" | "teaser" | "none"
    keylock: bool
    score: float
    notes: list[str] = field(default_factory=list)

    @property
    def overlap(self) -> int:
        return self.a_cut_bar - self.a_start_bar


def _keylock(a_bpm: float, b: Track) -> bool:
    return abs(b.bpm - a_bpm) / a_bpm > KEYLOCK_THRESHOLD


def _first_drop_bar(t: Track) -> int | None:
    for s in t.structure["sections"]:
        if s["kick"] and s["energy"] >= 0.6:
            return s["start_bar"]
    return None


def _snap(t: Track, bar: int) -> int:
    """Nearest phrase boundary within 2 bars, else the bar itself."""
    cand = t.phrase_start_at_or_after(bar - 2)
    return cand if abs(cand - bar) <= 2 else bar


def _window(t: Track, start: int, length: int) -> tuple[list[float], list[float]]:
    return t.structure["bar_low"][start:start + length], t.structure["bar_mid"][start:start + length]


def _late_sections(a: Track, kinds: tuple[str, ...], after_bar: float, min_len: int) -> list[dict]:
    half = a.structure["bars"] / 2
    return [s for s in a.structure["sections"]
            if s["kind"] in kinds and s["start_bar"] >= max(half, after_bar) and (s["end_bar"] - s["start_bar"]) >= min_len]


# --- pattern 1: break -> drop ----------------------------------------------------------

def break_drop(a: Track, b: Track, a_now: float, a_bpm: float) -> Plan | None:
    """B's drop lands where A's drop would return after a late break. B shows up during the
    break only if its material is complementary (drums -> 'bass', sparse -> 'tops'), else as
    a 4-bar quiet teaser."""
    drop_b = _first_drop_bar(b)
    breaks = _late_sections(a, ("break", "outro"), a_now + 2, MIN_BREAK)
    if drop_b is None or not breaks:
        return None
    br = breaks[0]
    cut = min(_snap(a, br["end_bar"]), a.structure["bars"])
    length = min(MAX_OVERLAP, cut - br["start_bar"])
    length -= length % 4
    length = min(length, drop_b - drop_b % 4)
    lows, mids = _window(b, drop_b - length, length)
    notes = [f"A break {br['start_bar']}-{br['end_bar']}", f"B drop at {drop_b}"]
    if length and lows and sum(1 for v in lows if v >= KICK_ON) >= 0.75 * len(lows):
        entry, score = "bass", 0.85
    elif length and mids and max(mids) < SPARSE_MIDS:
        entry, score = "tops", 0.8
    elif length >= 1:
        entry, length, score = "teaser", min(TEASER_BARS, length), 0.75
    else:
        entry, length, score = "none", 0, 0.7  # B's drop is at its very start: nothing to overlap
    return Plan("break_drop", cut - length, cut, drop_b - length, entry, _keylock(a_bpm, b), score, notes)


# --- pattern 2: slam ---------------------------------------------------------------------

def slam(a: Track, b: Track, a_now: float, a_bpm: float) -> Plan | None:
    """Hard cut on the one: A's kick section ends on a phrase boundary, B's drop starts
    right there. No overlap at all. Best when A would have gone into a break anyway."""
    drop_b = _first_drop_bar(b)
    if drop_b is None:
        return None
    kicks = [s for s in a.structure["sections"] if s["kick"] and s["end_bar"] > a_now + 2
             and s["start_bar"] >= a.structure["bars"] / 3]
    if not kicks:
        return None
    sec = kicks[0]
    cut = min(_snap(a, sec["end_bar"]), a.structure["bars"])
    if cut <= a_now + 2:
        cut = min(a.phrase_start_at_or_after(a_now + 2), a.structure["bars"])
    following = next((s for s in a.structure["sections"] if s["start_bar"] >= sec["end_bar"]), None)
    score = 0.7 + (0.1 if following and following["kind"] in ("break", "outro") else 0.0)
    b_drop_energy = next((s["energy"] for s in b.structure["sections"] if s["start_bar"] == drop_b), 0.0)
    score += 0.05 if b_drop_energy >= 0.85 else 0.0
    notes = [f"A kick section {sec['start_bar']}-{sec['end_bar']}", f"B drop at {drop_b}"]
    return Plan("slam", cut, cut, drop_b, "none", _keylock(a_bpm, b), score, notes)


# --- pattern 3: bass first ---------------------------------------------------------------

def bass_first(a: Track, b: Track, a_now: float, a_bpm: float) -> Plan | None:
    """A in a melodic break/outro; B brings its drums only (low-passed, lows in) for 8-16
    bars, phrase aligned, then A is cut and B opens. B's segment must have a steady kick."""
    breaks = _late_sections(a, ("break", "outro"), a_now + 2, PHRASE)
    if not breaks:
        return None
    br = breaks[0]
    cut = min(_snap(a, br["end_bar"]), a.structure["bars"])
    length = min(MAX_OVERLAP, cut - br["start_bar"])
    length -= length % PHRASE
    if length < PHRASE:
        return None
    # B: a kick section long enough, start on one of its phrase boundaries
    for s in b.structure["sections"]:
        if not s["kick"] or (s["end_bar"] - s["start_bar"]) < length + PHRASE:
            continue
        start = b.phrase_start_at_or_after(s["start_bar"])
        lows, mids = _window(b, start, length)
        if lows and min(lows) >= KICK_ON:
            steady = 0.05 if max(mids) < 0.5 else 0.0
            notes = [f"A break {br['start_bar']}-{br['end_bar']}", f"B groove from {start}"]
            return Plan("bass_first", cut - length, cut, start, "bass", _keylock(a_bpm, b), 0.78 + steady, notes)
    return None


PATTERNS = {"break_drop": break_drop, "slam": slam, "bass_first": bass_first}


def proposals(a: Track, b: Track, a_now: float, a_bpm: float, only: str | None = None) -> list[Plan]:
    out = []
    for name, fn in PATTERNS.items():
        if only and name != only:
            continue
        p = fn(a, b, a_now, a_bpm)
        if p and p.a_start_bar > a_now + 1:
            out.append(p)
    return out
