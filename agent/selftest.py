"""Loopback self-test, no Mixxx needed: wires the bridge's output port to its own input
and checks that commands are encoded and feedback decoded as agent/protocol.py says."""

import subprocess
import sys
import time

from agent import protocol as p
from agent.bridge import Bridge


def main() -> int:
    bridge = Bridge(name="djing-selftest")
    # ALSA: connect our output client to our input client (same port name, two clients)
    clients = [l.split()[1].rstrip(":") for l in subprocess.run(["aconnect", "-l"], capture_output=True, text=True).stdout.splitlines()
               if l.startswith("client") and "djing-selftest" in l]
    if len(clients) != 2:
        print("expected 2 ALSA clients, got", clients)
        return 1
    # rtmidi creates the input client first, then the output one
    subprocess.run(["aconnect", f"{clients[1]}:0", f"{clients[0]}:0"], check=True)

    bridge._send([0x90 | p.MASTER_CHANNEL, p.HELLO_NOTE, 0x7F])
    bridge.set("master", "crossfader", 0.25)          # arrives as cc14 feedback "crossfader"
    bridge.note("B", "play", True)                    # note 0x01 on deck B = feedback "beat"... same number
    bridge.set("A", "volume", 1.0)                    # cc14 0x00 = feedback "volume"
    time.sleep(0.3)

    checks = {
        "mapping loaded": bridge.mapping_loaded is True,
        "crossfader cc14 decoded": abs(bridge.state["master"].get("crossfader", -1) - 0.25) < 0.001,
        "deck B note decoded": bridge.state["B"].get("beat") == 1.0,
        "deck A volume decoded": bridge.state["A"].get("volume") == 1.0,
    }
    for name, ok in checks.items():
        print(("  [OK] " if ok else "  [KO] ") + name)
    bridge.close()
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
