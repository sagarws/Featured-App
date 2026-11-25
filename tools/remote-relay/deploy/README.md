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
sudo bash install.sh
```

It installs Node.js 24 (if needed) and coturn, starts both services, opens the
ports in `ufw` when it is on, and finds the public IP by itself — pass it as
the argument if that fails: `sudo bash install.sh 203.0.113.25`.
Running it again is safe.

If the provider has its own firewall / security group (AWS, Azure, GCP,
Hetzner, DigitalOcean…), open there too: **47900 TCP · 3478 TCP+UDP · 49160–49200 UDP**.

## 3. Check (from any other computer)

```bash
nc -vz YOUR_VPS_IP 47900                      # "succeeded"
curl http://YOUR_VPS_IP:47900/version         # {"name":"featured-remote-relay","version":"1.1.0","turn":true,"uptimeSec":42}
```

`version` is the deployed `relay.ts` (`RELAY_VERSION`; bump it and
`package.json` with every relay change). `turn: true` means it hands out TURN
logins (TURN_SECRET / TURN_URLS set).

## 4. App

In `shared/constants/remote.ts` → `REMOTE_SERVER.relay` (and the mobile app's
`src/features/remote/core/constants.ts`): `relay: '203.0.113.25:47900'`.
TURN needs nothing in the apps: see below.

Build and install the new version on every computer. Remote Desktop then shows
"Reachable from any network", and Diagnostics "relay … (built in) — online".

## Video between networks (TURN), with little load on the server

The relay carries only the small encrypted control connection. Video goes
**directly** between the two devices whenever it can (same network, or through
both routers with STUN — Cloudflare's and Google's free STUN, not the VPS).
Only when two networks block every direct path (strict NAT, mobile carriers,
corporate firewalls) does it go through coturn on the VPS, and then:

- each app gets a **short-lived TURN login from the relay** (coturn
  `use-auth-secret`; valid 12 h), so no TURN password ships inside the apps;
- the sharing app **caps relayed video at 2.5 Mbit/s, 30 fps**;
- coturn enforces **3.2 Mbit/s per session, 50 Mbit/s and 40 allocations in
  total** (`turnserver.conf`: `max-bps`, `bps-capacity`, `total-quota`).

install.sh sets this up. On a relay already running under PM2 (or systemd),
upload the folder and run only the TURN part:

```bash
scp -r tools/remote-relay root@YOUR_VPS_IP:/root/featured-relay-upload
ssh root@YOUR_VPS_IP 'cd /root/featured-relay-upload/deploy && bash setup-turn.sh'
```

It installs coturn, copies the new `relay.ts` over the one PM2 runs, restarts
`featured-relay` with `TURN_SECRET` / `TURN_URLS` (kept in
`/etc/featured-relay/turn.env`) and prints `coturn : running`. The relay log
then starts with `· TURN logins for turn:…`. Open **3478 TCP+UDP and
49160–49200 UDP** in the provider's firewall too.

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
systemctl status featured-relay coturn        # running?   (PM2: pm2 ls / pm2 logs featured-relay)
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
bash /opt/featured-relay/deploy/setup-turn.sh      # coturn + TURN logins for the relay
ufw allow 47900/tcp && ufw allow 3478 && ufw allow 49160:49200/udp
```

TURN logins expire by themselves and coturn refuses to reach private networks
behind the server, so a copied login is worth little. To cut off every login
at once, delete `/etc/featured-relay/turn.env` and run `setup-turn.sh` again
(new secret).
