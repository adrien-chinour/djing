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

from agent.bridge import Bridge
from agent.catalog import Catalog
from agent.decks import Deck
from agent.mixer import Mixer
from agent.select import choose_next


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", help="track to load and play on deck A (substring of title)")
    ap.add_argument("--b", help="track to load on deck B (substring of title); default: chosen by the agent")
    ap.add_argument("--bars", type=int, default=16)
    ap.add_argument("--skip-to", action="store_true", help="with --a: start A 2 phrases before the transition")
    ap.add_argument("--wait", type=float, default=120, help="seconds to wait for the Mixxx mapping")
    args = ap.parse_args()

    catalog = Catalog()
    bridge = Bridge()
    log("waiting for the Mixxx mapping...")
    if not bridge.wait_for_mapping(args.wait):
        log("no answer from Mixxx (enable djing-agent in Preferences > Controllers)")
        return 1
    time.sleep(0.5)
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
        if not deck_a.load(track_a):
            log("could not load A"); return 1
        bridge.note("A", "quantize", True)
        bridge.set("A", "volume", 1.0)
        bridge.set("A", "eq_low", 0.5)
        start_bar = max(0, track_a.structure["mix_out_bar"] - args.bars - 16) if args.skip_to else track_a.structure["mix_in_bar"]
        deck_a.seek_bar(start_bar)
        time.sleep(0.3)
        bridge.note("A", "play", True)
        log(f"A playing from bar {start_bar}")
    else:
        deck_a.track = deck_a.identify_loaded()
        if not deck_a.track or not deck_a.playing:
            log("deck A must be playing a known track (or pass --a)"); return 1
        log(f"A is playing: {deck_a.track} at bar {deck_a.bar():.1f}")

    # deck B
    track_b = catalog.find(args.b) if args.b else choose_next(catalog, deck_a.track, deck_a.bpm or deck_a.track.bpm, set())
    if not track_b:
        log("no compatible track for B"); return 1
    log(f"loading B: {track_b}")
    bridge.note("B", "play", False)
    if not deck_b.load(track_b):
        log("could not load B"); return 1
    mixer.prepare_incoming(deck_b)
    mixer.transition(deck_a, deck_b, bars=args.bars)
    bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
