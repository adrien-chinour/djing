#!/usr/bin/env bash
# Configures Mixxx for the Inpulse 300 MK2 and enables the Hercules controller mapping.
# Backs up the previous files first.
#   apply-mixxx-config.sh controller   sound through the controller's card (MAIN 1-2, headphones 3-4)
#   apply-mixxx-config.sh pc           sound through PipeWire (laptop speakers / default output)
set -euo pipefail

MODE="${1:-controller}"
case "$MODE" in
  controller|pc) ;;
  *) echo "Usage: $0 [controller|pc]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIXXX_DIR="${HOME}/.mixxx"
CARD_NAME="Inpulse 300 Mk2"
DEVICE_KEY="DJControl_Inpulse_300_Mk2_MIDI_"   # Mixxx replaces spaces by "_" (incl. trailing one)
MAPPING="/usr/share/mixxx/controllers/Hercules_DJControl_Inpulse_300.midi.xml"
CFG="${MIXXX_DIR}/mixxx.cfg"

if pgrep -x mixxx >/dev/null; then
  echo "Mixxx is running: close it first (it rewrites its config on exit)." >&2
  exit 1
fi
card="$(awk -v n="$CARD_NAME" 'index($0, n) {print $1; exit}' /proc/asound/cards || true)"
if [[ -z "$card" ]]; then
  echo "Controller not detected as an ALSA card: plug it in and retry." >&2
  exit 1
fi
[[ -f "$MAPPING" ]] || { echo "Mapping not found: $MAPPING" >&2; exit 1; }

mkdir -p "$MIXXX_DIR"
backup="${MIXXX_DIR}/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
for f in soundconfig.xml mixxx.cfg; do
  [[ -f "${MIXXX_DIR}/${f}" ]] && cp "${MIXXX_DIR}/${f}" "$backup/"
done
echo "Backup: $backup"

if [[ "$MODE" == "pc" ]]; then
  cp "${HERE}/mixxx/soundconfig-pc.xml" "${MIXXX_DIR}/soundconfig.xml"
  echo "soundconfig.xml -> PipeWire device (Master on the system default output)"
else
  sed "s/@CARD@/${card}/" "${HERE}/mixxx/soundconfig.xml" > "${MIXXX_DIR}/soundconfig.xml"
  echo "soundconfig.xml -> hw:${card},0 (Master 1-2, Headphones 3-4)"
fi

# cfg_set GROUP KEY VALUE : set KEY in [GROUP] of mixxx.cfg, creating the group if needed.
cfg_set() {
  local group="$1" key="$2" value="$3"
  touch "$CFG"
  awk -v g="[$group]" -v k="$key" -v v="$value" '
    BEGIN { ingroup = 0; done = 0; seen = 0 }
    /^\[/ { if (ingroup && !done) { print k " " v; done = 1 } ; ingroup = ($0 == g); if (ingroup) seen = 1 }
    ingroup && $1 == k && !done { print k " " v; done = 1; next }
    { print }
    END {
      if (!seen) { print ""; print g; print k " " v }
      else if (!done) { print k " " v }
    }' "$CFG" > "${CFG}.tmp"
  mv "${CFG}.tmp" "$CFG"
}
cfg_set "Controller" "$DEVICE_KEY" "1"
cfg_set "ControllerPreset" "$DEVICE_KEY" "$MAPPING"
echo "mixxx.cfg -> controller enabled with $(basename "$MAPPING")"
echo "Done. Start Mixxx and check Preferences > Sound Hardware and > Controllers."
