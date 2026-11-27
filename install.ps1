#Requires -Version 5.1
<#
  Installs Nightfall for the current user:
    - a Task Scheduler task that starts server.py (windowless) at log on, restarts it if it dies
    - an inbound firewall rule for TCP <Port>, limited to the local subnet
  Re-running is safe: both are replaced. Asks for elevation once (UAC) for the firewall rule.
#>
param(
  [int]$Port = 39847,
  [string]$ForUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()

if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $shell = (Get-Process -Id $PID).Path
  $p = Start-Process $shell -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Port', $Port, '-ForUser', "`"$ForUser`""
  )
  if ($p.ExitCode -ne 0) { throw "Install failed (exit $($p.ExitCode)). See the elevated window's output." }
  Write-Host 'Nightfall installed.' -ForegroundColor Green
  return
}

try {
  $pythonw = (Get-Command pythonw.exe -ErrorAction Stop).Source
  $taskName = 'Nightfall'

  $action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$here\server.py`"" -WorkingDirectory $here
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $ForUser
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  # Interactive + Limited: runs on your desktop session (needed to reach the monitors), no admin rights.
  $who = New-ScheduledTaskPrincipal -UserId $ForUser -LogonType Interactive -RunLevel Limited
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $who `
    -Description "Nightfall: turn the monitors off from your phone (port $Port)." -Force | Out-Null

  $rule = "Nightfall (TCP $Port)"
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null

  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 2
  $ok = $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '::')

  Write-Host ''
  Write-Host ($(if ($ok) { 'Nightfall is running.' } else { "Task registered, but nothing is listening on $Port yet. Check $here\logs\nightfall.log" }))
  Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp, Manual -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))' -and $_.InterfaceAlias -notmatch 'vEthernet|VMware|VirtualBox' } |
    ForEach-Object { Write-Host "  Home network: http://$($_.IPAddress):$Port" }
  $dns = (& tailscale status --json 2>$null | ConvertFrom-Json).Self.DNSName
  if ($dns) { Write-Host "  Tailscale:    https://$($dns.TrimEnd('.')):$Port  (if 'tailscale serve' is set up for this port)" }
  Write-Host ''
  if (-not $env:NIGHTFALL_NO_PAUSE) { Read-Host 'Press Enter to close' | Out-Null }
} catch {
  Write-Host $_ -ForegroundColor Red
  if (-not $env:NIGHTFALL_NO_PAUSE) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}
