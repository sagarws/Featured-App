import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, net: {}, safeStorage: {} }))
vi.mock('../electron/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), path: () => null } }))

import {
  buildSshdConfig,
  classifyAddress,
  formatDuration,
  generatePassword,
  generateUsername,
  hostForMode,
  isCgnatV4,
  isPrivateV4,
  isPublicV4,
  isVpsPassword,
  isVpsPort,
  isVpsUsername,
  passwordProblem,
  passwordStrength,
  usernameProblem,
  parseScriptLine,
  psQuote,
  redact,
  shQuote,
  sshCommand,
  sshConfigJson,
  VPS_ALLOWED_SOURCES,
  VPS_PASSWORD_ALPHABET
} from '../shared/utils/vps'
import { macos } from '../electron/main/vps/platforms/macos'
import { linux } from '../electron/main/vps/platforms/linux'
import { windows } from '../electron/main/vps/platforms/windows'
import { countEstablished, parseNetstatE, parseNetstatIb, parseProcNetDev } from '../electron/main/vps/monitor'

describe('SSH connection configuration', () => {
  it('has exactly the requested shape, with live values and no password', () => {
    const json = sshConfigJson('192.168.1.100', 'vpsab12c', 2222)
    expect(JSON.parse(json)).toEqual({ Host: { HostName: '192.168.1.100', User: 'vpsab12c', Port: 2222 } })
    expect(Object.keys(JSON.parse(json) as object)).toEqual(['Host'])
    expect(Object.keys((JSON.parse(json) as { Host: object }).Host)).toEqual(['HostName', 'User', 'Port'])
    expect(typeof (JSON.parse(json) as { Host: { Port: unknown } }).Host.Port).toBe('number')
    expect(json).not.toMatch(/password/i)
    expect(json).toBe('{\n  "Host": {\n    "HostName": "192.168.1.100",\n    "User": "vpsab12c",\n    "Port": 2222\n  }\n}')
  })

  it('builds the ssh command', () => {
    expect(sshCommand('100.101.102.103', 'vpsab12c', 2223)).toBe('ssh vpsab12c@100.101.102.103 -p 2223')
  })

  it('picks the host for the access mode', () => {
    const network = { lanIp: '192.168.1.5', vpnIp: '100.64.1.2' }
    expect(hostForMode(network, 'local')).toBe('192.168.1.5')
    expect(hostForMode(network, 'vpn')).toBe('100.64.1.2')
    expect(hostForMode({ lanIp: '192.168.1.5', vpnIp: null }, 'vpn')).toBeNull()
  })
})

describe('credentials', () => {
  it('generates long passwords with every class, from the safe alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword(randomInt)
      expect(pw).toHaveLength(24)
      expect(isVpsPassword(pw)).toBe(true)
      expect(pw).toMatch(/[A-Z]/)
      expect(pw).toMatch(/[a-z]/)
      expect(pw).toMatch(/[2-9]/)
      expect(pw).toMatch(/[-_.+=@%^*!?]/)
      expect(pw).not.toMatch(/[\s'"`$\\#:;&]/)
    }
  })

  it('refuses to generate short passwords', () => {
    expect(() => generatePassword(randomInt, 12)).toThrow()
  })

  it('does not repeat passwords', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword(randomInt)))
    expect(seen.size).toBe(500)
  })

  it('alphabet has no shell-special characters', () => {
    expect(VPS_PASSWORD_ALPHABET).not.toMatch(/[\s'"`$\\#:;&|<>(){}[\]]/)
  })

  it('generates valid usernames', () => {
    for (let i = 0; i < 100; i++) expect(isVpsUsername(generateUsername(randomInt))).toBe(true)
  })

  it('accepts any username except root (and names no system allows)', () => {
    for (const ok of ['vpsuser', 'John', 'admin', 'my user', 'dev.box', 'büro', 'a', "o'brien", '-x', '*', 'x'.repeat(40)]) expect(isVpsUsername(ok)).toBe(true)
    for (const bad of ['root', 'ROOT', '', '.', '..', 'a/b', 'a\\b', 'a\nb']) expect(isVpsUsername(bad)).toBe(false)
    expect(usernameProblem('root')).toMatch(/superuser/)
    expect(usernameProblem('vpsuser')).toBeNull()
  })

  it('accepts any password except empty or with a line break', () => {
    for (const ok of ['x', 'root', 'has space', "quote'd", 'dq"uote', 'back\\slash', 'colon:1', 'tick`1', 'ünïcødé 🔑', ' lead and trail ']) expect(isVpsPassword(ok)).toBe(true)
    expect(isVpsPassword('')).toBe(false)
    expect(isVpsPassword('a\nb')).toBe(false)
    expect(passwordProblem('')).toMatch(/Enter/)
    expect(passwordStrength('password')).toBe('weak')
    expect(passwordStrength(generatePassword(randomInt))).toBe('strong')
  })

  it('validates ports', () => {
    expect(isVpsPort(2222)).toBe(true)
    expect(isVpsPort(22)).toBe(false)
    expect(isVpsPort('2222')).toBe(false)
    expect(isVpsPort(2222.5)).toBe(false)
  })

  it('redacts secrets', () => {
    expect(redact('error near Abc123!xyz789 here', ['Abc123!xyz789'])).toBe('error near [redacted] here')
    expect(redact('nothing', [null, undefined])).toBe('nothing')
  })
})

describe('addresses', () => {
  it('classifies ranges', () => {
    expect(isPrivateV4('192.168.0.4')).toBe(true)
    expect(isPrivateV4('172.20.1.1')).toBe(true)
    expect(isPrivateV4('172.32.1.1')).toBe(false)
    expect(isCgnatV4('100.100.1.1')).toBe(true)
    expect(isCgnatV4('100.128.1.1')).toBe(false)
    expect(isPublicV4('8.8.8.8')).toBe(true)
    expect(isPublicV4('10.0.0.1')).toBe(false)
    expect(isPublicV4('not an ip')).toBe(false)
  })

  it('classifies interfaces', () => {
    expect(classifyAddress('en0', '192.168.1.4', 'IPv4', false)).toBe('lan')
    expect(classifyAddress('utun4', '100.90.1.2', 'IPv4', false)).toBe('vpn')
    expect(classifyAddress('tailscale0', '100.90.1.2', 'IPv4', false)).toBe('vpn')
    expect(classifyAddress('wg0', '10.8.0.2', 'IPv4', false)).toBe('vpn')
    expect(classifyAddress('utun0', 'fe80::1', 'IPv6', false)).toBe('link-local')
    expect(classifyAddress('lo0', '127.0.0.1', 'IPv4', true)).toBe('loopback')
    expect(classifyAddress('en0', '169.254.3.3', 'IPv4', false)).toBe('link-local')
  })
})

describe('script protocol', () => {
  it('parses known lines and ignores the rest', () => {
    expect(parseScriptLine('STEP user done vpsab12c (standard)')).toEqual({ kind: 'step', id: 'user', state: 'done', detail: 'vpsab12c (standard)' })
    expect(parseScriptLine('STEP bogus done')).toBeNull()
    expect(parseScriptLine('CHANGE user-created')).toEqual({ kind: 'change', change: 'user-created' })
    expect(parseScriptLine('CHANGE delete-everything')).toBeNull()
    expect(parseScriptLine('FIREWALL declined')).toEqual({ kind: 'firewall', result: 'declined' })
    expect(parseScriptLine('FINGERPRINT SHA256:abcdefghijklmnop')).toEqual({ kind: 'fingerprint', value: 'SHA256:abcdefghijklmnop' })
    expect(parseScriptLine('ERROR it broke')).toEqual({ kind: 'error', message: 'it broke' })
    expect(parseScriptLine('OK')).toEqual({ kind: 'ok' })
    expect(parseScriptLine('random output')).toBeNull()
  })

  it('quotes for sh and PowerShell', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(psQuote("it's")).toBe("'it''s'")
  })

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe('2d 4h')
  })
})

describe('sshd_config', () => {
  const config = (platform: 'darwin' | 'linux' | 'win32', penalties = false) =>
    buildSshdConfig({ platform, port: 2222, hostKeys: ['/k/ssh_host_ed25519_key'], pidFile: '/p/sshd.pid', penalties })

  it('is password-only, no root, one account from private / VPN sources', () => {
    const c = config('linux')
    expect(c).toMatch(/^Port 2222$/m)
    expect(c).toMatch(/^PermitRootLogin no$/m)
    expect(c).toMatch(/^PasswordAuthentication yes$/m)
    expect(c).toMatch(/^PermitEmptyPasswords no$/m)
    expect(c).toMatch(/^MaxAuthTries 3$/m)
    expect(c).toMatch(/^MaxStartups 3:50:10$/m)
    expect(c).toMatch(/^UsePAM yes$/m)
    expect(c).toMatch(/^AllowGroups featuredvps$/m)
    expect(c).not.toMatch(/AllowUsers/)
    // Everything that is not a private / VPN source is refused, in a Match block at the very end.
    expect(c).toContain(`Match Address *,${VPS_ALLOWED_SOURCES.map(x => `!${x}`).join(',')}\n\tDenyUsers *\n`)
    expect(c.trimEnd().split('\n').slice(-4)[0]).toMatch(/^Match Address /)
    expect(c).not.toMatch(/PerSourcePenalties/)
    expect(config('linux', true)).toMatch(/^PerSourcePenalties /m)
    expect([...c].every(ch => ch === '\n' || ch === '\t' || (ch >= ' ' && ch <= '~'))).toBe(true)
  })

  it('omits UsePAM and uses CRLF on Windows', () => {
    const c = config('win32')
    expect(c).not.toMatch(/UsePAM/)
    expect(c).toContain('\r\n')
  })

  it('refuses invalid values', () => {
    expect(() => buildSshdConfig({ platform: 'linux', port: 22, hostKeys: [], pidFile: null, penalties: false })).toThrow()
    expect(() => buildSshdConfig({ platform: 'linux', port: 0, hostKeys: [], pidFile: null, penalties: false })).toThrow()
  })

  // Real check against this machine's OpenSSH, when there is one.
  it.skipIf(process.platform === 'win32' || !existsSync('/usr/sbin/sshd') || !existsSync('/usr/bin/ssh-keygen'))('is accepted by sshd -t', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-sshd-'))
    try {
      execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')])
      const user = process.env['USER'] ?? 'nobody'
      for (const penalties of [false, true]) {
        const text = buildSshdConfig({ platform: process.platform as 'darwin' | 'linux', port: 2222, hostKeys: [join(dir, 'key')], pidFile: join(dir, 'pid'), penalties })
        writeFileSync(join(dir, 'sshd_config'), text)
        const r = spawnSync('/usr/sbin/sshd', ['-t', '-f', join(dir, 'sshd_config')], { encoding: 'utf8' })
        // Without root sshd may complain about privilege separation; anything else is a config error.
        const errors = `${r.stderr}`.split('\n').filter(l => l.trim() && !/privilege separation|must be owned by root|not running as root|Missing privilege/i.test(l))
        if (!penalties) expect(errors, `sshd -t (${user}): ${r.stderr}`).toEqual([])
        else if (errors.length) expect(errors.join(' ')).toMatch(/PerSourcePenalties|Bad configuration option/) // older sshd: the script falls back
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('platform scripts', () => {
  const setup = { username: 'vpsab12c', port: 2222, firewall: true, reuseUser: false }
  const teardown = { username: 'vpsab12c', port: 2222, changes: ['user-created', 'firewall-rule', 'package-installed', 'mac-firewall-app', 'ssh-group-added'] as never[], removeUser: true }
  const posix = [
    ['macOS setup', macos.setupScript(setup)],
    ['macOS setup (reuse, no firewall)', macos.setupScript({ ...setup, reuseUser: true, firewall: false })],
    ['macOS teardown', macos.teardownScript(teardown)],
    ['macOS teardown (keep user)', macos.teardownScript({ ...teardown, removeUser: false })],
    ['macOS password', macos.passwordScript('vpsab12c')],
    ['Ubuntu setup', linux.setupScript(setup)],
    ['Ubuntu setup (reuse, no firewall)', linux.setupScript({ ...setup, reuseUser: true, firewall: false })],
    ['Ubuntu teardown', linux.teardownScript(teardown)],
    ['Ubuntu teardown (keep user)', linux.teardownScript({ ...teardown, removeUser: false })],
    ['Ubuntu password', linux.passwordScript('vpsab12c')]
  ] as const

  it.each(posix)('%s is valid POSIX sh', (_name, script) => {
    const r = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it.each(posix)('%s rolls back on any unexpected exit', (_name, script) => {
    expect(script).toContain('trap on_exit EXIT')
  })

  it('an unexpected exit runs the rollback and reports an error', () => {
    const work = mkdtempSync(join(tmpdir(), 'vps-trap-'))
    try {
      // The prelude needs root; replace that check, then die the way the real bug did (redirection on a special builtin).
      const script = macos
        .passwordScript('vpsab12c')
        .split('step user running')[0]!
        .replace('[ "$(id -u)" = 0 ] || fail "Not running as administrator."', '')
        .replace(/\[ -f "\$WORK\/secret" \][\s\S]*$/, '') +
        `\nundo ${shQuote(`touch ${shQuote(join(work, 'undone'))}`)}\n: > /nonexistent-dir/x\nfinish\n`
      const r = spawnSync('/bin/sh', ['-c', script, 'featured-vps', work], { encoding: 'utf8' })
      expect(r.status).not.toBe(0)
      expect(existsSync(join(work, 'undone'))).toBe(true)
      expect(readFileSync(join(work, 'progress.log'), 'utf8')).toMatch(/^ERROR /m)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it.each(posix)('%s never puts the password on a command line', (_name, script) => {
    // The password only ever comes from $PW, read from the work folder.
    expect(script).not.toMatch(/-password\s/)
    expect(script).not.toMatch(/echo "\$PW"/)
  })

  it('macOS re-enables a kept (disabled) account before setting its password', () => {
    for (const script of [macos.setupScript({ ...setup, reuseUser: true }), macos.passwordScript('vpsab12c')]) {
      const enable = script.indexOf('-enableuser')
      expect(enable).toBeGreaterThan(-1)
      expect(enable).toBeLessThan(script.indexOf("printf 'passwd %s %s"))
    }
  })

  it('macOS checks the password strictly and never escapes non-ASCII for dscl', () => {
    const script = macos.passwordScript('my user')
    // "*rror*" missed dscl's usage text: success is "nothing but Goodbye".
    expect(script).toContain("dscl_ok()")
    expect(script).not.toContain('*rror*')
    // Only ASCII punctuation / spaces are escaped (a backslash before a UTF-8 byte breaks dscl).
    expect(script).toContain("sed 's/[[:punct:][:space:]]/")
    // The username is escaped for dscl too, and quoted for the shell.
    expect(script).toContain("'/Users/my\\ user'")
  })

  it.each(['my user', "o'brien", 'büro', '*', '-x'])('scripts for username %j are valid sh', name => {
    for (const script of [macos.setupScript({ ...setup, username: name }), linux.setupScript({ ...setup, username: name }), macos.teardownScript({ ...teardown, username: name })]) {
      const r = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
    }
  })

  it('setup scripts never touch the system sshd_config or Remote Login', () => {
    for (const script of [macos.setupScript(setup), linux.setupScript(setup), windows.setupScript(setup)]) {
      expect(script).not.toMatch(/\/etc\/ssh\/sshd_config|systemsetup|-setremotelogin|ProgramData\\\\ssh\\\\sshd_config/)
    }
  })

  it('refuses invalid inputs before generating anything', () => {
    for (const adapter of [macos, linux, windows]) {
      expect(() => adapter.setupScript({ ...setup, username: 'root' })).toThrow()
      expect(() => adapter.setupScript({ ...setup, port: 22 })).toThrow()
      expect(() => adapter.teardownScript({ ...teardown, username: '../apple' })).toThrow()
      expect(() => adapter.passwordScript('a/b')).toThrow()
    }
  })

  it('Windows scripts are ASCII and keep the password in a SecureString', () => {
    const scripts = [windows.setupScript(setup), windows.teardownScript(teardown), windows.passwordScript('vpsab12c')]
    for (const s of scripts) expect([...s].every(c => c === '\t' || c === '\n' || c === '\r' || (c >= ' ' && c <= '~'))).toBe(true)
    expect(scripts[0]).toContain('ConvertTo-SecureString')
    expect(scripts[0]).toContain("Remove-Item -LiteralPath $SecretPath")
    expect(scripts[0]).toMatch(/-RemoteAddress @\('LocalSubnet'/)
  })

  it.skipIf(process.platform !== 'win32')('Windows scripts parse in PowerShell', () => {
    for (const s of [windows.setupScript(setup), windows.teardownScript(teardown), windows.passwordScript('vpsab12c')]) {
      const dir = mkdtempSync(join(tmpdir(), 'vps-ps-'))
      writeFileSync(join(dir, 's.ps1'), s)
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${join(dir, 's.ps1')}',[ref]$null,[ref]$e); $e.Count`], { encoding: 'utf8' })
      rmSync(dir, { recursive: true, force: true })
      expect(r.stdout.trim()).toBe('0')
    }
  })
})

describe('monitor parsers', () => {
  it('reads /proc/net/dev', () => {
    const text = `Inter-|   Receive |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0`
    expect(parseProcNetDev(text)).toEqual({ rx: 5000, tx: 7000 })
  })

  it('reads macOS netstat -ibn', () => {
    const text = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        100     0      9000      100     0      9000     0
en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff   500     0     50000      400     0     40000     0
en0        1500  192.168.1     192.168.1.5        500     -     50000      400     -     40000     -
utun3      1380  <Link#20>                        10     0      1000       20     0      2000     0`
    expect(parseNetstatIb(text)).toEqual({ rx: 51000, tx: 42000 })
  })

  it('reads Windows netstat -e', () => {
    expect(parseNetstatE('Interface Statistics\n\n                           Received            Sent\n\nBytes                    123456          654321\n')).toEqual({ rx: 123456, tx: 654321 })
  })

  it('counts established SSH connections', () => {
    expect(countEstablished('0 0 192.168.1.5:2222 192.168.1.9:50000\n0 0 192.168.1.5:22 192.168.1.9:50001\n', 2222, 'linux')).toBe(1)
    expect(
      countEstablished(
        'tcp4  0  0  192.168.1.5.2222  192.168.1.9.53122  ESTABLISHED\ntcp4  0  0  *.2222  *.*  LISTEN\ntcp4 0 0 192.168.1.5.22222 1.2.3.4.5 ESTABLISHED\n',
        2222,
        'darwin'
      )
    ).toBe(1)
    expect(countEstablished('  TCP    192.168.1.5:2222   192.168.1.9:50000   ESTABLISHED\n  TCP    0.0.0.0:2222   0.0.0.0:0   LISTENING\n', 2222, 'win32')).toBe(1)
  })
})
