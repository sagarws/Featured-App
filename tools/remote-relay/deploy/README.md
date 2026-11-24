# Deploying the Featured App remote server

Lets two computers on **different networks** connect by their 8-digit ID (like
AnyDesk). On the same network the app still connects directly and never uses it.
Sessions stay end-to-end encrypted: the server cannot see screens or keystrokes.

## 1. Server

Any small Linux VPS with a public IP (1 vCPU / 1 GB is plenty for an office).
Vercel and other serverless hosts cannot run it: it needs raw TCP and UDP.

```bash
# on the VPS, with Docker installed
git clone <this repo> featured-app && cd featured-app/tools/remote-relay/deploy
nano turnserver.conf      # set the password, realm, and external-ip if the VPS is on AWS/GCP/Azure
docker compose up -d
```

Open these ports in the VPS firewall / cloud security group:

| Port | Protocol | For |
|---|---|---|
| 47900 | TCP | relay (connection set-up + control channel) |
| 3478 | TCP + UDP | STUN / TURN |
| 49160–49200 | UDP | TURN video |

Check from any computer: `nc -vz <server> 47900` and `nc -vzu <server> 3478`.

## 2. App

In `shared/constants/remote.ts` → `REMOTE_SERVER`:

```ts
host: 'remote.example.com',          // the VPS's host name or public IP
turnUsername: 'featured',            // user=featured:… in turnserver.conf
turnCredential: '…the password…',
```

Build and install the new version on **every** computer (auto update does this).
Each computer then registers with the relay while the app runs, and
Connect tries: same network → last known address → relay. Remote Desktop →
Diagnostics shows "relay … (built in) — online".

The TURN password ships inside the app, so anyone with the app could use the
TURN server for video. coturn above refuses to reach private networks, which
limits that to relaying traffic. Change the password and release a new version
if it is ever abused.
