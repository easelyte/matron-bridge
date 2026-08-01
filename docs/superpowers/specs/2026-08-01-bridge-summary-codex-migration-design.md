---
title: "Bridge summary/title generation: Gemini → codex exec (ChatGPT subscription)"
slug: bridge-summary-codex-migration
date: 2026-08-01
status: approved
revision: 5
risk: medium
repo: easelyte/claude-matrix-bridge
base_branch: journal-deploy
feature_branch: summary-codex-migration
related_principles: [V3, V3a, V8, P3, P7, P8, P33, P34, P53, P67, R501]
resolved_operator_decisions:
  - "B1 residual: ACCEPTED (operator, 2026-08-01). Rationale: codex already runs with broader (workspace-write) access in the interactive bridge sessions and the sysadmin/assistant agents, so a read-only, network-blocked, MCP-disabled, ephemeral cosmetic call is not a new exposure class. Cheap mitigations (--ignore-user-config, --ephemeral, -s read-only, neutral tmp cwd, regex+length-capped output) retained as hygiene. Revisit lightly if #458 shared-agent changes the trust model, but not a ship blocker."
rejected_alternatives:
  - "Approach A (inline swap in index.js): rejected — buries spawn/parse/timeout/fail-open logic in the 7k-line index.js, untestable in isolation."
  - "Approach C (migrate all naming paths incl. seed/session-summary to codex): rejected — those paths are already deterministic (no LLM cost), so no payoff against the $20 problem."
  - "Keep Gemini but reduce cadence/context: rejected — still metered; operator chose to eliminate the paid API entirely."
  - "Claude CLI for summaries: rejected — automated/unattended path, violates the 'never put Claude in crons' TOS rule."
  - "Repo name via LLM prompt instruction: rejected in favor of deterministic basename(workdir) — strictly more reliable."
  - "Reuse buildCodexExecArgs() from lib/codex-session.js: rejected in revision 2 — that builder is tuned for the interactive threaded path (threads, user config, workspace-write) and omits --ephemeral / --ignore-user-config; reusing it was the direct cause of the round-1 B1/B2 findings. codexOneShot builds its own argv."
  - "codex --output-schema for structured TITLE/SUMMARY instead of regex: deferred — strictly more robust, but changes the prompt contract; noted as a follow-up, kept regex to minimize surface."
---

# Bridge summary/title generation: Gemini → codex exec

## Problem

The matron journal bridge is the **only** consumer of a metered AI API in the workspace — `@google/generative-ai` (`gemini-3-flash-preview`) — costing ~$20/mo. It is used in exactly one place, `maybeUpdatePinnedSummary()` in `index.js`, to generate a conversation **title** and a running **pinned summary** every 5 messages. The ChatGPT subscription (via the already-installed, subscription-authed `codex` CLI) is flat-rate.

## Goals

1. Replace the two Gemini `generateContent()` calls with `codex exec` (ChatGPT subscription, flat-rate).
2. Show **which repo** a session is working on, in the conversation title.
3. Change the room-name prefix from `VPS-journal` to `VPS`, applied to **every** title-construction site.
4. Remove the `@google/generative-ai` dependency and the `GEMINI_API_KEY` reference, verified repo-wide.

## Current behavior (`index.js`, journal-deploy @ 4d99188)

- `maybeUpdatePinnedSummary()` (~line 4362) gated on `genAI` (presence of `GEMINI_API_KEY`). No key → `applyFallbackTitle()` and return.
- Triggers when `chatHistory.length >= 5 && length % 5 === 0`.
- If the running summary has >15 `•` bullets, one **compaction** call condenses it to 3 bullets (updates in-memory at ~4389; disk write happens later at ~4434 in the success path).
- One **title+summary** call over the last 50 messages; output parsed by regex on `TITLE:` / `SUMMARY:` / `NEW:`.
- Fire-and-forget — `maybeUpdatePinnedSummary(session)` at `index.js:3496` is not awaited.
- **Three** `${SERVER_LABEL}:`-prefixed title sites exist (grep-confirmed 2026-08-01): the LLM rename (`index.js:4412`), and the resume path (`index.js:4967` and `:4968`, `${SERVER_LABEL}: <summary>` / `${SERVER_LABEL}: Resumed <id>`). The resume path sets `session.firstMessageCaptured = true` (`:5004`) so `applyFallbackTitle` never corrects it. The title format `${label}:${xx} ${text}` is otherwise shared between the LLM path and `applyFallbackTitle()` in `lib/journal-title-seed.js`.

## Measured codex behavior (empirical, 2026-08-01; codex-cli 0.146.0)

A one-shot `codex exec --json --skip-git-repo-check -s read-only -c approval_policy="never" --ignore-user-config --ephemeral -` with the prompt on stdin:
- Returns clean output. Final text is in `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`; `turn.completed` carries usage.
- **~5s wall-clock**, **~14k input tokens** (codex base instructions, mostly cached) + tiny output; `reasoning_output_tokens: 0` on a simple format task.
- **Flags verified present in 0.146.0** via `codex exec --help`: `--ephemeral`, `--ignore-user-config` ("Do not load $CODEX_HOME/config.toml; auth still uses CODEX_HOME"), `-s/--sandbox`, `--skip-git-repo-check`, `--json`, `-m/--model`.
- **Tradeoff (accepted by operator):** each call consumes ChatGPT **weekly quota** shared with `/codex-review` + Anton. Trading $20/mo cash for quota pressure. Kill-switch below.

## Design (Approach B)

### 1. New module `lib/codex-oneshot.js`

Single-purpose "prompt in → text out" helper. **Builds its own argv** (does NOT reuse `buildCodexExecArgs` — see rejected_alternatives; that omission caused the round-1 containment findings).

```js
import os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';

const KILL_GRACE_MS = 3_000;

// One-shot codex text generation against the ChatGPT subscription (flat-rate;
// replaces metered Gemini). Read-only sandbox (no writes, no network),
// --ignore-user-config (no MCP tools, no user config), --ephemeral (no rollout
// persistence), neutral cwd. Fails OPEN: resolves { text: null, reason } on any
// failure so callers keep their deterministic fallback. NEVER throws.
export async function codexOneShot(prompt, {
  model = process.env.SUMMARY_CODEX_MODEL || null,
  timeoutMs = Number(process.env.SUMMARY_CODEX_TIMEOUT_MS) || 60_000,
  cwd = os.tmpdir(),
  spawnImpl = nodeSpawn,
  command = 'codex',
} = {}) { /* see argv + lifecycle below */ }
```

- **argv (fixed, containment-critical):** `exec --json --skip-git-repo-check -s read-only -c approval_policy="never" --ignore-user-config --ephemeral [-m <model>] -`. Prompt on **stdin** (no argv exposure / length limits).
- **cwd = `os.tmpdir()`**: neutral dir with no `AGENTS.md` — minimizes token load, no workspace instructions leak in.
- **Async spawn-error listener (Codex-r2 B1 — crash prevention):** attach `child.on('error', …)` immediately. Node's `spawn` with a missing/non-executable binary does **not** throw synchronously — it returns a child and emits `error` (`ENOENT`/`EACCES`) asynchronously; an unhandled `error` event **terminates the bridge**. The handler resolves `{text:null, reason:'spawn-error'}` through the shared resolve-once path. (The synchronous `try/catch` around `spawnImpl(...)` handles only the rare sync-throw case; both are required.) `codex-session.js:123` already models the async listener.
- **stdin lifecycle (B3):** attach `child.stdin.on('error', …)` **before** `child.stdin.end(prompt)`; an `EPIPE` from a child that exits before draining resolves `{text:null,reason:'stdin-error'}` — never an unhandled throw. (The existing interactive path at `codex-session.js:144` lacks this listener; do not copy that gap.)
- **Parse:** accumulate JSONL; keep the `text` of the last `item.completed` whose `item.type === 'agent_message'`.
- **Bounded accumulation (Codex-final B1 — hostile-output OOM guard, covers the whole child-output class):** cap total accumulated `stdout` at `MAX_OUTPUT_BYTES` (256 KiB) and `stderr` likewise; if either exceeds the cap, treat as failure — kill the child (SIGTERM→SIGKILL) and resolve `{text:null, reason:'output-overflow'}`. Independently cap the retained `agent_message` text (e.g. 4 KiB) before it leaves the helper. Rationale: `chatHistory` is hostile (R501); a message can instruct the shell-capable child to `cat` a large file, and unbounded `stdoutBuffer += chunk` (the pattern in `codex-session.js:106`) would buffer to OOM and take down the bridge — violating the "no path blocks message delivery" guarantee. The downstream 60/400-char title/compaction caps do not help, since they run only *after* the raw stream is already in memory (P8 Guard Boundary Inputs — bound at ingest, not after).
- **Timeout / termination (M3):** on timeout → `child.kill('SIGTERM')`; if `close` hasn't fired within `KILL_GRACE_MS`, escalate `child.kill('SIGKILL')`. Resolve only after `close` (or the grace-elapsed SIGKILL). Clear the timer on normal close.
- **Resolve-once:** all exit paths (close, `error`, `stdin` error, timeout) funnel through one guarded resolve so no path double-resolves.
- **Return shape (Codex-r2 M2 — telemetry must be producible):** `{ text, reason, exitCode, signal, durationMs }`. `reason ∈ {null(success), 'timeout', 'nonzero-exit', 'spawn-error', 'stdin-error', 'no-output', 'output-overflow'}`. `exitCode`/`signal` come from `close` (null when the process never closed cleanly). The caller needs these for the structured failure event (Observability §) — a `{text,reason}`-only contract cannot produce them. Never throws.

### 2. `maybeUpdatePinnedSummary()` rewrite

- Remove the `genAI` / `GoogleGenerativeAI` gate. Replace with a kill-switch:
  `const SUMMARY_LLM_ENABLED = (process.env.SUMMARY_CODEX_ENABLED ?? '1') !== '0';` — disabled → `applyFallbackTitle(...)` and return (deterministic titles, **zero quota**). (The speculative `SUMMARY_CODEX_EVERY` knob from revision 1 is **cut** — no defined semantics/tests; cadence stays the existing `length % 5`.)
- **In-flight guard (M1):** at entry, if `session._summaryInFlight` is set, return immediately; set it after the trigger check and clear it in a `finally`. Prevents overlapping runs (the call is unawaited and each run can take up to `timeoutMs`) from clobbering each other's summary/title or double-spending quota **within one session object's life**.
  - **Accepted limitations (cosmetic, documented — Codex-r2 B3 & M1):** (a) the guard lives on the session object; a restart/`recreateSession` mid-flight yields a fresh object without the flag, so old+new can briefly overlap. Consequence is a stale/overwritten **cosmetic** title/summary that self-corrects on the next cadence — and the *pre-existing* Gemini path had no guard at all (strictly worse). Cross-replacement cancellation is disproportionate machinery for a title race. (b) A cadence trigger that fires while a run is in flight is dropped rather than coalesced, so summary freshness can lag until the next `%5` boundary. Both accepted as cosmetic residuals, not fixed.
- Compaction (>15 bullets) and title+summary both call `codexOneShot(prompt)`. Prompt bodies **unchanged** (same `TITLE:`/`SUMMARY:`/`NEW:` contract + regex).
- **Compaction commit (M2):** on compaction success, cap the compacted text to a bound (**≤ 400 chars**, ~3 bullets — Codex-r2 B2 hygiene so a hostile oversized compaction can't persist a large blob) and persist to **disk immediately** (`persistSession(...)`), before the title+summary call — so a subsequent title-call failure/restart cannot resurrect the un-compacted summary and re-trigger compaction forever.
- **Compaction retry cap (Claude #6 / Codex-r2 M3):** track `session._compactionFailures`; after 2 consecutive compaction failures, skip the compaction call for that session (keep appending) and emit one structured warn. **Reset to 0 on any compaction success** (so a transient burst doesn't permanently disable compaction). The counter is **not** carried across session restart/recreate — a restarted always-failing backend re-tries twice, which is negligible and simpler than threading the field through every `recreateSession` copy list. Documented as intentional.
- **Fallback on failure:** if the title+summary `codexOneShot` returns `text:null`, call `applyFallbackTitle(...)` (a strict improvement — a Gemini failure previously left the bare workdir seed).
- Title assembly routed through the new formatter (below).

### 3. Title formatting — centralized, repo-aware, all sites

Add `formatRoomTitle({ serverLabel, workdir, text, defaultWorkdir })` to `lib/journal-title-seed.js`, used by **all three** title sites (the `defaultWorkdir` arg is threaded from the caller's `DEFAULT_WORKDIR` — a leaf lib module must NOT reverse-import `index.js`; parameter-passing is the only non-circular mechanism) — `maybeUpdatePinnedSummary()`, `applyFallbackTitle()`, **and the resume path (`index.js:4967-4968`, Claude #1)**:

```
VPS · <repo> · <text>        // text present
VPS · <repo>                 // text empty
```

- `<repo>` = `repoLabel(workdir, { defaultWorkdir })`:
  - `path.basename(path.resolve(workdir))`, **except** when `path.resolve(workdir) === defaultWorkdir` (the son-of-anton workspace root, whose basename is the uninformative `workspace`) it maps to `son-of-anton` (Claude #4).
  - **The workspace-root path is NOT re-literalized (Codex-r2 M3, V3a):** `index.js:109` already resolves it into `DEFAULT_WORKDIR` (env-overridable via `process.env.DEFAULT_WORKDIR`). `formatRoomTitle`/`repoLabel` receive that value as a parameter from the caller — no second hardcoded `/root/.openclaw/workspace` literal in `journal-title-seed.js`. Comparing against the resolved constant means an env override or deploy-path change can't silently degrade the mapping to the bare `workspace` basename.
  - Capped at **24 chars** with a trailing `…` if it overflows (Claude #5 + Codex-r2 minor — same ellipsis convention as `<text>`).
- `<text>` truncated to 60 chars **with a trailing `…`** — the ellipsis behavior from `applyFallbackTitle`, adopted uniformly (Claude #8; resolves the bare-slice/ellipsis mismatch at the two merged sites).
- The `sessionShort` 2-char id is **dropped** (operator preference). Reversible: re-add as `VPS:ab · <repo> · <text>`.
- `seedTitleFor()` still returns the bare basename for the transient pre-title seed; unchanged.
- The stale "Element sidebar truncates visually" comment is corrected — the live client is the journal/matron-web sidebar; deploy verify (below) checks its rendering of the three-segment title.

### 4. Prefix change (operational)

`SERVER_LABEL` is read from `.env` (host-local, gitignored). At deploy, change `/opt/matron/bridge-journal/.env`: `SERVER_LABEL=VPS-journal` → `SERVER_LABEL=VPS`. With §3 routing all three sites through `formatRoomTitle`, this now genuinely applies consistently (titles, resume names, help text).

### 5. Dependency + env cleanup (M5)

- Remove `import { GoogleGenerativeAI }` + the `genAI` const from `index.js`.
- Remove `@google/generative-ai` from `package.json` + regenerate `package-lock.json`.
- Remove the unused `GEMINI_API_KEY` line from `.env` at deploy.
- **Acceptance criteria (residue scan across ALL relevant artifact types — Codex-r2 M4; `--include='*.js'` alone can't see manifests/env):**
  - Source: `grep -rn "generative-ai\|GoogleGenerativeAI\|GEMINI_API_KEY" --include='*.js' . | grep -v node_modules` → **zero** hits. (Pre-verified 2026-08-01: only `index.js:13,217` match.)
  - Manifests: `grep -n "generative-ai" package.json package-lock.json` → **zero** hits (proves the dep is actually uninstalled, not just unimported).
  - Deploy env: `grep -n "GEMINI_API_KEY" /opt/matron/bridge-journal/.env` → **zero** hits (checked at deploy, step 4).
- **`node --check` gate:** add `lib/codex-oneshot.js` to the explicit file list in `package.json`'s `check` script (repo convention enumerates every module; no wildcard — Claude-r2 minor).

## Observability (P3 / P34 / V8 — round-1 consensus)

Titles are cosmetic, but the call **consumes shared paid quota**, so failure must be visible (both reviewers, M4 + Claude #2/#6). The event fields come from `codexOneShot`'s expanded return shape (`reason`, `exitCode`, `signal`, `durationMs`) plus `model` (which the caller already holds from the options it passed in) — the caller can only log what the helper returns (Codex-r2 M2).

Log-level contract (single source of truth; the Failure table below matches it exactly — resolves the Claude-r2 M1 / Codex-r2 M2 warn-vs-debug contradiction):
- **`warn`** — a genuine codex **failure** (`timeout`, `nonzero-exit`, `spawn-error`, `stdin-error`, `no-output`). These are the events an operator must see. Transient (`timeout`) vs permanent (`spawn-error`/`no-output`) are distinguishable by `reason` (V6/V8).
- **`debug`** — non-failures: kill-switch skip (`SUMMARY_CODEX_ENABLED=0`, with a `killSwitch:true` marker), malformed-but-non-empty output (regex miss), in-flight-guard skip, and success. Intentional disablement is not a failure, so it stays at `debug`; an operator checking "is codex failing?" greps `warn`.

## Security / boundary (P8, P7, P33, P67, R501 — BLOCK)

The prompt embeds up to 50 raw conversation messages. `chatHistory` includes assistant turns that may carry tool output / web-fetched / file content — i.e. **external content, treated as hostile (R501)**. Codex is agentic, so this is a real injection surface, unlike Gemini's inert `generateContent`.

**Mitigations applied (all in the fixed argv / output handling):**
- `--ignore-user-config` → no MCP tools, no user config/credentials-in-config (closes the tool-driven and MCP exfil paths; P67 capability reduction).
- `-s read-only` → no filesystem **writes**, **no network** (blocks direct exfil-to-third-party).
- `--ephemeral` → no rollout/session file persisted per call (P53; closes the durable-transcript-copy + disk-growth path, B2).
- Neutral `cwd=os.tmpdir()` → no `AGENTS.md`/workspace instructions loaded.
- Prompt on **stdin**, not argv.
- Output is untrusted (P33 parse-don't-validate): only `TITLE:`/`SUMMARY:`/`NEW:` regex captures used; title capped 60 chars, repo segment 24 — small exfil bandwidth.

**Residual (ACCEPTED, operator 2026-08-01 — `resolved_operator_decisions` B1):** the read-only sandbox still permits the model to **read** local files (e.g. via a model-generated `cat` inside the sandbox) and fold their contents into its response, sent to OpenAI as the turn and, in ≤60 chars, into the title. Network is blocked (no third-party exfil) and MCP is disabled. Operator accepted this: codex already runs with broader **workspace-write** access in the interactive bridge sessions and the sysadmin/assistant agents, so this read-only cosmetic call is not a new exposure class. Not a ship blocker. Lightweight revisit if loop #458 (shared-agent, Nastia — untrusted/multi-user content) changes the trust model.

## Failure behavior (fail-open, cosmetic feature)

| Condition | Result | Observability |
|---|---|---|
| `SUMMARY_CODEX_ENABLED=0` | Deterministic fallback title, no codex call, zero quota | **debug** + `killSwitch:true` marker |
| codex timeout | `text:null` → `applyFallbackTitle`; SIGTERM→SIGKILL escalation | **warn** `reason:timeout` |
| nonzero exit / no output | `text:null` → `applyFallbackTitle` | **warn** `reason:<class>` |
| spawn error (missing/non-exec binary, async `error`) | `text:null` → `applyFallbackTitle`, no crash | **warn** `reason:spawn-error` |
| stdin EPIPE (child died early) | `text:null`, no throw | **warn** `reason:stdin-error` |
| output overflow (>256 KiB stdout/stderr, e.g. hostile `cat`) | kill child, `text:null`, no OOM | **warn** `reason:output-overflow` |
| compaction returns null | keep existing summary; reset-on-success; after 2 in a row, skip compaction | **warn** per failure |
| malformed output (no `TITLE:`) | existing regex-miss handling: keep current summary/title | **debug** |
| overlapping cadence run | second run returns early (in-flight guard) | **debug** |

No path throws or blocks message delivery.

## Testing

`test/codex-oneshot.test.js` (vitest, mock `spawnImpl` with a fake child = EventEmitter + stdout/stderr EventEmitters + `stdin` = EventEmitter with `end` spy):
- `item.completed` agent_message + `close(0)` → `{text, reason:null, exitCode:0}`.
- Multiple agent_message items → returns the **last**.
- `close(1)` → `{text:null, reason:'nonzero-exit', exitCode:1}`.
- No agent_message, `close(0)` → `reason:'no-output'`.
- Timeout (fake timers): SIGTERM sent; no close within grace → SIGKILL sent; resolves `reason:'timeout'` exactly once (resolve-once assertion).
- `stdin` emits `error` (EPIPE) → `reason:'stdin-error'`, no throw.
- **child emits async `error` (ENOENT) after spawn returns a child (missing-binary case, Codex-r2 B1)** → `reason:'spawn-error'`, no unhandled event / no throw. (Distinct from the synchronous-`spawnImpl`-throws case, also tested.)
- **output overflow (Codex-final B1):** stdout stream exceeding `MAX_OUTPUT_BYTES` → child killed, resolves `reason:'output-overflow'`, no unbounded buffer growth (assert accumulated length is bounded).
- argv assertions: includes `-s read-only`, `approval_policy="never"`, `--ignore-user-config`, `--ephemeral`; `-m` present iff `SUMMARY_CODEX_MODEL` set.

`test/journal-title-seed.test.js` (extend):
- `formatRoomTitle` shapes (with/without text), no `:xx` id, ellipsis on 60-char text overflow AND on 24-char repo overflow, workspace-root (== `defaultWorkdir` param) → `son-of-anton` mapping, non-workspace path → basename.
- `applyFallbackTitle` produces `VPS · <repo> · <text>`.

`maybeUpdatePinnedSummary` — the round-1/round-2 safety mechanisms MUST be tested, not left "buried in index.js" (the exact untestability that rejected Approach A). Extract the testable units (a pure `repoLabel`/`formatRoomTitle` already extracted to `journal-title-seed.js`; the summary-flow helper factored enough to unit-test its branches with an injected `codexOneShot` double):
- in-flight guard skips a second concurrent entry;
- compaction persisted (and length-capped) before the title call; `_compactionFailures` resets on success and skips after 2;
- kill-switch path emits no codex call;
- **resume-path (`index.js:4967-4968`) renders `VPS · <repo> · <text>` via `formatRoomTitle`** (round-1 headline fix — Claude-r2 M4; assert this path, not only the fresh-session rename).
- **log-level contract**: a genuine failure `reason` logs at `warn`; the kill-switch/malformed/in-flight/success paths log at `debug` (Claude-r3 minor — pins the P34 "grep warn to know if codex is failing" guarantee against silent drift; assert via a spy on the structured logger).

Gates: `npm run test`, `npm run check`, `npm run lint` (`--max-warnings=0`) all green.

## Deploy plan

1. Develop + test on `summary-codex-migration` (worktree `/root/bridge-summary-codex`, off `origin/journal-deploy`).
2. `/ship-slim` → Codex adversarial review on diff → PR to `easelyte/claude-matrix-bridge` → merge to `journal-deploy`.
3. **Branch-contention precondition (Claude #7, operator-gated):** the live dir `/opt/matron/bridge-journal` is currently on `agent-inline-media` (another window's `show-file` MCP work), not `journal-deploy`. Deploy is **blocked** until: (a) confirm the `agent-inline-media` work is merged or stashed by its owner, then (b) `git -C /opt/matron/bridge-journal checkout journal-deploy && git pull`. **Resolved criterion:** `git -C /opt/matron/bridge-journal status` shows `journal-deploy` clean at the merged SHA. Restart kills all live bridge sessions (irreversible) — operator triggers when convenient. If coordination stalls, fallback = checkout `journal-deploy` into a fresh dir and repoint the systemd `WorkingDirectory` (avoids disturbing the other branch).
4. At deploy: edit `.env` (`SERVER_LABEL=VPS`, remove `GEMINI_API_KEY`), `npm ci`, `systemctl restart matron-bridge-journal.service`.
5. **Verify (non-vacuous, and not debug-gated — Claude #9 + Claude-r2 M5 + Codex-r2 M2):** success logs at `debug` only and `DEBUG` is off in prod (`index.js:149`), so a success-log grep would find nothing. Instead:
   - (a) `!start` a session, send 5 messages; confirm the title becomes `VPS · <repo> · <topic>` — a *meaningful topic title* (not the deterministic first-message fallback) is itself proof codex ran and returned usable output. Confirm it renders legibly in the journal sidebar.
   - (b) Confirm the `warn` failure log is **empty** for that session (no `reason:*` events) — combined with (a), that establishes the codex path succeeded, not that it silently fell back.
   - (c) `/resume` that session and confirm the resumed room name is also `VPS · <repo> · <text>` (exercises the resume-path fix — the deploy check must cover `/resume`, not only `!start`).
   - Optional deeper check: temporarily set `DEBUG=1` and grep for the `codexOneShot` success `debug` line + `durationMs`.

## Out of scope (file as loops at ship)

- **matron-web pinned-summary UI** — lost in the journal client; later claude-design round. Non-urgent, separate repo (`easelyte/matron-web`).
- **`codex --output-schema` structured output** — would replace the `TITLE:`/`SUMMARY:` regex with a schema-validated JSON response (more robust); deferred to keep the prompt contract stable this pass.
- **Further prompt wording tweaks** — only the deterministic repo indicator ships here.
