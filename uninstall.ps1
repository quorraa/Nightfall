#Requires -Version 5.1
# Removes the Nightfall logon task (stopping nightfall.exe) and firewall rule. Leaves this folder alone.
param([int]$Port = 39847)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process (Get-Process -Id $PID).Path -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Port', $Port)
  return
}
if (Get-ScheduledTask -TaskName 'Nightfall' -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName 'Nightfall' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'Nightfall' -Confirm:$false
}
Get-NetFirewallRule -DisplayName "Nightfall (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Nightfall removed. (A "tailscale serve" route for this port, if any, is untouched.)'
Read-Host 'Press Enter to close' | Out-Null
