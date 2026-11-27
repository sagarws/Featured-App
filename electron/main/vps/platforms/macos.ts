import { existsSync } from 'node:fs'
import { buildSshdConfig, isVpsPort, isVpsUsername, shQuote, VPS_GROUP, VPS_USER_MARKER } from '@shared/utils/vps'
import { guardScript, prelude, waitForPort, writeFile, writeSshdConfig } from './posix'
import type { PlatformAdapter, SetupParams, TeardownParams } from './types'

/*
 * macOS: the built-in OpenSSH, run as a SEPARATE launchd daemon with its own
 * config and port. System Settings → Remote Login (port 22) and
 * /etc/ssh/sshd_config are never touched, so whatever the user had keeps
 * working exactly as before.
 *
 *   /Library/Application Support/FeaturedAppVPS/      config, log, guard state
 *   /Library/LaunchDaemons/com.featuredapp.vps.sshd.plist
 *   /Library/LaunchDaemons/com.featuredapp.vps.guard.plist
 */

const DIR = '/Library/Application Support/FeaturedAppVPS'
const SSHD = '/usr/sbin/sshd'
const LABEL = 'com.featuredapp.vps.sshd'
const GUARD_LABEL = 'com.featuredapp.vps.guard'
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`
const GUARD_PLIST = `/Library/LaunchDaemons/${GUARD_LABEL}.plist`
const FIREWALL = '/usr/libexec/ApplicationFirewall/socketfilterfw'
const HOST_KEYS = ['/etc/ssh/ssh_host_ed25519_key', '/etc/ssh/ssh_host_ecdsa_key', '/etc/ssh/ssh_host_rsa_key']

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const plist = (label: string, args: string[], extra: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
${extra}
</dict>
</plist>
`

const check = (username: string, port?: number): void => {
  if (!isVpsUsername(username)) throw new Error('Invalid username.')
  if (port !== undefined && !isVpsPort(port)) throw new Error('Invalid port.')
}

/**
 * dscl's interactive mode treats a backslash as "the next character is literal": escape ASCII punctuation
 * and spaces. Non-ASCII (ü, 🔑…) must NOT be escaped — dscl rejects a backslash before a UTF-8 byte.
 */
const dsclEscape = (value: string): string => value.replace(/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&')

/** The username as dscl paths / names, quoted for the shell (any characters). */
const names = (u: string) => ({
  q: shQuote(u),
  path: shQuote(`/Users/${u}`),
  /** For dscl's interactive mode (stdin), escaped. */
  dsclPath: shQuote(`/Users/${dsclEscape(u)}`),
  dsclName: shQuote(dsclEscape(u))
})

/**
 * Shell function: escape $1 for dscl's interactive mode. Runs in the shell (printf is a builtin), so the
 * password goes through a pipe, never a command line. LC_ALL=C: byte-wise, so any UTF-8 passes intact.
 */
const DSCL_ESC = `desc() { printf '%s' "$1" | LC_ALL=C sed 's/[[:punct:][:space:]]/\\\\&/g'; }
# dscl's interactive mode prints only "Goodbye" when every command worked; anything else is a failure.
dscl_ok() { ! printf '%s\\n' "$1" | grep -v '^Goodbye$' | grep -q .; }`

/** Set the password from $PW through dscl's interactive mode (stdin), so it never appears on a command line. */
const setPassword = (u: string): string => {
  const n = names(u)
  return `
${DSCL_ESC}
# A kept account was disabled on Disconnect: a disabled account can neither take a new password nor authenticate, so enable it first.
pwpolicy -u ${n.q} -enableuser >/dev/null 2>&1
printf 'passwd %s %s\\n' ${n.dsclPath} "$(desc "$PW")" | dscl . >/dev/null 2>&1
AUTH=$(printf 'authonly %s %s\\n' ${n.dsclName} "$(desc "$PW")" | dscl . 2>&1)
if ! dscl_ok "$AUTH"; then
  # Older dscl without a usable interactive mode: the brief argv exposure is the fallback.
  ERR=$(dscl . -passwd ${n.path} "$PW" 2>&1 | tr '\\n' ' ' | cut -c1-160)
  if ! dscl . -authonly ${n.q} "$PW" >/dev/null 2>&1; then
    fail "Could not set the password. $ERR"
  fi
fi
PW=
rm -f ${shQuote(`${DIR}/guard.lock`)}
if [ -d ${shQuote(DIR)} ]; then : > ${shQuote(`${DIR}/guard.fails`)}; fi`
}

/** Scramble the password with a throwaway random one (stdin only) and disable the account. */
const disableAccount = (u: string): string => {
  const n = names(u)
  return `{ JUNK=$(openssl rand -base64 33 | tr -d '/+=\\n'); printf 'passwd %s %s\\n' ${n.dsclPath} "$JUNK" | dscl . >/dev/null 2>&1; JUNK=; pwpolicy -u ${n.q} -disableuser >/dev/null 2>&1; }`
}

/**
 * Delete the account, or — when macOS refuses (it only lets programs with
 * Full Disk Access delete accounts, even as root) — disable it, scramble its
 * password and keep it with its files, reporting USERKEPT so the app reuses
 * it next time. The home folder is removed only after the record is gone:
 * sysadminctl deletes the home first and then fails, so it is not used.
 */
const deleteOrKeep = (u: string, out: string): string => {
  const n = names(u)
  return `if dscl . -delete ${n.path} >/dev/null 2>&1 && { dscacheutil -flushcache >/dev/null 2>&1; ! dscl . -read ${n.path} >/dev/null 2>&1; }; then rm -rf ${n.path}; else ${disableAccount(u)}; echo USERKEPT >> ${out}; fi`
}

/** Only members of this group may log in to the app's server. */
const joinGroup = (u: string): string => {
  const n = names(u)
  return `if ! dseditgroup -o read ${VPS_GROUP} >/dev/null 2>&1; then
  dseditgroup -o create -r ${shQuote(VPS_USER_MARKER)} ${VPS_GROUP} >/dev/null 2>&1 || fail "Could not create the ${VPS_GROUP} group."
  change group-created
fi
dseditgroup -o edit -a ${n.q} -t user ${VPS_GROUP} >/dev/null 2>&1 || fail "Could not add the account to the ${VPS_GROUP} group."
undo ${shQuote(`dseditgroup -o edit -d ${n.q} -t user ${VPS_GROUP}`)}`
}

const setupScript = ({ username: u, port, firewall, reuseUser }: SetupParams): string => {
  check(u, port)
  const n = names(u)
  const config = (penalties: boolean) => buildSshdConfig({ platform: 'darwin', port, hostKeys: HOST_KEYS, pidFile: `${DIR}/sshd.pid`, penalties })
  const marker = shQuote(VPS_USER_MARKER)
  const msg = (text: string) => shQuote(text)
  return `${prelude(true)}
step checks running
[ -x ${SSHD} ] || fail "The built-in OpenSSH server is missing from this Mac."
[ -d ${n.path} ] && ! dscl . -read ${n.path} >/dev/null 2>&1 && fail ${msg(`A folder /Users/${u} already exists without an account.`)}
step checks done "macOS $(sw_vers -productVersion), $(uname -m)"

step install skipped "OpenSSH is built into macOS"

step user running
if dscl . -read ${n.path} >/dev/null 2>&1; then
  dscl . -read ${n.path} RealName 2>/dev/null | grep -q ${marker} || fail ${msg(`An account named "${u}" already exists on this Mac and was not made by this app. Choose another username.`)}
  ${reuseUser ? '' : `fail ${msg(`An account named "${u}" already exists.`)}`}
  dseditgroup -o checkmember -m ${n.q} admin >/dev/null 2>&1 && fail ${msg(`The account "${u}" is an administrator; it will not be used.`)}
  [ -d ${n.path} ] || createhomedir -c -u ${n.q} >/dev/null 2>&1 || { mkdir -p ${n.path} && chown ${n.q}:staff ${n.path} && chmod 700 ${n.path}; }
  change user-reenabled
  undo ${shQuote(disableAccount(u))}
else
  UID_NEXT=550
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$UID_NEXT"; do UID_NEXT=$((UID_NEXT + 1)); done
  ERR=$(dscl . -create ${n.path} 2>&1) || fail "macOS did not accept this username: $(printf '%s' "$ERR" | tr '\\n' ' ' | cut -c1-160)"
  change user-created
  undo ${shQuote(deleteOrKeep(u, '"$OUT"'))}
  dscl . -create ${n.path} RealName ${marker} &&
  dscl . -create ${n.path} UserShell /bin/zsh &&
  dscl . -create ${n.path} UniqueID "$UID_NEXT" &&
  dscl . -create ${n.path} PrimaryGroupID 20 &&
  dscl . -create ${n.path} NFSHomeDirectory ${n.path} &&
  dscl . -create ${n.path} IsHidden 1 || fail "Could not set up the account."
  createhomedir -c -u ${n.q} >/dev/null 2>&1 || { mkdir -p ${n.path} && chown ${n.q}:staff ${n.path} && chmod 700 ${n.path}; } || fail "Could not create the home folder."
fi
${setPassword(u)}
${joinGroup(u)}
# Remote Login restricted to listed users: macOS's sshd checks this group, so the account must be in it.
if dseditgroup -o read com.apple.access_ssh >/dev/null 2>&1; then
  if ! dseditgroup -o checkmember -m ${n.q} com.apple.access_ssh >/dev/null 2>&1; then
    dseditgroup -o edit -a ${n.q} -t user com.apple.access_ssh || fail "Could not allow SSH for the account."
    change ssh-group-added
    undo ${shQuote(`dseditgroup -o edit -d ${n.q} -t user com.apple.access_ssh`)}
  fi
fi
step user done ${msg(`${u} (standard, hidden)`)}

step config running
MISSING=0
for k in ${HOST_KEYS.map(shQuote).join(' ')}; do [ -f "$k" ] || MISSING=1; done
if [ "$MISSING" = 1 ]; then
  ssh-keygen -A >/dev/null 2>&1 || fail "Could not create the server's host keys."
  change host-keys-generated
fi
mkdir -p ${shQuote(DIR)} && chmod 755 ${shQuote(DIR)} || fail "Could not create the server folder."
undo ${shQuote(`rm -rf ${shQuote(DIR)}`)}
${writeSshdConfig(SSHD, `${DIR}/sshd_config`, config(true), config(false))}
: > ${shQuote(`${DIR}/sshd.log`)} && chmod 644 ${shQuote(`${DIR}/sshd.log`)}
${writeFile(`${DIR}/guard.sh`, guardScript(DIR, `pwpolicy -u ${n.q} -disableuser`, `pwpolicy -u ${n.q} -enableuser`), '755')}
FP=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}')
[ -n "$FP" ] && say "FINGERPRINT $FP"
step config done "Port ${port}, password login, private and VPN networks only"

step firewall running
${
  firewall
    ? `if ${FIREWALL} --getglobalstate 2>/dev/null | grep -qi enabled; then
  if ! ${FIREWALL} --listapps 2>/dev/null | grep -q ${SSHD}; then
    ${FIREWALL} --add ${SSHD} >/dev/null 2>&1 || fail "Could not add sshd to the macOS firewall."
    change mac-firewall-app
    undo ${shQuote(`${FIREWALL} --remove ${SSHD}`)}
  fi
  ${FIREWALL} --unblockapp ${SSHD} >/dev/null 2>&1
  change firewall-rule
  say "FIREWALL rule-added"
  step firewall done "sshd allowed by the macOS firewall"
else
  say "FIREWALL no-firewall"
  step firewall skipped "The macOS firewall is off"
fi`
    : `say "FIREWALL declined"
step firewall skipped "Not allowed by you"`
}

step service running
launchctl bootout system/${LABEL} >/dev/null 2>&1
launchctl bootout system/${GUARD_LABEL} >/dev/null 2>&1
${writeFile(PLIST, plist(LABEL, [SSHD, '-D', '-f', `${DIR}/sshd_config`, '-E', `${DIR}/sshd.log`], '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>'), '644')}
chown root:wheel ${PLIST}
change service-installed
undo ${shQuote(`launchctl bootout system/${LABEL}; rm -f ${PLIST}`)}
launchctl bootstrap system ${PLIST} || fail "launchd did not start the SSH server."
${writeFile(GUARD_PLIST, plist(GUARD_LABEL, ['/bin/sh', `${DIR}/guard.sh`], '  <key>StartInterval</key><integer>60</integer>\n  <key>RunAtLoad</key><true/>'), '644')}
chown root:wheel ${GUARD_PLIST}
change guard-installed
undo ${shQuote(`launchctl bootout system/${GUARD_LABEL}; rm -f ${GUARD_PLIST}`)}
launchctl bootstrap system ${GUARD_PLIST} || fail "launchd did not start the login guard."
step service done "launchd: ${LABEL}"

step verify running
${waitForPort(`nc -z -G 1 127.0.0.1 ${port} >/dev/null 2>&1`, `The SSH server did not start listening on port ${port}.`)}
step verify done "Answering on port ${port}"
finish
`
}

const teardownScript = ({ username: u, port, changes, removeUser }: TeardownParams): string => {
  check(u, port)
  const n = names(u)
  const did = (c: string) => changes.includes(c as never)
  return `${prelude(false)}
step service running
launchctl bootout system/${GUARD_LABEL} >/dev/null 2>&1
rm -f ${GUARD_PLIST}
launchctl bootout system/${LABEL} >/dev/null 2>&1
rm -f ${PLIST}
step service done
step firewall running
${did('mac-firewall-app') ? `${FIREWALL} --remove ${SSHD} >/dev/null 2>&1` : ':'}
step firewall done
step user running
if dscl . -read ${n.path} RealName 2>/dev/null | grep -q ${shQuote(VPS_USER_MARKER)}; then
  dseditgroup -o edit -d ${n.q} -t user ${VPS_GROUP} >/dev/null 2>&1
  ${did('ssh-group-added') ? `dseditgroup -o edit -d ${n.q} -t user com.apple.access_ssh >/dev/null 2>&1` : ':'}
  ${
    removeUser
      ? `${deleteOrKeep(u, '"$OUT"')}`
      : `${disableAccount(u)}
  echo USERKEPT >> "$OUT"`
  }
fi
step user done
step config running
rm -rf ${shQuote(DIR)}
step config done
finish
`
}

const passwordScript = (u: string): string => {
  check(u)
  return `${prelude(true)}
step user running
dscl . -read ${shQuote(`/Users/${u}`)} RealName 2>/dev/null | grep -q ${shQuote(VPS_USER_MARKER)} || fail ${shQuote(`The VPS account "${u}" was not found.`)}
${setPassword(u)}
step user done
finish
`
}

export const macos: PlatformAdapter = {
  id: 'darwin',
  serverDir: DIR,
  support: () =>
    Promise.resolve(existsSync(SSHD) ? { ok: true, reason: null } : { ok: false, reason: 'The built-in OpenSSH server (/usr/sbin/sshd) is missing.' }),
  setupScript,
  teardownScript,
  passwordScript
}
