# Remote Desktop

See and control another office computer running Featured App — or let someone
see and control this one. Built for coding on an office PC from another office
PC: direct LAN connection, H.264 hardware encoding, low-latency input, and
shortcuts that reach the remote IDE.

Sidebar → **Remote Desktop**: *Connect* (this device, connect, devices on the
network / saved / recent), *Active sessions*, *Settings*, *Security*, *History*,
*Diagnostics*. A session opens its own viewer window (full screen, fit /
1:1, screen switcher, quality, clipboard, files, special keys, statistics).

---

## 1. Architecture decision

| | Pure Electron + WebRTC + small native input helpers (**chosen**) | Embed RustDesk |
|---|---|---|
| Licence | All code ours; deps MIT/BSD/Apache | **AGPL-3.0**: shipping it inside this app obliges releasing the whole app under AGPL, incompatible with the app's current `UNLICENSED` distribution |
| Integration | Same process model, IPC, UI kit and settings as the rest of the app | A second app (Rust core + Flutter UI) to bundle, launch and bridge to |
| Capture / encode | Chromium's desktop capture + WebRTC encoders (VideoToolbox / MediaFoundation / VA-API hardware H.264) | Native capture, codec choice incl. its own VP9/AV1 paths |
| Input | Native helper per OS (CoreGraphics / SendInput / XTEST) — ~300 lines each | Mature native input incl. Windows service mode |
| Gaps | No secure-desktop (UAC/Ctrl+Alt+Del/lock screen) control on Windows, no Wayland control (see §7) | Handles UAC via a Windows service; also no Wayland input without portals |
| Infra | None on the LAN; optional self-hosted relay + coturn | Its own hbbs/hbbr servers for anything beyond LAN |

Chromium already contains a production WebRTC stack with congestion control,
hardware encoders and DTLS-SRTP, so the performance-critical path (capture →
encode → network → decode) is native code either way. What JavaScript cannot
do — injecting keyboard/mouse into the OS — is done by small helpers written
for this app (`native/`). RustDesk remains the option to revisit if Windows
secure-desktop control becomes a must; it would need an AGPL-compatible
distribution decision first.

### Components

```
 Viewer computer                                   Host computer (the one being controlled)
 ───────────────                                   ────────────────────────────────────────
 Remote Desktop page ─IPC─┐                     ┌─ Request window (Allow / Reject)
 Viewer window (#rd-viewer)│                     │  Host bar (#rd-hostbar, always on top)
   video ◀────────── WebRTC (DTLS-SRTP, UDP, P2P) ──────────── Capture window (#rd-host)
   input ─────────▶  data channels "input" / "move" ─────────▶   │ IPC (checked per event)
                           │                     │               ▼
 main: ViewerSession ◀═ TCP, X25519 + AES-256-GCM ═▶ main: HostSession ─▶ input helper (native)
        (service.ts)    signalling, clipboard,          (permission, timer,   remote-input
                        files, timer, permission         revoke, resume)
```

| Module | Path |
|---|---|
| Wire protocol, handshake, crypto, rate limiting, relay client | `electron/main/remote/core/` (no Electron imports; unit-tested over real TCP) |
| Service (listener, discovery, requests, routing, status) | `electron/main/remote/service.ts` |
| Host session (enforcement) / viewer session | `electron/main/remote/hostSession.ts`, `viewerSession.ts` |
| Identity, secrets, devices, audit log | `electron/main/remote/store.ts` |
| LAN discovery | `electron/main/remote/discovery.ts` |
| Input injection | `electron/main/remote/input/` + `native/{mac,win,linux}/remote-input.*` |
| File transfer | `electron/main/remote/transfers.ts` |
| IPC (role-checked) | `electron/main/remote/ipc.ts` |
| UI | `electron/renderer/remote/` |
| Relay (optional) | `tools/remote-relay/` |

## 2. Security model

- **Device identity.** Each install generates an Ed25519 key on first start,
  stored encrypted with the OS keychain/DPAPI/libsecret (`safeStorage`) in
  `remote-secrets.json`. The device ID — 8 digits, nothing else (`19304289`) —
  is derived from the public key (SHA-256, first 8 bytes mod 10⁸), so it never
  changes across restarts and cannot be claimed without the key. 8 digits are
  ~27 bits, so the *first* connection also pins the key's 128-bit fingerprint
  (shown in the UI); a changed key is refused. Builds up to 0.1.5 used 9 digits
  (`WD-019-304-289`); the 8-digit ID is their last 8 digits, so saved, trusted
  and blocked devices convert exactly, an old ID typed or pasted still works,
  and the handshake/announcements still carry the old form so 0.1.5 accepts
  0.1.6 and the other way round.
- **Transport.** Fresh X25519 per connection → HKDF → AES-256-GCM, one key and
  a strict counter per direction: replayed, reordered or altered frames close
  the connection. Both sides sign the handshake transcript with their device
  key. WebRTC SDP (with DTLS fingerprints) only travels over this channel, so
  video and input are end-to-end encrypted too — also through a relay or TURN.
- **Attended access.** The host shows requester name, device ID, OS, address,
  a first-time warning and a 6-digit verification code derived from the keys
  (same on both screens unless something is in between). The person chooses
  full control / view only and the duration. 60 s without an answer = rejected.
- **Unattended access** — off by default. The password is never stored or sent:
  the host keeps `Argon2id(password, salt)` (64 MiB, 3 passes) encrypted; the
  client proves knowledge with `HMAC(verifier, transcript)`, valid for that one
  handshake. Minimum strength enforced. Failed attempts: 3 free per
  address and per device, then 30 s lockout doubling to 15 min; >20 failures a
  minute globally pauses everyone for a minute. Request pop-ups are limited
  to 3/min per device. Owners can revoke one device (blocked even with the
  password), revoke all (password removed), or switch unattended off.
- **Host-side enforcement** (`hostSession.ts`): input is injected only while
  the session is active, unexpired, full-control, and the owner's *Disable
  remote control* kill switch is off — checked for every event in the main
  process. The time limit is a main-process timer. Viewer-to-host clipboard
  and files need full control. A dropped connection can be resumed for 30 s
  with the session's secret token and gets the permission as it is *now*
  (a revoked control stays revoked). Ended/revoked sessions cannot be resumed.
- **Always visible.** While shared, an always-on-top bar shows who is viewing
  or controlling, the time left, and View only / Extend / Send files / **Stop**.
  There is no hidden or background mode.
- **IPC.** Every channel checks the calling frame is the app's own page and the
  window role (management = main window only; a viewer can act only on its own
  session; the capture window only for its own session).
- **Files.** Explicit acceptance (or an owner-chosen trusted folder); names cut
  to the last path component, reserved characters/device names removed,
  `.part` + SHA-256 + size check before rename, never overwritten, never opened.

Known limits of the model: a determined attacker who brute-forces a key
matching a 30-bit ID could impersonate a host on a *first* connection (the
pinned fingerprint and verification code defeat it afterwards). Such an
impersonator could then try passwords offline against one captured proof —
Argon2id makes that slow, and a long password makes it impractical.

## 3. Setup (development)

```bash
npm install
npm run dev            # also compiles native/mac helpers (predev)
```

Two computers on the same LAN, both running the app:

1. On the host: Remote Desktop → note the **Device ID**. Leave *Allow remote
   access* on. Optionally set an unattended password.
2. On the viewer: enter the ID (the computer also appears under *On this
   network*), optionally the password → **Connect**.
3. Firewall: allow the app (TCP 47800 sessions, UDP 47801 discovery, WebRTC
   UDP). Windows asks once — choose *Private networks*.

### OS permissions

| | macOS | Windows 10/11 | Linux |
|---|---|---|---|
| Share the screen | **Screen & System Audio Recording** for the app (prompted on first share) | none | X11: none. Wayland: the desktop portal asks each time |
| Be controlled | **Accessibility** for the app (Diagnostics → *Ask macOS*); restart the session after granting | none (normal windows) | X11 session + `python3` with libX11/libXtst (preinstalled on X11 desktops). Wayland: view only |
| In development | Permissions attach to the terminal / Electron binary that launched the app | — | — |

## 4. Different networks (the built-in remote server)

On one network nothing leaves it and no server is used. To connect between
networks (another office, another Wi-Fi or subnet, home ↔ office) every app
registers with the **remote server** set in `REMOTE_SERVER`
(`shared/constants/remote.ts`): the dependency-free relay for the control
channel — plain TCP (`host:47900`) or WebSocket (`wss://…`, works behind
Cloudflare Tunnel) on the same port — and STUN/TURN for the video. Deploy both with
[`tools/remote-relay/deploy`](../tools/remote-relay/deploy/README.md). Neither
can decrypt sessions. Connect tries: found on this network → last known
address (2.5 s) → relay. Settings → Network can point one computer elsewhere.
With no server set, a failed connect names both networks
("last seen at 192.168.1.58, on a different network from this computer
(192.168.10.65)").

## 5. Build and packaging

`npm run build:mac` / `build:win` / `build:linux` as before. Added:

- `scripts/build-native-mac.cjs` also builds `remote-input` (universal
  arm64 + x86_64, Xcode command line tools) → `<Resources>/native/remote-input`.
- Windows ships `native/win/remote-input.ps1` (run with `powershell.exe
  -ExecutionPolicy Bypass`; C# compiled in memory on first use, ~1–2 s once).
- Linux ships `native/linux/remote-input.py` (python3 + ctypes, no packages).
- `@noble/hashes` (MIT, audited) provides Argon2id — Electron's BoringSSL has
  none — and is bundled into the main process build.
- macOS hardened runtime: no new entitlements are needed (Accessibility and
  Screen Recording are TCC permissions, not entitlements). Notarisation is
  still on the "Not done yet" list of the README.

Verified here: `electron-builder --mac dir --arm64` puts `remote-input` in
`Contents/Resources/native/` and it runs. Windows and Linux packages were not
built or run on those OSes.

## 6. Performance

### Design choices for latency

- LAN: host candidates with real IPs (mDNS obfuscation off), no STUN/TURN →
  direct UDP; TCP_NODELAY on the control channel.
- H.264 first (hardware encoder on Mac/Windows/most Linux GPUs), VP9/AV1 on
  request; `contentHint: 'text'` (sharp code) or `'motion'`; encoder sizes
  always even so Chromium never silently falls back to the software encoder
  (found and fixed during testing: odd sizes like 733×476 did).
- Receiver `jitterBufferTarget = 0`; mouse moves coalesced to one per frame on
  an unordered, no-retransmit data channel (a lost move is superseded, never
  waited for); clicks/keys on an ordered reliable channel.
- Auto quality: WebRTC congestion control plus a step-down ladder
  (native → 1080p30 → 900p24 → 720p18 → 480p12) when the encoder reports
  bandwidth/CPU limitation, stepping back up with headroom.
- "Keep text sharp" lowers fps before resolution; "Keep it smooth" the reverse.

### Measured (this is a single-machine loopback, not a LAN)

`npm run remote:selftest` on an Apple M3 Pro MacBook Pro, macOS 27.0.1,
3024×1964 Retina + 1920×1080 external, the app connected to itself over
127.0.0.1 (both ends on one CPU/GPU, no physical network):

| Metric | Result |
|---|---|
| Unattended connect (TCP + handshake + Argon2id + session) | 618–645 ms |
| Connect → first frames playing | 2.8–4.1 s (window + capture start + ICE) |
| Native 3024×1964, H.264 | 47–55 fps, ~5.2–5.5 Mbps |
| Ultra Low / High profiles, live switch | 714×464 @ 11–12 fps / 1644×1068 @ 55–56 fps |
| Input round trip (viewer → host capture window → viewer, data channel) | 1.6–2.8 ms |
| Decode time | 2.8–3.1 ms/frame |
| Jitter buffer (average since start) | 35–44 ms |
| Monitor switch mid-session | 3024×1964 → 1920×1080 → back, no reconnect |
| Software-encoder fallbacks after the even-size fix | 0 |

**Not measured yet:** two machines on a real LAN, glass-to-glass latency,
CPU/RAM under load, packet-loss behaviour. The viewer's statistics panel has a
**30 s benchmark** (avg + p95 of fps, bitrate, RTT, input RTT, decode, jitter
buffer, loss — Copy button) for exactly that. Target on a healthy LAN: < 50 ms
added interaction latency.

## 7. Keyboard, mouse and what the OS does not allow

Keys travel by **physical position** (`KeyboardEvent.code` → macOS key code /
Windows scan code / X11 keycode), so every shortcut works and the host's layout
decides the character; *Characters* mode types text instead (different
layouts). ⌘ ↔ Ctrl are swapped between Mac and PC (setting). With *Send
shortcuts to the remote computer* on, the main process intercepts every key
while the remote screen has focus — ⌘C/⌘V/⌘S/⌘⇧P, Ctrl+\`, ⌘W, ⌘Q, Ctrl+W, Ctrl+Tab all
go to the remote IDE. Full screen also requests Keyboard Lock (Alt+Tab, the
Windows key and Esc where Chromium can capture them). **Shift+Esc** leaves full
screen; plain Esc goes to the remote (vim, dialogs). Double-click, drag,
right/middle click, smooth wheel/trackpad scrolling and Unicode text work.

Cannot be done (OS restrictions — not simulated):

- **Windows lock screen**: possible only with *Lock screen access* turned on
  for that PC (Security tab, one-time administrator approval) — see §7a.
  Without it the viewer shows "The remote computer is locked" and the picture
  returns by itself once someone unlocks it. **UAC prompts** are never
  controllable (on purpose), and Windows blocks input into windows running
  **as administrator** unless the app does too.
- **⌘Tab / ⌘Space / Mission Control** on a *Mac viewer* are taken by macOS
  before any app; use the toolbar's *Send keys* menu. On a Mac **host** they
  work.
- **macOS** lock screen / FileVault login: no injection or capture.
- **Linux Wayland**: no injection (view only), capture via portal prompt.
- Secure text fields (macOS "Secure Input", password managers) may ignore
  injected keys by design.

### 7a. Lock screen, keeping the picture alive, reconnecting

- **Keeping the picture alive (all OSes):** while this computer is shared its
  display is kept awake (no display sleep / screen saver lock). If the capture
  stops — the screen locks, another remote tool such as AnyDesk closes and
  changes the display, the resolution changes, the PC wakes from sleep — the
  capture window starts it again by itself (retrying every few seconds), and
  connects even when capture is not possible yet, so input and the lock-screen
  picture still work.
- **Windows lock screen:** *Security → Lock screen access* installs
  `native/win/RemoteSecureAgent.cs` (run by `remote-secure-agent.ps1`) into
  `%ProgramFiles%\Featured App Remote Agent` and registers the scheduled task
  `FeaturedAppRemoteAgent` (SYSTEM, at startup). It keeps a copy of itself in
  the signed-in user's session, which — **only while that session is locked** —
  sends JPEG pictures of the lock screen (~4/s, only when changed) and injects
  keyboard/mouse there, so you can type the Windows password/PIN from the
  viewer; *Send keys → Ctrl+Alt+Delete* works where Windows allows software
  SAS (policy `SoftwareSASGeneration`). Unlocked, it refuses everything except
  "status", so it cannot click UAC prompts. Requires that someone signed in to
  Windows since the last restart (the app runs in that session). Remove it from
  the same place.
- **Controller gone without disconnecting** (app closed, crash, sleep, network
  lost): both sides ping every 2 s; 8 s of silence = link lost. The host then
  waits 30 s for that controller to resume — but a **new connection from the
  same computer** (proven by its device key) replaces the stale session at
  once instead of being told "busy". Other computers are still refused while
  a session is live. Before this fix the host stayed busy for ~29 s (measured).

## 8. Tests

### Automated (run in this repo)

| Suite | What it proves |
|---|---|
| `tests/remoteProtocol.test.ts` (23) | Real TCP: attended accept/reject/view-only, wrong password + lockout, unattended off, blocked device, request flood limit, ID/key mismatch and pinned-key refusal, probe, resume with real / forged token, encryption both ways, tamper and **replay** close the link, oversized pre-auth frame, relay pipe + relay impersonation refused |
| `tests/remoteHostSession.test.ts` (15) | 30-min default, 5-min warning, expiry disconnect, last-instant refusal, unlimited 10 h, extend / remove limit, view-only blocks input + clipboard, owner downgrade, kill switch, no pre-session clipboard leak, owner disconnect, viewer bye, 30 s resume window, revoked permission survives resume, original deadline survives resume, keepalive timeout |
| `tests/remoteTransfers.test.ts` (4) | Real encrypted channels + files: 3 MB + small + empty file, no overwrite, decline, `../../../` name lands inside the folder, checksum/size mismatch rejected and cleaned up |
| `tests/remoteUtils.test.ts` (20) | Settings defaults/sanitising, ID/target parsing, password policy, quality plans incl. even sizes on 8 real resolutions, ⌘/Ctrl mapping, key map coverage + uniqueness, coordinate mapping, malformed input/signals/discovery dropped, file-name safety |
| `npm run remote:selftest` (28 checks) | The real app, end to end, on one Mac (results in §6) |

### Manual two-machine checklist

Status as delivered: **none of these has been run on two physical machines.**

| # | Test | Expected | Status |
|---|---|---|---|
| 1 | Connect PC1 → PC2 by ID on the LAN | Video in < 5 s, *Direct LAN* in toolbar | not run |
| 2 | Connect with ID + password | No prompt on PC2, host bar appears | not run |
| 3 | Request → Reject; Request → Allow (full / view only) | Matches choice; same verification code on both | not run |
| 4 | Default 30 min | Warning at 25:00, disconnect at 30:00 on both sides | not run |
| 5 | Unlimited | No timer, no warning after > 30 min | not run |
| 6 | Host presses Stop / closes app | Viewer shows *Session ended* immediately | not run |
| 7 | Unattended: off by default; set password; revoke device | Revoked device refused even with password | not run |
| 8 | All six quality levels while connected | Resolution/fps change without reconnect | not run |
| 9 | Throttle network (e.g. `tc qdisc ... netem delay 80ms loss 2%`, Clumsy on Windows) | Auto steps down; input stays responsive | not run |
| 10 | Full screen, toolbar auto-hide, Shift+Esc, emergency disconnect | As described | not run |
| 11 | VS Code: ⌘/Ctrl+C/V/S, ⌘/Ctrl+⇧P, Ctrl+\`, multi-cursor, Tab switching | All reach the remote IDE | not run |
| 12 | Terminal typing (fast), mouse select, drag & drop, wheel scroll | No stuck keys, smooth | not run |
| 13 | Clipboard both ways | Text arrives; nothing from before the session | not run |
| 14 | Send 1 GB + 100 small files both ways; cancel midway | Correct bytes, speed shown, cancel cleans up | not run |
| 15 | Two monitors on host: switch | Correct screen, clicks land correctly | single-Mac only |
| 16 | Pull the network cable for 10 s / 40 s | Resumes / ends cleanly | not run |
| 17 | Unknown device, wrong password, view-only session | Cannot inject input | unit tests only |
| 18 | 10 wrong passwords | Lockout grows; audit log shows it | unit tests only |
| 19 | CPU, RAM, bitrate, fps, latency (30 s benchmark) | Record per profile | not run |
| 20 | Existing features (printing, recorder, screenshots, transcripts) | Unchanged | automated suites pass |

### Measured on the real office LAN (Mac → Windows 11, 2026-11-20)

MacBook Pro M3 Pro (Wi-Fi, 192.168.1.19) → DESKTOP-MS84JJ8 (Windows 11,
192.168.1.58), unattended password, no input sent: found by LAN discovery,
probe 39 ms, connect 654–680 ms, video 1920×1080 after 2.9–3.9 s, network RTT
12–14 ms, input RTT 7–15 ms. That run also found the codec bug (software AV1 was
negotiated; now H.264) and reproduced the 29 s "busy" after a killed controller
(fixed above, needs the new build on the remote). Frame rate/bitrate were not
measured: the remote screen was static during the test.

## 9. Not done / unsupported

- Validation on two physical machines, Windows, and Linux (see checklist).
- The Windows lock-screen agent's C# has not been compiled or run on Windows
  yet (no Windows / .NET here). Check it on a Windows PC with:
  `powershell -NoProfile -Command "Add-Type -Path native\win\RemoteSecureAgent.cs -ReferencedAssemblies System.Drawing,System.Core; 'compiled'"`
- Sign-in after a reboot (no user session yet) and UAC prompts.
- Wayland keyboard/mouse control (needs the RemoteDesktop portal / libei).
- Audio from the remote computer; browsing the remote file system (files are
  pushed by either side, not pulled).
- Multiple simultaneous viewers on one host (one incoming session at a time).
- Over the relay, media still needs TURN; there is no TCP media fallback.
- Code signing / notarisation (unchanged from the rest of the app).
