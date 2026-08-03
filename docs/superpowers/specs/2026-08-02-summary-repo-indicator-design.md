---
title: Summary title repo-indicator — infer target repo from transcript
status: draft
revision: 1
date: 2026-08-02
repo: easelyte/claude-matrix-bridge
base: journal-deploy
---

# Summary title repo-indicator

## Problem

The just-shipped Gemini→codex summary migration renders journal conversation
titles as `VPS · <repo> · <topic>`. The `<repo>` segment is
`repoLabel(session.workdir)` = `basename(workdir)`, with the workspace root
mapped to `son-of-anton` (`lib/journal-title-seed.js`).

The operator's standing workflow (per son-of-anton CLAUDE.md "Cross-repo /
nested-repo work") is to **stay rooted in son-of-anton and reach sibling /
external repos by path** (`git -C <repo>`, `npm --prefix`, `codex_*.sh
--workdir <repo>`, absolute-path edits). The session `cwd` is therefore
*reliably wrong* as a repo indicator: every cross-repo session shows
`son-of-anton` even when the real work targets `snafu-studio`,
`claude-matrix-bridge`, `matron-web`, etc. `cwd` only happens to be right for
work that genuinely edits son-of-anton itself.

## Goal

Make the `<repo>` segment reflect the **repository actually being worked on**,
inferred from the conversation, while preserving today's behavior whenever no
better signal exists.

Non-goals: changing the title/summary cadence, the codex invocation, the
kill-switch, the compaction path, the resume-path title, or the fallback-title
path. This is a single additive field on the summary prompt + a threaded
override into the existing formatter.

## Approach

Reverse the migration spec's "deterministic over LLM" choice **for the repo
segment only**, because the deterministic source (`cwd`) is structurally wrong
for this operator's cross-repo pattern, and a better deterministic source does
not exist inside the bridge (the bridge cannot see which sibling repo a
`git -C` / `--workdir` command inside the Claude session touched). The
transcript *does* carry that signal (file paths, `--workdir` flags, PR
targets, repo names), so the LLM that already summarizes the transcript is the
cheapest available inferrer.

Ride the existing codex summary call — **zero additional cost or latency** — by
adding one output field:

1. **Prompt (both branches in `updatePinnedSummary`)** — add a `REPO:` line to
   the requested output: the repository/project being worked on, inferred from
   file paths / `--workdir` / PR targets / repo names in the messages; write
   `unknown` when unclear.

2. **Extraction (`lib/journal-title-seed.js`, new exported
   `extractRepoOverride(text)`)** — collect all **line-anchored,
   case-insensitive** `REPO:` lines with `/^REPO:[^\S\r\n]*[^\r\n]*$/gim`
   (horizontal-whitespace-only + line-bounded capture so a blank `REPO:` cannot
   cross the newline and swallow the next field). Require **exactly one** such
   line: zero → no override; **two or more → reject to the workdir fallback**
   (a stray `REPO:` echoed from untrusted transcript content — this feature
   runs on the bridge whose own sessions discuss `REPO:` lines — is ambiguous
   and spoofable, so parse-don't-validate rejects rather than guessing which is
   canonical). A mid-line `REPO:` inside TITLE/prose is not line-anchored and is
   ignored. Then, on the single line:
   - Treat missing, empty-after-clean, or a sentinel (`unknown`, `none`,
     `n/a`, `na`, `-`, compared case-insensitively against the trimmed raw
     capture) as **no override** → returns `null`.
   - Otherwise sanitize the model-generated string (it is derived from
     untrusted transcript content and lands in a display sink). First strip
     Unicode control/format/separator chars —
     `.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,' ')` — which removes C0/C1
     controls, bidi overrides (`‮` etc. that could visually reorder the
     title), and line/paragraph separators. Then neutralize angle brackets so
     no `<`/`>` reaches the room name — strip tag *delimiters* but **preserve
     their text content** (parity with `applyFallbackTitle`; CodeQL
     js/incomplete-multi-character-sanitization): `.replace(/<[^>]*>/g,' ')`
     → `.replace(/[<>]/g,' ')` → `.replace(/·/g,' ')` (drop the `·` separator
     so an injected middot cannot forge extra title segments) →
     `.replace(/\s+/g,' ')` → `.trim()`. Empty after clean → `null`.
   - Cap with `truncateWithEllipsis(clean, REPO_LABEL_MAX)` — parity with
     `repoLabel`: strings ≤ 24 **code points** are returned unchanged; longer
     strings become the first 24 code points **plus** a `…` (25 code points).
     Truncation is code-point-aware (`Array.from`) so an astral character
     (emoji) at the boundary cannot be split into an unpaired surrogate.
     Returns the capped string.

3. **Formatting (`formatRoomTitle`)** — gain an optional `repo` param. When a
   non-empty `repo` is supplied, use it (defensively re-capped at
   `REPO_LABEL_MAX`) as the repo segment; otherwise fall back to today's
   `repoLabel(workdir, { defaultWorkdir })`. All existing callers that pass no
   `repo` (resume path index.js, `applyFallbackTitle`) keep today's behavior
   verbatim.

4. **Wiring (`updatePinnedSummary`)** — on the success path, compute
   `const repo = extractRepoOverride(result.text)` and pass `repo` into the
   existing `formatRoomTitle(...)` call. No other call site changes.

## Behavior table

| Codex REPO output | Title repo segment |
|---|---|
| `REPO: snafu-studio` | `snafu-studio` |
| `REPO: claude-matrix-bridge` (20 chars ≤ 24) | `claude-matrix-bridge` (unchanged — under cap) |
| `REPO: some-really-long-monorepo-name` (>24) | first 24 code points + `…` (`truncateWithEllipsis` parity, astral-safe) |
| `REPO: unknown` / omitted / whitespace | `repoLabel(workdir)` (today's behavior) |
| `REPO: <b>foo</b>bar` | `foo bar` (tag delimiters → space, content preserved, no `<`/`>`) |
| `TITLE: probe REPO: spoof`\n`REPO: real-repo` | `real-repo` (line-anchored regex ignores the mid-line echo) |
| `REPO: attacker`\n`REPO: real-repo` (two lines) | `repoLabel(workdir)` (duplicate → rejected, no override) |
| `REPO: safe‮abc` (bidi/control chars) | `safe abc` (control/format/bidi stripped) |
| codex call fails (`text === null`) | fallback-title path → `repoLabel(workdir)` (unchanged) |
| kill-switch off | fallback-title path → `repoLabel(workdir)` (unchanged) |
| resume path | `repoLabel(workdir)` (unchanged — no transcript LLM pass) |

## Edge cases / decisions

- **Self-correcting:** early in a session the transcript may not yet reveal the
  target repo → `unknown` → workdir fallback. As cross-repo commands accrue,
  later 5-message summary flushes infer it and the title updates. Acceptable —
  titles are already eventually-consistent and cosmetic.
- **Wrong inference is low-harm:** worst case a title shows a plausibly-wrong
  repo name for one cadence window; corrected on the next flush. No data,
  routing, or security impact (title is display-only).
- **Sanitization is mandatory, not optional:** the repo string originates from
  model output over untrusted transcript content and lands in a room name
  shown in every client. Reuse the existing tag/bracket cleaning contract.
- **Length:** repo 24-cap + title 60-cap + `VPS` + separators stays well
  within journal room-name limits (unchanged from today).
- **No new env knob:** the feature is unconditional on the success path;
  `SUMMARY_CODEX_ENABLED=0` already disables the whole codex path (and thus this
  field) via the fallback title.

## Files

- `lib/journal-title-seed.js` — new `extractRepoOverride`; `formatRoomTitle`
  gains optional `repo`.
- `lib/pinned-summary.js` — `REPO:` line in both prompt branches; extract +
  pass `repo`.
- `test/journal-title-seed.test.js` — `extractRepoOverride` cases;
  `formatRoomTitle` repo-override + fallback.
- `test/pinned-summary.test.js` — success path threads `repo` into
  `formatRoomTitle`; `unknown`/absent falls back.

## Deploy

Same restart-gated runbook as the migration (operator-gated; restarting
`matron-bridge-journal` kills the live session): `git pull` on
`journal-deploy` → `npm prune` (no dep changes here) →
`systemctl restart matron-bridge-journal.service`. No `.env` change.
