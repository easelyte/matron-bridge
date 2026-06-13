---
title: Take-all upstream sync of claude-matrix-bridge (easelyte fork ← Matronhq)
date: 2026-06-13
status: proposal
scope: bridge-only (Node claude-matrix-bridge); no web/native changes
repo: easelyte/claude-matrix-bridge
work_branch: integrate/upstream-sync-20260613 (off integrate/bridge-fixes-20260605)
related_principles:
  - "P14 Plans are executable specs: every PRESERVE item + every safety boundary needs a checkable gate"
  - "P51 Rollback mutation surface matches protection surface: forward mutation is branch + node_modules, so rollback restores both"
  - "Canonical source: our !model spawn-default stays authoritative; merged with Dan's in-session switch into ONE command"
rejected_alternatives:
  - "Selective carve (defer /model + /effort): topology showed the carve is MORE surgery than take-all (inline dispatch + f0280b4 interwoven). Rejected at round 1."
  - "Merged !model = keep ours unchanged, his via buttons only: zero regression but !model <x> stops switching the live session. Operator chose do-both. Rejected."
  - "Merged !model = subcommand split: more surface to remember. Rejected."
changelog:
  - "v3 (round-2 review): decided merged !model behavior (do-both + picker buttons) — corrects v2's wrong 'complementary /model vs !model' framing (both are !model; /model is only PTY text). Made PRESERVE gate exhaustive. Added executable smoke-isolation preflight, npm run ci deploy gate, node_modules snapshot rollback fallback. Renamed file (was -selective-)."
  - "v2 (round-1 review): selective-carve → take-all; npm ci in deploy/rollback; executable PRESERVE gate; dedup correction. Dropped tool-call cards (1b)."
---

# Take-all upstream sync — claude-matrix-bridge

## Goal

Bring **all 39** of Dan's upstream commits into the deployed easelyte fork while **preserving our 62**, merging the two model-switch features into one `!model` command. Headline win: Dan's ask-user/buttons work (`#79/#80/#81`) upgrades the question UX **every Matron client renders**. Reduces merge debt to zero against canonical.

## Context

- Deployed: `/opt/matron/bridge` @ `integrate/bridge-fixes-20260605` (`7ea062b`), run by `claude-matrix-bridge.service` (`node index.js`). **This service spawns the live operator Matrix↔Claude sessions** — restart kills active sessions.
- Divergence vs `upstream/master`: **39 ahead (theirs), 62 ahead (ours)**, merge-base `e78efed`. Merge probe: **4 conflicting files** — `ask-user.js`, `index.js`, `lib/prompt-detector.js`, `test/prompt-detector.test.js`.
- The fork is collaborative (`upstream` remote configured; Dan merges our PRs). Upstreaming our 62 is a later project.

## The `!model` merge (the one real design decision)

**Fact correction (round-2 code-trace):** both Matrix commands are `case '!model'` — there is NO `case '/model'` in upstream. `/model` is only the text Dan's handler types into Claude Code's TUI via `switchModelInSession`. So the merge is a **single-key collision** of two `!model` bodies:
- **Ours** (`resolveSpawnModelInput` + `MODEL_ALIASES`): sets the **persisted spawn-default** for new sessions; aliases `fable`/`fable-5`/`opus`/`opus-4-8|7|6`/`sonnet`/`sonnet-4-6`/`haiku`/`haiku-4-5`; 1M via a separate `1m` arg + `ONE_M_CAPABLE` set.
- **His** (`switchModelInSession` + `SWITCHABLE_ALIASES`): switches the **current iv-session** in place; aliases `default`/`opus`/`opus[1m]`/`sonnet`/`sonnet[1m]`/`haiku`/`opusplan`/`fable`; `1m` embedded in the alias.

**Decided merged behavior (operator pick — "do-both + picker buttons"):**
1. `!model <x>` → set `<x>` as the persisted spawn-default (ours) **AND**, if an active iv-session exists, switch it to `<x>` now (his). One command = "use this model now and going forward."
2. bare `!model` → show current model + Dan's picker buttons; tapping a chip switches the active session in-session.
3. **Alias registry:** union the two sets into one resolver — keep our `fable-5`, version-pins (`opus-4-8`), and the separate `1m` arg; add `opusplan` and `default`. Normalize so `opus 1m` (ours) and `opus[1m]` (his) resolve to the same target.
4. **1M preservation:** an in-session switch MUST preserve the `[1m]` context-variant suffix when the spawn-default carries it (don't silently drop to the 200k variant). This is the load-bearing coexistence invariant; its test is PRESERVE check (g) below.

Plan-stage owns the handler mechanics (single `!model` case with a unified resolver + a do-both body); this spec fixes the behavior contract above.

## Scope

### Take (all 39)
Everything on `upstream/master` not already in our tree: `#79/#80/#81` (ask-user/buttons), `#72` (ask-user timeout-liveness), `f0280b4` (picker-tap guard), `/effort` (`lib/effort-command.js`), the model picker (`lib/model-command.js`, `lib/model-aliases.js`), prompt-detector hardening (`a106c76`), `/compact` busy-clear (`abe62de`), mcp-config fixes, the `@anthropic-ai/sdk ^0.100.1→^0.102.0` bump, and Dan's docs.

### Preserve (our 62 — gated by the exhaustive PRESERVE checklist in Testing)
`!model` spawn-default + Fable 5 + 1M-context spawn, inherit-default model, iv worktree dispatch (`!start --worktree`), `!role`/`!who`, `!label`, `!clearall`/`!flush`, `!esc` queue-jump, uploads→`uploads/` subdir, and our ask-user fixes (reverse-ordering `34776c1`, 30s surface window `626729b`, surface-after-explanation `ac59cee`, timeout-recovery `#2`, option line-breaks `#3`).

### Conflict resolution (the 4 files)
- **`index.js`** — take Dan's `#79` refactor; re-apply our preserved features; resolve the `!model` collision per "The `!model` merge" above (one unified handler). `#67`/`#75` hunks are our own upstreamed work → already-reconciled no-ops.
- **`ask-user.js`** — combine: adopt Dan's detector-owned-buttons + `#80`/`#81` prose/descriptions; keep our surfacing-window/timeout-recovery/ordering. **Decision oracle = the full ask-user PRESERVE checks (d) below pass AND `#80`/`#81` render** — both clauses are concretely gated, so the oracle is non-circular.
- **`lib/prompt-detector.js`** — combine Dan's `a106c76` column-aware stripAnsi with our folded-paste fix. **The folded-paste pair (theirs `96fe359` / ours `5118277`) is NOT identical** — reconcile by hand. (Transcript-tail pair `b4a8695`/`ce309b1` IS identical → no-op.)
- **`test/prompt-detector.test.js`** — union both test sets; reconcile to the merged detector.

### Out of scope
Tool-call cards / `tool_call`/`ask_user`/`session_meta` emission (**dropped**). No web/native changes. No upstreaming our 62 (later).

## Integration strategy
Single `git merge upstream/master` on `integrate/upstream-sync-20260613`, resolve the 4 conflicts per above, pass the deploy gate, isolated live-smoke, deploy deliberately.

## Testing

### Deploy gate (round-2 Codex-M1): `npm run ci`, not just `npm test`
Run `npm run ci` (lint + `node --check` on `index.js`/`ask-user.js`/`lib/*.js` entry files + Vitest + audit). A manual conflict resolution can leave a parse error in a file Vitest never imports; `node --check` catches it before the service crashes at restart. Gate = `npm run ci` green.

### Live-smoke isolation preflight (round-2 Codex-B1) — BLOCKS smoke start
Before launching the worktree bridge, an executable preflight MUST assert ALL of: (i) the smoke bot MXID ≠ the production bot MXID; (ii) the target room is a dedicated scratch room the operator is NOT in; (iii) a separate session store / state dir (not the prod `anton/memory` or session DB); (iv) a separate `.env` (not the prod dotenv). If any assertion fails, the smoke harness aborts before connecting. Rationale: a worktree bridge launched with prod credentials/room would echo into live operator sessions.

### PRESERVE regression gate (exhaustive — each item an observable pass/fail; any failure blocks deploy)
Run in the isolated smoke (above):
- (a) `!start --worktree --prompt "<x>"` → isolated worktree session spawns; `!sessions` lists it.
- (b) `!role`/`!who` → allowlist-scoped roles; `!label <x>` applies; `!clearall`/`!flush` clears.
- (c) `!esc` → interrupts the current turn (queue-jump).
- (d) **Ask-user** — to trigger, send the smoke session a prompt that instructs CC to call `mcp__ask-user__ask_user` with a 3-option question carrying a `(Recommended)` tag (e.g. "ask me to pick a color, recommend blue, options red/green/blue"). Verify: option line-breaks render (`#3`), `(Recommended)`/⭐ marker present (`e9477f7`), reverse-ordering preserved (`34776c1`), the question surfaces AFTER its preceding explanation (`ac59cee`), Dan's option **descriptions** (`#80`) and **explanatory prose** (`#81`) render. Then trigger a second question and let it sit past the surface/answer timeout (the bridge's configured ask-user timeout, ~30s) → verify it recovers without wedging the session (`#2`/`626729b`).
- (e) File upload → lands in `uploads/`, not workdir root.
- (f) **`!model` spawn-default persistence across restart** — `!model opus 1m`, restart the bridge, start a NEW session → it spawns with `--model claude-opus-4-8[1m]` (proves our `1e2a298`/`914bac0` path survived the merge). Fable 5 remains accepted by `!model`.
- (g) **`!model` do-both + 1M preservation** — with an active session, `!model sonnet` switches it in-session AND updates the spawn-default; with a `[1m]` spawn-default active, an in-session switch preserves the `[1m]` suffix (does not drop to 200k). bare `!model` shows the picker buttons; tapping a chip switches in-session.
- (h) `/effort` (Dan's, newly taken) works without hanging/wedging the session.

### Coexistence is the take-all risk
Checks (f)+(g) are the coexistence verification — if (g)'s 1M-preservation fails, the plan must gate the in-session switch to re-append the spawn-default's `[1m]` suffix before writing `/model` to the PTY.

## Deploy & rollback

- **Blast radius:** deploy = update `/opt/matron/bridge`'s checkout → `npm ci` → `systemctl restart claude-matrix-bridge.service`, which **terminates all active sessions** (incl. the operator's). Announce in the operator's Matrix channel first; deploy when no session is mid-task (check the bridge session table / grace period after last bot message).
- **Dependency state (round-1 M1):** upstream bumps `@anthropic-ai/sdk ^0.100.1→^0.102.0`. `git checkout` does NOT restore `node_modules`; deploy includes `npm ci`.
- **Rollback (round-2 Codex-M2): snapshot fallback so rollback never depends on the registry.** BEFORE the deploy `npm ci`, `tar czf /opt/matron/bridge.node_modules.rollback.tgz -C /opt/matron/bridge node_modules` (snapshot the currently-deployed deps). Rollback = checkout `integrate/bridge-fixes-20260605` → restore `node_modules` from the snapshot (no network) → restart. `npm ci` is the clean path; the snapshot is the incident-time fallback when the registry/network is unavailable.
- **Topology (round-1 M5):** `integrate/upstream-sync-20260613` is off `integrate/bridge-fixes-20260605` (the *currently deployed* tip `7ea062b`), so rollback target == current deploy. Merging to easelyte `master` is a separate later step; deploy runs off the integration-branch checkout directly.
- **Rollback trigger:** any PRESERVE/coexistence check failing post-deploy, or a startup crash.

## Follow-ups (not this spec)
- Upstream our 62 to Dan (reduces future divergence).
- Long-term: maintain fork vs track canonical + contribute.
