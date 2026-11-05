#!/usr/bin/env bash
# Installs (or removes) the user systemd service that runs visuals/audio-server.js at login.
# No sudo: the unit lives in ~/.config/systemd/user/. Usage: install-visuals-service.sh [install|remove]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/djing-visuals.service"
action="${1:-install}"

case "$action" in
  install)
    node_bin="$(command -v node || true)"
    if [[ -z "$node_bin" ]]; then
      echo "node not found in PATH (Node 24 is required)" >&2
      exit 1
    fi
    if [[ ! -d "$HERE/visuals/node_modules/ws" ]]; then
      echo "visuals/node_modules missing: run 'npm install' in $HERE/visuals first" >&2
      exit 1
    fi
    mkdir -p "$unit_dir"
    sed -e "s|@REPO@|$HERE|g" -e "s|@NODE@|$node_bin|g" "$HERE/system/djing-visuals.service" > "$unit"
    systemctl --user daemon-reload
    systemctl --user enable --now djing-visuals.service
    echo "Installed $unit (node: $node_bin, repo: $HERE)"
    systemctl --user --no-pager status djing-visuals.service | head -n 5
    ;;
  remove)
    systemctl --user disable --now djing-visuals.service 2>/dev/null || true
    rm -f "$unit"
    systemctl --user daemon-reload
    echo "Removed $unit"
    ;;
  *)
    echo "Usage: $0 [install|remove]" >&2
    exit 1
    ;;
esac
