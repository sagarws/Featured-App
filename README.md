# Featured App

A small desktop app (Electron) that runs on each packing computer and lets the
TrackVid web app print label / invoice PDFs **silently to a named printer**.
It replaces QZ Tray: no certificate, no "Allow" popup.

Setup and theme are taken from Trackvid-CMS (electron-vite, MUI 7 + the ported
Monitor/Vercel theme, Tailwind 4, the same pinned versions).

## Run

```bash
npm install
npm run dev          # agent window + local API on http://127.0.0.1:17865
npm run verify       # typecheck ×2 + lint + tests
npm run build:mac    # dmg (x64 + arm64)
npm run build:win    # NSIS installer (x64)
```

## Recorder

Screen (full display or region), webcam and audio recording with system audio
by default, 30-minute crash-safe segments, automatic merge and recovery of
interrupted sessions. Sidebar → **Recorder**. Needs ffmpeg (bundled in packaged
builds; `brew install ffmpeg` for development). Details, OS support and the test
checklist: [docs/RECORDER.md](docs/RECORDER.md).

## Remote Desktop

See and control another office computer running the app (or let it control
this one) by **device ID** — attended (the other person clicks Allow) or
unattended (Argon2id-protected password, off by default). Direct and end-to-end
encrypted on the LAN, no external server; optional self-hosted relay + TURN for
outside the office. Sessions default to 30 minutes (up to unlimited), enforced
on the host, with an always-visible bar there to stop, limit or extend them.
Sidebar → **Remote Desktop**. Architecture, security model, OS permissions,
limitations, benchmarks and the test checklist:
[docs/REMOTE_DESKTOP.md](docs/REMOTE_DESKTOP.md).

```bash
npm run remote:selftest   # end-to-end on one machine (the app connects to itself)
npm run remote:relay      # optional relay for connections outside the office
```

## Auto update

Each build asks its own entry in the software-versions list (check-otp). The URL per
platform/arch is in `shared/constants/updates.ts`; today only **Windows x64**
(`Featured-App-x64` → `…-x64-setup.exe`) and **Mac Apple Silicon** (`Featured-App-arm64` →
`…-arm64.dmg`) are published. Others show "not published yet". The API answers
`{ softwareName, version, link }`, where `link` is a Google Drive share link. No `latest.yml` is used.

- **Auto update on** (Settings → Updates, the default): checks 10 s after every start. When a newer version
  is out it downloads, verifies and installs it, and the app restarts. A check while the app is
  running (every 6 h) only downloads it, and it installs on the next start or with **Restart & update**.
  The app never restarts during a recording.
- **Auto update off**: still checks and tells you (Home banner, tray, one notification), but
  installs only when you press **Update now**.
- **Check for updates** in Settings checks on demand.

Before anything runs, the download is verified. It must be a real installer (not Drive's HTML page),
the right kind for this computer, and, on a Mac, `com.featured.app` with a version newer than the
installed one. On Windows the one-click NSIS installer runs silently and relaunches the app
(`build/installer.nsh` waits for the old process to let go of its files). On a Mac a script
replaces the `.app` after the app quits and reopens it. The Mac app must be in a folder you can
write to, such as /Applications, not running from the DMG. A version that installs twice without
the app catching up is not retried automatically.

**Release steps:** bump `version` in package.json → build → upload the installer to Drive
("Anyone with the link") → update that build's row in check-otp with the new version and link.

## API (loopback only)

`GET /v1/status` → `{ ok, app, version, allowed, apiVersion: 2 }` answers any browser origin.
Everything else needs an allowed origin. The list is built in, not editable: `https://trackvid.in`,
`https://*.trackvid.in`, and `http://localhost` / `http://127.0.0.1` on **any port**
(`ALLOWED_ORIGINS` in `shared/constants/agent.ts`).

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/printers[?refresh=1]` | `{ ok, printers: [printer] }` |
| GET | `/v1/printers/:name[?refresh=1]` | `{ ok, printer }` |
| POST | `/v1/print` | `{ ok, jobId, job, printer }` once the OS queue took it. **409** + `printer` when it is offline / paused, **502** when the OS refused it |
| GET | `/v1/jobs` | `{ ok, jobs }`: this website's jobs from this session |
| GET | `/v1/jobs/:id` | `{ ok, job }` |
| POST | `/v1/jobs/:id/cancel` | `{ ok, job }` |
| GET | `/v1/events` | Server-Sent Events: `printers` (full list on every status change), `job` (each change to this website's jobs) |

**printer** = `{ name, displayName, isDefault, connection: network|usb|virtual|unknown, driver?, location?,
status: { state: ready|printing|paused|offline|error|unknown, message, issues: [{ code, severity, message }],
reachable, acceptingJobs, checkedAt }, supplies: [{ name, level: 0-100|null, color? }], queuedJobs }`

**job.status**: `sending → queued → printing → done`, or `held`, `failed`, `cancelled`.
`done` means the OS finished handing the job to the printer, not only that the queue took it.

**POST /v1/print** body (the original `{ printer, pdfBase64, jobName? }` still works):

```jsonc
{
  "printer": "Label_Printer",   // a `name` from GET /v1/printers
  "format": "pdf",              // or "raw": ZPL / EPL / ESC-POS sent to the printer untouched
  "data": "<base64>",           // or, for raw, "text": "^XA...^XZ"
  "jobName": "Label 1234",
  "options": {                  // all optional
    "copies": 2, "pages": "1-2", "orientation": "landscape", "paperSize": "4x6",
    "scale": "fit" | "shrink" | "none", "duplex": "one-sided" | "long-edge" | "short-edge", "color": false
  },
  "allowOffline": false         // true: queue even if the printer is offline/paused
}
```

Host must be `127.0.0.1:17865` or `localhost:17865` (DNS-rebinding guard). The port and paths
are mirrored in TrackVid-FE `src/config/constant.ts` (`PRINT_AGENT_*`).

## How it works

- **Printer status** is re-read every 10 s. The OS queue (paused? accepting? its jobs) comes from
  CUPS over its local socket (macOS/Linux) or the spooler via PowerShell (Windows). Then each
  **device is checked directly**:
  IPP/AirPrint printers get an IPP Get-Printer-Attributes (state, alerts, ink levels; Bonjour
  `dnssd://` names are resolved with `ippfind`), raw/LPD printers a TCP connect, and USB printers on
  macOS are looked up in the CUPS usb backend's device list. A Wi-Fi printer that is switched off
  shows as **Offline** within one poll, not after jobs pile up behind it.
- **Printing:** macOS `lp` (`-o fit-to-page` by default, `-o raw` for raw), Windows SumatraPDF via
  `pdf-to-printer` for PDFs and `WritePrinter` (datatype RAW) for raw. Jobs are handed over one at
  a time, in arrival order, then followed in the OS queue until they finish.
- **Offline / paused printers are refused** by default (Settings → Printing), so TrackVid shows
  the problem at once instead of the job printing hours later. `allowOffline: true` overrides it
  per job.
- **Managing the queue** from the window: Resume a paused printer, Release or Cancel held jobs
  (including other apps'), Clear the queue, Reprint recent jobs. Desktop notifications when a
  printer in use goes offline, runs out of paper, or a job fails.

## Not done yet

- Code signing / notarization (unsigned builds warn on first launch).
- Auto-update.
- The Windows status / queue / raw-printing code (PowerShell) is unit-tested but not yet run on a Windows machine.
- Real `.icns` / `.ico` icons (build/icon.png is the CMS icon).


Change usability
/Users/apple/Documents/Sagar/Other/Featured-App/shared/constants/sidebarFeatures.json
