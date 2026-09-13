# Using the Codex backend

matron-bridge runs Codex through a persistent stdio app-server connection per conversation. It queries account/model metadata and reads optional local rollout telemetry for resumed-thread context. It does not embed or scrape the interactive Codex terminal UI. The legacy exec adapter remains available as an explicit rollback.

Useful upstream references:

- [App server: model discovery and account limits](https://learn.chatgpt.com/docs/app-server)

- [Codex CLI](https://developers.openai.com/codex/cli/)
- [Authentication](https://developers.openai.com/codex/auth/)
- [Non-interactive mode](https://developers.openai.com/codex/non-interactive-mode/)

## How the backend works

The bridge initializes `codex app-server --listen stdio://`, starts or resumes a native thread, and sends turns over correlated JSON RPC. Prompts are not placed in command arguments. Ordinary turns reuse the connection; changing model, effort, or Plan/Build settings reconnects and resumes the same thread so MCP and permission changes take effect reliably.

Assistant text streams as it arrives, then becomes a durable message on item completion. Command output has a live log and a bounded, redacted final attachment. The conversation remains busy until Codex reports the turn completed. Lost acknowledgements never trigger automatic replay of a turn.

The bridge:

- runs Codex in the conversation's working directory;
- reads JSONL events for agent messages, tool activity, errors, and token usage;
- publishes the completed response and activity updates to the same Matron conversation;
- queues messages that arrive while the current turn is running;
- persists the Codex thread ID so the session can resume after a bridge restart;
- presents native approvals and questions as Matron cards; and
- injects the bridge's room-scoped MCP tools alongside local Codex MCP configuration.

The installed Codex CLI remains responsible for model access, authentication, user/project configuration, `AGENTS.md`, skills, rules, MCP servers, and tool execution.

Both blocking questions and `request_user_input_async` appear as Matron question cards with selectable options and free-text replies. Async questions stay available after normal turn completion until answered or expired; Codex can continue working meanwhile. Replies include the question text and use native steering during a turn or start a new turn afterward. Blocking permission requests take priority, and interruption, reconnection, or shutdown clears outstanding cards.

### Optional live view for Codex launched by a Claude session

This wrapper-based view is separate from the native app-server backend above.

The Codex live view is opt-in. Set `MATRON_CODEX_VIZ=1` in the bridge environment
to activate it. When it is unset (the default), the bridge provisions no sink
directory and starts no watcher, so existing sessions behave exactly as before.

The live view needs an event **producer** on the session's PATH. With
`MATRON_CODEX_VIZ=1` the bridge deploys one automatically: it prepends its
shipped `bin/shim` directory to each launched session's `PATH`, so the session's
`codex` resolves to the redaction-aware producer shim (which forwards to the real
`codex` found later on PATH). No manual PATH step is required. A son-of-anton–style
integration that sets `MATRON_CODEX_REAL_BIN` to a redaction-aware wrapper is also
recognized as a producer; the activation guard evaluates the session's environment
(not the bridge's), and if neither a shim on PATH nor a resolvable
`MATRON_CODEX_REAL_BIN` is present it logs one warning and leaves the live view
disabled rather than rendering a silent empty view.

Sink directories accumulate under `~/.claude/matron/codex-sinks/<sessionId>/`
(outside Claude Code's own pruned project tree). The bridge sweeps stale session
sink dirs at boot — staleness is measured from a session's newest run activity
(its `codex-runs/` writes), not from when the session dir was created, so a
long-lived but still-active session is not pruned. Override the retention window
with `MATRON_CODEX_SINK_RETENTION_MS` (default 7 days).

Before Codex events are durably published, the bridge redacts assignment values
whose keys look secret (for example, `DATABASE_PASSWORD=...` or
`"API_TOKEN": "..."`) and drops recognizable raw environment dumps as an
additional safeguard. This built-in secret-key baseline always applies. An
optional value-pattern policy adds format-based rules on top (for example, known
token shapes); point `MATRON_REDACTOR_CONFIG` at a YAML policy file to enable it.
Pattern-based redaction cannot decide that an arbitrary value is secret: a secret
under a non-secret-looking key whose value matches no configured pattern may pass
and must not be printed into agent output.

### Accepted single-principal residual

The live-view sidecar directory is writable by the Codex wrapper and therefore
by a shell-capable descendant. Such a descendant can forge a matching metadata
file and JSONL transcript that the journal presents as a Codex run. Shape and
PID-liveness validation, together with separate 64-child limits for live and
historical restart reconciliation, bound malformed data and volume but do not
establish provenance. Runs beyond either budget are omitted after one durable
notice on the parent conversation.

This is accepted only for a single-principal deployment, where the operator's own
trusted sessions share the OS principal: forgery within the operator's own journal
is not a new cross-principal capability. Out-of-band, bridge-stamped run
registration through a mediator that descendants cannot forge is a hard
prerequisite before any multi-principal or shared-toolset deployment. The current
bridge does not claim that provenance.

### Known outcome-delivery edge

The common disconnected-journal case is repaired by reconnect outcome re-emit
and terminal-field coalescing. A narrower edge remains if a parent session is
replaced during the outage after its terminal frame has been evicted from the
bounded publisher queue: the old tracker is no longer attached to a session,
so its child outcome cannot be re-emitted and the journal may continue to show
that child as running. Closing this fully would require a session-independent
terminal ledger that re-emits outcomes until the publisher receives an
authoritative acknowledgement.

## Install and authenticate

Install Codex globally, then authenticate it as the same OS user that launches matron-bridge:

```bash
npm install -g @openai/codex
codex --version
codex login
codex login status
```

In a Matron Codex conversation, send `/login` to sign in directly from chat. Matron also starts this flow when a model turn fails because credentials are missing or expired. Open the displayed link and enter the one-time code **on the OpenAI page**; nothing needs to be pasted back into Matron. Device-code login may need enabling in ChatGPT security settings or workspace permissions. Matron confirms completion automatically. Send the failed message again afterward; already-queued messages resume after successful login. `/login cancel` cancels the attempt, and `/login` replaces it with a fresh code if it expires. A bridge restart interrupts pending sign-in, so request a new code afterward.

`codex login` uses the browser-based ChatGPT flow by default. On a headless machine, use device authentication:

```bash
codex login --device-auth
```

API-key login is also supported:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Verify non-interactive execution before starting the bridge:

```bash
cd /path/to/a/workspace
codex exec --json "Reply with exactly: Codex is ready"
```

If the bridge runs under systemd, launchd, or another service manager, perform these checks as that service's OS user. A login cached under a different home directory will not be visible to the service. Treat `~/.codex/auth.json` as a password: never commit it, paste it into an issue, or send it through Matron.

## Bridge configuration

The Codex-specific `.env` settings are:

| Variable | Purpose | Default |
|---|---|---|
| `MATRON_DEFAULT_AGENT` | Provider used when a command has neither an explicit provider flag nor a persisted provider choice | `claude` |
| `CODEX_SANDBOX_MODE` | Sandbox outside Plan mode: `read-only`, `workspace-write`, or `danger-full-access` (YOLO, no approvals) | `danger-full-access` |
| `MATRON_CODEX_TRANSPORT` | `app-server`, or `exec` for legacy rollback without native interactive features | `app-server` |
| `CODEX_NETWORK_ACCESS` | Command network access in workspace-write mode: `true` or `false`; empty inherits Codex configuration | unset |
| `BRIDGE_CODEX_MD_PATH` | Developer-instructions file supplied to bridge-spawned Codex turns | repository `BRIDGE_CODEX.md` |

Example:

```dotenv
MATRON_DEFAULT_AGENT=codex
CODEX_SANDBOX_MODE=danger-full-access
CODEX_NETWORK_ACCESS=
BRIDGE_CODEX_MD_PATH=
```

These values are read when the bridge starts. Restart the bridge after changing them. An invalid sandbox value is normalized to `workspace-write`.

Codex still loads its normal configuration for the bridge user's account. Put model defaults, reasoning effort, MCP servers, skills, and network settings in that user's Codex configuration. `BRIDGE_CODEX.md` adds remote-operation guidance; replace it or point `BRIDGE_CODEX_MD_PATH` elsewhere if the deployment needs different instructions.

## Sandbox and approvals

Matron defaults to YOLO: `danger-full-access` with `approval_policy="never"`, disabling Codex sandbox restrictions and approval prompts. An explicit `CODEX_SANDBOX_MODE=workspace-write` or `read-only` enables sandboxing and native `approval_policy="on-request"` with `approvals_reviewer="user"`. Existing explicit sandbox settings remain effective.

In those sandboxed modes, command, file-change, and permission requests wait for Matron approval cards. Cards expire with denial, are bound to individual requests, and are cleared on interruption or teardown. Unknown request types fail closed. See [OpenAI's sandbox and approvals documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

| Mode | Appropriate use |
|---|---|
| `read-only` | Inspection, review, and explanation without workspace edits |
| `workspace-write` | Normal coding work within the selected workspace |
| `danger-full-access` | Fully trusted, isolated hosts where Codex intentionally needs access outside the workspace |

Use the least-privileged mode that can complete the work. Legacy `MATRON_CODEX_TRANSPORT=exec` still uses `approval_policy="never"`: it cannot answer approvals and blocked operations fail. Changing a config does not retroactively alter an already-running child.

`/plan [task]` or `/mode plan` selects a read-only sandbox with escalations denied and configured MCP servers disabled (MCP tools run outside the shell sandbox). After the plan, choose Build or type `build` to restore normal sandbox/approval settings and implement it. `/plan off` leaves Plan mode without starting work. This is Matron's explicit planning workflow, not an undocumented native collaboration-mode setting.

`workspace-write` does not itself enable command network access. Native sessions can request approval when needed. Operators who want command networking enabled without individual network approvals can explicitly set `CODEX_NETWORK_ACCESS=true` in the bridge's `.env`. The bridge supplies `sandbox_workspace_write.network_access=true` on initial and resumed threads while retaining workspace-write file restrictions and the transport's approval policy (`on-request` for native sessions, `never` for legacy exec). Set it to `false` to disable networking within the sandbox, or leave it empty to inherit the bridge user's Codex configuration. This setting applies only to workspace-write mode outside Plan mode, does not grant protected Git writes, and cannot override externally enforced policies. Restart the bridge after changing `.env`.

## Start and resume Codex sessions

Both `/` and `!` prefixes work for bridge commands.

```text
/start --codex
/start --codex ~/Dev/my-project
/workdir --codex ~/Dev/another-project
/sessions --codex
/resume --codex 1
/resume --codex <thread-id-or-unique-prefix>
```

From the Matron apps, the New Chat panel shows a Claude / Codex switch on the folder step for any box whose bridge can spawn `codex` (a real binary on the bridge's `PATH`, or `MATRON_CODEX_REAL_BIN`). The switch opens on the box's `MATRON_DEFAULT_AGENT` and hides where only Claude is available. Under the hood the bridge's `recent_folders` reply carries `agent_options` and `default_agent`, and the `start` RPC accepts `agent: "claude" | "codex"`; a Claude model pick is refused for a Codex start (`bad_model`), and a Codex pick on a box without the binary answers `bad_agent`.

`/sessions --codex` lists recent native CLI, desktop/IDE, exec, and app-server threads alongside bridge-owned threads for the current directory. A numeric `/resume` selection uses the last displayed list, so it does not shift when a thread updates. Native prefixes must identify one listed thread; ambiguity is rejected. Listing is bounded to 150 recent native threads, excludes archived threads and subagents, and falls back visibly to bridge records if the CLI is unavailable.

During a session:

```text
/agent                 Show the active provider
/status                Show the working directory, native session ID, and usage
/model                 List available models with selection buttons
/model <model-id>      Override the Codex model for future turns
/model default         Return to the Codex configuration default
/effort                List reasoning levels supported by the selected model
/effort <level>        Set reasoning effort for future turns
/effort default        Return to the Codex configuration default
/usage                 Show cumulative token counts
/limits                Fetch account quota usage and reset times
/working               Toggle tool-activity messages
!esc                    Interrupt the active Codex child without ending the conversation
/plan [task]           Enter read-only planning; Build approves implementation
/compact               Compact the native thread (no custom instruction argument)
/mcp                   Inspect native MCP server status
/tools                 List native MCP tools
/login                 Start ChatGPT device-code login; /login cancel cancels
/logout                Log out the shared OS-user Codex account
/show_bash             Toggle native command logs immediately
```

Messages sent while Codex is running are queued. Send-now uses native `turn/steer` with the expected turn ID, keeping the turn alive. Definite rejection retains input for the turn's end; a lost acknowledgement retains input but disables automatic resend to avoid duplicate actions. Inspect the response before explicitly sending or cancelling those messages. Use `!esc` to stop the active turn. Compaction runs separately and cannot be steered into another turn.

Manual `/compact` and automatic context compaction show a “Compacting context” notice when Codex starts summarizing, followed by “Context compacted” when it finishes. Manual compaction confirms only after its turn succeeds; automatic compaction leaves the running task and queued messages in place.

## Models, effort, and usage

`/model` discovers picker-visible models through `model/list`, including pagination. The bridge reads effective project configuration for the selected working directory; model and effort overrides stay local to the conversation and survive provider switches and restarts. `/model default` and `/effort default` remove the corresponding override. An explicit model ID remains usable if discovery is unavailable.

`/limits` queries `account/rateLimits/read`. Each quota bucket keeps its own reported duration, percentage and reset timestamp; a primary window is not assumed to be five hours. The header refreshes metadata at session start, while a turn is running, and after turn completion, using a one-minute cache per working directory. `/limits` forces a refresh. Account queries do not start model turns. API-key accounts or older CLIs may return no subscription data; the command explains this and other Codex functionality remains available.

`/usage` prefers absolute totals from the matching native thread's local rollout, so it includes earlier resumed turns and does not double-count repeated telemetry records. Cached input is included in input; reasoning tokens are included in output. Total tokens are input plus output. If native telemetry is unavailable, the command labels its fallback as bridge-recorded turns.

The context header uses the latest request's input tokens and the context window reported by Codex, not cumulative tokens or Claude's window size. The bridge reads a bounded tail of the matching thread file every five seconds during execution and on demand. This rollout format is an optional, internal CLI interface: if files or fields are unavailable, execution and turn-end usage still work, and no context window is invented. Files are read from `CODEX_HOME` (default `~/.codex`), including archived sessions. The bridge does not publish transcript contents as telemetry.

The app server must be able to initialize Codex's runtime state under the bridge service account. If account discovery is unavailable, check `codex app-server --help`, the service account's login, and its access to Codex's state directory. Neither account queries nor native telemetry estimate monetary cost.

## Switch providers in one conversation

Use `/switch codex` or `/switch claude` in an existing conversation:

```text
/switch codex
/switch claude
```

Switching preserves:

- the Matron conversation;
- the working directory, files, and Git state;
- one native session ID for Claude Code and one for Codex;
- provider-local model and usage state; and
- the bridge-visible user/assistant transcript.

The provider being switched to resumes its previous native session when one exists. On the next real user message, the bridge prepends a bounded transcript delta containing messages that provider has not seen. Switching does not create a synthetic agent turn.

Private reasoning, hidden provider context, pending tool state, and provider-specific UI state cannot be transferred. A switch is refused while a turn is running or queued, while a prompt/question is awaiting an answer, or while a plan decision is pending. Finish, interrupt, or dismiss that state first.

## Files, images, and voice notes

Matron journal media follows the same saved-file pipeline for both providers:

- text and voice-note transcriptions are sent as text;
- uploaded files and images are saved locally; and
- native Codex receives supported images as image inputs as well as saved-path annotations (legacy exec receives the path only).

Codex can inspect the saved file with its normal local tools when the sandbox permits it. Keep the conversation's working directory and file permissions accessible to the bridge service user.

## Current provider differences

| Capability | Claude Code | Codex backend |
|---|---|---|
| Bridge mode | Print or interactive PTY | Native app-server; legacy exec rollback |
| Native lifecycle | Long-lived CLI process | Persistent connection and thread; streams and native steering |
| `/mode` | Can switch print/interactive | Matron read-only Plan or Build; no terminal emulation |
| `/model` | Claude model aliases | Discovered Codex models, buttons, and config-default reset |
| `/effort` | Bridge command where supported | Model-specific reasoning levels; persisted for future turns |
| `--browser` / `--share` | Supported | Shared bridge extras and pinned file-viewer roots |
| Permission mode | Claude-specific bypass/auto settings | Native on-request cards; unknown requests and timeouts denied |
| `/mcp` | Live/configured status where available | Native MCP runtime/auth status |
| `/tools` | Lists tools when the CLI exposes them | Exact MCP inventory plus native-tool description |
| `/usage` | Tokens and bridge-reported cost | Native-thread token totals and actual context window; bridge totals as fallback |
| `/cost` | Monetary cost where reported | No invented monetary cost |
| `/limits` | Claude subscription limits | Account quota windows and reset times through app server |

Native subagent text is shown in linked child conversations with terminal outcomes and restart recovery. Closing/replacing the native connection marks unfinished child views interrupted; later collaboration events can rediscover those threads. The 64-child view limit applies to active children, with completed records pruned between turns. Arbitrary MCP schemas, secret-bearing native question forms, native TUI-only commands, and custom compaction instructions are not emulated. Secrets use the shared secure-input MCP flow; unsupported forms receive a visible refusal. `--model` on start/resume remains Claude-specific; Codex selects models using `/model`.

## Troubleshooting

### `Could not start Codex` or `spawn codex ENOENT`

The service cannot find the `codex` executable. Check the binary and PATH as the bridge service user:

```bash
command -v codex
codex --version
```

Global npm binaries are often available in an interactive shell but missing from systemd or launchd. Update the service PATH or install Codex somewhere already visible to the service, then restart it.

### Authentication failures

Check the cached login and a direct non-interactive turn as the bridge service user:

```bash
codex login status
codex exec --json "Reply with exactly: authenticated"
```

If those commands work only under another account, authenticate the actual service account. Do not solve this by copying credentials into the repository.

### A command is blocked or network access fails

First confirm `/mode` is not Plan and `CODEX_SANDBOX_MODE` is appropriate. In app-server mode Codex can request an approval card for GitHub/network and protected-path operations. In legacy exec mode it cannot. Setting `CODEX_NETWORK_ACCESS=true` (or `[sandbox_workspace_write] network_access = true` in Codex configuration) is an explicit, broader operator choice; it is not required for the approval-card path and does not by itself remove protected-path restrictions. Restart matron-bridge after changing `.env`, then restart/resume the conversation to apply the new backend. An already-running turn retains its original settings. External managed policies can still prohibit an operation.

### `/switch` is refused

Run `/status` and resolve the active state. Interrupt a running turn with `!esc`, let queued messages finish or cancel them, answer open questions, and finish or dismiss pending plans before switching.

### MCP tools are missing

Native Codex receives the bridge's `ask-user` tools and opted-in extras from `mcp-config.json`, in addition to local Codex servers. Use `/restart --browser` or `/restart --share` when needed. Plan mode deliberately disables MCP servers. Check `/mcp` and `/tools`; locally configured servers can also be checked with:

```bash
codex mcp list
```

If initialization fails, check the installed Codex CLI version and bridge service PATH. Keep `MATRON_CODEX_TRANSPORT=exec` only as a rollback: native controls and injected bridge MCP tools are unavailable there.

### A model override fails

Use a model ID available to the authenticated Codex account, or reset the conversation to the CLI default:

```text
/model default
```

Model selection is provider-local, so switching to Claude and back does not replace the saved Codex model choice.
