import { buildSshdConfig, isVpsPort, isVpsUsername, psQuote, VPS_GROUP, VPS_GUARD, VPS_USER_MARKER } from '@shared/utils/vps'
import type { PlatformAdapter, SetupParams, TeardownParams } from './types'

/*
 * Windows 10/11: Microsoft's OpenSSH Server (the optional feature, installed
 * when missing), run as a SEPARATE Windows service with its own config, port
 * and host key. The built-in "sshd" service and C:\ProgramData\ssh are left
 * exactly as they are.
 *
 *   C:\ProgramData\FeaturedVPS\        config, host key, log, guard state
 *   service       FeaturedVPSsshd      (Automatic, LocalSystem)
 *   task          FeaturedVPSGuard     (every minute, SYSTEM)
 *   firewall      FeaturedVPS-SSH      (inbound TCP, private / VPN sources only)
 *
 * PowerShell 5.1, ASCII only. Native programs run through `Native` so their
 * stderr does not trip $ErrorActionPreference = 'Stop'.
 */

const SERVICE = 'FeaturedVPSsshd'
const TASK = 'FeaturedVPSGuard'
const RULE = 'FeaturedVPS-SSH'
const REMOTE_ADDRESSES = ['LocalSubnet', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fe80::/10', 'fc00::/7']

const serverDir = (): string => `${process.env['ProgramData'] ?? 'C:\\ProgramData'}\\FeaturedVPS`

const check = (username: string, port?: number): void => {
  if (!isVpsUsername(username)) throw new Error('Invalid username.')
  if (port !== undefined && !isVpsPort(port)) throw new Error('Invalid port.')
}

const prelude = (withSecret: boolean): string => `param([string]$WorkDir)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Out = Join-Path $WorkDir 'progress.log'
function Say([string]$t) { Add-Content -LiteralPath $Out -Value $t -Encoding ASCII }
function Step([string]$t) { Say ('STEP ' + $t) }
$script:Undo = New-Object System.Collections.Generic.List[scriptblock]
function Push-Undo([scriptblock]$b) { $script:Undo.Insert(0, $b) }
function Fail([string]$m) {
  Say ('ERROR ' + ($m -replace '\\s+', ' '))
  foreach ($b in $script:Undo) { try { & $b } catch { } }
  exit 1
}
function Native([string]$exe, [string[]]$a) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $o = & $exe @a 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  return @{ Code = $code; Out = $o }
}
$Dir = Join-Path $env:ProgramData 'FeaturedVPS'
$Sshd = Join-Path $env:WINDIR 'System32\\OpenSSH\\sshd.exe'
$Keygen = Join-Path $env:WINDIR 'System32\\OpenSSH\\ssh-keygen.exe'
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) { Fail 'Not running as administrator.' }
${
  withSecret
    ? `$SecretPath = Join-Path $WorkDir 'secret'
if (-not (Test-Path -LiteralPath $SecretPath)) { Fail 'The password was not handed over.' }
# Exactly as typed: no trimming (spaces are allowed), UTF-8.
$Pw = ConvertTo-SecureString -String ([IO.File]::ReadAllText($SecretPath, [Text.Encoding]::UTF8)) -AsPlainText -Force
Remove-Item -LiteralPath $SecretPath -Force`
    : ''
}
`

/** The guard, run every minute as SYSTEM by the scheduled task. */
const guardScript = (u: string): string => `$ErrorActionPreference = 'SilentlyContinue'
$Dir = Join-Path $env:ProgramData 'FeaturedVPS'
$U = ${psQuote(u)}
$Log = Join-Path $Dir 'sshd.log'
$OffFile = Join-Path $Dir 'guard.offset'
$FailFile = Join-Path $Dir 'guard.fails'
$LockFile = Join-Path $Dir 'guard.lock'
$Now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$Off = [int64]0
if (Test-Path $OffFile) { [int64]::TryParse((Get-Content $OffFile -Raw).Trim(), [ref]$Off) | Out-Null }
$Size = [int64]0
if (Test-Path $Log) { $Size = (Get-Item $Log).Length }
if ($Size -lt $Off) { $Off = 0 }
$N = 0
if ($Size -gt $Off) {
  $fs = [IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite')
  $null = $fs.Seek($Off, 'Begin')
  $sr = New-Object IO.StreamReader($fs)
  $text = $sr.ReadToEnd()
  $sr.Close()
  $N = ([regex]::Matches($text, 'Failed password|Invalid user')).Count
}
Set-Content -Path $OffFile -Value $Size -Encoding ASCII
$Fails = @()
if (Test-Path $FailFile) { $Fails = @(Get-Content $FailFile | Where-Object { $_ -match '^\\d+$' -and [int64]$_ -ge ($Now - ${VPS_GUARD.windowSeconds}) }) }
for ($i = 0; $i -lt $N; $i++) { $Fails += "$Now" }
Set-Content -Path $FailFile -Value $Fails -Encoding ASCII
if (Test-Path $LockFile) {
  $Until = [int64]0
  [int64]::TryParse((Get-Content $LockFile -Raw).Trim(), [ref]$Until) | Out-Null
  if ($Now -ge $Until) {
    Enable-LocalUser -Name $U
    Remove-Item $LockFile -Force
    Set-Content -Path $FailFile -Value @() -Encoding ASCII
  }
} elseif ($Fails.Count -ge ${VPS_GUARD.threshold}) {
  Disable-LocalUser -Name $U
  Set-Content -Path $LockFile -Value ($Now + ${VPS_GUARD.lockSeconds}) -Encoding ASCII
}
`

const setPassword = (): string => `
Set-LocalUser -Name $U -Password $Pw
Enable-LocalUser -Name $U
$Pw = $null
Remove-Item -LiteralPath (Join-Path $Dir 'guard.lock') -Force -ErrorAction SilentlyContinue
if (Test-Path $Dir) { Set-Content -Path (Join-Path $Dir 'guard.fails') -Value @() -Encoding ASCII }`

const setupScript = ({ username: u, port, firewall, reuseUser }: SetupParams): string => {
  check(u, port)
  const config = (penalties: boolean) =>
    buildSshdConfig({ platform: 'win32', port, hostKeys: ['__PROGRAMDATA__/FeaturedVPS/ssh_host_ed25519_key'], pidFile: null, penalties })
  return `${prelude(true)}
$U = ${psQuote(u)}
$Port = ${port}
try {
  Step 'checks running'
  $os = Get-CimInstance Win32_OperatingSystem
  if ([int]($os.BuildNumber) -lt 17763) { Fail 'Windows 10 version 1809 or newer is needed.' }
  Step ('checks done ' + $os.Caption + ', ' + $env:PROCESSOR_ARCHITECTURE)

  Step 'install running'
  if (-not (Test-Path -LiteralPath $Sshd)) {
    $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
    if (-not $cap) { Fail 'OpenSSH Server is not offered for this edition of Windows.' }
    $capName = $cap.Name
    Add-WindowsCapability -Online -Name $capName | Out-Null
    Say 'CHANGE package-installed'
    Push-Undo { Remove-WindowsCapability -Online -Name $capName | Out-Null }
    if (-not (Test-Path -LiteralPath $Sshd)) { Fail 'OpenSSH Server was installed but sshd.exe is missing (a restart may be needed).' }
    # The feature also registers Windows' own "sshd" service (Manual, stopped). It is left as Windows set it.
    Step 'install done OpenSSH Server installed'
  } else {
    Step 'install skipped OpenSSH Server already installed'
  }

  Step 'user running'
  $existing = Get-LocalUser -Name $U -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Description -notlike ${psQuote(`*${VPS_USER_MARKER}*`)}) { Fail ('An account named ' + $U + ' already exists and was not made by this app.') }
    ${reuseUser ? '' : `Fail ('An account named ' + $U + ' already exists.')`}
    $admins = Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.Name.Split('\\')[-1] -eq $U }
    if ($admins) { Fail ('The account ' + $U + ' is an administrator; it will not be used.') }
    Say 'CHANGE user-reenabled'
    Push-Undo { Disable-LocalUser -Name $U }
  } else {
    New-LocalUser -Name $U -Password $Pw -Description ${psQuote(VPS_USER_MARKER)} -FullName ${psQuote(VPS_USER_MARKER)} -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword | Out-Null
    Say 'CHANGE user-created'
    Push-Undo { Remove-LocalUser -Name $U }
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $U
  }
  ${setPassword()}
  # Only members of this group may log in to the app's server.
  if (-not (Get-LocalGroup -Name '${VPS_GROUP}' -ErrorAction SilentlyContinue)) {
    New-LocalGroup -Name '${VPS_GROUP}' -Description ${psQuote(VPS_USER_MARKER)} | Out-Null
    Say 'CHANGE group-created'
  }
  if (-not (Get-LocalGroupMember -Group '${VPS_GROUP}' -ErrorAction SilentlyContinue | Where-Object { $_.Name.Split('\\')[-1] -eq $U })) {
    Add-LocalGroupMember -Group '${VPS_GROUP}' -Member $U
  }
  Push-Undo { Remove-LocalGroupMember -Group '${VPS_GROUP}' -Member $U -ErrorAction SilentlyContinue }
  Step ('user done ' + $U + ' (standard account)')

  Step 'config running'
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Push-Undo { Remove-Item -Recurse -Force -LiteralPath $Dir -ErrorAction SilentlyContinue }
  # SYSTEM and Administrators full control, everyone else read-only: no one else can change what the service runs.
  $r = Native 'icacls.exe' @($Dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX')
  if ($r.Code -ne 0) { Fail 'Could not secure the server folder.' }
  $Key = Join-Path $Dir 'ssh_host_ed25519_key'
  if (-not (Test-Path -LiteralPath $Key)) {
    $r = Native $Keygen @('-q', '-t', 'ed25519', '-N', '""', '-C', 'featured-vps', '-f', $Key)
    if ($r.Code -ne 0) { Fail 'Could not create the host key.' }
  }
  $r = Native 'icacls.exe' @($Key, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F')
  if ($r.Code -ne 0) { Fail 'Could not secure the host key.' }
  $fp = Native $Keygen @('-lf', ($Key + '.pub'))
  $parts = $fp.Out.Trim() -split '\\s+'
  if ($parts.Length -ge 2) { Say ('FINGERPRINT ' + $parts[1]) }
  $Cfg = Join-Path $Dir 'sshd_config'
  [IO.File]::WriteAllText($Cfg, @'
${config(true)}'@)
  $r = Native $Sshd @('-t', '-f', $Cfg)
  if ($r.Code -ne 0) {
    [IO.File]::WriteAllText($Cfg, @'
${config(false)}'@)
    $r = Native $Sshd @('-t', '-f', $Cfg)
    if ($r.Code -ne 0) { Fail ('sshd rejected the configuration: ' + $r.Out.Substring(0, [Math]::Min(200, $r.Out.Length))) }
  }
  $Log = Join-Path $Dir 'sshd.log'
  [IO.File]::WriteAllText((Join-Path $Dir 'guard.ps1'), @'
${guardScript(u)}'@)
  Step ('config done Port ' + $Port + ', password login, private and VPN networks only')

  Step 'firewall running'
  ${
    firewall
      ? `Remove-NetFirewallRule -Name ${psQuote(RULE)} -ErrorAction SilentlyContinue
  $enabled = @(Get-NetFirewallProfile | Where-Object { $_.Enabled }).Count
  if ($enabled -eq 0) {
    Say 'FIREWALL no-firewall'
    Step 'firewall skipped Windows Firewall is off'
  } else {
    New-NetFirewallRule -Name ${psQuote(RULE)} -DisplayName 'Featured App VPS (SSH)' -Description 'Added by Featured App VPS Manager; removed on Disconnect.' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress @(${REMOTE_ADDRESSES.map(psQuote).join(', ')}) -Action Allow -Profile Any | Out-Null
    Say 'CHANGE firewall-rule'
    Push-Undo { Remove-NetFirewallRule -Name ${psQuote(RULE)} -ErrorAction SilentlyContinue }
    Say 'FIREWALL rule-added'
    Step ('firewall done Inbound TCP ' + $Port + ' from private and VPN networks')
  }`
      : `Say 'FIREWALL declined'
  Step 'firewall skipped Not allowed by you'`
  }

  Step 'service running'
  if (Get-Service -Name ${psQuote(SERVICE)} -ErrorAction SilentlyContinue) {
    Stop-Service -Name ${psQuote(SERVICE)} -Force -ErrorAction SilentlyContinue
    Native 'sc.exe' @('delete', ${psQuote(SERVICE)}) | Out-Null
    Start-Sleep -Seconds 1
  }
  $bin = '"' + $Sshd + '" -f "' + $Cfg + '" -E "' + $Log + '"'
  New-Service -Name ${psQuote(SERVICE)} -DisplayName 'Featured App VPS (OpenSSH)' -Description 'SSH server managed by Featured App VPS Manager.' -BinaryPathName $bin -StartupType Automatic | Out-Null
  Say 'CHANGE service-installed'
  Push-Undo { Stop-Service -Name ${psQuote(SERVICE)} -Force -ErrorAction SilentlyContinue; Native 'sc.exe' @('delete', ${psQuote(SERVICE)}) | Out-Null }
  Start-Service -Name ${psQuote(SERVICE)}

  Unregister-ScheduledTask -TaskName ${psQuote(TASK)} -Confirm:$false -ErrorAction SilentlyContinue
  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dir 'guard.ps1') + '"')
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName ${psQuote(TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Say 'CHANGE guard-installed'
  Push-Undo { Unregister-ScheduledTask -TaskName ${psQuote(TASK)} -Confirm:$false -ErrorAction SilentlyContinue }
  Step ('service done Windows service ' + ${psQuote(SERVICE)})

  Step 'verify running'
  $up = $false
  for ($i = 0; $i -lt 15 -and -not $up; $i++) {
    $c = New-Object Net.Sockets.TcpClient
    try { $up = $c.ConnectAsync('127.0.0.1', $Port).Wait(1000) -and $c.Connected } catch { $up = $false } finally { $c.Close() }
    if (-not $up) { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { Fail ('The SSH server did not start listening on port ' + $Port + '.') }
  Step ('verify done Answering on port ' + $Port)
  Say 'OK'
  exit 0
} catch {
  Fail $_.Exception.Message
}
`
}

const teardownScript = ({ username: u, port, changes, removeUser }: TeardownParams): string => {
  check(u, port)
  const did = (c: string) => changes.includes(c as never)
  return `${prelude(false)}
$U = ${psQuote(u)}
try {
  Step 'service running'
  Unregister-ScheduledTask -TaskName ${psQuote(TASK)} -Confirm:$false -ErrorAction SilentlyContinue
  if (Get-Service -Name ${psQuote(SERVICE)} -ErrorAction SilentlyContinue) {
    Stop-Service -Name ${psQuote(SERVICE)} -Force -ErrorAction SilentlyContinue
    $r = Native 'sc.exe' @('delete', ${psQuote(SERVICE)})
    if ($r.Code -ne 0) { Fail 'Could not remove the SSH service.' }
  }
  Step 'service done'
  Step 'firewall running'
  Remove-NetFirewallRule -Name ${psQuote(RULE)} -ErrorAction SilentlyContinue
  Step 'firewall done'
  Step 'user running'
  $existing = Get-LocalUser -Name $U -ErrorAction SilentlyContinue
  if ($existing -and $existing.Description -like ${psQuote(`*${VPS_USER_MARKER}*`)}) {
    Remove-LocalGroupMember -Group '${VPS_GROUP}' -Member $U -ErrorAction SilentlyContinue
    ${
      removeUser
        ? `$sid = $existing.SID.Value
    Remove-LocalUser -Name $U
    Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Remove-CimInstance -ErrorAction SilentlyContinue`
        : `Disable-LocalUser -Name $U`
    }
  }
  ${
    changes.includes('group-created')
      ? `$g = Get-LocalGroup -Name '${VPS_GROUP}' -ErrorAction SilentlyContinue
  if ($g -and -not (Get-LocalGroupMember -Group '${VPS_GROUP}' -ErrorAction SilentlyContinue)) { Remove-LocalGroup -Name '${VPS_GROUP}' }`
      : ''
  }
  Step 'user done'
  Step 'install running'
  ${
    did('package-installed')
      ? `$cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' -and $_.State -eq 'Installed' } | Select-Object -First 1
  if ($cap) { try { Remove-WindowsCapability -Online -Name $cap.Name | Out-Null } catch { Step 'install done OpenSSH Server could not be removed' } }`
      : ''
  }
  Step 'install done'
  Step 'config running'
  Remove-Item -Recurse -Force -LiteralPath $Dir -ErrorAction SilentlyContinue
  Step 'config done'
  Say 'OK'
  exit 0
} catch {
  Fail $_.Exception.Message
}
`
}

const passwordScript = (u: string): string => {
  check(u)
  return `${prelude(true)}
$U = ${psQuote(u)}
try {
  Step 'user running'
  $existing = Get-LocalUser -Name $U -ErrorAction SilentlyContinue
  if (-not $existing -or $existing.Description -notlike ${psQuote(`*${VPS_USER_MARKER}*`)}) { Fail ('The VPS account ' + $U + ' was not found.') }
  ${setPassword()}
  Step 'user done'
  Say 'OK'
  exit 0
} catch {
  Fail $_.Exception.Message
}
`
}

export const windows: PlatformAdapter = {
  id: 'win32',
  get serverDir() {
    return serverDir()
  },
  support: () => {
    const [major, , build] = (process.getSystemVersion?.() ?? '0.0.0').split('.').map(Number)
    const ok = (major ?? 0) >= 10 && (build ?? 0) >= 17763
    return Promise.resolve(ok ? { ok: true, reason: null } : { ok: false, reason: 'Windows 10 version 1809 or newer is needed.' })
  },
  setupScript,
  teardownScript,
  passwordScript
}
