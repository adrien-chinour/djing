#!/usr/bin/env bash
# One-shot Ubuntu setup: installs Mixxx and the ALSA tools, then grants real-time
# scheduling (see install-realtime.sh). Run with sudo; log out and in afterwards.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with: sudo $0" >&2
  exit 1
fi

apt-get update
apt-get install -y mixxx alsa-utils usbutils
echo "Installed: mixxx $(dpkg-query -W -f='${Version}' mixxx)"

"${HERE}/install-realtime.sh"
echo "Next: log out and in, plug the controller, then 'make apply' (or 'make apply-pc') and 'make hardware'."
