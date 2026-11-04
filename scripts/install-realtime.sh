#!/usr/bin/env bash
# Grants real-time scheduling to the audio group and adds the invoking user to it.
# Run with sudo. A logout/login is required afterwards.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_user="${SUDO_USER:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with: sudo $0" >&2
  exit 1
fi
if [[ -z "$target_user" ]]; then
  echo "SUDO_USER is empty: run through sudo, not as a root login." >&2
  exit 1
fi

install -m 0644 "${HERE}/system/99-audio-realtime.conf" /etc/security/limits.d/99-audio-realtime.conf
echo "Installed /etc/security/limits.d/99-audio-realtime.conf"
usermod -aG audio "$target_user"
echo "Added $target_user to the audio group"
echo "Log out and back in, then run scripts/check-hardware.sh (expect rtprio 95)."
