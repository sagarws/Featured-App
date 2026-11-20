# Featured App — Remote Desktop lock-screen agent (Windows). See RemoteSecureAgent.cs.
#
# Installed by the app (Remote Desktop → Security → Lock screen access), with
# administrator approval, into "%ProgramFiles%\Featured App Remote Agent" and
# started by the scheduled task "FeaturedAppRemoteAgent" as SYSTEM:
#
#   remote-secure-agent.ps1 -Mode service   session 0: keeps -Mode session running
#   remote-secure-agent.ps1 -Mode session   in the user's session: the pipe server
param([ValidateSet('service', 'session')][string]$Mode = 'session')

$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'RemoteSecureAgent.cs') -ReferencedAssemblies System.Drawing, System.Core

if ($Mode -eq 'service') {
  [FeaturedSecureAgent]::RunService($PSCommandPath)
} else {
  [FeaturedSecureAgent]::RunSession()
}
