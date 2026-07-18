# Upstream sync merge strategy — journal-deploy ← upstream/master

**Status:** PHASE 1 ANALYSIS — awaiting operator review. Nothing merged, nothing pushed.
**Date:** 2026-07-18
**Analyst:** Claude (bridge session), grounded against actual files/diffs + a non-destructive dry-run merge.

## Coordinates

| | |
|---|---|
| Fork branch | `journal-deploy` @ `4cf75e0` (origin = `easelyte/claude-matrix-bridge`) |
| Upstream | `upstream/master` = `Matronhq/matron-bridge` (**never push here**) |
| Merge base | `c5b54d5` (fork point; **Matrix already removed here**) |
| Divergence | upstream is **20 ahead**, journal-deploy **6 ahead** |
| Our 6 local commits | `d4fe89a` root-permissions allow-list · `a5c920d`+`810b28b` caption (PR #6) · `c90fb1e` uploads-dir (PR #7) · +2 merge commits |

## Headline findings

1. **No Matrix-removal divergence.** Both branches descend from `c5b54d5`, which already has Matrix stripped. None of the 20 upstream commits touch Matrix/Element/homeserver code or re-introduce Matrix assumptions (`updateRoomName`/`roomId` are the journal convo-rename primitives, not Matrix). The Matrix-removal axis is **a non-issue** for this merge.

2. **The entire conflict surface is 4 files** — empirically confirmed by a dry-run `git merge --no-commit` (aborted, branch untouched):
   - `index.js` (narrow: only the `journalMediaRouter` wiring, lines ~5952–5977)
   - `lib/journal-input-router.js`
   - `lib/journal-media.js`
   - `test/journal-media.test.js`

   Everything else auto-merges clean: all NEW files (`inline-image.js`, `subagent-tool-format.js`, `recent-folders.js`, `deploy.sh`, new tests), plus `session-mode.js`, `journal-rpc.js`, `journal-title-seed.js`, `package.json`, `package-lock.json` (+565 lines, sharp dep), and the spawn/session-id region of `index.js`.

3. **The conflict is a duplicate-feature reconcile, not a code clash.** Upstream #139 ships the *same* composer-caption feature we already shipped as PR #6/#7. The two implementations differ in **where the caption is folded** and in **3 hardening deltas we keep that upstream lacks** (uploads-dir, audio scope-fence, caption-only drop+notice). A 4th delta — our 4096 caption clamp — is **intentionally dropped** per operator decision (converge to upstream's unbounded caption; see §Flag (a)). See §Flag (a).

4. **⚠️ Auto-merge of `buildSavedMediaBlocks` is textually clean but SEMANTICALLY BROKEN.** Do not trust the auto-merged result. Git grafted upstream's *lead-caption* onto our *trail-caption* orchestrator → **caption doubles in SDK mode**, and our conflict-side `ivCaption:` reference points at a param upstream renamed → downscale silently disabled + iv caption dropped. This is the single most important thing to get right (details in §Reconcile spec).

---

## Flagged commits

### (a) #139 `8dd7b8e` "deliver the composer caption to claude" — DUPLICATES our PR #6/#7 → SEMANTIC RECONCILE

Same feature, shipped twice. Reconcile must **keep our guard-before-append + audio scope-fence + uploads-dir** (the 4096 clamp is intentionally dropped — see below). Field-by-field:

| Aspect | Upstream #139 | Ours (PR #6/#7) | Reconcile decision |
|---|---|---|---|
| Caption fold point | **Leads** — `if (caption) blocks.push()` at top of SDK branch in `buildSavedMediaBlocks` ("order a person would say it") | **Trails** — orchestrator (`routeOne`) tail-appends `if (caption && !ivHandled)` after the saved-to line | **OPERATOR CALL.** Recommend adopting upstream's LEAD (better UX, single fold point, shrinks our divergence). Then retire our tail-append. **Never keep both → doubling bug.** |
| Router trim/clamp | stores **raw** `payload.caption`, unbounded (trim-checked only for emptiness) | trims + **clamps to 4096** (`captionRaw.slice(0,4096)`) | **DROP OUR CLAMP → converge to upstream (unbounded).** Operator decision 2026-07-18: the caption is a *prompt* that rides with the upload, not a label; there is no technical cap (API/journal/bridge all take far more), so a self-imposed 4096 limit is unjustified. Keep only **trim-to-omit** (blank → no caption). See companion follow-up for the web `maxLength` half. |
| Audio caption | not injected (audio path never reads caption) | **explicit scope-fence** (comment + tests): transcript-only to Claude, caption stays on media row, no double-mirror | Net behavior equivalent; **re-add our tests** if lead ordering chosen. |
| Caption-only drop + notice | with lead ordering a failed save still emits caption block (never caption-only) | on empty builder result, **drops + `publishNotice("Couldn't deliver…")`** | **KEEP OURS** — re-add in `routeOne`. |
| SDK save location | `session.workdir` **root** | `<workdir>/uploads` via `sessionUploadsDir()` + upload-failed guard (PR #7) | **KEEP OURS** — already auto-merged into `buildSavedMediaBlocks` body; verify it survives resolution. |
| `ivCaption`→`caption` rename | yes | we kept `ivCaption` | **Adopt upstream's `caption`** (cleaner; required for the merged signature). |

### (b) #141 `dfd3543` "surface every subagent tool call in its sub-chat" — prereq for web subchats → CLEAN

- **What it publishes:** extracts the inline `formatSubagentToolBody` from `index.js` into new `lib/subagent-tool-format.js` and **widens** it. Previously only WebSearch/WebFetch/Task/TodoWrite surfaced; now every tool call formats to *something*: `Bash → 🔧 \`cmd\`` (100-char cap), `Read → 📖 path`, `Glob/Grep → 🔍 pattern`, unknown → generic `🔧 Name`. `Edit/Write/MultiEdit → null` (caller publishes a structured diff card instead). Each formatted body is published to the **child convo**.
- **`parent_convo_id` contract (unchanged by #141, pre-exists in base `lib/subagent-convos.js`):** a subagent is published as its own child conversation with `parent_convo_id = childConvoId(parentConvoId, agentId)` = `` `${parentConvoId}${CHILD_CONVO_INFIX}${agentId}` ``. The child convo's text / tool-output / diffs route under that id. #141 doesn't touch the contract — it just makes the child convo non-empty (Bash/Read/Grep now visible), which is exactly what the web subchats feature needs to render.
- **Merge:** CLEAN. `index.js` change is an import add + inline-function delete at line ~2457, non-overlapping with our edits. New file + new test add cleanly.

### (c) #138 `00e11b4` "media sends auto-resume a reaped session like text does" — BUG IS LIVE ON journal-deploy → CONFLICT (wanted fix)

- **Verified live:** `lib/journal-input-router.js:158` currently gates auto-resume on `type === 'text'` only, and `blobRef` is resolved inline at line ~201. So today, sending a file/image to an idle/reaped journal session **dead-ends** with "no longer active." #138 fixes exactly this: hoists `blobRef` above the resume gate and admits media frames (`type === 'text' || isMedia`) that carry a usable `blob_ref`. Blob-less media and `prompt_reply` still never respawn.
- **Merge:** CONFLICTS with our `a5c920d` in the same file/block (we added the caption line where #138 restructures blobRef). **Take upstream's #138 structure** (blobRef hoist + media auto-resume), re-apply our caption clamp inside it. See §Reconcile spec.

### (d) #137 / titles / folders / deploy.sh

- **#137 `26d3696` inline image downscale + `d9b058d` dimension-aware fallback** — new `lib/inline-image.js` (`prepareInlineImage`/`appendInlineImageBlocks`, sharp-backed): downscale >1.5MB or unsupported-format images to 1568px/JPEG q80 for the inline base64 block, keep full-res on disk. `d9b058d` hardens the fallback to skip inlining when the known long edge >8000px (header-only `limitInputPixels:false`). **New capability we lack — take it.** `buildSavedBlocks` becomes **async**. `inline-image.js`/`inline-image.test.js` auto-merge clean; the async signature + `appendInlineImageBlocks` calls collide with our media edits (part of the 4-file conflict).
- **#137's edit to `buildSavedMediaBlocks` body auto-merged with our uploads-dir** — coherent-looking but see the ⚠️ hazard; verify.
- **#140 `162ab9e` title-revert fix** — stops session respawn clobbering a good convo title with the repo basename. CLEAN (`journal-title-seed.js` + `index.js` title paths, we never touched those).
- **#142 `b6f3432` title-from-first-user-message (Gemini-absent) + `a267438` hardening** — when `GEMINI_API_KEY` is unset the LLM rename no-ops; this names convos from the first user message instead. **Directly relevant** — our deployment may run without a Gemini key. `a267438` also carries a CodeQL XSS-sanitization fix (drop stray `<`). CLEAN. Depends on #140's seed structure — **take the trio `162ab9e ← b6f3432 ← a267438` together.**
- **#143 `37f0eca` durable folder history** — new `lib/recent-folders.js`; folder picker no longer forgets a folder when its last session record is cleaned. CLEAN. **New stateful surface:** persists to `~/.matron-bridge-folders.json` → **`/root/.matron-bridge-folders.json`** on the VPS (service runs as root), alongside `~/.claude-matrix-sessions.json`. Append-only, never pruned, debounced 5 min/folder, fails-open. Note for backup/cleanup; not under `data/`.
- **#140 `1fcffec` deploy.sh** — ⚠️ **auto-merges clean but is NON-FUNCTIONAL on our host.** Hardcodes macOS launchd (`launchctl kickstart -k gui/$(id -u)/chat.matron.claude-matrix-bridge`) and `git pull --ff-only origin master`. Our host is Linux systemd (`matron-bridge-journal.service`, `/opt/matron/bridge-journal`, branch `journal-deploy`, origin=easelyte). **Post-merge action:** delete it or port to a systemd variant. Its preflight logic (`npm ls --omit=dev`, `npm run check`, dynamic `import('sharp')` + `import('./lib/inline-image.js')` boot-check while old process still serves) is portable and worth keeping — that check guards exactly the "sharp added as top-level import, node_modules not synced → crash-loop" failure mode #137 introduces.

---

## Full commit ledger (20)

| SHA | PR | Summary | Class |
|---|---|---|---|
| `ce98532` | #136 | pre-assign claude session ids at spawn (RPC start in print mode) | **clean** (spawn region auto-merged; non-overlapping with our permissions patch) |
| `460b1a9` | #136 | merge | merge commit |
| `26d3696` | #137 | downscale oversized images for inline injection | **conflict** (media path) |
| `d9b058d` | #137 | dimension-aware fallback when downscale fails | **clean** (`inline-image.js` only) |
| `9b73f95` | #137 | merge | merge commit |
| `00e11b4` | #138 | media auto-resume of reaped session — **live bug fix** | **conflict** (router) |
| `4096972` | #138 | merge | merge commit |
| `8dd7b8e` | #139 | deliver composer caption — **DUPLICATES PR #6/#7** | **semantic reconcile** (all 3 src files) |
| `162ab9e` | #140 | stop title reverting to repo name on respawn | **clean** |
| `1fcffec` | #140 | deploy.sh (macOS/launchd) | **clean-merge / non-functional here** |
| `74e7dda` | #140 | merge | merge commit |
| `dfd3543` | #141 | subagent tool calls in sub-chat — **web-subchats prereq** | **clean** |
| `470f914` | #141 | merge | merge commit |
| `b6f3432` | #142 | title from first user message (Gemini absent) | **clean** |
| `a267438` | #142 | harden fallback title (+ XSS sanitize) | **clean** |
| `2034873` | #143 | merge | merge commit |
| `37f0eca` | #143 | durable folder history | **clean** (new state file in $HOME) |
| `1a81741` | — | chore: retrigger CI | trivial |
| `05a1ce0` | — | merge master into no-gemini-title | merge commit |
| `7e7d0e7` | #142 | merge | merge commit |

Substantive non-merge commits: 12. Conflicts originate from exactly 3 of them (#137 `26d3696`, #138 `00e11b4`, #139 `8dd7b8e`) — the media/caption/router cluster.

---

## Recommended plan: single merge commit, hand-resolve 4 files

**Approach A (recommended): `git merge upstream/master`, resolve 4 files, one merge commit.**
Rationale: upstream is a chain of PR merge commits; cherry-picking would mangle the merge structure and lose attribution, for no benefit. The conflict set is small and localized. A merge preserves upstream history cleanly and is trivially reviewable (only 4 files to inspect).

Reject Approach B (cherry-pick per commit): merge commits don't cherry-pick cleanly; you'd rebuild the same 4-file reconcile anyway across scattered picks.

### Steps (operator runs these; do NOT run autonomously)

```
# work in an isolated worktree so journal-deploy stays clean until verified
git -C /opt/matron/bridge-journal worktree add /tmp/bj-sync journal-deploy
cd /tmp/bj-sync
git merge upstream/master              # expect conflicts in the 4 files below
# ... resolve per §Reconcile spec ...
npm ci && npm run check && npx vitest run   # green (minus the known env-only failures)
# operator eyeballs: send a captioned image to a live+reaped session, both modes
git commit                             # merge commit
# only after verification:
git -C /opt/matron/bridge-journal merge --ff-only <merge-sha>   # or push the worktree branch
git push origin journal-deploy         # easelyte remote ONLY — never upstream
```

### Reconcile spec (the 4 conflicted files)

**Decision gate first: caption LEAD vs TRAIL.** Recommend **LEAD** (adopt upstream #139's fold in `buildSavedMediaBlocks`, retire our orchestrator tail-append). Everything below assumes LEAD; the TRAIL alternative is noted inline.

1. **`lib/journal-input-router.js`** — take upstream's #138 structure (hoisted `blobRef`, `type === 'text' || isMedia` auto-resume gate) **and take upstream's caption line as-is** — no clamp, trim only for emptiness:
   ```js
   caption: typeof payload?.caption === 'string' && payload.caption.trim()
     ? payload.caption.trim()   // trim-to-omit; NO length clamp (operator decision 2026-07-18)
     : null,
   ```
   This drops our former `slice(0, 4096)`. (Upstream stores untrimmed `payload.caption`; storing the trimmed value instead is a cosmetic nicety to avoid leading/trailing whitespace in the prompt — either is fine.) Our previous `captionRaw.slice(0,4096)` line is **removed**, not carried forward.

2. **`index.js` — `journalMediaRouter` wiring (the actual conflict, ~5952–5977):** take the **UPSTREAM side verbatim** — `buildSavedBlocks: async (…) => { …prepareInlineImage… return buildSavedMediaBlocks({… caption, … inline }).blocks }`. Our HEAD side (`ivCaption: caption ?? null`, sync, returns object, no `inline`) is superseded and is the source of the semantic break.
   - *TRAIL alternative:* keep `async` + `inline` from upstream but return the full `{blocks, ivHandled}` object (drop `.blocks`) so `routeOne` can read `ivHandled`.

3. **`index.js` — `buildSavedMediaBlocks` body (auto-merged, MUST re-verify):** the auto-merge already produced the correct union for LEAD — upstream's `caption` param + `if (caption) blocks.push()` lead + our `sessionUploadsDir()` save + upload-failed guard + `appendInlineImageBlocks`. **Verify** it reads coherently (signature `{… caption, workdirName, inline }`, no lingering `ivCaption`, uploads-dir on both image and file branches). If TRAIL chosen instead: **delete** the `if (caption) blocks.push()` lead line here.

4. **`lib/journal-media.js` `routeOne`:** take upstream's `await buildSavedBlocks({… caption})` shape, then **re-add our two hardening behaviors** that upstream lacks:
   - **caption-only drop + notice:** on empty builder result with a caption, `publishNotice(convoId, "Couldn't deliver that attachment to claude.")` and return (don't inject caption-only).
   - **audio scope-fence:** keep the comment/behavior that an audio caption is never injected (transcript-only) — behavior already matches upstream, but keep our explicit fence + tests.
   - Under LEAD, **remove** our `if (caption && !ivHandled) blocks.push(...)` tail-append (buildSavedMediaBlocks now leads it — keeping both doubles the caption).

5. **`test/journal-media.test.js`:** reconcile to the chosen semantics. Under LEAD, our `ivHandled` tail-append tests are invalid — replace with lead-ordering assertions (caption block precedes "saved to" line). Keep our audio-scope-fence and caption-only-drop tests.

### Post-merge cleanup (not conflicts, but required)

- **`deploy.sh`:** delete or port to systemd (`git pull origin journal-deploy`; `systemctl restart matron-bridge-journal.service`). Keep the preflight (`npm ls`, `npm run check`, dynamic sharp/inline-image import) — it guards the sharp crash-loop.
- **Re-apply nothing for permissions:** our `d4fe89a` root-permissions allow-list auto-merged (spawn region non-overlapping with #136's `planSessionIdentity`); **verify** both spawn sites still pass `permissions: BRIDGE_ROOT_PERMISSIONS` in `--settings` and that `--dangerously-skip-permissions` did NOT come back from upstream.
- **New runtime state file** `/root/.matron-bridge-folders.json` appears after first `persistSession` — note for backup.
- **sharp dependency** is now required (`package.json`/`package-lock.json` merged it): `npm ci` before restart or the bridge crash-loops.

### Companion follow-up (SEPARATE — `matron-web`, `/opt/matron/web-journal`)

**Lift the caption `maxLength` in the web composer.** Dropping the bridge clamp (above) only removes half the self-limit — the web upload modal's caption textarea still hard-stops the operator at 4096 characters. To actually remove the limitation:

- `src/journal/components.tsx` — the `UploadConfirmDialog` caption `<textarea>` currently sets `maxLength={4096}`. Raise it substantially or remove it (the caption is a prompt, not a label — no reason to cap what the operator can ask). The design spec (`docs/superpowers/specs/2026-07-17-web-upload-caption-modal-design.md`) also documents 4096 as a "caption bound"; update that note so the spec and code agree.
- This is a **matron-web** change, its own PR/branch/deploy (static build → nginx 8443, per the web deploy runbook). It is **independent of and not blocked by** the bridge merge — but ship them close together so the two halves stay consistent (bridge unbounded + web still capped = the UI silently wins at 4096).
- Not gating the merge. Tracked so it doesn't get lost.

### Verification checklist (before ff-merge to journal-deploy + push)

- [ ] `npm run check` + `npx vitest run` green (minus known env-only failures: file-link-guard / inline-image sharp-path tests that fail outside the primary checkout).
- [ ] Captioned image, LIVE session, SDK mode → caption appears **once**, then "Image saved to …/uploads/…", then the (downscaled) image.
- [ ] Captioned image, **reaped** session → auto-resumes (#138) and delivers (was dead-ending before).
- [ ] Captioned audio → transcript reaches Claude, caption does **not** (no double-mirror).
- [ ] SDK-mode uploads land in `<workdir>/uploads`, not workdir root.
- [ ] Root spawn still works (permissions allow-list intact, no skip-permissions flag).
- [ ] Subagent sub-chat shows Bash/Read/Grep lines (#141).
- [ ] Push target is `origin` (easelyte) — **never** `upstream`.

---

## Appendix — grounding method

- Diffs read directly via `git show` for #136–#143 + all 6 local commits.
- Conflict set proven by `git merge --no-commit --no-ff upstream/master` on a throwaway worktree/branch (`_tmp_mergecheck`), then `merge --abort` + worktree/branch removed + `rerere clear`. journal-deploy verified unchanged at `4cf75e0`.
- The `buildSavedMediaBlocks` auto-merge hazard was caught by reading the merged function body against both conflict sides, not by trusting "no conflict marker = safe."
