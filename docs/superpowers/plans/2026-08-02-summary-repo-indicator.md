---
title: Summary title repo-indicator — implementation plan
spec: docs/superpowers/specs/2026-08-02-summary-repo-indicator-design.md
status: draft
revision: 1
date: 2026-08-02
repo: easelyte/claude-matrix-bridge
base: journal-deploy
risk: low
execution_tier: slim
---

# Plan — Summary title repo-indicator

Small additive change riding the existing codex summary call. Two files + two
test files. No dependency, env, or migration changes.

## Phase 1 — title formatter (`lib/journal-title-seed.js` + test)

**T-1.1 — `extractRepoOverride(text)` (new exported fn)**
- Signature: `extractRepoOverride(text) → string | null`.
- Collect all line-anchored `REPO:` lines with
  `/^REPO:[^\S\r\n]*[^\r\n]*$/gim` (horizontal-ws-only + line-bounded so a
  blank `REPO:` cannot cross a newline and swallow the next field). Require
  **exactly one**: `!lines || lines.length !== 1` → `null` (zero = no override;
  ≥2 = ambiguous/spoofable stray `REPO:` echo → reject to workdir fallback). A
  mid-line `REPO:` in TITLE/prose is not line-anchored → ignored.
- Strip the `REPO:` prefix from the single line and trim →`raw`. Lowercase-
  compare against the sentinel set `{unknown, none, n/a, na, -}` → `null`.
- Sanitize for a display sink (mirror `applyFallbackTitle`, plus control-char
  policy): `.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,' ')` (C0/C1 controls,
  bidi/format, separators) → `.replace(/<[^>]*>/g,' ')` →
  `.replace(/[<>]/g,' ')` → `.replace(/·/g,' ')` → `.replace(/\s+/g,' ')`
  → `.trim()`. Empty after clean → `null`.
- Cap with `truncateWithEllipsis(clean, REPO_LABEL_MAX)` (code-point-aware; ≤24
  unchanged; >24 → first 24 + `…`); return it.
- Keep the fn pure/synchronous; export it.

**T-1.2 — `formatRoomTitle` gains optional `repo`**
- Destructure `repo` from the params object.
- `const repoSegment = (typeof repo === 'string' && repo.trim())`
  `? truncateWithEllipsis(repo.trim(), REPO_LABEL_MAX)`
  `: repoLabel(workdir, { defaultWorkdir });`
- Use `repoSegment` in place of the current inline `repoLabel(...)` call.
- No signature break: omitting `repo` yields byte-identical output to today.

**T-1.3 — tests (`test/journal-title-seed.test.js`)**
- `extractRepoOverride`: valid (`REPO: snafu-studio` → `snafu-studio`);
  under-cap unchanged (`REPO: claude-matrix-bridge` → `claude-matrix-bridge`,
  20 chars); over-cap (`REPO: some-really-long-monorepo-name` → first 24 +
  `…`); each sentinel → `null`; no `REPO:` line → `null`; whitespace-only →
  `null`; blank REPO followed by another field (`TITLE: x\nREPO:\nSUMMARY: done`
  and `REPO:   \nNEW: done` → `null`, must not swallow the next line); tag
  injection preserves content + drops brackets (tags → space:
  `REPO: <b>foo</b>bar` → `foo bar`, assert no `<`/`>`); astral truncation
  (23 ASCII + emoji over the cap → no unpaired surrogate / `�`); middot
  injection
  (`REPO: a · b` → `a b`, no `·`); line-anchored spoof
  (`TITLE: probe REPO: spoof\nREPO: real-repo` -> `real-repo`); duplicate REPO: lines -> `null` (reject); control/bidi chars (`REPO: safe\u202Eabc` -> `safe abc`).
- `formatRoomTitle`: with `repo:'snafu-studio'` → segment is `snafu-studio`
  (not workdir basename); with `repo` omitted → identical to pre-change output
  (assert against a workdir case); with `repo:'   '` → falls back to
  `repoLabel`.

**Gate:** `npx vitest run test/journal-title-seed.test.js` green;
`npx eslint lib/journal-title-seed.js` 0 warnings (repo gate `--max-warnings=0`).

## Phase 2 — summary wiring (`lib/pinned-summary.js` + test)

**T-2.1 — `REPO:` in both prompt branches**
- Add to the requested output (both the `currentSummary` and the no-summary
  branch): a numbered item asking for the repository/project being worked on,
  inferred from file paths / `--workdir` / PR targets / repo names in the
  messages; write `unknown` if unclear.
- Add `REPO: <repo or unknown>` to each `Format:` block (between TITLE and
  SUMMARY/NEW). Renumber the list items.
- Do not touch the compaction prompt.

**T-2.2 — extract + thread `repo`**
- Import `extractRepoOverride` from `./journal-title-seed.js`.
- In the success path, after the `titleMatch` guard, compute
  `const repo = extractRepoOverride(result.text);` and add `repo` to the
  existing `formatRoomTitle({ serverLabel, workdir, text, defaultWorkdir })`
  call. No other call site changes; fallback path untouched.

**T-2.3 — tests (`test/pinned-summary.test.js`)**
- Update the existing "routes a successful title through formatRoomTitle"
  assertion to include `repo` in the expected `formatRoomTitle` args.
- Add: codex returns `...\nREPO: snafu-studio\n...` → `formatRoomTitle` called
  with `repo:'snafu-studio'`.
- Add: codex returns no `REPO:` / `REPO: unknown` → `formatRoomTitle` called
  with `repo: null` (fallback to workdir happens inside the formatter).

**Gate:** `npx vitest run test/pinned-summary.test.js test/journal-title-seed.test.js`
green; `npx eslint lib/pinned-summary.js` 0 warnings; `node --check` on both
files clean.

## Phase 3 — review + ship

- One Codex adversarial review of the branch diff vs `origin/journal-deploy`
  (`codex_adversarial_exec.sh --diff origin/journal-deploy --workdir
  /root/bridge-repo-indicator`, backgrounded for the 2-min cap). Fix
  blockers/majors; do not loop.
- Full suite `npx vitest run` green.
- `/ship-slim` (or manual PR) → `easelyte/claude-matrix-bridge`, base
  `journal-deploy`.
- **Deploy is operator-gated** (restart kills this session): after merge,
  `git pull` on `journal-deploy` in `/opt/matron/bridge-journal` → `npm prune`
  → `systemctl restart matron-bridge-journal.service`. No `.env` change.

## Out of scope / do not touch
- Codex invocation, cadence (every-5-messages), kill-switch, concurrency cap,
  compaction path, resume-path title, fallback-title path (all unchanged).
- No new env knob. No dependency change.
