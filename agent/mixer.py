"""Executes a transition Plan (see agent.patterns) on two live decks.

Common shape: B is cued at plan.b_start_bar and started on A's bar plan.a_start_bar (Mixxx
quantize puts it on the beat); during the overlap B is shaped by plan.entry; on plan.a_cut_bar
A is cut on the one and B is fully opened. Tempo: B syncs to A; keylock only above 2 %.
"""

from __future__ import annotations

import time

from agent.decks import Deck
from agent.patterns import Plan

EQ_NEUTRAL, EQ_KILL = 0.5, 0.0
FILTER_NEUTRAL, FILTER_HIGHPASS, FILTER_LOWPASS = 0.5, 0.82, 0.22
FADER_TOPS, FADER_BASS, FADER_TEASER = 0.45, 0.7, 0.3
LEAD_S = 0.12

ENTRY_SETTINGS = {
    "bass": {"eq_low": EQ_NEUTRAL, "filter": FILTER_LOWPASS, "volume": FADER_BASS},
    "tops": {"eq_low": EQ_KILL, "filter": FILTER_HIGHPASS, "volume": FADER_TOPS},
    "teaser": {"eq_low": EQ_KILL, "filter": FILTER_HIGHPASS, "volume": FADER_TEASER},
    "none": {"eq_low": EQ_NEUTRAL, "filter": FILTER_NEUTRAL, "volume": 1.0},
}


class Mixer:
    def __init__(self, bridge, log=print) -> None:
        self.bridge = bridge
        self.log = log

    def prepare_incoming(self, deck: Deck, p: Plan) -> None:
        b = self.bridge
        assert deck.track
        b.note(deck.name, "sync", True)
        b.note(deck.name, "keylock", p.keylock)
        b.note(deck.name, "quantize", True)
        b.set(deck.name, "eq_mid", EQ_NEUTRAL)
        b.set(deck.name, "eq_high", EQ_NEUTRAL)
        for key, value in ENTRY_SETTINGS[p.entry].items():
            b.set(deck.name, key, value)
        deck.seek_bar(p.b_start_bar)
        time.sleep(0.2)

    def ramp_over_bars(self, clock: Deck, from_bar: float, to_bar: float, setter) -> None:
        while True:
            bar = clock.bar()
            if bar >= to_bar:
                setter(1.0)
                return
            setter(max(0.0, (bar - from_bar) / (to_bar - from_bar)))
            time.sleep(0.03)

    def transition(self, outgoing: Deck, incoming: Deck, p: Plan) -> dict:
        b = self.bridge
        assert outgoing.track and incoming.track
        self.log(f"transition [{p.pattern}/{p.entry}]: {outgoing.track} -> {incoming.track}  ({'; '.join(p.notes)})")
        self.log(f"  A bar now {outgoing.bar():.1f}; B (from its bar {p.b_start_bar}) starts at A bar {p.a_start_bar} "
                 f"in {outgoing.seconds_until_bar(p.a_start_bar):.1f}s; overlap {p.overlap} bars; A cut at {p.a_cut_bar}; "
                 f"keylock {'on' if p.keylock else 'off'}")
        result: dict = {}

        outgoing.wait_for_bar(p.a_start_bar, lead_s=LEAD_S)
        b.note(incoming.name, "play", True)
        if p.overlap == 0:
            # slam: A goes silent exactly on the one B starts on
            outgoing.wait_for_bar(p.a_cut_bar, lead_s=0.02)
            b.set(outgoing.name, "volume", 0.0)
        time.sleep(0.4)
        if not incoming.playing:
            b.note(incoming.name, "play", True)
        result["b_start"] = (round(incoming.bar(), 2), round(outgoing.bar(), 2))
        self.log(f"  B playing at its bar {incoming.bar():.2f} (A bar {outgoing.bar():.2f})")

        if p.overlap:
            settings = ENTRY_SETTINGS[p.entry]

            def opening(frac: float) -> None:
                e = frac * frac  # eased: quiet first half
                if p.entry == "bass":
                    # drums only until the one: opening the low-pass early lets B's vocals and
                    # leads bleed under A's break, which the listener found odd (2026-11-05)
                    b.set(incoming.name, "volume", settings["volume"] + (1.0 - settings["volume"]) * e)
                elif p.entry == "tops":
                    b.set(incoming.name, "filter", settings["filter"] + (FILTER_NEUTRAL - settings["filter"]) * e)
                    b.set(incoming.name, "volume", settings["volume"] + (1.0 - settings["volume"]) * e)
                else:
                    b.set(incoming.name, "volume", FADER_TEASER + 0.15 * e)
                if frac > 0.5:
                    b.set(outgoing.name, "eq_high", EQ_NEUTRAL - 0.3 * (frac - 0.5) * 2)
            self.ramp_over_bars(outgoing, p.a_start_bar, p.a_cut_bar - 0.25, opening)
            outgoing.wait_for_bar(p.a_cut_bar, lead_s=0.03)
            b.set(outgoing.name, "volume", 0.0)

        # the one: B fully in
        b.set(incoming.name, "eq_low", EQ_NEUTRAL)
        b.set(incoming.name, "filter", FILTER_NEUTRAL)
        b.set(incoming.name, "volume", 1.0)
        result["cut"] = (round(outgoing.bar(), 2), round(incoming.bar(), 2))
        self.log(f"  cut: A out at bar {outgoing.bar():.2f}, B full at its bar {incoming.bar():.2f}")
        time.sleep(0.5)
        b.note(outgoing.name, "play", False)
        time.sleep(0.3)
        for key, value in (("volume", 1.0), ("eq_high", EQ_NEUTRAL), ("eq_low", EQ_NEUTRAL), ("filter", FILTER_NEUTRAL)):
            b.set(outgoing.name, key, value)
        b.note(outgoing.name, "sync", False)
        self.log(f"  done: {incoming.name} is live")
        return result
