#!/usr/bin/env bash
# Featured App remote server, without Docker (Ubuntu / Debian).
#
#   sudo bash install.sh [public-ip]
#
# Installs Node.js 24 + the relay (systemd: featured-relay) and coturn (systemd:
# coturn), opens the firewall with ufw when it is present. Safe to run again.
# Run it from the uploaded folder: /opt/featured-relay/deploy
set -euo pipefail

PUBLIC_IP="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET=/opt/featured-relay

if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo bash install.sh [public-ip]"; exit 1; fi
if [ -z "$PUBLIC_IP" ]; then PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || true)"; fi
if [ -z "$PUBLIC_IP" ]; then echo "Could not find the public IP; pass it as the argument."; exit 1; fi

echo "== Files → $TARGET"
mkdir -p "$TARGET"
if [ "$(cd "$HERE/.." && pwd)" != "$TARGET" ]; then cp "$HERE/../relay.ts" "$HERE/../package.json" "$TARGET/"; fi

echo "== Node.js"
NODE_OK=0
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== Relay service (TCP 47900)"
sed "s#/usr/bin/node#$(command -v node)#" "$HERE/featured-relay.service" > /etc/systemd/system/featured-relay.service
systemctl daemon-reload
systemctl enable featured-relay >/dev/null
systemctl restart featured-relay

echo "== coturn (TURN) + TURN logins for the relay"
bash "$HERE/setup-turn.sh" "$PUBLIC_IP"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "== Firewall (ufw)"
  ufw allow 47900/tcp
  ufw allow 3478
  ufw allow 49160:49200/udp
fi

sleep 1
echo
systemctl is-active --quiet featured-relay && echo "relay   : running on TCP 47900" || echo "relay   : NOT running — journalctl -u featured-relay"
systemctl is-active --quiet coturn && echo "coturn  : running on 3478" || echo "coturn  : NOT running — journalctl -u coturn"
echo
echo "Also open these in your provider's firewall / security group if it has one:"
echo "  47900 TCP · 3478 TCP+UDP · 49160-49200 UDP"
echo
echo "Put this in shared/constants/remote.ts → REMOTE_SERVER.relay (TURN needs nothing in the apps):"
echo "  relay: '$PUBLIC_IP:47900',"
