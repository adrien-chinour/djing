"""One agent-driven transition from deck A to deck B, improvised among the validated patterns.

  uv run python -m agent.mix --a "super bouncy" --skip-to       # A imposed, B and pattern chosen
  uv run python -m agent.mix --a "super bouncy" --pattern slam  # force a pattern
  uv run python -m agent.mix --b "dreams"                       # A: whatever plays on deck A
  uv run python -m agent.mix                                    # everything chosen by the agent
Afterwards: uv run python -m agent.rate <1-5> "<comment>"  (make rate N=4 C="...")
"""

from __future__ import annotations

import argparse
import sys
import time

from agent import feedback
from agent.analysis.camelot import compatible
from agent.catalog import Catalog, Track
from agent.decks import Deck
from agent.mixer import Mixer
from agent.patterns import Plan, proposals
from agent.remote import RemoteBridge as Bridge
from agent.select import MAX_BPM_DIFF, MIN_BPM, RELAXED_BPM_DIFF


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def candidates(catalog: Catalog, a: Track, a_now: float, a_bpm: float, b_only: Track | None,
               pattern: str | None, played: set[str]) -> list[tuple[float, Track, Plan]]:
    """Every (B, plan) couple that fits, best first."""
    bias = feedback.pattern_bias()
    out: list[tuple[float, Track, Plan]] = []
    pool = [b_only] if b_only else [t for t in catalog.tracks if t.id != a.id and t.id not in played and t.bpm >= MIN_BPM]
    for b in pool:
        diff = abs(b.bpm - a_bpm) / a_bpm
        harmony = compatible(a.camelot, b.camelot)
        if not b_only:
            if diff > RELAXED_BPM_DIFF or harmony < 1 or (diff > MAX_BPM_DIFF and harmony < 2):
                continue
        for p in proposals(a, b, a_now, a_bpm, only=pattern):
            score = p.score + 0.1 * harmony - 2.0 * diff + bias.get(f"{p.pattern}/{p.entry}", 0.0) + bias.get(p.pattern, 0.0)
            out.append((score, b, p))
    out.sort(key=lambda x: -x[0])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", help="track to load and play on deck A (substring of title)")
    ap.add_argument("--b", help="track to load on deck B; default: chosen by the agent")
    ap.add_argument("--pattern", choices=["break_drop", "slam", "bass_first"])
    ap.add_argument("--skip-to", action="store_true", help="with --a: start A 8 bars before the transition")
    ap.add_argument("--wait", type=float, default=120)
    ap.add_argument("--wait-reload", action="store_true")
    args = ap.parse_args()

    catalog = Catalog()
    bridge = Bridge()
    bridge.reload_protocol()
    if args.wait_reload:
        log("waiting for Mixxx to reload the mapping (Preferences > Controllers > Apply, or restart)...")
        if not bridge.wait_for_reload(args.wait):
            log("mapping not reloaded"); return 1
    log("waiting for the Mixxx mapping...")
    if not bridge.wait_for_mapping(args.wait):
        log("no answer from Mixxx (enable djing-agent in Preferences > Controllers)"); return 1
    time.sleep(3.0)
    deck_a, deck_b = Deck(bridge, "A", catalog), Deck(bridge, "B", catalog)
    mixer = Mixer(bridge, log)

    cf = bridge.state["master"].get("crossfader", 0.5)
    if abs(cf - 0.5) > 0.1:
        log(f"crossfader at {cf:.2f}: centering it so both decks are audible")
        bridge.set("master", "crossfader", 0.5)

    if args.a:
        track_a = catalog.find(args.a)
        log(f"loading A: {track_a}")
        bridge.note("A", "play", False)
        if not deck_a.load(track_a, log=log):
            log("could not load A"); return 1
        bridge.note("A", "quantize", True)
        for key, value in (("volume", 1.0), ("eq_low", 0.5), ("eq_high", 0.5), ("filter", 0.5)):
            bridge.set("A", key, value)
        a_now = 0.0
    else:
        deck_a.track = deck_a.identify_loaded()
        if not deck_a.track or not deck_a.playing:
            log("deck A must be playing a known track (or pass --a)"); return 1
        a_now = deck_a.bar()
        log(f"A is playing: {deck_a.track} at bar {a_now:.1f}")

    a_bpm = deck_a.bpm or deck_a.track.bpm
    b_only = catalog.find(args.b) if args.b else None
    options = candidates(catalog, deck_a.track, a_now, a_bpm, b_only, args.pattern, set())
    if not options:
        log("no (track, pattern) fits"); return 1
    for score, b, p in options[:5]:
        log(f"  option {score:.2f}: {b} [{p.pattern}/{p.entry}] B {p.b_start_bar} at A {p.a_start_bar}, cut {p.a_cut_bar}, overlap {p.overlap}")
    score, track_b, p = options[0]
    log(f"chosen: {track_b} with {p.pattern}/{p.entry}")

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
    result = mixer.transition(deck_a, deck_b, p)
    tid = feedback.log_transition({
        "a": str(deck_a.track), "b": str(track_b), "pattern": p.pattern, "entry": p.entry,
        "a_start_bar": p.a_start_bar, "a_cut_bar": p.a_cut_bar, "b_start_bar": p.b_start_bar,
        "overlap": p.overlap, "keylock": p.keylock, "score": round(score, 3), "result": result})
    log(f"logged as {tid}; rate it: make rate N=<1-5> C=\"...\"")
    bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
