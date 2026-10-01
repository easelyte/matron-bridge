<#
.SYNOPSIS
  Run the Matron bridge (or the file viewer) in the foreground with logs.

.DESCRIPTION
  The Windows counterpart of start-bridge.sh and the body of the Scheduled
  Tasks that setup\service.ps1 registers. It checks the prerequisites, rotates
  the log and runs node on the absolute index.js path (restart.ps1 finds the
  process by that command line) through cmd.exe, which appends stdout and
  stderr to one log under %LOCALAPPDATA%\matron-bridge\logs\ (opened shared,
  so `Get-Content -Wait` can follow it). It exits with node's exit code so
  the task's restart-on-failure fires on a crash and stays quiet on a clean
  exit, after ending any session trees the bridge left behind (they would
  otherwise keep the task instance alive).

  index.js loads .env itself (dotenv), so no environment inlining is needed:
  edit .env, then .\restart.ps1.

.PARAMETER Viewer
  Run viewer\start.js instead of index.js.
#>
[CmdletBinding()]
param(
  [switch]$Viewer
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir

$Name = if ($Viewer) { 'matron-bridge-viewer' } else { 'matron-bridge' }
$Entry = if ($Viewer) { Join-Path $RepoDir 'viewer\start.js' } else { Join-Path $RepoDir 'index.js' }

$StateDir = Join-Path $env:LOCALAPPDATA 'matron-bridge'
$LogDir = Join-Path $StateDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Fail($msg) { Write-Host "ERROR: $msg"; exit 1 }

if (-not (Test-Path (Join-Path $RepoDir '.env'))) { Fail "No .env in $RepoDir. Run setup\install.ps1 (or npm run setup) first." }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node.exe not found on PATH. Install Node.js 22+ (winget install OpenJS.NodeJS.LTS) and open a new terminal.' }
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Fail "Node.js 22+ is required (found $(& $node.Source --version))." }
if (-not $Viewer -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning 'claude not found on PATH: sessions will fail to spawn until Claude Code is installed (irm https://claude.ai/install.ps1 | iex).'
}

# Rotate: keep the last 5 runs.
$Log = Join-Path $LogDir "$Name.log"
for ($i = 4; $i -ge 1; $i--) {
  if (Test-Path "$Log.$i") { Move-Item -Force "$Log.$i" "$Log.$($i + 1)" }
}
if (Test-Path $Log) { Move-Item -Force $Log "$Log.1" }
"[start-bridge] $(Get-Date -Format o) starting $Name ($Entry) with $($node.Source)" | Out-File -FilePath $Log -Encoding utf8

# ELECTRON_RUN_AS_NODE unset, as the systemd unit does.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# cmd /s /c strips the outer quotes and runs the rest; its exit code is node's.
$cmdLine = "/d /s /c `"`"$($node.Source)`" `"$Entry`" >> `"$Log`" 2>&1`""
$proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdLine -WorkingDirectory $RepoDir -NoNewWindow -PassThru
$null = $proc.Handle   # cache the handle so ExitCode is readable after exit
# node is cmd's child; remember its pid so leftovers can be found after exit.
$nodePid = 0
for ($i = 0; $i -lt 20 -and $nodePid -eq 0; $i++) {
  Start-Sleep -Milliseconds 250
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($proc.Id)" | Select-Object -First 1
  if ($child) { $nodePid = [int]$child.ProcessId }
}
$proc.WaitForExit()
$code = $proc.ExitCode

# Session trees the bridge did not get to kill (a crash) stay in this task's
# job and would keep the instance "Running", so restart-on-failure never
# fires. End them here.
if ($nodePid -gt 0) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $nodePid" | ForEach-Object {
    $ErrorActionPreference = 'Continue'
    & taskkill.exe /PID $_.ProcessId /T /F *> $null
  }
}
"[start-bridge] $(Get-Date -Format o) $Name exited with code $code" | Out-File -FilePath $Log -Append -Encoding utf8
exit $code
