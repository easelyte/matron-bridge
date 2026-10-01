<#
.SYNOPSIS
  Matron Bridge - install on Windows.

.DESCRIPTION
  The counterpart of setup\install-linux.sh / install-macos.sh: checks the
  prerequisites, installs the npm dependencies and seeds .env (the guided
  wizard on a terminal, the .env.example template otherwise).

  Prerequisites (see README "Windows"):
    - Node.js 22+          winget install OpenJS.NodeJS.LTS
    - Git for Windows       winget install Git.Git   (Git Bash gives Claude Code its Bash tool)
    - Claude Code           irm https://claude.ai/install.ps1 | iex   (then `claude` once, to log in)
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ScriptDir
Set-Location $RepoDir

Write-Host '=== Matron Bridge - Install (Windows) ==='
Write-Host "Repo: $RepoDir"
Write-Host "User: $env:USERNAME"
Write-Host ''

function Fail($msg) { Write-Host "ERROR: $msg"; exit 1 }
# Native commands under Windows PowerShell 5.1: see deploy.ps1 (stderr lines
# become terminating errors under Stop when stderr is redirected).
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Write-Host
  return $LASTEXITCODE
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node.exe not found on PATH. Install Node.js 22+ (winget install OpenJS.NodeJS.LTS) and open a new terminal.' }
$ver = (& $node.Source --version)
if ([int]($ver.TrimStart('v').Split('.')[0]) -lt 22) { Fail "Node.js 22+ is required (found $ver)." }
Write-Host "Node: $($node.Source) ($ver)"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warning 'git not found on PATH. Install Git for Windows (winget install Git.Git): Claude Code uses Git Bash for its Bash tool, and deploy.ps1 needs git.'
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning 'claude not found on PATH. Install Claude Code (irm https://claude.ai/install.ps1 | iex), then run `claude` once to log in as this user.'
}

Write-Host 'Installing npm dependencies...'
if ((Invoke-Native 'npm' @('install')) -ne 0) { Fail 'npm install failed' }

$envFile = Join-Path $RepoDir '.env'
if (-not (Test-Path $envFile)) {
  # The wizard needs a real terminal on both ends (it masks the token).
  $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
  if ($interactive) {
    & $node.Source (Join-Path $ScriptDir 'wizard.mjs')
    if ($LASTEXITCODE -ne 0) { Fail 'the setup wizard did not complete' }
  } else {
    Write-Host 'Creating .env from .env.example (no terminal for the setup wizard)...'
    $content = Get-Content -Raw (Join-Path $RepoDir '.env.example')
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hmac = -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
    # (?=\r?$): .NET's $ ignores a CR, so a CRLF template would keep HMAC_SECRET empty.
    $content = $content -replace '(?m)^HMAC_SECRET=(?=\r?$)', "HMAC_SECRET=$hmac"
    $content = $content -replace '(?m)^DEFAULT_WORKDIR=.*$', "DEFAULT_WORKDIR=$($env:USERPROFILE -replace '\\', '/')"
    # UTF-8 without BOM (Windows PowerShell's -Encoding utf8 writes one).
    [IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding $false))
    Write-Host '  Edit .env to set JOURNAL_WS_URL, JOURNAL_TOKEN_FILE (or JOURNAL_TOKEN), ALLOWED_USER_IDS, etc.'
    Write-Host "  (or run 'npm run setup' from a terminal for the guided version)"
  }
} else {
  Write-Host ".env already exists - run 'npm run setup' to change it."
}
# chmod 600 equivalent: only this user can read .env (best effort).
& icacls.exe $envFile /inheritance:r /grant:r "$($env:USERNAME):F" *> $null

Write-Host ''
Write-Host 'Done. Next steps:'
Write-Host '  .\start-bridge.ps1            # run the bridge in this terminal (Ctrl+Break to stop)'
Write-Host '  setup\service.ps1             # or register it to start at logon (Scheduled Task)'
