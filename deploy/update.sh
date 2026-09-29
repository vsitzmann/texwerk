#!/usr/bin/env bash
# Deploy the current commit of this checkout to /srv/texwerk/app and restart.
#
#   sudo ./deploy/update.sh            # refuses while someone is connected
#   sudo ./deploy/update.sh --force    # restart anyway (open tabs reload by themselves)
#
# Deploys what is committed (HEAD), never uncommitted work. The server
# persists every open project on SIGTERM; browser tabs and mirror bridges
# reconnect and re-sync against the reloaded documents on their own.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
APP=/srv/texwerk/app
PORT=5810
restart=1 force=0
for a in "$@"; do
  [[ $a == --no-restart ]] && restart=0
  [[ $a == --force ]] && force=1
done
as_tw() { sudo -u texwerk env HOME=/srv/texwerk PATH=/opt/texwerk-node/bin:/usr/bin "$@"; }

if [[ $restart == 1 && $force == 0 ]] && ss -H -tn state established "( sport = :$PORT )" | grep -q .; then
  echo "someone is connected to TeXWerk right now; re-run later or with --force"; exit 1
fi

rev=$(git -C "$SRC" rev-parse HEAD)
echo "== deploying ${rev:0:7} from $SRC"
tmp=$(mktemp -d)
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$tmp"
install -d -o texwerk -g texwerk -m 0755 "$APP"
lock_changed=1
[[ -f $APP/package-lock.json ]] && cmp -s "$tmp/package-lock.json" "$APP/package-lock.json" && lock_changed=0
rsync -a --delete --exclude node_modules --exclude dist "$tmp/" "$APP/"
rm -rf "$tmp"
echo "$rev" > "$APP/REVISION"
chown -R texwerk:texwerk "$APP"
cd "$APP"
if [[ $lock_changed == 1 || ! -d node_modules ]]; then as_tw npm ci --no-audit --no-fund; fi
as_tw npm run build
if [[ $restart == 1 ]]; then
  systemctl restart texwerk.service
  for i in $(seq 1 30); do
    [[ $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ || true) == 200 ]] && { echo "serving ${rev:0:7}"; exit 0; }
    sleep 1
  done
  journalctl -u texwerk -n 30 --no-pager; echo "DID NOT COME UP"; exit 1
fi
