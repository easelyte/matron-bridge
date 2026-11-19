// Unified-diff snippets for Edit/Write/MultiEdit tool_use events, published
// as journal `diff` events (spec: matron-apple docs/superpowers/specs/
// 2026-07-14-diff-cards-design.md). The output is a display snippet of
// intent — hunk headers use positions within the tool-input strings, not
// file line numbers, and `replace_all` still diffs one occurrence.
import { structuredPatch } from 'diff';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 400;
const MAX_BYTES = 64 * 1024;
// Write's old-content read is synchronous (see computeEditDiff below), so
// cap what we're willing to pull onto the event loop: past this size a
// source-file diff card is useless anyway, and claiming "new file" for an
// overwritten huge file would lie — so oversized targets get no card at all.
const MAX_OLD_READ_BYTES = 1024 * 1024;
// The line diff itself is synchronous too, and its cost grows with the
// product of size and edit distance: a full rewrite of a few thousand lines
// can hold the event loop for seconds. Give up past these bounds (the diff
// library returns undefined) and publish no card, like an oversized Write.
// The edit-length bound is the deterministic one (2000 changed lines is
// already five times what the card shows); the timeout is a backstop for
// huge inputs with smaller edits. A diff against an empty side (a new file)
// is linear, so it is not edit-length bounded and keeps its card.
const DIFF_MAX_EDIT_LENGTH = 2000;
const DIFF_TIMEOUT_MS = 1000;

// Render structuredPatch hunks as unified-diff text WITHOUT ---/+++ file
// headers (the card header carries the filename), counting +/- lines
// before any truncation so the header counts stay honest.
function renderHunks(hunks) {
  const lines = [];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      lines.push(l);
      if (l.startsWith('+')) added += 1;
      else if (l.startsWith('-')) removed += 1;
    }
  }
  return { lines, added, removed };
}

function capText(lines) {
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + newline
    if (out.length >= MAX_LINES || bytes + lineBytes > MAX_BYTES) {
      return { text: out.join('\n'), truncated: true };
    }
    out.push(line);
    bytes += lineBytes;
  }
  return { text: out.join('\n'), truncated: false };
}

function fromHunks(hunks, newFile) {
  if (!hunks.length) return null; // no-op edit — nothing to show
  const { lines, added, removed } = renderHunks(hunks);
  const { text, truncated } = capText(lines);
  return { diff: text, added, removed, truncated, newFile };
}

// Returns the hunks, or null when the diff hit DIFF_MAX_EDIT_LENGTH or
// DIFF_TIMEOUT_MS.
function patchHunks(oldStr, newStr) {
  const opts = { context: 3, timeout: DIFF_TIMEOUT_MS };
  if (oldStr && newStr) opts.maxEditLength = DIFF_MAX_EDIT_LENGTH;
  const patch = structuredPatch('a', 'b', oldStr, newStr, '', '', opts);
  return patch ? patch.hunks : null;
}

// Returns {diff, added, removed, truncated, newFile} or null when the tool
// input has no usable content (unknown tool, missing fields, no-op edit,
// Write over a file larger than MAX_OLD_READ_BYTES, a diff past the
// DIFF_MAX_EDIT_LENGTH / DIFF_TIMEOUT_MS bounds). Never throws.
// SYNCHRONOUS by contract: the caller publishes the result through the
// ordered journal pipeline at tool_use time, and an async compute here
// would let later stream events publish first, reordering diff cards
// against their tool_use. Write's readFileSync is the only I/O.
export function computeEditDiff(toolName, input, workdir) {
  try {
    if (!input || typeof input !== 'object') return null;
    if (toolName === 'Edit'
        && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      const hunks = patchHunks(input.old_string, input.new_string);
      return hunks ? fromHunks(hunks, false) : null;
    }
    if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      const hunks = [];
      for (const e of input.edits) {
        if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') continue;
        const h = patchHunks(e.old_string, e.new_string);
        if (!h) return null; // a partial card would under-count the change
        hunks.push(...h);
      }
      return fromHunks(hunks, false);
    }
    if (toolName === 'Write' && typeof input.content === 'string' && input.file_path) {
      const abs = path.isAbsolute(input.file_path)
        ? input.file_path
        : path.join(workdir || '', input.file_path);
      let old = null;
      try {
        if (fs.statSync(abs).size > MAX_OLD_READ_BYTES) return null;
        old = fs.readFileSync(abs, 'utf8');
      } catch {
        old = null; // absent or unreadable -> treat as new file (fail open)
      }
      const hunks = patchHunks(old ?? '', input.content);
      return hunks ? fromHunks(hunks, old === null) : null;
    }
    return null;
  } catch {
    return null;
  }
}
