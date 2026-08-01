---
title: "Plan — Bridge summary/title: Gemini → codex exec"
slug: bridge-summary-codex-migration
date: 2026-08-01
spec: docs/superpowers/specs/2026-08-01-bridge-summary-codex-migration-design.md
repo: easelyte/claude-matrix-bridge
base_branch: journal-deploy
feature_branch: summary-codex-migration
risk: medium
execution_tier: slim
related_principles: [V3, V3a, V8, P3, P7, P8, P33, P34, P53, P67, R501]
---

# Plan — Bridge summary/title generation: Gemini → codex exec (ChatGPT subscription)

Implements `docs/superpowers/specs/2026-08-01-bridge-summary-codex-migration-design.md` (rev 5, approved). Replaces the bridge's metered Gemini summary/title generation with a one-shot `codex exec` against the flat-rate ChatGPT subscription; adds a deterministic repo indicator to conversation titles; changes the room-name prefix `VPS-journal` → `VPS`; removes the `@google/generative-ai` dependency.

**Working tree:** `/root/bridge-summary-codex` (worktree off `origin/journal-deploy`). All paths below are relative to it. Do NOT touch the live `/opt/matron/bridge-journal` checkout (on another window's `agent-inline-media` branch).

**Logging convention (grounded 2026-08-01):** the bridge has no structured-event framework — `console.warn('[summary] …', {fields})` is always-visible; `debug(...)` is `DEBUG=1`-gated. "Structured warn event" in the spec = `console.warn` with a `[summary]` prefix + a fields object; success/non-failure = `debug()`.

## Dependency graph

- **Phase 1** (codex-oneshot module) and **Phase 2** (title formatter) are independent — parallelizable.
- **Phase 3**: T-3.1 (`lib/pinned-summary`) depends on Phase 1 (`codexOneShot`) + Phase 2 (`formatRoomTitle`); T-3.2 (wire) depends on T-3.1; T-3.3 (resume path) depends on Phase 2; T-3.4 (tests) depends on T-3.1/T-3.2.
- **Phase 4** (cleanup + verification + deploy runbook) depends on Phase 3.

## Spec-coverage map

| Spec part | Task(s) |
|---|---|
| Goal 1 (codex exec replaces Gemini) | T-1.1, T-3.1, T-3.2 |
| Goal 2 (repo indicator in title) | T-2.1, T-3.1, T-3.3 |
| Goal 3 (prefix VPS, all sites) | T-2.1, T-3.1, T-3.3, T-4.3 |
| Goal 4 (remove dep + key, verified) | T-2.1 (comment), T-3.2 (import), T-4.1 (manifest), T-4.2 (grep) |
| §1 codex-oneshot (argv, scrubbed-env, timeout-validation, listeners, bounded output, return shape) | T-1.1, T-1.2 |
| §2 summary flow (kill-switch, in-flight + global-cap, compaction commit/cap/retry, fallback) | T-3.1, T-3.2, T-3.4 |
| §3 formatRoomTitle / repoLabel / all-three sites | T-2.1, T-2.2, T-3.1 (LLM+fallback), T-3.3 (resume) |
| §Observability (warn/debug contract) | T-3.1, T-3.4 |
| §Security (argv mitigations + scrubbed env) | T-1.1, T-1.2 (asserts) |
| §Testing | T-1.2, T-2.2, T-3.4 |
| §Deploy plan (incl. service-user preflight) | T-4.3 (runbook; execution operator-gated) |

---

## Phase 1 — codex-oneshot helper module

### T-1.1: Write `lib/codex-oneshot.js`

- [ ] Create `lib/codex-oneshot.js` exporting `async function codexOneShot(prompt, opts)` per spec §1.
- [ ] Options + defaults: `model = process.env.SUMMARY_CODEX_MODEL || null`, `timeoutMs = parseTimeout(process.env.SUMMARY_CODEX_TIMEOUT_MS)`, `cwd = os.tmpdir()`, `spawnImpl = nodeSpawn`, `command = 'codex'`. Consts `KILL_GRACE_MS = 3000`, `MAX_OUTPUT_BYTES = 256*1024`, `MAX_TEXT_CHARS = 4096`, `DEFAULT_TIMEOUT_MS = 60000`, `MIN_TIMEOUT_MS = 1000`, `MAX_TIMEOUT_MS = 300000`.
- [ ] **Timeout input validation (Codex-r1 M3, P8):** `parseTimeout(v)` → `Number.isInteger(n) && n >= MIN && n <= MAX ? n : DEFAULT` (rejects `-1`, `Infinity`, `NaN`, non-integer, out-of-range — `Number(v) || 60000` accepts negatives/Infinity as truthy). Export `parseTimeout` for unit testing.
- [ ] Build argv directly (do NOT reuse `buildCodexExecArgs`): `['exec','--json','--skip-git-repo-check','-s','read-only','-c','approval_policy="never"','--ignore-user-config','--ephemeral', ...(model?['-m',model]:[]), '-']`.
- [ ] **Scrubbed env (Codex-r1 B1, R500/R501/P67):** spawn with a MINIMAL env — `{ PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) }` — NOT `process.env`. Codex needs only PATH (find binary), HOME/CODEX_HOME (subscription auth in `~/.codex/auth.json`); passing the full bridge env would expose tokens/HMAC_SECRET/etc. to a process fed hostile `chatHistory`. Read-only blocks writes/network but not reads, so the summarizer must not have secrets in its env to read. (The general read-only-FS-read residual is operator-accepted; this env-scrub is a distinct, free tightening.)
- [ ] Spawn via `spawnImpl(command, args, { cwd, env: scrubbedEnv, stdio: ['pipe','pipe','pipe'] })` inside `try/catch` (sync-throw → resolve `spawn-error`).
- [ ] Attach `child.on('error', …)` → resolve `{text:null, reason:'spawn-error'}` (async ENOENT/EACCES; unhandled would crash the bridge).
- [ ] Attach `child.stdin.on('error', …)` BEFORE `child.stdin.end(prompt)` → resolve `stdin-error` on EPIPE.
- [ ] Accumulate `stdout`/`stderr`; enforce `MAX_OUTPUT_BYTES` on each — on exceed, kill child (SIGTERM→SIGKILL) and resolve `output-overflow`. Parse JSONL lines; retain the `text` of the last `item.completed` with `item.type==='agent_message'`, truncated to `MAX_TEXT_CHARS`.
- [ ] Timeout: `setTimeout(timeoutMs)` → `child.kill('SIGTERM')`; if not closed within `KILL_GRACE_MS` → `child.kill('SIGKILL')`; resolve `timeout`. Clear timer on close.
- [ ] Single guarded `resolveOnce()` funnels every exit path (close, error, stdin-error, timeout, overflow) — no double-resolve. On clean `close`: `exitCode!==0` → `nonzero-exit`; no text → `no-output`; else success `reason:null`.
- [ ] Return `{ text, reason, exitCode, signal, durationMs }` (durationMs from a start captured at spawn; NOTE `Date.now()` is fine in the bridge runtime — this is not a workflow script). Never throws.
- **Acceptance:** module imports clean (`node --check lib/codex-oneshot.js`); every listed listener/guard present; argv exactly matches spec §Security mitigations.

### T-1.2: Tests `test/codex-oneshot.test.js`

- [ ] vitest suite; mock `spawnImpl` returning a fake child = EventEmitter with `stdout`/`stderr` EventEmitters and `stdin` = EventEmitter with an `end` spy and `kill` spy.
- [ ] Cases (spec §Testing): success (`item.completed` agent_message + `close(0)` → `{text, reason:null, exitCode:0}`); multiple agent_messages → last; `close(1)` → `nonzero-exit`; no agent_message → `no-output`; timeout (fake timers) → SIGTERM then SIGKILL after grace, resolves once; stdin `error` → `stdin-error`; **async child `error` ENOENT (after spawn returns) → `spawn-error`, no throw**; sync `spawnImpl` throw → `spawn-error`; **output overflow (stdout chunk > MAX_OUTPUT_BYTES) → child killed, `output-overflow`, accumulated buffer bounded**; argv includes `-s read-only`, `approval_policy="never"`, `--ignore-user-config`, `--ephemeral`, `-m` iff `SUMMARY_CODEX_MODEL` set.
- [ ] **env-scrub assertion (Codex-r1 B1):** capture the `env` passed to `spawnImpl` — assert it contains only PATH/HOME/(CODEX_HOME) and does NOT contain a sentinel secret (e.g. set `process.env.HMAC_SECRET='SENTINEL'` in the test and assert it's absent from the spawn env).
- [ ] **parseTimeout unit tests (Codex-r1 M3):** `'-1'`, `'Infinity'`, `'0'`, `'abc'`, `'999999999'` (>max), `''`, unset → `DEFAULT_TIMEOUT_MS`; a valid in-range integer string → that value.
- **Acceptance:** `npx vitest run test/codex-oneshot.test.js` green; all spec §Testing bullets present incl. env-scrub + parseTimeout.

---

## Phase 2 — Repo-aware title formatter

### T-2.1: Add `formatRoomTitle` + `repoLabel` to `lib/journal-title-seed.js`

- [ ] Export `formatRoomTitle({ serverLabel, workdir, text, defaultWorkdir })` → `${serverLabel} · ${repo}` and, when `text`, `${serverLabel} · ${repo} · ${text}`.
- [ ] Export `repoLabel(workdir, { defaultWorkdir })`: `path.resolve(workdir) === defaultWorkdir` → `'son-of-anton'`; else `path.basename(path.resolve(workdir))`. Cap to 24 chars with trailing `…` on overflow. (No hardcoded `/root/.openclaw/workspace` literal — `defaultWorkdir` is a parameter; V3a/Codex-r2 M3.)
- [ ] `<text>` cap: 60 chars with trailing `…` (same ellipsis convention; Claude-r2 M1/#8).
- [ ] Rewrite `applyFallbackTitle` — **keep the `(session, opts)` shape** (first positional `session` is load-bearing: reads `session._fallbackTitleApplied`/`chatHistory`/`claudeSessionId`/`roomId`). Add `defaultWorkdir` to the `opts` bag. Build the name via `formatRoomTitle` (drop the `${serverLabel}:${sessionShort} ${text}` literal; `:xx` id removed).
- [ ] **Comment residue (Codex-r1 B3):** the module header comment at `lib/journal-title-seed.js:3` mentions `GEMINI_API_KEY` — rewrite it (the LLM rename now runs via codex, not a Gemini key) so the T-4.2 residue grep passes. Also update the "Same title format as the LLM rename (`label:xx <text>`)" comment to the new `VPS · <repo> · <text>` shape.
- **Acceptance:** `node --check lib/journal-title-seed.js`; `formatRoomTitle`/`repoLabel` exported; `applyFallbackTitle` still `(session, opts)`; no path literal (`grep -n "openclaw/workspace" lib/journal-title-seed.js` → zero); no `GEMINI_API_KEY` token (`grep -n GEMINI_API_KEY lib/journal-title-seed.js` → zero).

### T-2.2: Tests `test/journal-title-seed.test.js` (extend)

- [ ] `formatRoomTitle` shapes: with/without text; ellipsis on 60-char text overflow AND 24-char repo overflow; no `:xx` id.
- [ ] `repoLabel`: `workdir === defaultWorkdir` → `son-of-anton`; other path → basename; overflow → `…`.
- [ ] `applyFallbackTitle` produces `VPS · <repo> · <text>` (update existing assertions from the old `label:xx text` shape).
- **Acceptance:** `npx vitest run test/journal-title-seed.test.js` green.

---

## Phase 3 — Summary-flow extraction + index.js integration

> **Extraction rationale (Claude-r1 B2 / Codex-r1 M1):** `index.js` exports nothing, is never imported by any test, and runs top-level side effects on import (`apiServer.listen`, unguarded `main()` → `process.exit(1)` on missing env). Testing its logic requires the repo's established pattern: extract to a `lib/*.js` module with dependency injection + exports, and leave a thin wrapper in `index.js`. T-3.1 does the extraction; T-3.2 wires the thin wrapper; T-3.4 tests the module + one real-wrapper wiring test.

### T-3.1: Extract summary orchestration to `lib/pinned-summary.js`

- [ ] Create `lib/pinned-summary.js` exporting `async function updatePinnedSummary(session, deps)` — deps injected: `{ codexOneShot, formatRoomTitle, applyFallbackTitle, persistSession, updateRoomName, debug, warn, serverLabel, defaultWorkdir, env = process.env }`. All summary logic lives here (index.js keeps only a thin wrapper, T-3.2).
- [ ] **Test-isolation seam for the module-level counter (Claude-r3 major-2):** export a test-only `__resetConcurrency()` that sets `activeCount = 0`, so the `test/pinned-summary.test.js` suite (one shared module instance under vitest) can reset counter state in `beforeEach` — otherwise the "load-bearing" symmetry test can see stale state bleed from prior cases.
- [ ] Kill-switch: `const enabled = (env.SUMMARY_CODEX_ENABLED ?? '1') !== '0'` — disabled → `applyFallbackTitle(session, { serverLabel, updateRoomName, workdir: session.workdir, defaultWorkdir })` (**note `(session, opts)` — session is the first positional; Claude-r1 B1/Codex-r1 B2**), `debug('[summary] kill-switch', { killSwitch:true })`, return.
- [ ] Trigger unchanged: `chatHistory.length >= 5 && length % 5 === 0`.
- [ ] Per-session in-flight guard: `if (session._summaryInFlight) return;` set after trigger check, clear in a `finally`.
- [ ] **Global concurrency cap (Codex-r1 M4) — counter symmetry is load-bearing (Claude-r2):** module-level `let activeCount = 0`; `const MAX = parseMaxConcurrent(env.SUMMARY_CODEX_MAX_CONCURRENT)`. Check-and-skip BEFORE incrementing: `if (activeCount >= MAX) { debug('[summary] at-capacity', {activeCount}); return; }` (place this check alongside the in-flight guard, before any increment). Then wrap ONLY the actual codex work in a dedicated nested block: `activeCount++; try { …compaction + title work… } finally { activeCount--; }` — the increment and decrement are paired in their OWN scope, NOT the in-flight-guard's `finally`. An at-capacity skip returns before incrementing, so it never decrements → no negative drift. **`parseMaxConcurrent(v)`** mirrors `parseTimeout`: `Number.isInteger(n) && n >= 1 && n <= 32 ? n : 2` (rejects `-1`/`Infinity`/`1.5`/`NaN` — do NOT reuse the `Number()||2` anti-pattern that round-1 already fixed for timeout). Export for unit testing.
- [ ] Compaction (>15 bullets): `await codexOneShot(compactPrompt)`; success → cap ≤400 chars, set `session.pinnedSummaryText`, `persistSession(...)` immediately (before title call), `session._compactionFailures = 0`; failure → `session._compactionFailures = (session._compactionFailures||0)+1`, `warn('[summary] compaction failed', { reason, exitCode, signal, durationMs, model: env.SUMMARY_CODEX_MODEL||null })` (**full field set — Claude-r1 minor**), and while `>= 2` skip the compaction call. Emit the skip `warn` **once at the threshold crossing** (when the counter reaches 2), not on every subsequent skip (Codex-r1/Claude-r1 minor — resolves the cadence ambiguity).
- [ ] Title+summary: `const r = await codexOneShot(prompt)`; `r.text==null` → `applyFallbackTitle(session, { serverLabel, updateRoomName, workdir: session.workdir, defaultWorkdir })` + `warn('[summary] failed', { reason:r.reason, exitCode:r.exitCode, signal:r.signal, durationMs:r.durationMs, model:env.SUMMARY_CODEX_MODEL||null })`, return. Success → parse `TITLE:`/`SUMMARY:`/`NEW:` (unchanged regex). **Restore the baseline `if (titleMatch)` null-guard (Claude-r2 — baseline index.js:4404-4412 guards the rename):** only `updateRoomName(session.roomId, formatRoomTitle({ serverLabel, workdir: session.workdir, text: titleMatch[1].trim(), defaultWorkdir }))` when `titleMatch` is present; else `debug('[summary] no title match', {})` and keep the existing room name (NO crash, NO fallback-title thrash). Then accumulate summary (guarded on `summaryMatch`/`newMatch` as baseline), `persistSession(...)`. Emit a SINGLE terminal debug line (Claude-r3 minor — no title match already logged its own debug; don't also emit `[summary] ok` for the malformed case): `debug('[summary] ok', { durationMs:r.durationMs })` only on the `titleMatch`-present path.
- [ ] **"malformed" defined (Claude-r2 reconciliation):** "malformed" = codex returned non-null `text` that fails the `TITLE:` regex → the null-guard branch above (debug, keep title). This is distinct from `r.text==null` (a codex *failure* → `warn` + fallback). T-3.4's log-level test asserts malformed → debug-only (no warn); `r.text==null` → warn.
- [ ] Log-level contract: codex *failures* (`r.text==null`, compaction failure) → `warn`; kill-switch / malformed (no `TITLE:` match) / in-flight / at-capacity / success → `debug`.
- **Acceptance:** `node --check lib/pinned-summary.js`; module exports `updatePinnedSummary`; every `applyFallbackTitle` call is `(session, opts)`; no `genAI`/Gemini reference.

### T-3.2: Wire the thin wrapper in `index.js`

- [ ] Replace the body of `maybeUpdatePinnedSummary(session)` with a thin wrapper that calls `updatePinnedSummary(session, { codexOneShot, formatRoomTitle, applyFallbackTitle, persistSession, updateRoomName, debug, warn: (...a)=>console.warn(...a), serverLabel: SERVER_LABEL, defaultWorkdir: DEFAULT_WORKDIR })`. Keep the call site at `index.js:3496` unchanged (still fire-and-forget) — but the wrapper `await`s + `.catch(e => debug('[summary] wrapper error', e))` internally so no rejection escapes the unawaited call.
- [ ] Remove `import { GoogleGenerativeAI } from '@google/generative-ai'` and the `genAI` const.
- [ ] Import `codexOneShot` from `./lib/codex-oneshot.js`, `updatePinnedSummary` from `./lib/pinned-summary.js`, `formatRoomTitle` from `./lib/journal-title-seed.js`.
- **Acceptance:** `node --check index.js`; no `genAI`/`GoogleGenerativeAI`/`@google/generative-ai` reference in index.js; the fire-and-forget call cannot produce an unhandled rejection (wrapper catches).

### T-3.3: Route the resume-path title site through `formatRoomTitle`

- [ ] Resume site (`index.js:4967-4968`): replace the `${SERVER_LABEL}: <summary>` / `${SERVER_LABEL}: Resumed <id>` literals with `formatRoomTitle({ serverLabel: SERVER_LABEL, workdir: session.workdir, text: summary || (\`Resumed \${shortId}\`), defaultWorkdir: DEFAULT_WORKDIR })` (Claude-spec #1 — the round-1 headline bypass). **Use `session.workdir`, and compute `roomName` AFTER `createSession` runs (Claude-r3 major-1):** `createSession` can degrade a pruned/missing `actualWorkdir` to a fallback and rewrite `session.workdir`; computing the title from the pre-degradation `actualWorkdir` would show a nonexistent repo in the title while the room notice says that workdir is gone. `session.workdir` is the corrected value. Preserve the `Resumed <id>` text when there's no summary.
- [ ] Grep-verify no other `${SERVER_LABEL}:` title constructions remain unrouted.
- [ ] **Update the two `/help` strings (Claude-r2 minor, index.js:5282 plain + 5325 HTML):** `"Room names show the server (${SERVER_LABEL}) and first message summary"` → mention the repo segment + topic (e.g. `"Room names show <server> · <repo> · <topic>"`). These use `(${SERVER_LABEL})` not the colon form, so the grep above won't catch them.
- **Acceptance:** `grep -n 'SERVER_LABEL}:' index.js` → zero; resume path uses `formatRoomTitle`; `/help` strings describe the new format.

### T-3.4: Tests — `lib/pinned-summary` branches + real-wrapper wiring

- [ ] `test/pinned-summary.test.js` (vitest, inject doubles for every dep; **`beforeEach(() => __resetConcurrency())`** to isolate the module-level counter — Claude-r3): in-flight guard skips a concurrent entry; global-cap skips when `activeCount >= MAX` (no codexOneShot call); **counter symmetry (Claude-r2)** — after N at-capacity skips interleaved with M completed runs, `activeCount` returns to 0 (never drifts negative); **`parseMaxConcurrent` unit tests (Claude-r2)** — `'-1'`/`'Infinity'`/`'1.5'`/`'0'`/`'abc'`/`''`/`'99'`(>32) → 2, valid in-range int → that value; compaction persisted (+ ≤400 cap) before title call; `_compactionFailures` resets on success, skips after 2, warns once at threshold; kill-switch emits no codexOneShot call and calls `applyFallbackTitle(session, opts)`; title-success routes through `formatRoomTitle`; **malformed (non-null text, no `TITLE:` match) → keeps existing room name, no crash, no fallback, `warn` NOT called (Claude-r2)**; `r.text==null` → fallback + `warn`. **Log-level contract:** codex failures (`r.text==null`, compaction failure) → `warn` fires; kill-switch/malformed/in-flight/at-capacity/success → `warn` NOT called (debug only).
- [ ] **Wiring test (Codex-r1 M1):** one test importing the real `updatePinnedSummary` and invoking it with a spy `codexOneShot` + spy `persistSession`/`updateRoomName`, asserting the production dep-wiring (persist-before-title ordering + fallback-on-null) holds — proves the extracted module is actually exercised as wired, not just in isolation.
- [ ] Resume-path formatting is verified via the `formatRoomTitle` unit tests (T-2.2) + the deploy `/resume` check (T-4.3), NOT a unit test (it's inline in the un-exported resume handler — extracting that is out of scope; documented deliberate exception).
- **Acceptance:** `npx vitest run test/pinned-summary.test.js` green; wiring test + log-level assertions present.

---

## Phase 4 — Cleanup, verification, deploy runbook

### T-4.1: Remove `@google/generative-ai` from manifests + update check script

> (The `index.js` import/const removal is in T-3.2; the `journal-title-seed.js` comment residue is in T-2.1.)

- [ ] `npm uninstall @google/generative-ai` — removes it from `package.json` dependencies and regenerates `package-lock.json`.
- [ ] Add `&& node --check lib/codex-oneshot.js && node --check lib/pinned-summary.js` to the `check` script's file list in `package.json` (repo convention — enumerate every new module).
- **Acceptance:** `npm ls @google/generative-ai` reports absent; `npm run check` includes both new lib modules.

### T-4.2: Residue-scan acceptance (source + manifests)

- [ ] `grep -rn "generative-ai\|GoogleGenerativeAI\|GEMINI_API_KEY" --include='*.js' . | grep -v node_modules` → zero.
- [ ] `grep -n "generative-ai" package.json package-lock.json` → zero.
- **Acceptance:** both greps zero-hit (deploy-env `.env` grep deferred to T-4.3, runs on the live host).

### T-4.3: Deploy runbook (documentation; execution operator-gated)

- [ ] Append a "Deploy" section to this plan (or a sibling runbook doc) capturing the operator-gated steps: (0) **precondition** — `/opt/matron/bridge-journal` must be on `journal-deploy` clean at the merged SHA (currently on `agent-inline-media`; coordinate with that window before restart — restart kills live sessions); (1) **service-user codex preflight (Codex-r1 M2)** — BEFORE removing the Gemini dep, run a bounded probe as the service identity/env to prove codex resolves + auth works: `sudo -u <svc-user> env -i PATH=$PATH HOME=<svc-home> bash -c 'echo "reply TITLE: ok" | codex exec --json --skip-git-repo-check -s read-only -c approval_policy=\"never\" --ignore-user-config --ephemeral -'` (or `systemd-run` with the unit's exact User=/Environment=) → expect an `agent_message`; no conversation data. If it fails (PATH/HOME/CODEX_HOME/auth), fix before proceeding — else every prod summary silently falls back; (2) edit `/opt/matron/bridge-journal/.env`: `SERVER_LABEL=VPS`, remove `GEMINI_API_KEY`; `grep -n GEMINI_API_KEY .env` → zero; (3) `npm ci`; (4) `systemctl restart matron-bridge-journal.service`; (5) **verify** per spec §Deploy step 5: `!start` → 5 messages → title `VPS · <repo> · <topic>` (a meaningful topic, not the deterministic fallback) + empty `[summary]` warn log for the session; `/resume` → resumed title also `VPS · <repo> · <text>`; optional `DEBUG=1` grep for the `[summary] ok` debug line.
- [ ] **Document the new env knobs (Claude-r2 minor):** if the repo has an `.env.example`/`.env.sample`, add `SUMMARY_CODEX_ENABLED` (default 1), `SUMMARY_CODEX_MODEL` (default codex default), `SUMMARY_CODEX_TIMEOUT_MS` (default 60000), `SUMMARY_CODEX_MAX_CONCURRENT` (default 2) with one-line comments so the kill-switch/cap are operator-discoverable. If no example file exists, note the knobs in this runbook section instead.
- [ ] Rollback note: `git -C /opt/matron/bridge-journal checkout <prev>` + `npm ci` + restart; `.env` revert.
- **Acceptance:** runbook section present with precondition, steps, verify, rollback. Do NOT execute deploy in this plan — it is operator-gated on the branch-contention resolution.

### T-4.4: Full verification gate

- [ ] `npm run test` → all green (existing + new).
- [ ] `npm run check` → clean (includes new `lib/codex-oneshot.js`).
- [ ] `npm run lint` (`--max-warnings=0`) → clean.
- **Acceptance:** all three gates green; no new lint warnings.

---

## Out of scope (file as loops at ship)

- **matron-web pinned-summary UI** — reintroduce the lost pinned-summary surface (later claude-design round). Separate repo `easelyte/matron-web`, non-urgent.
- **`codex --output-schema`** structured output instead of regex parsing — deferred (spec Out-of-scope).

## Appendix: Verified Claims (research pass 2026-08-01)

✓ Claim: `codex exec` in codex-cli 0.146.0 supports `--ephemeral`, `--ignore-user-config` (skips config.toml, keeps CODEX_HOME auth), and `-s/--sandbox` (read-only/workspace-write/danger-full-access). Verified: `codex --version` + `codex exec --help` — all flags present with described semantics.
✓ Claim: `-s read-only` blocks outbound network by default (no `-c` override). Verified: openai/codex source `codex-rs/protocol/src/protocol.rs` — `SandboxPolicy::ReadOnly { network_access: false }` by default; `-s read-only` maps to it with no per-flag network toggle. Grounds the §Security "network is blocked" posture.
✓ Claim: an unhandled `'error'` event on a Node ChildProcess terminates the process. Verified: nodejs.org/api/events.html. Grounds T-1.1's mandatory `child.on('error')`.
✓ Claim: `spawn()` with a missing binary emits async `'error'` (ENOENT), not a sync throw. Verified: nodejs.org/api/child_process.html. Grounds T-1.1's dual sync-catch + async-listener design.
✓ Claim: writing to a fast-exiting child's stdin yields EPIPE on the stdin stream, needing an `'error'` listener. Verified: nodejs/node#40085, #48786. Grounds T-1.1's `child.stdin.on('error')` before `end()`.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
