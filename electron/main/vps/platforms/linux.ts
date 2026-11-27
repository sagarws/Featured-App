import { existsSync, readFileSync } from 'node:fs'
import { buildSshdConfig, isVpsPort, isVpsUsername, shQuote, VPS_GROUP, VPS_USER_MARKER } from '@shared/utils/vps'
import { guardScript, prelude, waitForPort, writeFile, writeSshdConfig } from './posix'
import type { PlatformAdapter, SetupParams, TeardownParams } from './types'

/*
 * Ubuntu (and other Debian-family systems with systemd): openssh-server,
 * installed with apt when missing, run as a SEPARATE systemd unit with its own
 * config and port. The distribution's ssh.service and /etc/ssh/sshd_config
 * are never changed — except that when this app had to install the package,
 * the ssh.service the package switches on (port 22, default config) is
 * switched off again, and the package is removed on Disconnect.
 *
 *   /var/lib/featured-vps/                         config, log, guard state
 *   /etc/systemd/system/featured-vps-sshd.service
 *   /etc/systemd/system/featured-vps-guard.{service,timer}
 */

const DIR = '/var/lib/featured-vps'
const SSHD = '/usr/sbin/sshd'
const UNIT = 'featured-vps-sshd.service'
const GUARD = 'featured-vps-guard'
const UNIT_DIR = '/etc/systemd/system'
const HOST_KEYS = ['/etc/ssh/ssh_host_ed25519_key', '/etc/ssh/ssh_host_ecdsa_key', '/etc/ssh/ssh_host_rsa_key']
/** The ranges UFW is opened for — the same private / VPN ranges sshd accepts (IPv4; UFW's IPv6 rules are left alone). */
const UFW_SOURCES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']

const check = (username: string, port?: number): void => {
  if (!isVpsUsername(username)) throw new Error('Invalid username.')
  if (port !== undefined && !isVpsPort(port)) throw new Error('Invalid port.')
}

const sshdUnit = `[Unit]
Description=Featured App VPS (OpenSSH server managed by Featured App)
After=network.target

[Service]
ExecStartPre=/bin/mkdir -p /run/sshd
ExecStartPre=${SSHD} -t -f ${DIR}/sshd_config
ExecStart=${SSHD} -D -f ${DIR}/sshd_config -E ${DIR}/sshd.log
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`

const guardService = `[Unit]
Description=Featured App VPS login guard

[Service]
Type=oneshot
ExecStart=/bin/sh ${DIR}/guard.sh
`

const guardTimer = `[Unit]
Description=Featured App VPS login guard (every minute)

[Timer]
OnBootSec=60
OnUnitActiveSec=60
AccuracySec=10

[Install]
WantedBy=timers.target
`

const setPassword = (u: string): string => `
printf '%s:%s\\n' ${shQuote(u)} "$PW" | chpasswd || fail "Could not set the password."
PW=
usermod -U -- ${shQuote(u)} >/dev/null 2>&1
rm -f ${DIR}/guard.lock
[ -d ${DIR} ] && : > ${DIR}/guard.fails`

const setupScript = ({ username: u, port, firewall, reuseUser }: SetupParams): string => {
  check(u, port)
  const q = shQuote(u)
  const config = (penalties: boolean) => buildSshdConfig({ platform: 'linux', port, hostKeys: HOST_KEYS, pidFile: `${DIR}/sshd.pid`, penalties })
  const marker = shQuote(VPS_USER_MARKER)
  return `${prelude(true)}
step checks running
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
. /etc/os-release 2>/dev/null
step checks done "\${PRETTY_NAME:-Linux}, $(uname -m)"

step install running
if [ ! -x ${SSHD} ]; then
  command -v apt-get >/dev/null 2>&1 || fail "openssh-server is not installed and apt-get is not available."
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -q openssh-server >/dev/null 2>&1 || { apt-get update -q >/dev/null 2>&1 && apt-get install -y -q openssh-server >/dev/null 2>&1; } || fail "Could not install openssh-server (apt-get failed - is another install running?)."
  change package-installed
  undo 'DEBIAN_FRONTEND=noninteractive apt-get remove -y -q openssh-server'
  # The package switches on ssh.service (port 22, default config, every account). It was not there before: keep it off.
  systemctl disable --now ssh.service ssh.socket >/dev/null 2>&1
  change default-service-disabled
  step install done "openssh-server installed"
else
  step install skipped "OpenSSH server already installed"
fi

step user running
if id -- ${q} >/dev/null 2>&1; then
  getent passwd ${q} | cut -d: -f5 | grep -q ${marker} || fail ${shQuote(`An account named "${u}" already exists on this computer and was not made by this app. Choose another username.`)}
  ${reuseUser ? '' : `fail ${shQuote(`An account named "${u}" already exists.`)}`}
  id -nG -- ${q} | tr ' ' '\\n' | grep -qxE 'sudo|admin|wheel|root' && fail ${shQuote(`The account "${u}" has administrator rights; it will not be used.`)}
  usermod -e '' -- ${q} >/dev/null 2>&1
  change user-reenabled
  undo ${shQuote(`usermod -L -e 1 -- ${q}`)}
else
  # --badname: accept any name the system can store (older useradd without it: retry plainly).
  ERR=$(useradd -m -s /bin/bash -c ${marker} --badname -- ${q} 2>&1 || useradd -m -s /bin/bash -c ${marker} -- ${q} 2>&1) || fail "Ubuntu did not accept this username: $(printf '%s' "$ERR" | tr '\\n' ' ' | cut -c1-160)"
  id -- ${q} >/dev/null 2>&1 || fail "Ubuntu did not accept this username."
  change user-created
  undo ${shQuote(`userdel -r -- ${q}`)}
fi
# Only members of this group may log in to the app's server.
getent group ${VPS_GROUP} >/dev/null 2>&1 || { groupadd ${VPS_GROUP} || fail "Could not create the ${VPS_GROUP} group."; change group-created; }
usermod -aG ${VPS_GROUP} -- ${q} || fail "Could not add the account to the ${VPS_GROUP} group."
undo ${shQuote(`gpasswd -d ${q} ${VPS_GROUP}`)}
${setPassword(u)}
step user done ${shQuote(`${u} (standard account)`)}

step config running
MISSING=0
for k in ${HOST_KEYS.map(shQuote).join(' ')}; do [ -f "$k" ] || MISSING=1; done
if [ "$MISSING" = 1 ]; then
  ssh-keygen -A >/dev/null 2>&1 || fail "Could not create the server's host keys."
  change host-keys-generated
fi
mkdir -p ${DIR} && chmod 755 ${DIR} || fail "Could not create ${DIR}."
undo 'rm -rf ${DIR}'
mkdir -p /run/sshd
${writeSshdConfig(SSHD, `${DIR}/sshd_config`, config(true), config(false))}
: > ${DIR}/sshd.log && chmod 644 ${DIR}/sshd.log
${writeFile(`${DIR}/guard.sh`, guardScript(DIR, `usermod -L -- ${q}`, `usermod -U -- ${q}`), '755')}
FP=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}')
[ -n "$FP" ] && say "FINGERPRINT $FP"
step config done "Port ${port}, password login, private and VPN networks only"

step firewall running
${
  firewall
    ? `if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
${UFW_SOURCES.map(
  net => `  ufw allow from ${net} to any port ${port} proto tcp comment featured-vps >/dev/null || fail "Could not add the UFW rule."
  undo ${shQuote(`ufw delete allow from ${net} to any port ${port} proto tcp`)}`
).join('\n')}
  change firewall-rule
  say "FIREWALL rule-added"
  step firewall done "UFW: port ${port} open to private and VPN networks"
else
  say "FIREWALL no-firewall"
  step firewall skipped "UFW is not active"
fi`
    : `say "FIREWALL declined"
step firewall skipped "Not allowed by you"`
}

step service running
${writeFile(`${UNIT_DIR}/${UNIT}`, sshdUnit, '644')}
${writeFile(`${UNIT_DIR}/${GUARD}.service`, guardService, '644')}
${writeFile(`${UNIT_DIR}/${GUARD}.timer`, guardTimer, '644')}
change service-installed
change guard-installed
undo ${shQuote(`systemctl disable --now ${UNIT} ${GUARD}.timer; rm -f ${UNIT_DIR}/${UNIT} ${UNIT_DIR}/${GUARD}.service ${UNIT_DIR}/${GUARD}.timer; systemctl daemon-reload`)}
systemctl daemon-reload
if ! systemctl enable --now ${UNIT} >/dev/null 2>&1; then
  WHY=$(journalctl -u ${UNIT} -n 3 --no-pager -o cat 2>/dev/null | tr '\\n' ' ' | cut -c1-200)
  fail "The SSH service did not start. $WHY"
fi
systemctl enable --now ${GUARD}.timer >/dev/null 2>&1 || fail "The login guard did not start."
step service done "systemd: ${UNIT}"

step verify running
${waitForPort(`systemctl is-active --quiet ${UNIT} && ss -Hltn "sport = :${port}" 2>/dev/null | grep -q .`, `The SSH server did not start listening on port ${port}.`)}
step verify done "Answering on port ${port}"
finish
`
}

const teardownScript = ({ username: u, port, changes, removeUser }: TeardownParams): string => {
  check(u, port)
  const q = shQuote(u)
  const did = (c: string) => changes.includes(c as never)
  return `${prelude(false)}
step service running
systemctl disable --now ${GUARD}.timer ${UNIT} >/dev/null 2>&1
rm -f ${UNIT_DIR}/${UNIT} ${UNIT_DIR}/${GUARD}.service ${UNIT_DIR}/${GUARD}.timer
systemctl daemon-reload
step service done
step firewall running
${
  did('firewall-rule')
    ? `if command -v ufw >/dev/null 2>&1; then
${UFW_SOURCES.map(net => `  ufw delete allow from ${net} to any port ${port} proto tcp >/dev/null 2>&1`).join('\n')}
fi`
    : ':'
}
step firewall done
step user running
if getent passwd ${q} | cut -d: -f5 | grep -q ${shQuote(VPS_USER_MARKER)}; then
  pkill -KILL -u ${q} >/dev/null 2>&1
  gpasswd -d ${q} ${VPS_GROUP} >/dev/null 2>&1
  ${
    removeUser
      ? `userdel -r -- ${q} >/dev/null 2>&1; id -- ${q} >/dev/null 2>&1 && fail ${shQuote(`Could not delete the account "${u}".`)}`
      : `usermod -L -e 1 -- ${q} || fail ${shQuote(`Could not disable the account "${u}".`)}`
  }
fi
step user done
step install running
${
  did('package-installed')
    ? `DEBIAN_FRONTEND=noninteractive apt-get remove -y -q openssh-server >/dev/null 2>&1 || say "STEP install done openssh-server could not be removed"`
    : ':'
}
step install done
step config running
rm -rf ${DIR}
step config done
finish
`
}

const passwordScript = (u: string): string => {
  check(u)
  return `${prelude(true)}
step user running
getent passwd ${shQuote(u)} | cut -d: -f5 | grep -q ${shQuote(VPS_USER_MARKER)} || fail ${shQuote(`The VPS account "${u}" was not found.`)}
${setPassword(u)}
step user done
finish
`
}

const osRelease = (): Record<string, string> => {
  try {
    return Object.fromEntries(
      readFileSync('/etc/os-release', 'utf8')
        .split('\n')
        .map(line => /^([A-Z_]+)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => !!m)
        .map(m => [m[1] as string, (m[2] as string).replace(/^"|"$/g, '')])
    )
  } catch {
    return {}
  }
}

export const linuxPrettyName = (): string | null => osRelease()['PRETTY_NAME'] ?? null

export const linux: PlatformAdapter = {
  id: 'linux',
  serverDir: DIR,
  support: () => Promise.resolve(linuxSupport()),
  setupScript,
  teardownScript,
  passwordScript
}

function linuxSupport(): { ok: boolean; reason: string | null } {
  const release = osRelease()
  const family = `${release['ID'] ?? ''} ${release['ID_LIKE'] ?? ''}`
  if (!/ubuntu|debian/i.test(family)) return { ok: false, reason: 'Only Ubuntu (and Debian-based systems) are supported on Linux.' }
  if (!existsSync('/bin/systemctl') && !existsSync('/usr/bin/systemctl')) return { ok: false, reason: 'systemd is required.' }
  if (!existsSync('/usr/bin/pkexec') && !existsSync('/bin/pkexec')) {
    return { ok: false, reason: 'pkexec (polkit) is needed to ask for the administrator password: sudo apt install pkexec' }
  }
  return { ok: true, reason: null }
}
