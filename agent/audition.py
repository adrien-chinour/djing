"""Listen to what the analysis claims: load a track on a deck, start at a given bar.

  uv run python -m agent.audition "tu tu" --bar 44          # from the detected first drop? pass the bar
  uv run python -m agent.audition "tu tu" --section drop    # from the first section of that kind
  uv run python -m agent.audition "tu tu" --phrase 3        # from the 3rd 8-bar phrase start
Prints the bar counter so you can check downbeat and phrase alignment by ear.
"""

from __future__ import annotations

import argparse
import sys
import time

from agent.remote import RemoteBridge as Bridge
from agent.catalog import Catalog
from agent.decks import Deck


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("title")
    ap.add_argument("--deck", default="A")
    ap.add_argument("--bar", type=float)
    ap.add_argument("--section")
    ap.add_argument("--phrase", type=int)
    ap.add_argument("--seconds", type=float, default=20)
    args = ap.parse_args()
    catalog = Catalog()
    track = catalog.find(args.title)
    s = track.structure
    bar = args.bar if args.bar is not None else 0.0
    if args.section:
        bar = next(sec["start_bar"] for sec in s["sections"] if sec["kind"] == args.section)
    if args.phrase is not None:
        bar = s["phrase_offset_bars"] + 8 * args.phrase
    print(f"{track}: bar {bar} = {track.bar_time(bar):.2f}s | downbeat offset {s['downbeat_offset']} | phrase offset {s['phrase_offset_bars']}")
    print("sections:", ", ".join(f"{sec['kind']} {sec['start_bar']}-{sec['end_bar']}" for sec in s["sections"]))
    bridge = Bridge()
    if not bridge.wait_for_mapping(60):
        print("no Mixxx mapping"); return 1
    deck = Deck(bridge, args.deck, catalog)
    bridge.note(args.deck, "play", False)
    if not deck.load(track):
        print("load failed"); return 1
    bridge.note(args.deck, "quantize", False)
    bridge.set(args.deck, "volume", 1.0)
    deck.seek_bar(bar)
    time.sleep(0.3)
    bridge.note(args.deck, "play", True)
    t_end = time.monotonic() + args.seconds
    last = -1
    while time.monotonic() < t_end:
        cur = int(deck.bar())
        if cur != last:
            rel = (cur - s["phrase_offset_bars"]) % 8
            print(f"  bar {cur:4d}  phrase pos {rel + 1}/8" + ("  <== phrase start" if rel == 0 else ""), flush=True)
            last = cur
        time.sleep(0.02)
    bridge.note(args.deck, "play", False)
    bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
