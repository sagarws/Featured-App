# VPS Manager

Sidebar → **VPS Manager** turns this computer into an SSH server that other
computers on the same network, or on the same VPN (Tailscale, WireGuard),
can log in to with a username and password.

Switch it off for a build with `"vps": false` in
`shared/constants/sidebarFeatures.json`.

## What "Convert into VPS" does

One administrator prompt (macOS password dialog / polkit / UAC) runs one
script that:

1. installs the OpenSSH server if it is missing (Ubuntu: `openssh-server`,
   Windows: the *OpenSSH Server* optional feature; macOS has it built in),
2. creates a **standard, non-admin** account `vps` + 5 random characters,
   marked *Featured App VPS*, with a 24-character CSPRNG password,
3. writes a **separate** `sshd_config` and starts a **separate** sshd service
   on port 2222 (or the next free port up to 2232),
4. adds a firewall rule for that port, limited to private and VPN source
   addresses, if you allowed it,
5. installs the login guard (below) and checks that the server answers.

If any step fails, the script undoes the steps before it (newest first) and
exits, so the system is left as it was.

| | macOS | Ubuntu | Windows |
|---|---|---|---|
| Server | `/usr/sbin/sshd` under launchd `com.featuredapp.vps.sshd` | `/usr/sbin/sshd` under systemd `featured-vps-sshd.service` | `sshd.exe` as service `FeaturedVPSsshd` |
| Files | `/Library/Application Support/FeaturedAppVPS/` | `/var/lib/featured-vps/` | `C:\ProgramData\FeaturedVPS\` |
| Host key | system keys in `/etc/ssh` (`ssh-keygen -A` if missing) | same | own ed25519 key in the folder above |
| Firewall | application firewall: allow `/usr/sbin/sshd` | UFW rules from 10/8, 172.16/12, 192.168/16, 100.64/10 | rule `FeaturedVPS-SSH`, remote addresses LocalSubnet + private + VPN ranges |
| Guard | launchd `com.featuredapp.vps.guard` (every 60 s) | `featured-vps-guard.timer` | scheduled task `FeaturedVPSGuard` |

The system's own SSH setup is **never edited**: macOS Remote Login, Ubuntu's
`ssh.service`, `/etc/ssh/sshd_config` and Windows' `sshd` service all stay
as they were. The one exception: when the app had to install
`openssh-server` on Ubuntu, it switches off the `ssh.service` the package
turns on, because that service would otherwise open port 22 with the default
config for every account.

## Login

- **Username:** default `vpsuser`, editable, with a random button. Any name
  is accepted except `root` (the system superuser). Also refused: what no
  system allows in a login (empty, `/`, `\`, `.`, `..`, control
  characters); these also keep the home-folder path safe. Beyond that the OS
  decides, and its own error is shown. The scripts never take over an
  account that already exists and wasn't made by the app (for example your
  own login).
- **Password:** anything, with no rules. Only empty and line breaks are
  refused, because an SSH prompt can't send them. It is prefilled with a
  strong random one, with show / regenerate, a weak / fair / strong hint
  (advice only), and **Regenerate both**.
- **While running:**
  - **Regenerate password** sets a strong random one (one prompt).
  - **Change username / password** with the same name changes only the
    password (one prompt).
  - With a new name, it disconnects and converts again (two prompts).
- **How any username is safe in sshd:** the server allows members of the
  app's own group `featuredvps` (`AllowGroups`). The username never appears
  in `sshd_config`, so a name like `*` can't act as a wildcard.
- **How any password gets through:**
  - Linux: `chpasswd` (stdin).
  - Windows: read byte-exact as UTF-8, no trimming.
  - macOS: `dscl`'s interactive mode on stdin, with ASCII punctuation and
    spaces backslash-escaped. Non-ASCII must stay unescaped, because `dscl`
    rejects a backslash before a UTF-8 byte.
  - macOS success means `dscl` printed nothing but `Goodbye`.

## Security

- **No public exposure.** A final `Match Address *,!<private ranges>` block
  applies `DenyUsers *` to every address outside loopback, RFC 1918,
  link-local, 100.64.0.0/10 (Tailscale / CGNAT) and the IPv6 ULA /
  link-local ranges. Logins from any other address are refused by sshd
  itself, even if someone forwards the port on their router. The app never
  sets up port forwarding. For remote access, use a VPN.
- **Password login only**, for that one account. `PermitRootLogin no`,
  public keys off, no agent / TCP / X11 forwarding, no tunnels.
- **Rate limits:** `MaxAuthTries 3`, `MaxStartups 3:50:10`,
  `LoginGraceTime 30`, and `PerSourcePenalties` on OpenSSH 9.8 and newer (the
  script drops that line if this sshd rejects it).
- **Temporary lockout:** the guard counts `Failed password` / `Invalid user`
  lines in the server's own log. After 10 in 10 minutes it disables the
  account for 15 minutes. Regenerating the password unlocks it straight away.
  Because sshd logs attempts from refused (public) addresses too, a flood
  from outside can trigger the lockout. It cannot get anyone in.
- **Host-key verification is kept.** The dashboard shows the server's
  SHA256 fingerprint, so the first `ssh` connection can be checked against it.
- **The password:**
  - It never goes on a command line. The script reads it from a 0600 file
    in a private temp folder, deletes the file at once, and passes it on
    through stdin (`chpasswd`, interactive `dscl`) or a PowerShell
    SecureString.
  - On old macOS builds where interactive `dscl` cannot set it, the script
    falls back to `dscl -passwd`, which shows it on the command line for
    about a second.
  - The app keeps it on disk only when the OS can encrypt it (safeStorage).
    Otherwise it stays in memory only, and after a restart you regenerate it.
  - It is never logged (script output is also redacted), never in
    localStorage, and never in the SSH JSON.
  - The window gets it only on Show or Copy, and hides it again after 30 s.
- **No arbitrary execution.** The window can call only the fixed operations
  in `VPS_IPC`, from the main window, and every argument is validated. The
  scripts are built in the main process from validated values (`vps` +
  `[a-z0-9]{5}`, port 2222–2232). On macOS and Linux the script text is
  passed straight to the root shell (`sh -c`), so nothing on disk can be
  swapped between the prompt and the run.

## Internet (relay) access

The third access mode. It reaches this computer from any network, with plain
`ssh` and nothing to install, through the same relay VPS Remote Desktop
uses (`REMOTE_SERVER.relay`, which must be a plain-TCP relay on a public
VPS running relay 2.0.0+).

```
this computer ──outbound──▶ relay 89.116.32.17 ◀── ssh user@89.116.32.17 -p 22xxx
```

- **Tunnel core:** `electron/main/vps/tunnelCore.ts`. It registers with an
  Ed25519 key (kept encrypted, `vps-tunnel-key.json`) and gets a stable
  public port. Per visitor, it opens a data connection and pipes it to
  `127.0.0.1:<ssh port>`. It runs inside the app (tray), only while the
  server runs in this mode.
- **SSH is end to end.** The host key seen through the relay is the server's
  own; this was verified live.
- **Abuse control:**
  - The relay limits and auto-bans per visitor address.
  - Every visitor reaches sshd from 127.0.0.1, so the app maps the local
    source port in sshd's log back to the visitor and asks the relay to ban
    an address after 3 wrong passwords (1 h).
  - sshd exempts loopback from `PerSourcePenalties`, so one attacker
    cannot lock out every relay user.
  - The 10-failure account lockout still applies.
  - The app warns when the password is weak in this mode.

## Disconnect

Disconnect asks for confirmation, then runs one elevated script that:

- stops and removes the server and guard services,
- removes the firewall rule or app entry only if the app added it,
- deletes the account and its home folder (the default), or disables and
  keeps it so its files stay. The next Convert reuses a kept account with a
  new password,
- removes the server folder, and removes `openssh-server` or the Windows
  OpenSSH Server feature only if the app installed it.

**macOS 27 and account deletion.** macOS lets only programs with Full Disk
Access delete local accounts. A root shell or launchd daemon gets
`eDSPermissionError -14120` from both `dscl -delete` and `sysadminctl
-deleteUser`. `sysadminctl` also removes the home folder *before* it fails,
so it is not used. When deletion is refused, the script:

- scrambles the account's password with a random one (through stdin) and
  disables it,
- keeps it hidden, with its files,
- reports `USERKEPT`. The app records the account as kept, says so, and the
  next Convert reuses it with a fresh password.

To really delete it, give Featured App Full Disk Access first. Without it,
delete the account in System Settings → Users & Groups after un-hiding it
(`sudo dscl . -create /Users/<name> IsHidden 0`).

Accounts, SSH services and firewall rules that the app did not create are
never touched. Every account action first checks for the *Featured App VPS*
marker. VPNs are not managed by the app and stay connected.

## Manifest, restart and recovery

`<userData>/vps/manifest.json` records the account, port, access mode, what
the setup changed (`VpsChange`), the firewall result and the host-key
fingerprint. It holds no secrets.

- It is written **before** the administrator prompt.
- **App restart:** the server is a system service and keeps running. On the
  next start the app reads the manifest and checks the port (SSH banner on
  127.0.0.1) to show *Connected* or *Not answering*.
- **Interrupted setup** (crash, power cut) shows **Clean up**, which runs the
  disconnect script with everything recorded so far.

## Monitoring

Nothing runs in the background. While the page is open and the VPS is
running, the window asks for metrics every 5 s (and only while the window
is visible):

- CPU, RAM, disk, network rate and uptime come from OS counters.
- Active connections come from one fixed `ss` / `netstat` call.
- Whether the service is running comes from a banner check.

**Check public IP** is the only call to an outside service
(`api.ipify.org`), and it runs only when you press it.

## Code

```
shared/types/vps.ts              types (status, manifest, metrics…)
shared/utils/vps.ts              JSON/command, password + username generation, sshd_config, address rules, script protocol
electron/main/vps/
  ipc.ts                         VPS_IPC handlers (main window only, validated)
  manager.ts                     convert / disconnect / recover / password, status
  elevate.ts                     the one elevated run per action, progress follow
  config.ts                      manifest + platform adapter choice
  credentials.ts                 password storage (encrypted or memory only)
  network.ts                     interfaces, LAN/VPN/IPv6, public IP, port pick, banner check
  monitor.ts                     metrics
  platforms/{macos,linux,windows}.ts  the scripts; posix.ts shared sh pieces (rollback, guard)
electron/renderer/vps/           VpsManagerPage + cards
tests/vps.test.ts
```

## Testing status

Automated (`npm test`, `tests/vps.test.ts`):

- JSON shape and serialisation, the ssh command
- password strength and alphabet, username and port validation
- address classification, script-line protocol, redaction, monitor parsers
- every generated macOS and Ubuntu script passes `sh -n`
- scripts refuse bad inputs, and never touch the system sshd_config
- the generated `sshd_config` is accepted by the local `sshd -t` (verified
  on macOS with OpenSSH 10.3)
- on Windows, a PowerShell parse check of the three scripts (it only runs on
  Windows)

**Live-tested on macOS 27.0.1 (Apple M3 Pro, OpenSSH 10.3), 2026-11-27.** The
generated setup, password and teardown scripts were run as the app runs
them (osascript → `sh -c`, password in a 0600 file).

- Setup reusing a kept account, firewall off: every step passed, `OK`. The
  password file was deleted by the script.
- SSH banner and host key match the fingerprint the dashboard shows.
- Password login works over `127.0.0.1` and over the LAN IP. The account is
  a standard one (no admin, `sudo` refused).
- Wrong password: denied. Another local account: refused (`not listed in
  AllowUsers`).
- The active-connection count saw an open session. The guard ran every 60 s
  (exit 0) and counted the failures.
- Regenerate password: the old one is denied, the new one works.
- Teardown: port closed, launchd jobs and plists removed, server folder
  removed, account taken out of `com.apple.access_ssh`. Deleting the account
  was refused (above), so it was disabled and kept (`USERKEPT`), and its last
  password no longer authenticates.

Not yet live-tested on macOS:

- the first-time account creation path (it would leave another account
  macOS won't let us delete)
- the macOS firewall-on path
- lockout after 10 failures (`PerSourcePenalties` throttles attempts to one
  per 30 s per address, so it takes a while)
- clicking through the app UI end to end

Also live-tested (same Mac):

- creating a new account (`vpsuser`)
- a typed password full of symbols (`#$&()[]{}<>,;~/|`)
- changing to a short typed password: old denied, new works
- Disconnect: account kept and disabled

Not live-tested: renaming via Change username / password. It is Disconnect
plus Convert, both tested on their own.

**Ubuntu and Windows: not yet tested on real machines.** Nothing has been installed by the
Convert / Disconnect scripts end to end. Before claiming support for a
platform, run this checklist on it:

| Case | macOS | Ubuntu | Windows |
|---|---|---|---|
| Convert, then `ssh user@lan-ip -p 2222` from another LAN machine | ☐ | ☐ | ☐ |
| Connect over Tailscale (VPN mode JSON / command) | ☐ | ☐ | ☐ |
| Wrong password ×10 → locked; regenerate → unlocked | ☐ | ☐ | ☐ |
| Login from a public address is refused | ☐ | ☐ | ☐ |
| Cancel the administrator prompt → nothing changed | ☐ | ☐ | ☐ |
| Untick the firewall option → "declined" shown, no rule added | ☐ | ☐ | ☐ |
| Stop the service by hand → dashboard shows "Not answering" | ☐ | ☐ | ☐ |
| Quit and reopen the app while running → still Connected, password per OS storage | ☐ | ☐ | ☐ |
| Force a failure mid-setup (e.g. port taken after the check) → rolled back | ☐ | ☐ | ☐ |
| Kill the app during setup → **Clean up** offered and works | ☐ | ☐ | ☐ |
| Disconnect (delete account) → services, rules, account, folder gone | ☐ | ☐ | ☐ |
| Disconnect (keep account) → disabled; Convert reuses it | ☐ | ☐ | ☐ |
| Pre-existing SSH (Remote Login / ssh.service / sshd) still works afterwards | ☐ | ☐ | ☐ |
| Copy SSH Configuration / Command → clipboard holds the live values | ☐ | ☐ | ☐ |
