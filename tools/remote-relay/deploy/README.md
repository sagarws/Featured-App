# Deploying the Featured App remote server (no Docker)

Lets two computers on **different networks** connect by their 8-digit ID (like
AnyDesk). On the same network the app still connects directly and never uses it.
Sessions stay end-to-end encrypted: the server cannot see screens or keystrokes.

Two programs run on the server, both as normal systemd services:

| Service | What | Port |
|---|---|---|
| `featured-relay` | `relay.ts` on Node.js — connects the two apps, carries the encrypted control channel | 47900 TCP |
| `coturn` | TURN/STUN — carries the video when the two networks cannot reach each other | 3478 TCP+UDP, 49160–49200 UDP |

## 1. Upload (from the Mac)

Any Ubuntu / Debian VPS with a public IP; the smallest plan is enough.

```bash
cd /Users/apple/Documents/Sagar/Other/Featured-App
scp -r tools/remote-relay root@YOUR_VPS_IP:/opt/featured-relay
```

## 2. Install (on the VPS)

```bash
ssh root@YOUR_VPS_IP
cd /opt/featured-relay/deploy
sudo bash install.sh YOUR-TURN-PASSWORD          # letters/digits, 12+ characters
```

It installs Node.js 24 (if needed) and coturn, starts both services, opens the
ports in `ufw` when it is on, and finds the public IP by itself — pass it as a
second argument if that fails: `sudo bash install.sh YOUR-TURN-PASSWORD 203.0.113.25`.
It ends by printing the three values for the app. Running it again is safe.

If the provider has its own firewall / security group (AWS, Azure, GCP,
Hetzner, DigitalOcean…), open there too: **47900 TCP · 3478 TCP+UDP · 49160–49200 UDP**.

## 3. Check (from any other computer)

```bash
nc -vz YOUR_VPS_IP 47900          # "succeeded"
```

## 4. App

In `shared/constants/remote.ts` → `REMOTE_SERVER`, put what install.sh printed:

```ts
relay: '203.0.113.25:47900',
stun: ['stun:203.0.113.25:3478'],
turn: { urls: ['turn:203.0.113.25:3478?transport=udp', 'turn:203.0.113.25:3478?transport=tcp'], username: 'featured', credential: 'YOUR-TURN-PASSWORD' },
```

Build and install the new version on every computer. Remote Desktop then shows
"Reachable from any network", and Diagnostics "relay … (built in) — online".

## Without a VPS: Cloudflare Tunnel (testing)

The relay also speaks WebSocket, so it can run on any computer behind a
Cloudflare Tunnel (no port to open). Video then uses Cloudflare's free STUN; a
TURN server is still needed for networks that block direct video.

```bash
node tools/remote-relay/relay.ts 47900
cloudflared tunnel --url http://localhost:47900      # prints https://<name>.trycloudflare.com
```

App: `relay: 'wss://<name>.trycloudflare.com'` in `REMOTE_SERVER`, or the same
in Remote Desktop → Settings → Network → Relay on each computer (no rebuild).
A quick tunnel's name changes on every restart; a named tunnel on your own
domain (`cloudflared tunnel create`) keeps it.

Check a relay end to end from the repo:
`RELAY_TEST_URL=wss://<name>.trycloudflare.com npx vitest run tests/remoteProtocol.test.ts -t relay`

## Managing it

```bash
systemctl status featured-relay coturn        # running?
journalctl -u featured-relay -f               # relay log
journalctl -u coturn -f                       # TURN log
systemctl restart featured-relay coturn       # after changing /etc/turnserver.conf
```

Updating the relay later: upload `relay.ts` to `/opt/featured-relay/` again and
`systemctl restart featured-relay`.

## By hand (what install.sh does)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
cp /opt/featured-relay/deploy/featured-relay.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now featured-relay

apt install -y coturn
cp /opt/featured-relay/deploy/turnserver.conf /etc/turnserver.conf
nano /etc/turnserver.conf     # password after user=featured:, realm, external-ip
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn   # older Ubuntu
systemctl enable --now coturn && systemctl restart coturn

ufw allow 47900/tcp && ufw allow 3478 && ufw allow 49160:49200/udp
```

The TURN password ships inside the app, so anyone with the app could use the
TURN server for video. The config refuses to reach private networks, which
limits that to relaying traffic. Change the password and release a new version
if it is ever abused.
