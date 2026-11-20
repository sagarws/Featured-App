# Remote Desktop relay (optional, self-hosted)

Only needed to reach an office computer from **outside** the office network.
On the LAN the app connects directly and never uses it.

The relay introduces two computers and copies bytes between them. Sessions stay
**end-to-end encrypted and authenticated by the apps** (X25519 + AES-256-GCM,
Ed25519 device keys, Argon2id passwords): the relay cannot read or change them.
A computer can only register the device ID that its own key hashes to.

```bash
node tools/remote-relay/relay.ts 47900      # Node 22.18+; no npm install needed
```

Open TCP 47900 on the server. In the app: **Remote Desktop → Settings →
Network → Relay** = `relay.example.com:47900` on both computers.

## Video outside the office: TURN

The relay carries the session's control channel; the **video** is WebRTC and
needs a TURN server when the two computers cannot reach each other directly
(different networks / NAT). Use the open-source [coturn](https://github.com/coturn/coturn):

```conf
# /etc/turnserver.conf
listening-port=3478
fingerprint
lt-cred-mech
user=office:CHANGE-ME-long-random
realm=turn.example.com
# keep TURN for your own users only
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
```

App: **Settings → Network → TURN / STUN** = `turn:turn.example.com:3478`,
username `office`, credential as above (stored encrypted). The TURN server only
relays DTLS-SRTP packets it cannot decrypt.

## Running it as a service (systemd)

```ini
[Unit]
Description=Featured App Remote Desktop relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/featured-relay/relay.ts 47900
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```
