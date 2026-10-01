# Windows support for matron-bridge

## Goal

Make the bridge installable and runnable on native Windows (Windows 10 1809+ /
Windows Server 2019+) with the same operator experience as Linux and macOS:
install script, guided setup, run at logon as a supervised background task,
restart and deploy scripts, and a CI job that keeps it that way.

The first deployment is a Windows VM that runs GUI software (an InDesign
render host). A Claude Code session started by the bridge there has to be able
to drive desktop applications, so the bridge must run **inside the logged-on
user's interactive desktop session**, not as a Session 0 service.

## Non-goals

- The Codex backend on Windows. Everything under `lib/codex-*`, `bin/codex-producer.mjs`
  and the codex shim stays Linux/macOS-only; `/start --codex` on Windows is refused
  with a clear message. (The producer shim relies on symlinks, `/proc` and POSIX
  process groups.)
- Voice-note transcription (whisper.cpp + ffmpeg) on Windows. `lib/transcribe.js`
  is already guarded by `WHISPER_MODEL_PATH`; the install script does not try to
  install whisper.
- The `browser` MCP extra on Windows beyond unwrapping the Xvfb launcher. Chrome
  DevTools MCP runs natively on Windows; it is not verified in this work.
- WSL. The bridge runs on native Windows with native Node and the native Claude
  Code installer. Operators who want WSL use the Linux instructions inside WSL.
- Changing Linux or macOS behaviour. Every change below is either additive
  (new files) or behind `process.platform === 'win32'`, with the POSIX branch
  byte-for-byte what it is today. The one shared refactor (PATH delimiter) is
  a no-op on POSIX.
- A Windows *service* (SCM). A service runs in Session 0 and cannot drive the
  desktop; a Scheduled Task at logon is the right primitive here (see below).

## Requirements

A Windows user with Node.js 22+, Git for Windows and the native Claude Code
installer should be able to, in PowerShell:

1. Clone the repo and run `setup\install.ps1` to install Node deps and seed `.env`
   (guided wizard on a terminal, template fallback otherwise).
2. Run `setup\service.ps1` to register two Scheduled Tasks (bridge, viewer) that
   start at logon of that user and restart on failure, and start them now.
3. Run `restart.ps1` to bounce the current code and `deploy.ps1` to pull, sync
   deps, preflight and restart — the same contract as the shell versions.
4. Start a Claude session from Matron on that box and have it work in print mode:
   tool-use streaming, live Bash output, permission gating, plan approval,
   `restart_session`, idle reaping, and `agent_session_start` from another box.

A Linux or macOS user's existing flow keeps working unchanged. CI runs the lint,
syntax check and unit tests on `windows-latest` as well as `ubuntu-latest`.

## Audit: what assumes Linux or macOS today

| Where | Assumption | Windows answer |
|---|---|---|
| `start-bridge.sh`, `restart.sh`, `deploy.sh` | bash, `/tmp/matron-bridge.log`, `lsof`, `pgrep`, `pkill`, `nohup`, `kill`, `systemctl`/`launchctl`, `uname -s` | PowerShell equivalents (`start-bridge.ps1`, `restart.ps1`, `deploy.ps1`); Scheduled Task as the supervisor; `Get-NetTCPConnection` + `Get-CimInstance Win32_Process` for port/pid lookup; `Stop-Process -Force`/`taskkill /T` as the hard kill |
| `setup/install.sh`, `setup/service.sh`, `setup/systemd.sh`, `setup/service-*.sh`, `setup/install-whisper*.sh` | bash dispatchers on `uname -s`; systemd units / launchd plists; `openssl rand`, `sed -i`, `chmod 600` | `setup\install.ps1`, `setup\service.ps1`; the bash dispatchers gain a line that tells a Windows user (MSYS/Git Bash `uname` reports `MINGW64_NT-…`) to run the `.ps1` instead |
| `setup/wizard.mjs` | prints `sudo bash setup/service.sh` as the next step; `chmodSync(0o600)` | print the platform's service command; chmod is a harmless no-op on Windows (files in the profile dir are user-private by ACL) |
| `hooks/*.sh` (compact-notify, stop-notify, matron-bash-tee) | bash + `jq` + `curl`; `/tmp/matron-cmd-<id>.log`; `bash -c` in the rewritten command | Node (`.mjs`) ports of the three live hooks, invoked in Claude Code's exec form (`command: node.exe, args: [...]`) so no shell is involved; log dir from `os.tmpdir()` on win32. `hooks/exit-plan-decision.sh` is referenced only in comments (the plan flow moved to `/plan-decision` + plan-approval items) and is not ported |
| `hooks/xvfb-wrap.sh` + `mcp-config.json` `browser` extra | Xvfb, `setpriv`, `setsid`, `mkfifo` | no Xvfb on Windows: unwrap to the real command exactly as `lib/mcp-config-mac.js` does for macOS |
| `hooks/matron-tee` | extension-less `#!/usr/bin/env node` script | invoked as `node <path>/matron-tee`; Node ignores the shebang. No change to the file |
| `lib/permission-prompt.js` `buildPrintSessionSettings` | POSIX `shellQuote` for the `permission-gate.mjs` hook command string | exec form with `args` on win32 (no quoting at all) |
| `index.js` iv-mode settings literal (~L2943) | `.sh` hook paths | same hook-entry builder as print mode |
| `index.js` `spawn('claude', …)` | resolved via PATH; no `windowsHide` | PATH resolution works (`claude.exe` from the native installer sits in `%USERPROFILE%\.local\bin`); add `windowsHide: true` so no console window flashes per session |
| `lib/spawn-env.js` `pathWithNodeBin` | splits/joins PATH on `:` | `path.delimiter` |
| `lib/live-output.js` `sweepOrphanedLogs('/tmp')`, `index.js` `/tmp/matron-cmd-${id}.log` | hardcoded `/tmp` | one `liveLogDir()` helper: `/tmp` on POSIX (unchanged), `os.tmpdir()` on win32, shared by index.js and the tee hook |
| `index.js` `readProcessTable` | `ps -axo pid=,ppid=,args=` | `Get-CimInstance Win32_Process` via `powershell.exe -NoProfile`, emitted as the same `pid ppid args` lines so `parseProcessTable` and `liveWorkChildren` are untouched; `basename` in `lib/work-hold.js` learns `\` |
| `index.js` `killSession` → `proc.kill('SIGTERM')`, `iv.kill`, idle reaper, restart | signals; POSIX children die with their process group | on Windows `ChildProcess.kill` is `TerminateProcess` on one pid and MCP servers / Bash children are orphaned. New `lib/process-kill.js`: on win32 `taskkill /PID <pid> /T /F` (tree kill), falling back to `proc.kill()` |
| `index.js` `process.on('SIGINT'/'SIGTERM')` → `gracefulShutdown` | a supervisor stops the bridge with SIGTERM; the handler kills sessions and flushes the journal outbox | Nothing on Windows can deliver SIGTERM to a hidden background process. New loopback `POST /shutdown` (win32 only, per-boot token) that runs the same `gracefulShutdown`; `SIGBREAK` is also wired for console runs. `restart.ps1` uses it, then falls back to a tree kill |
| `lib/sleep-command.js` `spawn('/bin/sh', ['-c', cmd])` | `/bin/sh` | `powershell.exe -NoProfile -NonInteractive -Command <cmd>` on win32 (`MATRON_SLEEP_COMMAND` is written per platform by the operator) |
| `lib/file-link-guard.js` `/proc/self/fd` | already branches on `platform === 'linux'`; non-Linux uses `realpath` | no change (same residual as macOS) |
| `lib/codex-liveness.js` `/proc/<pid>/stat` | already falls back off-Linux | no change (Codex is out of scope) |
| `index.js` `expandHome` | handles `~/` and `~\` | no change |
| `index.js` secret files `mode: 0o600`, `SECRETS_DIR` `0o700` | POSIX modes | no-ops on Windows; the files live under the user profile, which is user-private by default ACL. Documented, not changed |
| `lib/spawn-capacity.js` `statfsSync` | works on Windows (`fs.statfsSync('C:\\')` returns block counts) | no change |
| `lib/session-status.js` `os.loadavg` | returns `[0,0,0]` on Windows | accepted; the host-side probes that read it do not exist on Windows |
| `lib/interactive-session.js` `node-pty` | `pty.spawn('claude', …)` | node-pty 1.1.0 (what the lockfile resolves) ships `prebuilds/win32-x64` and `win32-arm64`, so `npm ci` needs no build tools; it uses ConPTY by default. See "Interactive mode" below |
| CI (`.github/workflows/ci.yml`) | `ubuntu-latest` only | add a `windows-latest` job |
| README | Linux + macOS sections | Windows sections: requirements, setup, service management, caveats |

## Architecture

### Script layout

PowerShell scripts sit beside the shell ones; nothing dispatches between them
(a PowerShell user runs `.ps1`, a bash user runs `.sh`). The bash dispatchers
only gain a friendlier error for MSYS.

```
start-bridge.ps1          # foreground run with logs (what the Scheduled Task executes)
restart.ps1               # graceful stop + start (task-aware, like restart.sh)
deploy.ps1                # pull → npm install → preflight → hand off restart
setup/
  install.ps1             # node check, npm install, wizard or template .env
  service.ps1             # register + start the two Scheduled Tasks (idempotent); -Uninstall
hooks/
  compact-notify.mjs      # Node ports of the three live hooks
  stop-notify.mjs
  matron-bash-tee.mjs
lib/
  hook-command.js         # one hook entry builder: .sh shell-form on POSIX, .mjs exec-form on win32
  live-log-dir.js         # where matron-cmd-<id>.log lives
  process-kill.js         # killTree(pid): taskkill /T on win32, signal elsewhere
  process-table.js        # readProcessTable command per platform (+ the PowerShell one-liner)
  shutdown-endpoint.js    # POST /shutdown token + handler (win32)
```

### Running at logon: Scheduled Tasks, not a service

`setup\service.ps1` registers two tasks in the `\Matron\` folder:

| Task | Action | Purpose |
|---|---|---|
| `Matron\matron-bridge` | `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <repo>\start-bridge.ps1` | the bridge |
| `Matron\matron-bridge-viewer` | same, with `-Viewer` | the file viewer (`viewer/start.js`) |

Task definition (both):

- Trigger: `New-ScheduledTaskTrigger -AtLogOn -User <current user>`.
- Principal: `-UserId <current user> -LogonType Interactive -RunLevel Limited`.
  **Interactive** is the whole point: the task runs in the user's desktop
  session, so a Claude session can launch and script GUI applications. The
  consequence is that the bridge only runs while that user is logged on; the
  VM must auto-logon (or someone logs in) after a reboot. This is stated in the
  README and the installer's output.
- Settings: `-ExecutionTimeLimit (New-TimeSpan -Seconds 0)` (no 72 h cut-off),
  `-RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)` (the
  `Restart=always` equivalent; Task Scheduler's floor is one minute),
  `-MultipleInstances IgnoreNew`, `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable`.
- Working directory: the repo. `index.js` loads `.env` itself with dotenv, so
  unlike launchd no inlining is needed and editing `.env` only needs a restart.

The script is idempotent: `Unregister-ScheduledTask` if present, `Register-ScheduledTask`, then `Start-ScheduledTask`. `-Uninstall` removes both tasks. It needs no elevation (a per-user task), and refuses to run elevated so the task is not registered for the wrong principal.

`start-bridge.ps1` is the task body and also the manual foreground runner:

1. `Set-Location` to the repo; fail loudly if `.env`, `node` (22+) or `claude` are missing from PATH (the task's environment is the user's, so `%USERPROFILE%\.local\bin` from the Claude installer and the Node installer's PATH entry are both present).
2. Rotate `%LOCALAPPDATA%\matron-bridge\logs\bridge.log` (keep 5), then run
   `node "<repo>\index.js"` with `Start-Process -NoNewWindow -Wait -RedirectStandardOutput/-RedirectStandardError -PassThru`, and exit with node's exit code so the task's restart-on-failure triggers on a crash and stays quiet on a clean exit 0. The absolute `index.js` path in the command line is what `restart.ps1` matches on.

### Stopping without signals

Windows has no way to deliver SIGTERM to a hidden background process, and
`Stop-ScheduledTask` / `Stop-Process` are `TerminateProcess`: no handler runs,
so the bridge would not kill its sessions (orphaned `claude.exe` trees keep
working and spending tokens) and would not flush the journal outbox.

The bridge gets a loopback shutdown endpoint, registered only on win32:

- At boot the bridge writes a random token to `%LOCALAPPDATA%\matron-bridge\shutdown.token`
  (the same per-boot capability pattern as the journal read proxy's header file).
- `POST http://127.0.0.1:<API_PORT>/shutdown` with header `X-Matron-Shutdown-Token: <token>`
  replies `202` and calls `gracefulShutdown('http')` — identical to the SIGTERM path:
  sessions killed (tree-killed, see next section), outbox flushed, `process.exit(0)`.
  Wrong or missing token: `403`. Not win32: route not registered (`404`).
- `process.on('SIGBREAK')` is also wired to `gracefulShutdown` so Ctrl+Break works in a console run.

`restart.ps1`:

1. If the `Matron\matron-bridge` task exists: POST `/shutdown`, wait up to 15 s for the port to be released, then `Stop-ScheduledTask` + tree-kill anything still holding the port or running `<repo>\index.js` (the forced fallback), then `Start-ScheduledTask`.
2. If no task: same stop sequence, then `Start-Process powershell -WindowStyle Hidden -File start-bridge.ps1` (the `nohup` equivalent).
3. `-DelaySeconds N` runs the whole thing after a sleep in a detached process. This is how `deploy.ps1` restarts from inside a bridge session: the script that invoked it is a descendant of the bridge being stopped, so the restart has to outlive it (the systemd equivalent is `systemd-run --on-active=20`).

`deploy.ps1` mirrors `deploy.sh` step for step: `git pull --ff-only`, `npm install --no-audit --no-fund`, restore `package-lock.json`, preflight (`npm ls --omit=dev` scan for missing/invalid/unmet, `npm run check`, the sharp + inline-image import probe, task exists), then record the old pid to `%TEMP%\matron-deploy-oldpid` and hand off to `restart.ps1 -DelaySeconds 15`. `-DryRun` stops after preflight.

### Killing sessions: process trees

`lib/process-kill.js` exports `killProcessTree(pid, signal, { platform, exec })`. On
win32 it runs `taskkill /PID <pid> /T /F` (fire-and-forget, errors logged at
debug level, then `proc.kill()` as a fallback so a missing `taskkill` still ends
the direct child). On POSIX it is `proc.kill(signal)` exactly as today.

`killSession`, the idle reaper and `/usage`'s `proc.kill('SIGKILL')` go through it.
For interactive sessions `pty.kill()` is called first (closing the ConPTY handle
ends most of the tree) and the tree kill follows on `pty.pid`.

### Hooks: Node, exec form

The three hooks the bridge actually installs (`compact-notify`, `stop-notify`,
`matron-bash-tee`) are ported to Node (`hooks/*.mjs`) with the same stdin/stdout
contract and the same fail-open behaviour (exit 0, empty or `{}` output on
anything unexpected). They need neither bash, jq nor curl (`fetch` with an
`AbortSignal.timeout`). `matron-bash-tee.mjs` imports `liveLogDir()` from lib
so the hook and the bridge agree on the directory.

`lib/hook-command.js` produces the settings entry per platform:

```js
// POSIX (unchanged today):
{ type: 'command', command: '<hooksDir>/stop-notify.sh', timeout: 10 }
// win32 — Claude Code's exec form, no shell:
{ type: 'command', command: process.execPath, args: ['<hooksDir>/stop-notify.mjs'], timeout: 10 }
```

Exec form is used on Windows because Claude Code runs shell-form hook commands
through Git Bash when present and PowerShell otherwise, with MSYS path mangling
in between; exec form takes a real `.exe` plus literal `args` and sidesteps all
of that. The `permission-gate.mjs` hook already is Node: on win32 its `--port`
and `--room` move from a POSIX-quoted command string into `args`.
`buildPrintSessionSettings` and the iv-mode literal in `index.js` both call the
builder.

The rewritten Bash command on Windows is `"<node.exe>" "<tee>" "<log>" -- bash -c '<cmd>'`
with forward-slash paths (valid in Git Bash and for Node). The Bash tool runs
it in Git Bash, so `bash` resolves there. Without Git for Windows the tool is
`PowerShell`, the `Bash` matcher never fires, and live output is simply off.

The `.sh` hooks stay for Linux and macOS. Because the `.mjs` ports are plain Node,
their tests run on every CI platform — the `.sh` tests remain POSIX-only.

### `/tmp`, `bash`, `HOME`

- `lib/live-log-dir.js`: `/tmp` on POSIX (unchanged), `os.tmpdir()` on win32. Used by
  `sweepOrphanedLogs`, the live-output register in `index.js`, and the tee hook.
- `bash` is never invoked by the bridge itself on Windows; only the tee rewrite
  mentions it, and that string is executed by Claude Code's Bash tool (Git Bash).
- `HOME`: every state file already goes through `os.homedir()`, which is
  `%USERPROFILE%` on Windows. Nothing to change. The `.env.example` default
  `DEFAULT_WORKDIR=~/` keeps working via `expandHome`.
- Bridge-owned Windows state (logs, shutdown token) goes under `%LOCALAPPDATA%\matron-bridge\`.

### Process table

`lib/process-table.js` returns the `{ file, args }` to run per platform plus the
parser (moved from `lib/work-hold.js`, re-exported). On win32:

```
powershell.exe -NoProfile -NonInteractive -Command
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"
```

which emits the same `pid ppid args` lines `ps` does. It costs a few hundred
milliseconds and runs at most once per reaper tick (five minutes), only when
some session has passed the idle timeout. `MCP_SERVER_SIGNATURES` matching
stays token-based; `basename()` strips `\` as well as `/`.

### Interactive mode (node-pty / ConPTY)

node-pty 1.1.0 ships Windows prebuilds and defaults to ConPTY, so the PTY
spawns without build tools. Two known risks, both outside the bridge:

1. ConPTY re-renders terminal output rather than passing the application's
   escape sequences through, so `lib/prompt-detector.js` may see different
   bytes for the same TUI prompt. Reports against Claude Code on Windows
   describe broken ConPTY rendering and dead input in some versions.
2. ConPTY turns Shift+Enter into Enter (LF becomes CR), which affects multi-line
   input in TUI mode.

Print mode (`--print` with stream-json) has no PTY and is the mode every
bridge feature is built on, so **Windows support is print mode**. `/iv` is
left available and documented as "best effort, verify on your box"; if the
detector misfires the user switches back with `/iv off`. Nothing in this work
hardcodes a refusal, so a future Claude Code fix needs no bridge change.

### MCP config

`buildMcpServers` applies the Xvfb unwrapper for `win32` as it does for `darwin`
(the function in `lib/mcp-config-mac.js` is renamed `unwrapXvfbServers`, with
`macifyMcpServers` kept as an alias). `./ask-user.js` and `./show-file-mcp.js`
resolve to absolute paths today; forward slashes are fine for Node on Windows.

### CI

`ci.yml` gains a `test-windows` job on `windows-latest`, Node 22: `npm ci`,
`npm run lint`, `npm run check`, `npm test`. A `vitest.config.js` that reads
`process.platform` excludes suites on win32, in three groups, each listed
with its reason:

1. POSIX-only subjects: the `.sh` hooks, `xvfb-wrap.sh`, the Codex shim and
   liveness (`/proc`, symlinks, process groups).
2. Integration suites that need ffmpeg or a journal.
3. Suites whose *fixtures* pin POSIX paths, modes, symlinks or FIFOs (the code
   they cover is platform-neutral): file-link guard, transcript dir encoding,
   viewer download/view, attachments, atomic-write modes, and the Coordinator
   block loaders. The first Windows run failed 27 of 203 files; these are
   excluded rather than ported now, and porting them is follow-up work.

The `.mjs` hook tests and every new lib test run on both platforms. A
`.gitattributes` with `eol=lf` keeps Windows checkouts from handing the
bridge CRLF markdown and hooks. The Linux job is unchanged.

### Docs

README gains:

- **Requirements → Windows**: Node.js 22+ (`winget install OpenJS.NodeJS.LTS`),
  Git for Windows (Git Bash is what gives Claude Code its Bash tool; set
  `CLAUDE_CODE_GIT_BASH_PATH` if it is not found), Claude Code via
  `irm https://claude.ai/install.ps1 | iex`, logged in as the same user that
  will run the task.
- **Setup → Windows**: `setup\install.ps1`, `npm run setup`, `setup\service.ps1`.
- **Managing the service → Windows**: status (`Get-ScheduledTask`/`Get-ScheduledTaskInfo`), restart (`.\restart.ps1`), logs (`Get-Content -Wait`), stop, uninstall.
- Caveats: runs only while the user is logged on (auto-logon for an unattended box); print mode is the supported mode; Codex and voice notes are not available on Windows.

`setup/wizard.mjs` prints the platform's service command in its "Next steps".

## Testing

Unit (both CI platforms): `lib/hook-command.js` (shape per platform),
`lib/live-log-dir.js`, `lib/process-kill.js` (injected exec: taskkill argv on
win32, signal elsewhere), `lib/process-table.js` (PowerShell output parses to
the same rows as `ps`; backslash basenames), `lib/shutdown-endpoint.js` (token
match / mismatch / not win32), the three `.mjs` hooks (run under node with
stdin JSON, assert stdout and the HTTP calls against a local stub server),
`sleep-command` spawn argv on win32, `pathWithNodeBin` with `;`.

Manual on a Windows VM (Dan, on the target box — this work does not touch it):

1. Fresh clone, `setup\install.ps1` → wizard → `.env` written, `npm ci` ok.
2. `setup\service.ps1` → both tasks registered, `Get-ScheduledTask` shows Running, bridge log shows the journal hello.
3. From Matron: `/start` on the box, a print-mode session answers; a Bash tool call streams live output; a permission card appears for a gated MCP call; `restart_session` works and the replacement continues.
4. `.\restart.ps1` → journal shows a clean shutdown, sessions are gone from Task Manager (no orphan `claude.exe`), the task is Running again.
5. `.\deploy.ps1 -DryRun` passes preflight; `.\deploy.ps1` from inside a bridge session restarts the bridge and the session resumes.
6. Log out / log in → tasks start at logon. Kill `node.exe` from Task Manager → the task restarts it within a minute.
7. `/iv` → note whether prompts are detected; record the result in the README caveat.

Linux regression: `npm test` on the dev server, `deploy.sh` on a Linux bridge — hooks and paths unchanged.

## Files touched

**New:** `start-bridge.ps1`, `restart.ps1`, `deploy.ps1`, `setup/install.ps1`,
`setup/service.ps1`, `hooks/compact-notify.mjs`, `hooks/stop-notify.mjs`,
`hooks/matron-bash-tee.mjs`, `hooks/hook-util.mjs`, `lib/hook-command.js`,
`lib/live-log-dir.js`, `lib/process-kill.js`, `lib/process-table.js`,
`lib/shutdown-endpoint.js`, `vitest.config.js`, `.gitattributes`, tests for each.

**Modified:** `index.js` (hook entries, live log dir, process table, tree kill,
shutdown route, `windowsHide`, `SIGBREAK`, Codex falls back to Claude on win32
with a notice),
`lib/permission-prompt.js` (hook entries), `lib/spawn-env.js` (delimiter),
`lib/live-output.js` (dir param already exists; caller changes),
`lib/work-hold.js` (basename), `lib/mcp-config.js` + `lib/mcp-config-mac.js`
(unwrap on win32), `lib/sleep-command.js` (win32 shell), `setup/wizard.mjs`
(next-steps hint), `setup/install.sh` / `setup/service.sh` /
`setup/install-whisper.sh` (MSYS hint), `.github/workflows/ci.yml`, `README.md`.

## Delivery

Four PRs, in order, each independently reviewable and green on both CI jobs:

1. **Spec** — this document.
2. **Runtime portability** — the `lib/` additions, the `.mjs` hooks, `index.js` wiring, `vitest.config.js`, and the Windows CI job (which is what proves the runtime changes).
3. **PowerShell scripts** — `start-bridge.ps1`, `restart.ps1`, `deploy.ps1`, `setup/install.ps1`, `setup/service.ps1`, wizard hint, bash-dispatcher hint.
4. **Install notes** — README sections.
