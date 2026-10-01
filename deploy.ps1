<#
.SYNOPSIS
  Ship the latest master to the live bridge on Windows, safely.

.DESCRIPTION
  The counterpart of deploy.sh: pull -> sync deps -> PREFLIGHT (prove the new
  code boots while the OLD process is still serving) -> restart. A broken
  deploy leaves the running bridge untouched instead of crash-looping under
  the Scheduled Task's restart-on-failure.

  restart.ps1 stays the dumb "just bounce the current code" path; it never
  touches deps.

.PARAMETER DryRun
  Pull, install, preflight - report readiness, NO restart.
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir
$TaskPath = '\Matron\'
$TaskName = 'matron-bridge'

function Step($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor White }
function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }
# Native commands: Windows PowerShell 5.1 turns a redirected stderr line into
# a terminating error under $ErrorActionPreference = 'Stop' (and powershell's
# own stderr is a pipe when this runs from a bridge session), so every
# native call goes through here with the preference relaxed and stderr
# merged into the output.
function Invoke-Native([string]$exe, [string[]]$arguments, [switch]$Quiet) {
  $ErrorActionPreference = 'Continue'
  if ($Quiet) {
    & $exe @arguments *> $null
  } else {
    & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Write-Host
  }
  return $LASTEXITCODE
}
function Run($file, [string[]]$arguments) {
  if ((Invoke-Native $file $arguments) -ne 0) { throw "$file $($arguments -join ' ') exited $LASTEXITCODE" }
}

# 1. Pull latest master. --ff-only: never rewrite or diverge the live tree.
Step 'git pull --ff-only origin master'
try { Run 'git' @('pull', '--ff-only', 'origin', 'master') } catch { Fail $_ }

# 2. Sync dependencies (idempotent; where native deps like sharp land).
Step 'npm install'
try { Run 'npm' @('install', '--no-audit', '--no-fund') } catch { Fail $_ }
# npm may rewrite the committed lockfile's metadata; it is the repo's, put it back.
if (Test-Path 'package-lock.json') {
  if ((Invoke-Native 'git' @('checkout', '-q', '--', 'package-lock.json') -Quiet) -ne 0) { Fail 'could not restore package-lock.json after npm install - refusing to restart on a modified lockfile' }
}

# 3. PREFLIGHT - prove the new code boots BEFORE we kill the working process.
Step 'preflight (old process still serving)'

Write-Host '  - declared deps all installed?'
# npm ls also exits non-zero for benign 'extraneous' packages; only a
# genuinely missing/unmet/invalid dep is a boot blocker. (EAP is relaxed for
# the 2>&1: under Stop, Windows PowerShell turns the first stderr line into a
# terminating error.)
$npmLs = & { $ErrorActionPreference = 'Continue'; & npm ls --omit=dev 2>&1 | ForEach-Object { "$_" } | Out-String }
if ($LASTEXITCODE -ne 0 -and ($npmLs -match '(?i)missing|invalid|unmet')) {
  ($npmLs -split "`n" | Where-Object { $_ -match '(?i)missing|invalid|unmet' }) | Write-Host
  Fail "a declared dependency is missing/invalid - 'npm install' did not resolve it"
}

Write-Host '  - syntax of every entrypoint (npm run check)?'
if ((Invoke-Native 'npm' @('run', 'check') -Quiet) -ne 0) { Fail "syntax check failed - see 'npm run check'" }

Write-Host '  - native bindings actually load, import chain resolves?'
if ((Invoke-Native 'node' @('--input-type=module', '-e', "await import('sharp'); await import('./lib/inline-image.js')")) -ne 0) { Fail 'the new code cannot import its dependencies - refusing to restart a broken build' }

Write-Host '  - the Scheduled Task we are about to restart exists?'
$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Fail "no Scheduled Task $TaskPath$TaskName - run setup\service.ps1 first (nothing would be restarted, and the old code would keep serving)" }

Write-Host '  preflight OK - the new code imports and boots'

if ($DryRun) {
  Step '-DryRun: readiness verified, bridge NOT restarted'
  exit 0
}

# 4. Restart, delayed and from a one-shot Scheduled Task: this script usually
#    runs inside a bridge session, i.e. inside the job of the task about to
#    be stopped (restart.ps1 explains).
$oldPid = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape((Join-Path $RepoDir 'index.js')) } | Select-Object -First 1).ProcessId
"$(if ($oldPid) { $oldPid } else { 'none' })" | Out-File -FilePath (Join-Path $env:TEMP 'matron-deploy-oldpid') -Encoding ascii
Step "restart $TaskPath$TaskName in 15 s  (old PID: $(if ($oldPid) { $oldPid } else { 'none' }))"
& (Join-Path $RepoDir 'restart.ps1') -DelaySeconds 15

Write-Host "Restart scheduled. Old PID was $(if ($oldPid) { $oldPid } else { 'none' }) (saved to $env:TEMP\matron-deploy-oldpid)."
Write-Host "Verify: Get-ScheduledTaskInfo -TaskPath '$TaskPath' -TaskName '$TaskName'; the bridge PID should differ and stay up."
