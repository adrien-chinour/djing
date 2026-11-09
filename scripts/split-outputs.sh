#!/usr/bin/env bash
# Splits the controller's 4-channel sound card into two stereo PipeWire sinks:
# "Inpulse MAIN" (channels 1-2) and "Inpulse Casque" (channels 3-4).
# Chrome on Linux only opens stereo outputs, so web/ plays MAIN and the headphone cue on these
# two sinks. Runs in the foreground; the sinks disappear when it stops (Ctrl+C).
#
# Usage: scripts/split-outputs.sh [target-node-name]
#   default target: the first sink whose description contains "Inpulse".
set -euo pipefail

target="${1:-}"
if [[ -z "$target" ]]; then
  target=$(pw-dump | python3 -I -c '
import json, sys
for o in json.load(sys.stdin):
    p = o.get("info", {}).get("props", {}) or {}
    if p.get("media.class") == "Audio/Sink" and "inpulse" in p.get("node.description", "").lower() \
            and not p.get("node.name", "").startswith("djing-"):
        print(p["node.name"]); break')
fi
if [[ -z "$target" ]]; then
  echo "no Inpulse sink found (controller plugged? Mixxx closed?)" >&2
  exit 1
fi
echo "splitting $target into djing-main (1-2) and djing-cue (3-4)"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Playback ports of the target in channel order (FL FR RL RR, or AUX0..3 with the Pro Audio profile).
mapfile -t ports < <(pw-link -i | grep "^$target:playback_")
if (( ${#ports[@]} < 4 )); then
  echo "$target has ${#ports[@]} playback ports, 4 expected" >&2
  exit 1
fi

# The loopback outputs are linked by hand: PipeWire would otherwise match channels by position
# and route both stereo sinks to FL/FR.
loopback() { # name description first-port-index
  pw-loopback \
    --capture-props="media.class=Audio/Sink node.name=$1 node.description=\"$2\" audio.position=[FL FR]" \
    --playback-props="node.name=$1-out node.autoconnect=false node.passive=true audio.position=[FL FR]" &
  pids+=($!)
  for _ in $(seq 50); do
    pw-link -o | grep -q "^$1-out:output_FR" && break
    sleep 0.1
  done
  pw-link "$1-out:output_FL" "${ports[$3]}"
  pw-link "$1-out:output_FR" "${ports[$(($3 + 1))]}"
}
loopback djing-main "Inpulse MAIN" 0
loopback djing-cue "Inpulse Casque" 2
echo "ready: djing-main -> ${ports[0]} ${ports[1]}, djing-cue -> ${ports[2]} ${ports[3]}"
wait
