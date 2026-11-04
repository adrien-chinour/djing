#!/usr/bin/env bash
# Checks that the Hercules DJControl Inpulse 300 MK2 is detected by Linux and that
# Mixxx is installed and configured to use it. Exit code 1 if anything is wrong.
set -euo pipefail

USB_ID="06f8:b12f"
CARD_NAME="Inpulse 300 Mk2"
MAPPING="/usr/share/mixxx/controllers/Hercules_DJControl_Inpulse_300.midi.xml"
MIXXX_DIR="${HOME}/.mixxx"
status=0

ok() { printf '  [OK] %s\n' "$1"; }
ko() { printf '  [KO] %s\n' "$1"; status=1; }
warn() { printf '  [!!] %s\n' "$1"; }

echo "USB"
if lsusb -d "$USB_ID" >/dev/null 2>&1; then
  ok "controller detected ($USB_ID)"
else
  ko "controller not found: plug it in and check the USB cable"
fi

echo "ALSA"
card="$(awk -v n="$CARD_NAME" 'index($0, n) {print $1; exit}' /proc/asound/cards || true)"
if [[ -n "$card" ]]; then
  ok "sound card is hw:${card},0"
  if grep -q "Channels: 4" "/proc/asound/card${card}/stream0" 2>/dev/null; then
    ok "4 output channels (MAIN 1-2, HEADPHONE 3-4)"
  else
    warn "unexpected channel layout, see /proc/asound/card${card}/stream0"
  fi
else
  ko "no ALSA card named '$CARD_NAME'"
fi
if amidi -l 2>/dev/null | grep -q "$CARD_NAME"; then
  ok "MIDI port present"
else
  ko "no MIDI port for the controller"
fi

echo "Real-time scheduling"
if [[ "$(ulimit -r)" != "0" ]]; then
  ok "rtprio limit is $(ulimit -r)"
else
  ko "rtprio limit is 0: run 'sudo scripts/install-realtime.sh' then log out and in"
fi
if id -nG | tr ' ' '\n' | grep -qx audio; then
  ok "user is in the audio group"
else
  ko "user is not in the audio group (install-realtime.sh adds it)"
fi

echo "Mixxx"
if command -v mixxx >/dev/null; then
  ok "installed: $(dpkg-query -W -f='${Version}' mixxx 2>/dev/null || echo '?')"
else
  ko "not installed: sudo apt install mixxx"
fi
if [[ -f "$MAPPING" ]]; then
  ok "Hercules mapping shipped with Mixxx"
else
  ko "mapping file missing: $MAPPING"
fi
if grep -q 'name="pipewire"' "${MIXXX_DIR}/soundconfig.xml" 2>/dev/null; then
  ok "soundconfig.xml sends sound to PipeWire (pc mode: laptop speakers)"
elif grep -q "$CARD_NAME" "${MIXXX_DIR}/soundconfig.xml" 2>/dev/null; then
  cfg_card="$(sed -n 's/.*alsaHwDevice="hw:\([0-9]*\),0".*/\1/p' "${MIXXX_DIR}/soundconfig.xml" | head -1)"
  if [[ -n "$card" && "$cfg_card" != "$card" ]]; then
    warn "soundconfig.xml points to hw:${cfg_card},0 but the card is hw:${card},0: rerun apply-mixxx-config.sh"
  else
    ok "soundconfig.xml uses the controller"
  fi
else
  ko "soundconfig.xml does not use the controller: run scripts/apply-mixxx-config.sh"
fi
if grep -q "^DJControl_Inpulse_300_Mk2_MIDI_ 1" "${MIXXX_DIR}/mixxx.cfg" 2>/dev/null; then
  ok "controller enabled in mixxx.cfg"
else
  ko "controller not enabled in mixxx.cfg: run scripts/apply-mixxx-config.sh"
fi
if [[ -f "${MIXXX_DIR}/mixxx.log" ]] && grep -q "not scheduled with the real-time policy" "${MIXXX_DIR}/mixxx.log"; then
  warn "last Mixxx run had no real-time scheduling (see Real-time section)"
fi

exit "$status"
