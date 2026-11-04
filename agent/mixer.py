"""Transitions v2: no two busy tracks at full volume together.

Plan modes, chosen from the structure of both tracks (see plan()):
- "break": A has a late break (no kick, low energy). B enters at the start of that break,
  lows cut, fader low, high-passed, and opens up during the break. Where A's drop would
  hit, A is cut on the one and B's lows come in: B's own drop is placed on that instant.
- "cut": no usable break. Optional short teaser of B (filtered, low fader) on the last
  bars of A's phrase, then A is cut on the one and B plays full from its phrase start.
Tempo: B syncs to A; keylock only if the tempo gap exceeds 2 %.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from agent.bridge import Bridge
from agent.catalog import Track
from agent.decks import Deck

EQ_NEUTRAL, EQ_KILL = 0.5, 0.0
FILTER_NEUTRAL, FILTER_HIGHPASS, FILTER_LOWPASS = 0.5, 0.82, 0.22
FADER_TOPS, FADER_BASS, FADER_TEASER = 0.45, 0.7, 0.3
TEASER_BARS = 4
SPARSE_MIDS = 0.2    # max per-bar mids/highs for a segment to count as "drums only / sparse"
KICK_ON = 0.35
LEAD_S = 0.12
KEYLOCK_THRESHOLD = 0.02
MAX_OVERLAP = 16
MIN_BREAK = 4


@dataclass
class Plan:
    mode: str
    a_start_bar: int      # A bar where B starts playing (overlap begins)
    a_cut_bar: int        # A bar where A is cut and B's lows come in
    b_start_bar: int      # B bar to cue B at
    keylock: bool
    entry: str = "none"   # how B overlaps: "tops" (high-passed, low fader), "bass" (lows in, low-passed), "teaser", "none"

    @property
    def overlap(self) -> int:
        return self.a_cut_bar - self.a_start_bar


def _late_breaks(a: Track, after_bar: float) -> list[dict]:
    half = a.structure["bars"] / 2
    return [s for s in a.structure["sections"]
            if s["kind"] in ("break", "outro") and s["start_bar"] >= max(half, after_bar)
            and (s["end_bar"] - s["start_bar"]) >= MIN_BREAK]


def _first_drop_bar(b: Track) -> int:
    for s in b.structure["sections"]:
        if s["kick"] and s["energy"] >= 0.6:
            return s["start_bar"]
    return b.structure["mix_in_bar"]


def _entry_for(b: Track, b_start: int, length: int) -> tuple[str, int, int]:
    """Decide how B may overlap A's break on B bars [b_start, b_start + length).

    Returns (entry, b_start, length). Only complementary material overlaps: B's drums under
    A's melodic break ("bass"), or a really sparse B segment on top ("tops"). Otherwise a short
    quiet teaser, or nothing at all.
    """
    if length <= 0:
        return "none", b_start, 0
    lows = b.structure["bar_low"][b_start:b_start + length]
    mids = b.structure["bar_mid"][b_start:b_start + length]
    if lows and sum(1 for v in lows if v >= KICK_ON) >= 0.75 * len(lows):
        return "bass", b_start, length
    if mids and max(mids) < SPARSE_MIDS:
        return "tops", b_start, length
    teaser = min(TEASER_BARS, length)
    return "teaser", b_start + length - teaser, teaser


def plan(a: Track, b: Track, a_now_bar: float, a_bpm: float) -> Plan:
    keylock = abs(b.bpm - a_bpm) / a_bpm > KEYLOCK_THRESHOLD
    drop_b = _first_drop_bar(b)
    breaks = _late_breaks(a, a_now_bar + 2)
    if breaks:
        br = breaks[0]
        # A is cut where its drop would hit: the end of the break, snapped to a phrase boundary
        cut = a.phrase_start_at_or_after(br["end_bar"] - 2)
        if abs(cut - br["end_bar"]) > 2:
            cut = br["end_bar"]
        length = min(MAX_OVERLAP, cut - br["start_bar"])
        length -= length % 4
        # B's drop lands on the cut: B starts `length` bars before its drop
        if drop_b < length:
            length = drop_b - drop_b % 4
        entry, b_start, length = _entry_for(b, drop_b - length, length)
        return Plan("break", cut - length, cut, b_start, keylock, entry)
    # cut mode on the next phrase boundary of A at least 1 bar ahead (or its mix-out point)
    target = a.structure["mix_out_bar"] if a.structure["mix_out_bar"] > a_now_bar + 1 else a.phrase_start_at_or_after(a_now_bar + 1)
    length = min(TEASER_BARS, drop_b - drop_b % 4)
    entry, b_start, length = _entry_for(b, drop_b - length, length)
    return Plan("cut", target - length, target, b_start, keylock, entry)


class Mixer:
    def __init__(self, bridge: Bridge, log=print) -> None:
        self.bridge = bridge
        self.log = log

    def prepare_incoming(self, deck: Deck, plan: Plan) -> None:
        b = self.bridge
        assert deck.track
        b.note(deck.name, "sync", True)
        b.note(deck.name, "keylock", plan.keylock)
        b.note(deck.name, "quantize", True)
        b.set(deck.name, "eq_mid", EQ_NEUTRAL)
        b.set(deck.name, "eq_high", EQ_NEUTRAL)
        if plan.entry == "bass":          # B brings the drums under A's break
            b.set(deck.name, "eq_low", EQ_NEUTRAL)
            b.set(deck.name, "filter", FILTER_LOWPASS)
            b.set(deck.name, "volume", FADER_BASS)
        elif plan.entry == "tops":        # sparse B material on top, lows cut
            b.set(deck.name, "eq_low", EQ_KILL)
            b.set(deck.name, "filter", FILTER_HIGHPASS)
            b.set(deck.name, "volume", FADER_TOPS)
        elif plan.entry == "teaser":      # barely audible hint, then the cut
            b.set(deck.name, "eq_low", EQ_KILL)
            b.set(deck.name, "filter", FILTER_HIGHPASS)
            b.set(deck.name, "volume", FADER_TEASER)
        else:
            b.set(deck.name, "eq_low", EQ_NEUTRAL)
            b.set(deck.name, "filter", FILTER_NEUTRAL)
            b.set(deck.name, "volume", 1.0)
        deck.seek_bar(plan.b_start_bar)
        time.sleep(0.2)

    def ramp_over_bars(self, clock: Deck, from_bar: float, to_bar: float, setter) -> None:
        """Call setter(fraction 0..1) while `clock` moves from from_bar to to_bar."""
        while True:
            bar = clock.bar()
            if bar >= to_bar:
                setter(1.0)
                return
            setter(max(0.0, (bar - from_bar) / (to_bar - from_bar)))
            time.sleep(0.03)

    def transition(self, outgoing: Deck, incoming: Deck, p: Plan) -> None:
        b = self.bridge
        assert outgoing.track and incoming.track
        self.log(f"transition [{p.mode}/{p.entry}]: {outgoing.track} -> {incoming.track}")
        self.log(f"  A bar now {outgoing.bar():.1f}; B (from its bar {p.b_start_bar}) starts at A bar {p.a_start_bar} "
                 f"in {outgoing.seconds_until_bar(p.a_start_bar):.1f}s; overlap {p.overlap} bars; A cut at {p.a_cut_bar}; "
                 f"keylock {'on' if p.keylock else 'off'}")

        outgoing.wait_for_bar(p.a_start_bar, lead_s=LEAD_S)
        b.note(incoming.name, "play", True)
        time.sleep(0.4)
        if not incoming.playing:
            b.note(incoming.name, "play", True)
        self.log(f"  B playing at its bar {incoming.bar():.2f} (A bar {outgoing.bar():.2f})")

        if p.overlap:
            # B opens up over the overlap (eased: quiet first half), A's highs step back on the 2nd half
            def opening(frac: float) -> None:
                e = frac * frac
                if p.entry == "bass":
                    b.set(incoming.name, "filter", FILTER_LOWPASS + (FILTER_NEUTRAL - FILTER_LOWPASS) * e)
                    b.set(incoming.name, "volume", FADER_BASS + (1.0 - FADER_BASS) * e)
                elif p.entry == "tops":
                    b.set(incoming.name, "filter", FILTER_HIGHPASS + (FILTER_NEUTRAL - FILTER_HIGHPASS) * e)
                    b.set(incoming.name, "volume", FADER_TOPS + (1.0 - FADER_TOPS) * e)
                else:  # teaser stays low and filtered, only creeps up a little
                    b.set(incoming.name, "volume", FADER_TEASER + 0.15 * e)
                if frac > 0.5:
                    b.set(outgoing.name, "eq_high", EQ_NEUTRAL - 0.3 * (frac - 0.5) * 2)
            self.ramp_over_bars(outgoing, p.a_start_bar, p.a_cut_bar - 0.25, opening)
            outgoing.wait_for_bar(p.a_cut_bar, lead_s=0.03)

        # the one: A out, B's lows in
        b.set(outgoing.name, "volume", 0.0)
        b.set(incoming.name, "eq_low", EQ_NEUTRAL)
        b.set(incoming.name, "filter", FILTER_NEUTRAL)
        b.set(incoming.name, "volume", 1.0)
        self.log(f"  cut: A out at bar {outgoing.bar():.2f}, B lows in at its bar {incoming.bar():.2f}")
        time.sleep(0.5)
        b.note(outgoing.name, "play", False)
        time.sleep(0.3)
        b.set(outgoing.name, "volume", 1.0)
        b.set(outgoing.name, "eq_high", EQ_NEUTRAL)
        b.set(outgoing.name, "eq_low", EQ_NEUTRAL)
        b.note(outgoing.name, "sync", False)
        self.log(f"  done: {incoming.name} is live")
