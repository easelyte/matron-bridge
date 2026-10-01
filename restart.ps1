<#
.SYNOPSIS
  Restart (or stop) the Matron bridge on Windows.

.DESCRIPTION
  The counterpart of restart.sh. Stops the running bridge gracefully through
  its loopback POST /shutdown (the bridge kills its sessions and flushes the
  journal outbox, then exits 0 - see lib/shutdown-endpoint.js), falls back to
  a forced process-tree kill of anything still holding the API port or
  running this checkout's index.js, and starts it again: through the
  Scheduled Task when setup\service.ps1 installed one, otherwise detached
  from this console (the nohup equivalent).

  Task Scheduler keeps every descendant of a task's action in the task's job
  object, so a restart run from INSIDE a bridge session (a Claude tool call,
  deploy.ps1) would be killed by its own Stop-ScheduledTask and would keep
  the old task instance "Running". Such a run is detected and re-issued as a
  one-shot Scheduled Task (\Matron\matron-bridge-restart) a few seconds out,
  which runs in its own job - the systemd-run --on-active equivalent.

.PARAMETER DelaySeconds
  Run the restart this many seconds from now, from a one-shot Scheduled Task.

.PARAMETER StopOnly
  Stop the bridge (gracefully, then forced) and disable the task so the
  watchdog trigger does not start it again. `.\restart.ps1` re-enables it.

.PARAMETER Port
  The bridge API port (default: MATRON_BRIDGE_API_PORT from .env, else 9802).
#>
[CmdletBinding()]
param(
  [int]$DelaySeconds = 0,
  [switch]$StopOnly,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Self = $MyInvocation.MyCommand.Path
Set-Location $RepoDir
$TaskPath = '\Matron\'
$TaskName = 'matron-bridge'
$RestartTaskName = 'matron-bridge-restart'
$IndexJs = Join-Path $RepoDir 'index.js'
$StateDir = Join-Path $env:LOCALAPPDATA 'matron-bridge'
$TokenFile = Join-Path $StateDir 'shutdown.token'
$LogDir = Join-Path $StateDir 'logs'

# Native commands: Windows PowerShell 5.1 turns a redirected stderr line into
# a terminating error under $ErrorActionPreference = 'Stop', so every native
# call goes through here with the preference relaxed for the call.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  & $exe @arguments *> $null
  return $LASTEXITCODE
}

# Port from .env when not given.
if ($Port -le 0) {
  $Port = 9802
  $envFile = Join-Path $RepoDir '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^MATRON_BRIDGE_API_PORT=(\d+)' | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }
}

function Get-BridgeProcess {
  # Anything running THIS checkout's index.js (start-bridge.ps1 passes the
  # absolute path), plus whatever holds the API port.
  $found = @()
  $escaped = [regex]::Escape($IndexJs)
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped } | ForEach-Object { $found += [int]$_.ProcessId }
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $found += [int]$_.OwningProcess }
  return @($found | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

# True when this script is a descendant of the bridge (run from a session).
function Test-InsideBridge {
  $bridge = Get-BridgeProcess
  if (-not $bridge) { return $false }
  $all = @{}
  Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  $cur = $PID
  for ($i = 0; $i -lt 64 -and $all.ContainsKey($cur); $i++) {
    $parent = $all[$cur]
    if ($bridge -contains $parent) { return $true }
    if ($parent -le 0 -or $parent -eq $cur) { break }
    $cur = $parent
  }
  return $false
}

function Wait-PortFree([int]$seconds) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Register-DelayedRestart([int]$seconds) {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Self`" -Port $Port"
  if ($StopOnly) { $arguments += ' -StopOnly' }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $RepoDir
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($seconds)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $RestartTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "Restart scheduled in $seconds s as task $TaskPath$RestartTaskName (runs outside this process tree)."
}

if ($DelaySeconds -gt 0) {
  Register-DelayedRestart $DelaySeconds
  exit 0
}

# A run from inside a bridge session must not do the stop itself (see above).
if (Test-InsideBridge) {
  Write-Host 'This shell is a descendant of the bridge; handing the restart to a one-shot task.'
  Register-DelayedRestart 5
  exit 0
}

# Clean up the one-shot task (we may be it; it may be stale).
if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $RestartTaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
}

$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host 'Stopping the bridge...'
# 1. Graceful: POST /shutdown with the per-boot token.
$graceful = $false
if ((Test-Path $TokenFile) -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  $token = (Get-Content -Raw $TokenFile).Trim()
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/shutdown" `
      -Headers @{ 'X-Matron-Shutdown-Token' = $token } -TimeoutSec 5
    if ($resp.StatusCode -eq 202) {
      Write-Host '  shutdown accepted; waiting for the port to be released...'
      $graceful = Wait-PortFree 20
    } else {
      Write-Host "  /shutdown answered $($resp.StatusCode)"
    }
  } catch {
    Write-Host "  /shutdown failed: $($_.Exception.Message)"
  }
}
if (-not $graceful) {
  # 2. Forced: the task (Task Scheduler ends its job), then anything left.
  if ($task) { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
  foreach ($procId in (Get-BridgeProcess)) {
    Write-Host "  killing process tree $procId"
    Invoke-Native 'taskkill.exe' @('/PID', "$procId", '/T', '/F') | Out-Null
  }
  if (-not (Wait-PortFree 10)) {
    Write-Host "ERROR: port $Port is still in use after cleanup:"
    Get-NetTCPConnection -LocalPort $Port -State Listen | Format-Table -AutoSize | Out-String | Write-Host
    exit 1
  }
}
# A clean exit can leave orphaned session trees behind (they are what kept the
# bridge's job alive); nothing of this checkout should survive a stop.
foreach ($procId in (Get-BridgeProcess)) { Invoke-Native 'taskkill.exe' @('/PID', "$procId", '/T', '/F') | Out-Null }

if ($StopOnly) {
  if ($task) {
    Disable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null
    Write-Host "Stopped; task $TaskPath$TaskName disabled (run .\restart.ps1 to enable and start it again)."
  } else {
    Write-Host 'Stopped.'
  }
  exit 0
}

Write-Host 'Starting the bridge...'
if ($task) {
  Enable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null
  # The task is MultipleInstances=IgnoreNew: a start request while the old
  # instance is still winding down would be dropped.
  for ($i = 0; $i -lt 40; $i++) {
    if ((Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).State -ne 'Running') { break }
    Start-Sleep -Milliseconds 500
  }
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
  Start-Sleep -Seconds 3
  $state = (Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).State
  Write-Host "  task $TaskPath$TaskName state: $state"
  Write-Host "  logs: $LogDir\matron-bridge.log"
  if ($state -ne 'Running') { Write-Host 'ERROR: the task did not start.'; exit 1 }
} else {
  $start = Join-Path $RepoDir 'start-bridge.ps1'
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$start`"") | Out-Null
  Start-Sleep -Seconds 2
  $running = Get-BridgeProcess
  if ($running) {
    Write-Host "  bridge started (PID $($running -join ', ')); logs: $LogDir\matron-bridge.log"
  } else {
    Write-Host "ERROR: the bridge did not start. Check $LogDir\matron-bridge.log"
    exit 1
  }
}
