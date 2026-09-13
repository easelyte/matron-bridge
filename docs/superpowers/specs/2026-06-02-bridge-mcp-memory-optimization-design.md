# Design: Reduce per-session MCP/plugin memory in claude-matrix-bridge

**Date:** 2026-06-02
**Status:** Draft — awaiting user review
**Goal:** Make the bridge runnable on small VPS boxes by cutting steady-state
memory, driven by per-machine opt-in MCP/plugin configuration. Lean by default;
operators opt into the heavy stuff per machine (and, for stdio servers, per
session).

## Problem

Each Matrix room runs its own `claude` subprocess, and each `claude` loads MCP
servers. On a busy host with several concurrent rooms the bridge cgroup sat at
~5.1 GB (systemd) / ~2.7 GB summed RSS across 3 sessions. The dominant,
*controllable* cost is the set of **local-process** MCP servers spawned **per
session**.

### Measurements (this machine, 3 live sessions)

`claude mcp list` shows most MCP servers are HTTP/remote (github, figma,
greptile, Linear, Gmail, Google Calendar/Drive) — these cost ~0 locally. Only
**four servers spawn local processes**, and they fall into two different
control systems:

| Server      | ~RSS/session | Kind                      | Disabled by |
|-------------|-------------:|---------------------------|-------------|
| `ask-user`  |        65 MB | bridge `mcpServers`       | (keep — it *is* the bridge) |
| `circleci`  |        65 MB | **user `mcpServers`**     | `--strict-mcp-config` |
| `context7`  |       190 MB | **plugin** MCP            | `CLAUDE_CODE_PLUGIN_CACHE_DIR` |
| `serena`    |       155 MB | **plugin** MCP            | `CLAUDE_CODE_PLUGIN_CACHE_DIR` |

Per default session today: claude (~395 MB) + all four (~475 MB) ≈ **860 MB**.
Target default: claude + ask-user ≈ **460 MB**, with everything else opt-in.

The user's global `~/.claude.json` `mcpServers` also contains `chrome-devtools`
and `linear-server`; `--strict-mcp-config` drops those too (the bridge already
owns its own browser stack via the `browser` extra).

## Verified mechanisms (empirical, claude 2.1.160)

1. **`--strict-mcp-config`** — "Only use MCP servers from `--mcp-config`,
   ignoring all other MCP configurations." Confirmed it governs *user/project
   `mcpServers`* (circleci, chrome-devtools, linear-server) but **not** plugin
   MCPs.
2. **`CLAUDE_CODE_PLUGIN_CACHE_DIR=<empty dir>`** — verified: every `plugin:*`
   MCP server disappears (context7, serena, github, figma, greptile) while the
   real `~/.claude` is untouched, so **credentials, transcripts, and `--resume`
   keep working**. This is the safe lever for plugin memory.
3. **`CLAUDE_CONFIG_DIR`** exists (would fully isolate config) but relocates
   creds + transcripts and creates OAuth-refresh coupling. **Rejected** — (2)
   achieves the same plugin savings with zero auth risk.

## Design

Two independent layers plus one optional win. Lean by default; per-machine
config turns things back on.

### Layer A — stdio `mcpServers` (circleci, browser): strict + extras + default

Reuse the bridge's existing `mcpExtras` machinery (`lib/mcp-config.js`).

- **Add `--strict-mcp-config`** to both spawn arg arrays
  (`index.js:302` print-mode, `index.js:549` iv-mode). The bridge's generated
  `--mcp-config` (ask-user + requested extras) becomes the *only* source of
  stdio servers; the user's global `mcpServers` no longer leak into every
  session.
- **Machine-local extras overlay.** The committed `mcp-config.json` stays
  generic (`mcpServers: {ask-user}`, `mcpExtras: {browser}`). A new
  **gitignored** `mcp-config.local.json` may declare additional per-machine
  `mcpExtras`. The loader merges its `mcpExtras` into the in-memory config.
  This keeps machine-specific paths (e.g. circleci's
  `/home/danbarker/circleci-mcp/server.js`) out of the shared repo.

  Example `mcp-config.local.json` on dev-3:
  ```json
  {
    "mcpExtras": {
      "circleci": {
        "circleci": { "command": "node", "args": ["/home/danbarker/circleci-mcp/server.js"] }
      }
    }
  }
  ```
- **Dynamic flag registration.** Replace the hardcoded `EXTRA_FLAG_TO_NAME`
  Map with one derived from the union of known extra names (committed ∪ local):
  flag `--<name>` ↔ extra `<name>`. So `--circleci` works automatically once
  the overlay defines it. Preserve the existing prototype-safety (build from a
  Set/Map of real keys, not a plain object).
- **Per-machine default: `MCP_DEFAULT_EXTRAS`** (comma-separated env, e.g.
  `circleci`). Applied as the resolution baseline.

#### Resolution semantics (chosen: "merge, no per-session opt-out")

```
machineDefault = parseList(process.env.MCP_DEFAULT_EXTRAS)        // [] if unset
sessionExtras  = options.mcpExtras                                // explicit /start --flags
              ?? persistedForRoom.mcpExtras                       // resume/restart
              ?? []
effectiveExtras = unique([...machineDefault, ...sessionExtras])   // machine default always applies
```

- `mcpConfigPathFor(effectiveExtras)` builds the actual config (already
  dedupes + sorts + caches by extras-key).
- **Persist `sessionExtras` only** (not `effectiveExtras`) in `session.mcpExtras`,
  so changing `MCP_DEFAULT_EXTRAS` later re-applies live and the default is never
  baked into room state.
- Explicit flags **add** to the machine default; there is intentionally **no**
  `--no-<name>`. To run lean on a machine that defaults circleci on, change the
  env and restart the service.

Net: on dev-3, `MCP_DEFAULT_EXTRAS=circleci` → every session gets circleci;
`/start --browser` → circleci + browser. A fresh VPS leaves it unset → ask-user
only.

### Layer B — plugin MCPs (context7, serena): per-machine plugin cache

- **New env `BRIDGE_PLUGIN_CACHE_DIR`**, injected as
  `CLAUDE_CODE_PLUGIN_CACHE_DIR` into both spawn `env` blocks (same place as the
  existing `PATH`/`CLAUDECODE` injection, `index.js` ≈ proc spawn).
- **Default (unset): lean.** The bridge points spawned sessions at a
  bridge-owned **empty** plugin-cache dir (created on boot, e.g.
  `~/.claude-matrix-bridge/empty-plugin-cache/`). Result: **no plugin MCP
  servers** load (~345 MB/session saved), creds/transcripts untouched.
- **To re-enable plugins on a machine:** set `BRIDGE_PLUGIN_CACHE_DIR` to the
  real cache (full set, heavy) or to a curated dir containing only the wanted
  plugins. dev-3 (62 GB RAM) can point at the real cache if leanness doesn't
  matter there.
- This is a **machine-level** knob (not per-session): plugins are the heavy,
  rarely-toggled tier. Per-session plugin selection (per-extras config dirs) is
  explicitly out of scope (YAGNI).

> Implementation note: confirm the exact directory level
> `CLAUDE_CODE_PLUGIN_CACHE_DIR` expects (the empty-dir test pointed at a bare
> dir and disabled all plugins; the "curated subset" path/layout must be
> verified against the real `~/.claude/plugins` structure during the plan).

### Optional — context7 via hosted remote

context7 has a hosted endpoint (`https://mcp.context7.com/mcp`). A machine that
wants context7 *without* the 190 MB local process can declare it as a
URL-transport extra in `mcp-config.local.json` instead of relying on the local
plugin. Treated as optional; not part of the core change.

## Config surface (summary)

| Knob | Scope | Default | Purpose |
|------|-------|---------|---------|
| `--strict-mcp-config` | always-on (code) | added | Stop inheriting user `mcpServers` |
| `mcp-config.local.json` | per-machine, gitignored | absent | Declare machine-specific stdio extras |
| `MCP_DEFAULT_EXTRAS` | per-machine env | unset (none) | Stdio extras on by default |
| `BRIDGE_PLUGIN_CACHE_DIR` | per-machine env | empty dir (lean) | Which plugins (incl. their MCPs) load |
| `--<extra>` flags | per session | — | Add stdio extras on top of default |

## Security / secrets

- `mcp-config.json` is committed → it must contain **no secret literals**.
  `mcp-config.local.json` is gitignored and may reference machine-local servers,
  but secrets should still come from the server's own config/env, not literals
  (circleci reads its token from `~/.circleci/cli.yml`; no secret in the def).
- `--strict-mcp-config` reduces blast radius: bridge sessions can no longer pick
  up arbitrary user-global MCP servers.

## Testing

- **Unit (`test/`, `lib/mcp-config.js`):**
  - `--circleci` (and any local-overlay flag) parses to the right extra.
  - Local overlay `mcpExtras` merge into known extras + flag set.
  - Resolution: `effectiveExtras = unique(machineDefault ++ sessionExtras)`;
    persistence stores `sessionExtras` only.
  - Unknown/prototype-named flags still don't resolve.
- **Manual verification (read-only, no API turn):**
  - `claude --strict-mcp-config --mcp-config <generated>` then `mcp list`
    (subcommand separated from the variadic flag) shows only ask-user + extras.
  - `CLAUDE_CODE_PLUGIN_CACHE_DIR=<empty> claude mcp list` shows no `plugin:*`.
  - Spawn a real bridge session lean, then with `MCP_DEFAULT_EXTRAS=circleci`,
    then `BRIDGE_PLUGIN_CACHE_DIR=<real cache>`; confirm the child-process set
    and RSS at each step.
- **Regression:** `--resume` still works (creds/transcripts unaffected by Layer
  B); idle-reaper + auto-resume carry `sessionExtras` correctly.

## Rollout

1. **Layer A** (strict + local overlay + dynamic flags + `MCP_DEFAULT_EXTRAS`).
   Low risk, no auth impact. Drops circleci/chrome-devtools/linear-server leak;
   establishes the per-machine framework. Set `MCP_DEFAULT_EXTRAS=circleci` +
   `mcp-config.local.json` on dev-3 to preserve current circleci behaviour.
2. **Layer B** (`BRIDGE_PLUGIN_CACHE_DIR`, default empty). Biggest memory win
   (~345 MB/session). On dev-3, set it to the real cache (or a curated dir) if
   plugins are wanted there.
3. **Optional** context7-remote extra, per machine, if desired.

Docs to update: `README.md` (new env vars + the browser-tools note),
`BRIDGE_CLAUDE.md` / system-prompt note (mention `--circleci` etc. alongside
`--browser`), `.env.example`, `.gitignore` (`mcp-config.local.json`).

## Out of scope / rejected

- **Full `CLAUDE_CONFIG_DIR` isolation** — rejected; Layer B gets the plugin
  savings without relocating creds/transcripts or risking OAuth refresh churn.
- **Shared HTTP/SSE MCP supervisor** — overkill here: the heavy locals are
  serena (stateful, workdir-scoped — unsafe to share) and context7 (already has
  a hosted remote, which is the better fix than self-hosting a shared one).
- **Per-session plugin toggling** — YAGNI; plugins are machine-level.
- **Concurrency cap / idle-reaper retuning** — the reaper already exists
  (`SESSION_IDLE_TIMEOUT_MS`, default 1 h); not part of this change.
