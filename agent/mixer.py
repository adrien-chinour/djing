"""The transition itself: bass swap over N bars, phrase aligned on the outgoing deck.

Timeline, in bars of the outgoing deck A (S = start bar, N = transition length):
  S          : B starts (quantized by Mixxx) at its mix-in phrase, lows cut, full volume
  S + N/2    : bass swap over one bar (A lows out, B lows in)
  S + N/2..N : A volume fades to zero
  S + N      : A stops; A's faders are put back to neutral for the next round
"""

from __future__ import annotations

import time

from agent.bridge import Bridge
from agent.decks import Deck

EQ_NEUTRAL = 0.5
EQ_KILL = 0.0
LEAD_S = 0.12  # press play slightly before the bar so Mixxx's quantize lands on it


class Mixer:
    def __init__(self, bridge: Bridge, log=print) -> None:
        self.bridge = bridge
        self.log = log

    def prepare_incoming(self, deck: Deck) -> None:
        """Sync + keylock + quantize on, lows cut, cued at the mix-in phrase."""
        b = self.bridge
        assert deck.track
        b.note(deck.name, "sync", True)
        b.note(deck.name, "keylock", True)
        b.note(deck.name, "quantize", True)
        b.set(deck.name, "eq_low", EQ_KILL)
        b.set(deck.name, "eq_mid", EQ_NEUTRAL)
        b.set(deck.name, "eq_high", EQ_NEUTRAL)
        b.set(deck.name, "filter", 0.5)
        b.set(deck.name, "volume", 1.0)
        deck.seek_bar(deck.track.structure["mix_in_bar"])
        time.sleep(0.2)

    def plan_start_bar(self, outgoing: Deck, bars: int) -> int:
        """Phrase-aligned bar of the outgoing deck where the incoming one starts."""
        assert outgoing.track
        t = outgoing.track
        ideal = t.structure["mix_out_bar"] - bars
        now = outgoing.bar()
        if ideal > now + 1:
            return int(ideal)
        return t.phrase_start_at_or_after(now + 1)

    def ramp_over_bars(self, clock: Deck, from_bar: float, to_bar: float, setter, start: float, end: float) -> None:
        """Drive setter(value) from start to end while `clock` moves from from_bar to to_bar."""
        while True:
            bar = clock.bar()
            if bar >= to_bar:
                setter(end)
                return
            frac = max(0.0, (bar - from_bar) / (to_bar - from_bar))
            setter(start + (end - start) * frac)
            time.sleep(0.03)

    def transition(self, outgoing: Deck, incoming: Deck, bars: int = 16) -> None:
        b = self.bridge
        assert outgoing.track and incoming.track
        start = self.plan_start_bar(outgoing, bars)
        end = start + bars
        swap = start + bars // 2
        self.log(f"transition: {outgoing.track} -> {incoming.track}")
        self.log(f"  A bar now {outgoing.bar():.1f}; B starts at A bar {start} (in {outgoing.seconds_until_bar(start):.1f}s), "
                 f"bass swap at {swap}, A out at {end}")

        outgoing.wait_for_bar(start, lead_s=LEAD_S)
        b.note(incoming.name, "play", True)
        time.sleep(0.5)
        if not incoming.playing:
            self.log("  !! B did not start, retrying play")
            b.note(incoming.name, "play", True)
        self.log(f"  B playing at bar {incoming.bar():.2f} (A bar {outgoing.bar():.2f})")

        outgoing.wait_for_bar(swap)
        self.log("  bass swap")
        self.ramp_over_bars(outgoing, swap, swap + 1,
                            lambda v: (b.set(outgoing.name, "eq_low", EQ_NEUTRAL * (1 - v)),
                                       b.set(incoming.name, "eq_low", EQ_NEUTRAL * v)), 0.0, 1.0)

        self.log("  A fades out")
        self.ramp_over_bars(outgoing, swap + 1, end, lambda v: b.set(outgoing.name, "volume", v), 1.0, 0.0)
        b.note(outgoing.name, "play", False)
        time.sleep(0.3)
        b.set(outgoing.name, "volume", 1.0)
        b.set(outgoing.name, "eq_low", EQ_NEUTRAL)
        b.note(outgoing.name, "sync", False)
        self.log(f"  done: {incoming.name} is live at bar {incoming.bar():.1f}")
