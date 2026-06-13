---
title: Selective upstream sync of claude-matrix-bridge (easelyte fork ← Matronhq)
date: 2026-06-13
status: proposal
scope: bridge-only (Node claude-matrix-bridge); no web/native changes
repo: easelyte/claude-matrix-bridge
work_branch: integrate/upstream-sync-20260613 (off integrate/bridge-fixes-20260605)
related_specs:
  - docs/superpowers/specs/2026-06-12-matron-events-protocol.md (Phase-5 contract; consumed by follow-up 1b)
related_principles:
  - "Canonical source: keep one authoritative model stack (ours) rather than two switch surfaces in one pass"
  - "Fail loud: bridge must start clean post-merge; a half-merged dispatch table is worse than deferring"
rejected_alternatives:
  - "Full reconcile (merge Dan's /model picker WITH our !model in one pass): higher risk; deferred to a follow-up since the two surfaces are complementary, not mutually exclusive."
  - "Cards-first (build tool_call before syncing): builds on a soon-refactored index.js (Dan's #79), creating rework."
  - "Sync-only then stop: acceptable, but we want tool_call cards (1b) and prefer to sequence them on the synced base."
---

# Selective upstream sync — claude-matrix-bridge

## Goal

Bring Dan's high-value bridge improvements into the deployed easelyte fork **without losing our 62 fork-local commits** and **without** reconciling the dual model-switch surfaces in this pass. The headline win: Dan's ask-user/buttons work (`#79/#80/#81`) upgrades the question UX that **matron-web already renders** (via `MButtonGroupBody`), so web improves with zero web-side code. This is Tier 1a; tool-call cards (1b) build on the result.

## Context

- Deployed bridge: `/opt/matron/bridge` @ `integrate/bridge-fixes-20260605` (`7ea062b`), run by `claude-matrix-bridge.service` (`node index.js`). This service spawns the live Matrix↔Claude sessions.
- Divergence vs `upstream/master` (Matronhq): **39 commits ahead (theirs), 62 ahead (ours)**, merge-base `e78efed`.
- Read-only merge probe: **4 conflicting files** — `ask-user.js`, `index.js`, `lib/prompt-detector.js`, `test/prompt-detector.test.js`. Dan's `index.js` delta is a ~1.5k-line refactor centred on `#79 unify question handling as detector-owned buttons`.
- The fork is collaborative: `upstream` remote is configured; Dan's master already merges easelyte PRs (#67, #75). Our changes are wanted upstream eventually (separate follow-up).

## Scope

### INCLUDE (take from upstream)
- **Ask-user / buttons foundation:** `#79` (detector-owned buttons + question unification — this is the infra we want), `#80` (option descriptions), `#81` (explanatory prose), `#72` (ask-user timeout-liveness), `#67` (ask-user HTML rendering), `f0280b4` (picker taps don't eat a pending TUI prompt).
- **Prompt-detector hardening:** `a106c76` (column-aware stripAnsi / CHA→padding).
- **Stability:** `abe62de` (clear busy on manual `/compact` boundary).
- **Docs:** `2026-06-12-matron-events-protocol.md` (Phase-5 contract — needed for 1b), Dan's model/prompt-buttons design docs (reference only).

### DEFER (do NOT wire in this pass)
- **Dan's `/model` picker command** (`56ba560`, `78a0feb`, `efc07cd`, `a91cf26`, `9fb9073`, `c602a7c` merge) and `lib/model-command.js` / `lib/model-aliases.js`. Rationale: our `!model` (persisted spawn-default), Fable 5 allowlist, and 1M-context spawn are canonical. Dan's `/model` is an **in-session** switch — *complementary*, not conflicting — so it can be added in a later pass. Keeping it out now removes the only true semantic conflict.
- **Dan's `/effort` command** (`2f2cb13`, `26aed99`). It is a **consumer of the `#79` picker-button infra** and is coupled to `/model` handling ("handle /effort like /model"). Take the `#79` infra; leave `/effort` unwired this pass.

### DEDUP (keep ours, drop their duplicate)
- Transcript-tail final-line fix: theirs `b4a8695` ≈ ours `ce309b1` → keep ours.
- Folded-paste arrow-menu detector fix: theirs `96fe359` ≈ ours `5118277` → keep ours.

### PRESERVE (our 62 — must survive untouched in behaviour)
Model stack (`!model`, Fable 5, 1M-context, inherit-default), iv worktree dispatch (`!start --worktree`), `!role`/`!who`, `!label`, `!clearall`/`!flush`, `!esc` queue-jump, uploads-to-`uploads/` subdir, and our ask-user fixes (reverse-ordering `34776c1`, 30s surface window `626729b`, surface-after-explanation `ac59cee`, timeout-recovery `#2`, option line-breaks `#3`). Note: our ask-user fixes overlap Dan's `#79/#80/#81` — at each `ask-user.js`/`index.js` conflict, **combine intent** (keep our surfacing/timeout behaviour; adopt his detector-owned-buttons structure + prose/descriptions). This is the highest-judgment part of the merge.

### OUT OF SCOPE (explicit non-goals)
- No `chat.matron.tool_call` / `ask_user` / `session_meta` emission (that's 1b / D-later).
- No web or native changes.
- No upstreaming our 62 to Dan (separate follow-up).

## Integration strategy: merge-then-carve

Prefer a single `git merge upstream/master` over per-commit cherry-pick, because `#79` is a foundational refactor everything else sits on — cherry-picking around it onto our diverged `index.js` would multiply conflicts. Steps (detailed sequencing belongs to the plan):

1. On `integrate/upstream-sync-20260613` (already created off our HEAD), `git merge upstream/master`.
2. Resolve the 4 conflicts by the per-file intent below.
3. **Carve:** ensure `/model` and `/effort` slash handlers are NOT registered in the command dispatch; do not ship `lib/model-command.js` / `lib/model-aliases.js` as active (delete or leave unimported). Our model code stays canonical at every model-touching conflict site.
4. Dedup the two duplicate fixes (keep ours).
5. Green the test suite; live-smoke in the worktree against a scratch room before any service restart.

### Per-file conflict intent
- **`ask-user.js`** — adopt Dan's detector-owned-buttons + prose/descriptions structure; retain our surfacing-window / timeout-recovery / ordering behaviour. Combine, don't pick-a-side.
- **`index.js`** — take Dan's `#79` question-handling refactor; re-apply our preserved features (worktree dispatch, role/label/clearall/esc, uploads, model spawn) on top; **omit** `/model` + `/effort` dispatch entries.
- **`lib/prompt-detector.js`** — take Dan's `a106c76` column-aware stripAnsi; keep our folded-paste fix (dedup vs his `96fe359`).
- **`test/prompt-detector.test.js`** — union of both test sets; reconcile expectations to the merged detector.

## Testing

- **Unit:** `npm test` green (existing bridge suite + Dan's new `test/*` for prompt-detector/buttons that we keep). New model-command/effort tests we defer are excluded with the commands.
- **Live smoke (worktree, scratch room, separate port/session — never the deployed service):** start a session, exercise: a buttons/ask-user question (verify prose + option descriptions render and answer correlates), `!model`/Fable 5/1M spawn still works, `!start --worktree`, `!role`/`!label`/`!clearall`/`!esc`, a file upload lands in `uploads/`. Confirm `/model` and `/effort` are absent (not half-wired).
- **Regression guard:** diff our preserved-feature behaviours against the deployed branch.

## Deploy & rollback

- **Blast radius:** deploying = `git checkout` the synced branch in `/opt/matron/bridge` + `systemctl restart claude-matrix-bridge.service`, which **terminates all active Matrix↔Claude sessions** (including the operator's). Deploy deliberately, when no critical session is mid-flight; announce first.
- **Deploy:** fast-forward `/opt/matron/bridge` working checkout to the reviewed branch (or merge to easelyte `master` and check that out), `systemctl restart claude-matrix-bridge.service`, verify health + a smoke question.
- **Rollback:** `git checkout integrate/bridge-fixes-20260605` in `/opt/matron/bridge` + restart. The branch is unchanged by this work, so rollback is one checkout.

## Follow-ups (not this spec)
- **1b — tool-call cards** end-to-end against the Phase-5 `chat.matron.tool_call` contract (bridge emit + web `MToolCallBody`), contributed back so native lights up too.
- **Model reconcile** — add Dan's in-session `/model` picker alongside our `!model` (complementary surfaces).
- **Upstream our 62** to Dan where generally useful.
