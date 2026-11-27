#Requires -Version 5.1
<#
  Installs Nightfall for the current user:
    - a Task Scheduler task that starts nightfall.exe (no window) at log on and restarts it if it dies
    - an inbound firewall rule for TCP <Port>, limited to the local subnet
  Uses nightfall.exe next to this script. In a clone of the repository with Rust installed, it
  builds a fresh one first. Re-running is safe: the task, rule and .exe are replaced.
  Asks for elevation once (UAC) for the firewall rule.
#>
param(
  [int]$Port = 39847,
  [string]$ForUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [string]$Built = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$exe = Join-Path $here 'nightfall.exe'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()

if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # Build as you, not as admin, so the build output stays yours.
  if ((Test-Path (Join-Path $here 'Cargo.toml')) -and (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host 'Building nightfall.exe...'
    Push-Location $here
    try { cargo build --release; if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' } } finally { Pop-Location }
    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $here 'target' }
    $Built = Join-Path $target 'release\nightfall.exe'
  } elseif (-not (Test-Path $exe)) {
    throw "nightfall.exe isn't next to install.ps1. Download it from the GitHub release, or install Rust (https://rustup.rs) to build it."
  }
  $shell = (Get-Process -Id $PID).Path
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Port', $Port, '-ForUser', "`"$ForUser`"")
  if ($Built) { $argv += @('-Built', "`"$Built`"") }
  $p = Start-Process $shell -Verb RunAs -Wait -PassThru -ArgumentList $argv
  if ($p.ExitCode -ne 0) { throw "Install failed (exit $($p.ExitCode)). See the elevated window's output." }
  Write-Host 'Nightfall installed.' -ForegroundColor Green
  return
}

try {
  $taskName = 'Nightfall'
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  if ($Built) {
    # The old copy may take a moment to exit after its task stops.
    foreach ($try in 1..20) {
      try { Copy-Item -LiteralPath $Built -Destination $exe -Force; break }
      catch { if ($try -eq 20) { throw }; Start-Sleep -Milliseconds 250 }
    }
  }
  if (-not (Test-Path $exe)) { throw "nightfall.exe isn't next to install.ps1." }

  $action = New-ScheduledTaskAction -Execute $exe -Argument "--port $Port" -WorkingDirectory $here
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $ForUser
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  # Interactive + Limited: runs on your desktop session (needed to reach the monitors), no admin rights.
  $who = New-ScheduledTaskPrincipal -UserId $ForUser -LogonType Interactive -RunLevel Limited
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
  $dns = $null
  if (Get-Command tailscale -ErrorAction SilentlyContinue) { $dns = (& tailscale status --json 2>$null | ConvertFrom-Json).Self.DNSName }
  if ($dns) { Write-Host "  Tailscale:    https://$($dns.TrimEnd('.')):$Port  (if 'tailscale serve' is set up for this port)" }
  Write-Host ''
  if (-not $env:NIGHTFALL_NO_PAUSE) { Read-Host 'Press Enter to close' | Out-Null }
} catch {
  Write-Host $_ -ForegroundColor Red
  if (-not $env:NIGHTFALL_NO_PAUSE) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}
