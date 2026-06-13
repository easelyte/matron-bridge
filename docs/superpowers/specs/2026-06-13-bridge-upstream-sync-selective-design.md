---
title: Take-all upstream sync of claude-matrix-bridge (easelyte fork ← Matronhq)
date: 2026-06-13
status: proposal
scope: bridge-only (Node claude-matrix-bridge); no web/native changes
repo: easelyte/claude-matrix-bridge
work_branch: integrate/upstream-sync-20260613 (off integrate/bridge-fixes-20260605)
related_principles:
  - "Canonical source: our model stack (!model spawn-default) stays authoritative; Dan's /model is a complementary in-session surface, not a competing source"
  - "P51 Rollback mutation surface matches protection surface: forward mutation is branch + node_modules, so rollback must restore both"
  - "P14 Plans are executable specs: every PRESERVE item needs a checkable gate, not a prose 'diff against deployed branch'"
rejected_alternatives:
  - "Selective carve (defer Dan's /model + /effort): round-1 review + git topology showed the carve is MORE surgery than take-all — /model+/effort dispatch is inline in index.js and f0280b4 (a picker-tap guard we want) is interwoven with effort:/model: routing. Deferring leaves dormant half-wired code. Rejected."
  - "Maintain fork indefinitely without syncing: merge debt (39 behind) compounds. Deferred to a later upstream-and-track decision, out of scope here."
changelog:
  - "v2 (round-1 review): flipped selective-carve → take-all; added npm ci to deploy/rollback (sdk 0.100→0.102 bump); replaced 'diff against deployed branch' with an executable PRESERVE gate; corrected dedup (folded-paste pair DIFFERS, transcript-tail identical); added /model↔!model coexistence verification; drew branch topology. Tool-call cards (1b) removed from scope."
---

# Take-all upstream sync — claude-matrix-bridge

## Goal

Bring **all 39** of Dan's upstream commits into the deployed easelyte fork while **preserving our 62 fork-local commits**, including the dual model surfaces (his in-session `/model` picker + our `!model` spawn-default). Headline win: Dan's ask-user/buttons work (`#79/#80/#81`) upgrades the question UX that **every Matron client renders** (web `MButtonGroupBody`, native sheets), so all clients improve. Reduces merge debt to zero against canonical.

## Context

- Deployed bridge: `/opt/matron/bridge` @ `integrate/bridge-fixes-20260605` (`7ea062b`), run by `claude-matrix-bridge.service` (`node index.js`). **This service spawns the live operator Matrix↔Claude sessions** — restarting it kills active sessions.
- Divergence vs `upstream/master` (Matronhq): **39 ahead (theirs), 62 ahead (ours)**, merge-base `e78efed`. Read-only merge probe: **4 conflicting files** — `ask-user.js`, `index.js`, `lib/prompt-detector.js`, `test/prompt-detector.test.js`.
- Topology verified (round-1): `#79` is the question/buttons foundation (clean — even deletes `lib/mcp-question-gate.js`); `/model` + `/effort` dispatch is inline in `index.js` (≈ lines 3456–3961) and `f0280b4` (picker-tap guard) is interwoven with `effort:/model:` routing. This is **why we take it all** rather than carve.
- The fork is collaborative: `upstream` remote configured; Dan's master already merges our PRs (#67, #75). Upstreaming our 62 back is a separate later project.

## Why take-all (not carve)

Dan's `/model` (switch the *current* iv-session's model via picker buttons) and our `!model` (set the *persisted spawn-default*, plus Fable 5 allowlist + 1M-context spawn) are **complementary surfaces, not a conflict**: one mutates a live session, the other sets what new sessions spawn as. Taking both is simpler than surgically excluding one from an entangled refactor. The only real work is **verifying they coexist** (below).

## Scope

### Take (all 39)
Everything on `upstream/master` not already in our tree: `#79/#80/#81` (ask-user/buttons), `#72` (ask-user timeout-liveness), `f0280b4` (picker-tap guard), `/effort` (`lib/effort-command.js`), `/model` picker (`lib/model-command.js`, `lib/model-aliases.js`), prompt-detector hardening (`a106c76`), `/compact` busy-clear (`abe62de`), mcp-config fixes, dep bumps, and Dan's design/spec docs.

### Preserve (our 62 — executable gate, not prose)
Every fork-local behaviour must survive. The gate is the **PRESERVE checklist** in Testing — each item maps to a concrete check. Items: `!model`/Fable 5/1M-context spawn (canonical), inherit-default model, iv worktree dispatch (`!start --worktree`), `!role`/`!who`, `!label`, `!clearall`/`!flush`, `!esc` queue-jump, uploads→`uploads/` subdir, and our ask-user fixes (reverse-ordering `34776c1`, 30s surface window `626729b`, surface-after-explanation `ac59cee`, timeout-recovery `#2`, option line-breaks `#3`).

### Conflict resolution (the 4 files)
- **`ask-user.js`** — our ask-user fixes overlap Dan's `#79/#80/#81`. Resolve by **combining**: adopt his detector-owned-buttons structure + prose/option-descriptions; keep our surfacing-window / timeout-recovery / ordering behaviour. **Decision oracle:** the PRESERVE ask-user checks (Testing) are the pass/fail — a resolution is correct iff all of `34776c1`/`626729b`/`ac59cee`/`#2`/`#3` behaviours still pass AND `#80`/`#81` prose+descriptions render. Note: `#67`/`#75` were upstreamed from us, so some hunks are already-reconciled no-ops.
- **`index.js`** — take Dan's `#79` question refactor; re-apply our preserved features on top; keep BOTH `/model` (his) and `!model` (ours) dispatch entries.
- **`lib/prompt-detector.js`** — combine Dan's `a106c76` column-aware stripAnsi with our folded-paste fix. **Correction:** the folded-paste pair (theirs `96fe359` / ours `5118277`) is **NOT identical** — both must be reconciled by hand, not "keep ours." (Transcript-tail pair `b4a8695`/`ce309b1` *is* identical → no-op.)
- **`test/prompt-detector.test.js`** — union both test sets; reconcile expectations to the merged detector.

### Out of scope
- Tool-call cards / `tool_call`/`ask_user`/`session_meta` emission (**dropped** — was 1b).
- No web or native changes. No upstreaming our 62 (later).

## Integration strategy

Single `git merge upstream/master` on `integrate/upstream-sync-20260613` (already created off our HEAD), resolve the 4 conflicts per above, green the suite, live-smoke, then deploy deliberately. No carve, no dormant code.

## Testing

### Unit
`npm test` green — existing suite + Dan's incoming `test/effort-command.test.js`, `test/prompt-buttons.test.js`, `test/model-*.test.js`, plus the unioned `test/prompt-detector.test.js`.

### Coexistence verification (the take-all risk)
In live smoke: (a) `!model <x>` sets the spawn-default and a NEW session spawns as `<x>`; (b) Dan's `/model <y>` switches the CURRENT iv-session to `<y>` without mutating the persisted default; (c) the 1M-context variant still spawns (our `1e2a298`/`914bac0` path) and an in-session `/model` switch does not strip the `[1m]` variant unexpectedly; (d) Fable 5 remains in the `!model` allowlist. If (c) fails (e.g. `/model` re-spawns without 1M), document the interaction and gate `/model` to preserve the context-variant suffix.

### PRESERVE regression gate (executable — replaces "diff against branch")
Each item is a concrete check, run in the worktree smoke before deploy:
- `!start --worktree --prompt` → spawns an isolated worktree session; `!sessions` lists it.
- `!role`/`!who` → returns allowlist-scoped roles; `!label` → applies; `!clearall`/`!flush` → clears.
- `!esc` → interrupts the current turn (queue-jump).
- A file upload → lands in `uploads/`, not workdir root.
- Ask-user: trigger a question → option line-breaks render (`#3`), recommendation marker present, surfaces after its preceding explanation (`ac59cee`), and a timed-out question recovers without wedging (`#2`).
Any check failing blocks deploy.

### Live smoke harness
The bridge is a Matrix client, not a port-served app, so smoke needs a **separate bot identity + a scratch room the operator is NOT in** (or a throwaway homeserver), so it can't echo into live operator sessions. Run all of the above there against the worktree checkout — never the deployed service.

## Deploy & rollback

- **Blast radius:** deploy = update `/opt/matron/bridge`'s checkout to the reviewed branch + `systemctl restart claude-matrix-bridge.service`, which **terminates all active Matrix↔Claude sessions** (including the operator's). Announce in the operator's Matrix channel first; deploy when no session is mid-task (check the bridge session table / a grace period after the last bot message).
- **Dependency state (round-1 M1/Codex-M3):** upstream bumps `@anthropic-ai/sdk ^0.100.1 → ^0.102.0` (+lockfile). `git checkout` alone does NOT restore `node_modules`. Deploy = checkout → **`npm ci`** → restart. Rollback = checkout `integrate/bridge-fixes-20260605` → **`npm ci`** (restore old dep state) → restart. Pre-flight: confirm the checkout is clean (no stray state files) before switching.
- **Branch topology (round-1 M5):** `integrate/upstream-sync-20260613` is off `integrate/bridge-fixes-20260605` (the *currently deployed* tip, confirmed `7ea062b`), so rollback target == current deploy. Merging this to easelyte `master` later is a separate step; deploy can run directly off the integration branch checkout without going through `master`.
- **Rollback trigger:** any PRESERVE check or coexistence check failing post-deploy, or a startup crash → checkout old branch + `npm ci` + restart (one-step, branch is unchanged by this work).

## Follow-ups (not this spec)
- Upstream our 62 to Dan where generally useful (reduces future divergence; the collaborative-fork direction).
- Decide long-term: maintain fork vs track canonical + contribute. Out of scope.
