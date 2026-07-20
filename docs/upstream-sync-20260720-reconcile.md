# Upstream sync 2026-07-20 — reconcile record

**Strategy:** merge (continues the divergence-minimization approach from `upstream-sync-20260718-merge-strategy.md`).
**Branch:** `integrate/upstream-sync-20260720` off `journal-deploy`.
**Merge commit:** `Merge remote-tracking branch 'upstream/master' into integrate/upstream-sync-20260720`.
**Upstream:** `Matronhq/matron-bridge` `master`. Before: journal-deploy was 13 behind / 8 ahead. After: 0 behind, deltas replayed on top.

## Result: CLEAN merge — zero conflicts.
Upstream's changes and our deltas were disjoint (upstream touched `lib/spawn-guard.js` (new), `viewer/server.js`, `lib/viewer-tokens.js`, `lib/journal-publisher.js`, `lib/file-link-guard.js`, `lib/command-dispatch.js`, tests; our deltas live in `index.js` spawn sites + caption modules + `lib/iv-uploads.js`).

## Upstream commits brought in (13)
- `feat(viewer)`: signed `/download` route for binary artifacts + macOS guard fix; per-IP rate limit on `/download` via `express-rate-limit` (CodeQL `js/missing-rate-limiting`).
- `fix(spawn-guard)`: persist + report the guarded workdir on resume (new `lib/spawn-guard.js` + tests).
- `chore`: retire remaining user-facing Matrix strings.
- Supporting: `lib/journal-publisher.js` additions + tests, `package.json`/lock bumps.

## easelyte deltas verified intact (8)
- **root-permissions** (`d4fe89a`): `BRIDGE_ROOT_PERMISSIONS` const present at 3 sites (def + both spawn sites, lines ~1023 and ~1558 pass `--settings permissions: BRIDGE_ROOT_PERMISSIONS`). The root-blocked skip-permissions flag appears ONLY in the explanatory comment (line 94), passed nowhere. This is the load-bearing delta that lets the bridge spawn Claude as root (uid 0) — verified surviving per `procedure_matron_bridge_root_skip_permissions`.
- **journal media captions** (`a5c920d`, `810b28b`, PR #6): caption extraction/trim/clamp + delivery in iv and SDK modes — intact (`lib/journal-media.js`, `lib/journal-input-router.js`, `lib/iv-uploads.js`, `index.js`).
- **uploads-dir** (`c90fb1e`, PR #7): SDK-mode uploads saved to `<workdir>/uploads` — intact (`index.js:4385`, `lib/iv-uploads.js`).

## Verification
- `npm install` clean (audit warnings only, non-blocking).
- `npm test` (vitest): **962 passed / 7 skipped**, including the new upstream `spawn-guard`, `viewer-download`, and `journal-publisher` test suites.

## Deploy (NOT done here — deliberate operator step)
The live `matron-bridge-journal.service` still runs the pre-sync code from `/opt/matron/bridge-journal` (journal-deploy). To deploy: fast-forward `journal-deploy` to this merge, then `systemctl restart matron-bridge-journal.service` (disrupts active journal sessions — do when idle). Origin is `easelyte`; NEVER push to `upstream` (Matronhq).
