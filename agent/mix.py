"""Step 3 CLI: one agent-driven transition from deck A to deck B.

  uv run python -m agent.mix --a "super bouncy" --b "dreams"     # both imposed, agent loads both
  uv run python -m agent.mix --b "dreams"                          # A: whatever is playing on deck A
  uv run python -m agent.mix                                       # agent also picks B (bpm + Camelot)
Options: --bars 16 (transition length), --skip-to (start A a few phrases before its mix-out)
"""

from __future__ import annotations

import argparse
import sys
import time

from agent.remote import RemoteBridge as Bridge
from agent.catalog import Catalog
from agent.decks import Deck
from agent.mixer import Mixer, plan
from agent.select import choose_next


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", help="track to load and play on deck A (substring of title)")
    ap.add_argument("--b", help="track to load on deck B (substring of title); default: chosen by the agent")
    ap.add_argument("--skip-to", action="store_true", help="with --a: start A 2 phrases before the transition")
    ap.add_argument("--wait", type=float, default=120, help="seconds to wait for the Mixxx mapping")
    ap.add_argument("--wait-reload", action="store_true", help="wait for Mixxx to (re)load the mapping first")
    args = ap.parse_args()

    catalog = Catalog()
    bridge = Bridge()
    bridge.reload_protocol()  # the daemon may predate the current protocol
    if args.wait_reload:
        log("waiting for Mixxx to reload the mapping (Preferences > Controllers > Apply, or restart)...")
        if not bridge.wait_for_reload(args.wait):
            log("mapping not reloaded"); return 1
    log("waiting for the Mixxx mapping...")
    if not bridge.wait_for_mapping(args.wait):
        log("no answer from Mixxx (enable djing-agent in Preferences > Controllers)")
        return 1
    time.sleep(3.0)  # let Mixxx finish starting up (library view, controllers)
    deck_a, deck_b = Deck(bridge, "A", catalog), Deck(bridge, "B", catalog)
    mixer = Mixer(bridge, log)

    cf = bridge.state["master"].get("crossfader", 0.5)
    if abs(cf - 0.5) > 0.1:
        log(f"crossfader at {cf:.2f}: centering it so both decks are audible")
        bridge.set("master", "crossfader", 0.5)

    # deck A
    if args.a:
        track_a = catalog.find(args.a)
        log(f"loading A: {track_a}")
        bridge.note("A", "play", False)
        if not deck_a.load(track_a, log=log):
            log("could not load A"); return 1
        bridge.note("A", "quantize", True)
        bridge.set("A", "volume", 1.0)
        bridge.set("A", "eq_low", 0.5)
        bridge.set("A", "eq_high", 0.5)
    else:
        deck_a.track = deck_a.identify_loaded()
        if not deck_a.track or not deck_a.playing:
            log("deck A must be playing a known track (or pass --a)"); return 1
        log(f"A is playing: {deck_a.track} at bar {deck_a.bar():.1f}")

    # deck B
    a_bpm = deck_a.bpm or deck_a.track.bpm
    track_b = catalog.find(args.b) if args.b else choose_next(catalog, deck_a.track, a_bpm, set())
    if not track_b:
        log("no compatible track for B"); return 1
    a_now = deck_a.bar() if deck_a.playing else 0.0
    p = plan(deck_a.track, track_b, a_now, a_bpm)
    log(f"plan [{p.mode}]: B starts at A bar {p.a_start_bar}, A cut at {p.a_cut_bar}, B from its bar {p.b_start_bar}, overlap {p.overlap}")

    if args.a:
        start_bar = max(0, p.a_start_bar - 8) if args.skip_to else deck_a.track.structure["mix_in_bar"]
        deck_a.seek_bar(start_bar)
        time.sleep(0.3)
        bridge.note("A", "play", True)
        log(f"A playing from bar {start_bar}")

    log(f"loading B: {track_b}")
    bridge.note("B", "play", False)
    if not deck_b.load(track_b, log=log):
        log("could not load B"); return 1
    mixer.prepare_incoming(deck_b, p)
    mixer.transition(deck_a, deck_b, p)
    bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
