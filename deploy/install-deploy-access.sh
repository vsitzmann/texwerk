#!/usr/bin/env bash
# Once, as root: install the no-sudo deploy path (texwerk-deploy.service + polkit rule).
# Re-run after changing deploy/update.sh so the root-owned copy matches.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
install -o root -g root -m 0755 "$HERE/update.sh" /usr/local/bin/texwerk-update
install -o root -g root -m 0644 "$HERE/texwerk-deploy.service" /etc/systemd/system/texwerk-deploy.service
install -o root -g polkitd -m 0640 "$HERE/50-werk-deploy.rules" /etc/polkit-1/rules.d/50-werk-deploy.rules 2>/dev/null \
  || install -o root -g root -m 0644 "$HERE/50-werk-deploy.rules" /etc/polkit-1/rules.d/50-werk-deploy.rules
systemctl daemon-reload
echo "installed; deploy with: systemctl start texwerk-deploy  /  systemctl start deckwerk-update"
