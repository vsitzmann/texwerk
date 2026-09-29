#!/usr/bin/env bash
# One-time setup of the TeXWerk server on this machine, alongside DeckWerk.
#
#   sudo ./deploy/install.sh
#
# Creates the `texwerk` system user and /srv/texwerk, installs TeX Live,
# gives the service a private copy of Node, builds the app from this
# checkout, starts texwerk.service on 127.0.0.1:5810 and publishes it on the
# tailnet with `tailscale serve` at https://<machine>.<tailnet>.ts.net:10000.
# Safe to re-run.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
ME=${SUDO_USER:-vsitzmann}
NODE_SRC=$(sudo -u "$ME" bash -lc 'dirname "$(dirname "$(readlink -f "$(command -v node)")")"')
PORT=5810
TS_PORT=10000

echo "== TeX Live (latexmk, pdflatex/xelatex/lualatex, biber, synctex, common packages)"
pacman -S --needed --noconfirm \
  texlive-basic texlive-bin texlive-binextra texlive-latex texlive-latexrecommended texlive-latexextra \
  texlive-fontsrecommended texlive-fontsextra texlive-fontutils texlive-bibtexextra texlive-mathscience \
  texlive-pictures texlive-plaingeneric texlive-publishers texlive-xetex texlive-luatex texlive-langgerman \
  biber git openssh rsync

echo "== user and folders"
getent group texwerk >/dev/null || groupadd --system texwerk
getent passwd texwerk >/dev/null || useradd --system -g texwerk -d /srv/texwerk -s /usr/bin/nologin texwerk
install -d -o texwerk -g texwerk -m 0750 /srv/texwerk
setfacl -m u:$ME:rx /srv/texwerk
install -d -o texwerk -g texwerk -m 2770 /srv/texwerk/projects
# Both users can read/write every project, now and for files created later.
setfacl -R -m u:texwerk:rwX,u:$ME:rwX,m::rwX /srv/texwerk/projects
setfacl -d -m u:texwerk:rwX,u:$ME:rwX,g::rwX,m::rwX,o::- /srv/texwerk/projects
# Projects are git repositories owned by texwerk; let vsitzmann run git in them too.
sudo -u "$ME" git config --global --get-all safe.directory | grep -qx '/srv/texwerk/projects/\*' \
  || sudo -u "$ME" git config --global --add safe.directory '/srv/texwerk/projects/*'

echo "== node (private root-owned copy from $NODE_SRC; texwerk cannot read your home)"
rm -rf /opt/texwerk-node
cp -a "$NODE_SRC" /opt/texwerk-node
chown -R root:root /opt/texwerk-node
/opt/texwerk-node/bin/node -v

echo "== app"
"$HERE/update.sh" --no-restart

echo "== systemd"
install -m 0644 "$HERE/texwerk.service" /etc/systemd/system/texwerk.service
systemctl daemon-reload
systemctl enable --now texwerk.service
ok=0
for i in $(seq 1 30); do
  [[ $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ || true) == 200 ]] && { ok=1; break; }
  sleep 1
done
[[ $ok == 1 ]] || { journalctl -u texwerk -n 30 --no-pager; echo "SERVICE DID NOT COME UP"; exit 1; }

echo "== tailnet (HTTPS port $TS_PORT; DeckWerk keeps 443)"
tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$PORT
tailscale serve status

echo "== sandbox check (should say Permission denied / No such file)"
sudo -u texwerk ls /home/$ME 2>&1 | head -1
systemd-analyze security texwerk.service 2>/dev/null | tail -1
echo "INSTALLED — open https://$(tailscale status --json | /opt/texwerk-node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.Self.DNSName.replace(/\.$/,""))})'):$TS_PORT/"
