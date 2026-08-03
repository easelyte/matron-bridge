# Using the Codex backend

matron-bridge supports Codex through the Codex CLI's non-interactive JSONL interface. This integration is programmatic only: it does not embed or scrape the interactive Codex terminal UI.

Useful upstream references:

- [Codex CLI](https://developers.openai.com/codex/cli/)
- [Authentication](https://developers.openai.com/codex/auth/)
- [Non-interactive mode](https://developers.openai.com/codex/non-interactive-mode/)

## How the backend works

Each user turn starts one `codex exec --json` child process. The prompt is written to stdin rather than placed in the process arguments. After the first turn, the bridge records the native Codex thread ID and continues it with `codex exec resume <thread-id>` on later turns.

The bridge:

- runs Codex in the conversation's working directory;
- reads JSONL events for agent messages, tool activity, errors, and token usage;
- publishes the completed response and activity updates to the same Matron conversation;
- queues messages that arrive while the current turn is running;
- persists the Codex thread ID so the session can resume after a bridge restart; and
- passes `--skip-git-repo-check`, allowing an explicitly selected non-Git working directory.

The installed Codex CLI remains responsible for model access, authentication, user/project configuration, `AGENTS.md`, skills, rules, MCP servers, and tool execution.

Before Codex events are durably published, the bridge applies the canonical
value-pattern policy and also redacts assignment values whose keys look secret
(for example, `DATABASE_PASSWORD=...` or `"API_TOKEN": "..."`). Recognizable
raw environment dumps are dropped as an additional safeguard. Pattern-based
redaction cannot decide that an arbitrary value is secret: a secret under a
non-secret-looking key whose value matches no configured pattern may pass and
must not be printed into agent output.

### Accepted single-principal residual

The live-view sidecar directory is writable by the Codex wrapper and therefore
by a shell-capable descendant. Such a descendant can forge a matching metadata
file and JSONL transcript that the journal presents as a Codex run. Shape and
PID-liveness validation, together with separate 64-child limits for live and
historical restart reconciliation, bound malformed data and volume but do not
establish provenance. Runs beyond either budget are omitted after one durable
notice on the parent conversation.

This is accepted only for the current single-principal deployment, where the
operator's own trusted sessions share the principal. It follows the P67 trust
model and the accepted `show_file` token-isolation residual: forgery
within the operator's own journal is not a new cross-principal capability.
Out-of-band, bridge-stamped run registration through a mediator that descendants
cannot forge is a hard prerequisite before any multi-principal or curated-toolset
(Nastia) deployment. The current bridge does not claim that provenance.

### Activation-gating residual

The common disconnected-journal case is repaired by reconnect outcome re-emit
and terminal-field coalescing. A narrower edge remains if a parent session is
replaced during the outage after its terminal frame has been evicted from the
bounded publisher queue: the old tracker is no longer attached to a session,
so its child outcome cannot be re-emitted and the journal may continue to show
that child as running. Before `EPIPE_TOLERANT_VERSIONS` is changed to activate
the visualization, this must be closed with a session-independent terminal
ledger that re-emits outcomes until the publisher receives authoritative
acknowledgement.

## Install and authenticate

Install Codex globally, then authenticate it as the same OS user that launches matron-bridge:

```bash
npm install -g @openai/codex
codex --version
codex login
codex login status
```

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
| `CODEX_SANDBOX_MODE` | Sandbox applied to every remote Codex turn: `read-only`, `workspace-write`, or `danger-full-access` | `workspace-write` |
| `BRIDGE_CODEX_MD_PATH` | Developer-instructions file supplied to bridge-spawned Codex turns | repository `BRIDGE_CODEX.md` |

Example:

```dotenv
MATRON_DEFAULT_AGENT=codex
CODEX_SANDBOX_MODE=workspace-write
BRIDGE_CODEX_MD_PATH=
```

These values are read when the bridge starts. Restart the bridge after changing them. An invalid sandbox value is normalized to `workspace-write`.

Codex still loads its normal configuration for the bridge user's account. Put model defaults, reasoning effort, MCP servers, skills, and network settings in that user's Codex configuration. `BRIDGE_CODEX.md` adds remote-operation guidance; replace it or point `BRIDGE_CODEX_MD_PATH` elsewhere if the deployment needs different instructions.

## Sandbox and approvals

Remote turns cannot pause for a terminal approval. The bridge therefore forces `approval_policy="never"` and combines it with `CODEX_SANDBOX_MODE`:

| Mode | Appropriate use |
|---|---|
| `read-only` | Inspection, review, and explanation without workspace edits |
| `workspace-write` | Normal coding work within the selected workspace |
| `danger-full-access` | Fully trusted, isolated hosts where Codex intentionally needs access outside the workspace |

Use the least-privileged mode that can complete the work. With `approval_policy="never"`, an operation that needs privileges outside the active sandbox is rejected instead of asking the remote user to approve it. The bridge reports the failure in the conversation.

`workspace-write` does not itself enable command network access. If a workflow needs network access, configure it deliberately in the Codex CLI settings for the bridge user. Do not switch to `danger-full-access` merely to solve an authentication, PATH, or MCP configuration problem.

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

`/sessions --codex` lists bridge-owned Codex threads for the current working directory. A numeric `/resume` selection is relative to that list. Native ID prefixes must identify exactly one persisted thread; ambiguous prefixes are rejected.

During a session:

```text
/agent                 Show the active provider
/status                Show the working directory, native session ID, and usage
/model <model-id>      Override the Codex model for future turns
/model default         Return to the Codex configuration default
/usage                 Show cumulative token counts
/working               Toggle tool-activity messages
!esc                    Interrupt the active Codex child without ending the conversation
```

Messages sent while Codex is running are queued and delivered after the turn completes. The bare busy-queue commands `send`, `interrupt`, and `cancel` keep their normal bridge meanings; use `!esc` when the intention is specifically to stop the active Codex turn.

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
- Codex receives a text annotation containing the saved path rather than a provider-native binary content block.

Codex can inspect the saved file with its normal local tools when the sandbox permits it. Keep the conversation's working directory and file permissions accessible to the bridge service user.

## Current provider differences

| Capability | Claude Code | Codex backend |
|---|---|---|
| Bridge mode | Print or interactive PTY | Programmatic `codex exec --json` only |
| Native lifecycle | Long-lived CLI process | One child process per turn; native thread resumed between turns |
| `/mode` | Can switch print/interactive | Reports programmatic mode; interactive Codex is not implemented |
| `/effort` | Bridge command where supported | Configure `model_reasoning_effort` in Codex config |
| `--browser` bridge extra | Supported for Claude sessions | Not supported; configure Codex MCP servers locally |
| `/mcp` | Live/configured status where available | Uses local Codex config; live status is not present in JSONL events |
| `/tools` | Lists tools when the CLI exposes them | No authoritative inventory in JSONL; tools come from Codex, skills, sandbox, and MCP config |
| `/usage` | Tokens and bridge-reported cost | Token counts only |
| `/cost` | Monetary cost where reported | Turn count only; `codex exec` does not report monetary cost |
| `/limits` | Claude subscription limits | Not exposed by `codex exec` JSONL |

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

First confirm `CODEX_SANDBOX_MODE` is appropriate. For workspace edits, use `workspace-write`. Configure network access and any destination policy in the bridge user's Codex settings. Restart matron-bridge after changing `.env`; Codex configuration changes apply to subsequent child processes.

### `/switch` is refused

Run `/status` and resolve the active state. Interrupt a running turn with `!esc`, let queued messages finish or cancel them, answer open questions, and finish or dismiss pending plans before switching.

### MCP tools are missing

Codex does not use the bridge's Claude-specific `mcp-config.json` or `--browser` extra. Configure and authenticate MCP servers with the Codex CLI under the bridge service account, then verify them directly:

```bash
codex mcp list
```

The bridge's `/mcp` response for Codex is informational because `codex exec --json` does not publish a complete live server-status inventory.

### A model override fails

Use a model ID available to the authenticated Codex account, or reset the conversation to the CLI default:

```text
/model default
```

Model selection is provider-local, so switching to Claude and back does not replace the saved Codex model choice.
