#!/usr/bin/env bash
# TURN (coturn) for Featured App video between networks, on the relay's VPS.
#
#   sudo bash setup-turn.sh [public-ip]
#
# Upload the remote-relay folder (relay.ts + deploy/) and run this from
# deploy/. It:
#   1. installs coturn with short-lived logins (use-auth-secret) and load limits,
#   2. updates the running relay (pm2 "featured-relay" or systemd
#      "featured-relay") to the uploaded relay.ts and gives it the secret, so it
#      hands each app a fresh TURN login,
#   3. opens the firewall with ufw when it is active.
# Safe to run again: the secret is kept in /etc/featured-relay/turn.env.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_IP="${1:-}"
ENV_DIR=/etc/featured-relay
ENV_FILE=$ENV_DIR/turn.env

if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo bash setup-turn.sh [public-ip]"; exit 1; fi
if [ -z "$PUBLIC_IP" ]; then PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || true)"; fi
if [ -z "$PUBLIC_IP" ]; then echo "Could not find the public IP; pass it: sudo bash setup-turn.sh 203.0.113.25"; exit 1; fi

echo "== Secret"
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
if [ -f "$ENV_FILE" ] && grep -q '^TURN_SECRET=' "$ENV_FILE"; then
  SECRET="$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
  echo "kept the existing one ($ENV_FILE)"
else
  SECRET="$(openssl rand -hex 32)"
fi
cat > "$ENV_FILE" <<EOF
TURN_SECRET=$SECRET
TURN_URLS=turn:$PUBLIC_IP:3478?transport=udp,turn:$PUBLIC_IP:3478?transport=tcp
EOF
chmod 600 "$ENV_FILE"

echo "== coturn (UDP/TCP 3478, UDP 49160-49200)"
command -v turnserver >/dev/null || { apt-get update -qq && apt-get install -y coturn; }
sed -e "s#^static-auth-secret=.*#static-auth-secret=$SECRET#" \
    -e "s#^realm=.*#realm=$PUBLIC_IP#" \
    -e "s#^external-ip=.*#external-ip=$PUBLIC_IP#" \
    "$HERE/turnserver.conf" > /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
chgrp turnserver /etc/turnserver.conf 2>/dev/null || true
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn >/dev/null
systemctl restart coturn

echo "== Relay"
UPLOADED="$HERE/../relay.ts"
if command -v pm2 >/dev/null && pm2 describe featured-relay >/dev/null 2>&1; then
  # The relay.ts pm2 runs: the script itself (pm2 start relay.ts …), or an
  # argument (pm2 start node -- relay.ts …, where the script is node). Never
  # anything that is not a file named relay.ts.
  SCRIPT="$(pm2 jlist | node -e '
    const path = require("node:path")
    let s = ""
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const p = JSON.parse(s).find(p => p.name === "featured-relay")?.pm2_env ?? {}
      const args = Array.isArray(p.args) ? p.args : String(p.args ?? "").split(" ")
      const hit = [p.pm_exec_path, ...args].find(a => typeof a === "string" && path.basename(a) === "relay.ts")
      process.stdout.write(hit ? path.resolve(p.pm_cwd ?? process.cwd(), hit) : "")
    })')"
  if [ -z "$SCRIPT" ] || [ "$(basename "$SCRIPT")" != relay.ts ]; then
    echo "could not tell which relay.ts pm2 runs; restarting it as it is (update that relay.ts yourself)"
  elif [ -f "$UPLOADED" ] && [ "$(realpath "$UPLOADED")" != "$(realpath "$SCRIPT")" ]; then
    cp "$UPLOADED" "$SCRIPT"
    echo "updated $SCRIPT"
  else
    echo "pm2 runs $SCRIPT (already this one)"
  fi
  set -a; . "$ENV_FILE"; set +a
  pm2 restart featured-relay --update-env >/dev/null
  pm2 save >/dev/null
  echo "pm2 featured-relay restarted with TURN logins"
elif systemctl list-unit-files featured-relay.service >/dev/null 2>&1 && [ -f /etc/systemd/system/featured-relay.service ]; then
  [ -f "$UPLOADED" ] && [ -d /opt/featured-relay ] && [ "$(realpath "$UPLOADED")" != /opt/featured-relay/relay.ts ] && cp "$UPLOADED" /opt/featured-relay/relay.ts
  mkdir -p /etc/systemd/system/featured-relay.service.d
  printf '[Service]\nEnvironmentFile=%s\n' "$ENV_FILE" > /etc/systemd/system/featured-relay.service.d/turn.conf
  systemctl daemon-reload
  systemctl restart featured-relay
  echo "systemd featured-relay restarted with TURN logins"
else
  echo "No featured-relay found in pm2 or systemd. Start the relay with the secret, e.g.:"
  echo "  set -a; . $ENV_FILE; set +a; pm2 start relay.ts --name featured-relay --interpreter node -- 47900 && pm2 save"
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "== Firewall (ufw)"
  ufw allow 3478/tcp >/dev/null
  ufw allow 3478/udp >/dev/null
  ufw allow 49160:49200/udp >/dev/null
fi

sleep 1
echo
systemctl is-active --quiet coturn && echo "coturn : running on 3478" || echo "coturn : NOT running — journalctl -u coturn -n 50"
echo
echo "If your provider has its own firewall (Hostinger: VPS → Firewall; AWS: security group), allow:"
echo "  47900 TCP · 3478 TCP+UDP · 49160-49200 UDP"
echo
echo "Nothing to change in the apps: they get a TURN login from the relay on every connection."
