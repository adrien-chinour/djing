"""Step 1 demo: prove the agent can act on Mixxx and read its state.

Moves the crossfader from A to B and back while printing what Mixxx reports.
Start this first, then start Mixxx (or open Preferences > Controllers so Mixxx
rescans MIDI devices and loads the "djing agent" mapping).
"""

import os
import sys
import time

from agent.remote import RemoteBridge as Bridge


def main() -> int:
    bridge = Bridge()
    wait = float(os.environ.get("DEMO_WAIT", "60"))
    print(f"Virtual MIDI port 'djing-agent' ready. Waiting for the Mixxx mapping ({wait:.0f} s)...", flush=True)
    print("  -> start Mixxx now, or open Preferences > Controllers and click Apply", flush=True)
    if not bridge.wait_for_mapping(wait):
        print("No 'mapping loaded' message from Mixxx. Is the djing-agent controller enabled?")
        return 1

    def report(scope: str, name: str, value: float) -> None:
        if (scope, name) in {("master", "crossfader"), ("A", "play"), ("B", "play"), ("A", "bpm"), ("B", "bpm")}:
            print(f"  feedback {scope:6s} {name:10s} = {value:.3f}")

    time.sleep(0.5)
    print("Initial state:", {k: dict(v) for k, v in bridge.state.items()})
    bridge.on_change(report)

    print("Crossfader -> B over 6 s")
    bridge.ramp("master", "crossfader", 0.0, 1.0, 6.0)
    time.sleep(1)
    print("Crossfader -> A over 6 s")
    bridge.ramp("master", "crossfader", 1.0, 0.0, 6.0)
    time.sleep(1)
    print("Crossfader back to center")
    bridge.set("master", "crossfader", 0.5)
    time.sleep(0.5)
    print("Done. Final crossfader as seen by Mixxx:", bridge.state["master"].get("crossfader"))
    bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
