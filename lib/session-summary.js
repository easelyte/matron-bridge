// Bounded, async session-summary reads for the /sessions listing and
// /resume room naming (extracted from index.js's old getSessionSummary),
// plus the async id-resolution/existence helpers for the same command paths
// (listSessionIdsByMtime / pathExists — issue #102).
//
// Why this module exists (review fast-follow): the old implementation was
// fully synchronous and unbounded — readdirSync + statSync + a whole-file
// readFileSync for EVERY transcript in the history dir, sliced to the 15
// newest only AFTER reading everything. On a dir with months of sessions
// that blocks the event loop (every session + the journal socket) for
// the duration, and the journal command-parity work exposed the same cost
// to the Matron control convo's /sessions. The fix is shape-preserving but
// I/O-bounded:
//   - stat first, sort by mtime, and only THEN read the top `limit` files;
//   - per file, read only a bounded head chunk — the summary is the FIRST
//     user message, which lives at the head of the transcript, so reading
//     the whole (potentially many-MB) file bought nothing;
//   - everything through fs.promises, awaited from handleCommand's already-
//     async cases, so other rooms keep being served while a listing runs.
//
// Output format is byte-identical to the old code path (same extraction
// rules, same {sessionId, modified, summary} item shape, same sort). The
// only semantic difference is the explicit bound: a pathological transcript
// whose first user message sits deeper than SUMMARY_HEAD_BYTES now yields
// an empty summary instead of a found one — accepted, per review.

import fsp from 'fs/promises';
import path from 'path';

// Generous head-chunk cap: first user-text records live in the first few KB
// of a transcript in practice; 256 KiB covers even huge pasted first
// messages while staying firmly bounded.
export const SUMMARY_HEAD_BYTES = 256 * 1024;

// First-user-message extraction, byte-for-byte the old getSessionSummary
// scan: skip blank lines, first `user` record with usable text (string or
// first text block), skip <local-command…/<command-name> pseudo-messages,
// strip tags, trim, cap at 80 chars + ellipsis. A malformed line aborts the
// whole scan to '' — same as the old version, whose try/catch wrapped the
// entire loop.
export function extractSummaryFromContent(content) {
  try {
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === 'user' && record.message) {
        const msg = record.message;
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.find(b => b.type === 'text')?.text || ''
            : '';
        if (text && !text.startsWith('<local-command') && !text.startsWith('<command-name>')) {
          const clean = text.replace(/<[^>]+>/g, '').trim();
          return clean.slice(0, 80) + (clean.length > 80 ? '…' : '');
        }
      }
    }
  } catch { /* malformed line aborts the scan, exactly like the old whole-file version */ }
  return '';
}

// Read at most `headBytes` from the start of `filePath` and extract the
// summary from the complete lines within it. When the file is larger than
// the cap, the trailing partial line is dropped before scanning (it isn't a
// complete record, and a cut-off JSON line would otherwise abort the scan).
// Any I/O error (missing file, permissions) yields '' — same catch-all
// contract the old sync version had.
export async function readSessionSummary(filePath, { headBytes = SUMMARY_HEAD_BYTES } = {}) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, headBytes);
    const buf = Buffer.alloc(len);
    // read() may return fewer bytes than asked for (issue #102 nit) — loop
    // until the head chunk is full or EOF, and only decode what was actually
    // read; the old single unchecked read left a short read's tail NUL-filled
    // and the NUL-padded line aborted the whole scan to ''.
    let read = 0;
    while (read < len) {
      const { bytesRead } = await fh.read(buf, read, len - read, read);
      if (bytesRead === 0) break; // EOF — e.g. the file shrank after stat
      read += bytesRead;
    }
    let content = buf.toString('utf-8', 0, read);
    if (read < size) {
      // The head chunk (or an EOF-shortened read) stops mid-file — drop the
      // trailing partial line before scanning, same rationale as before.
      content = content.slice(0, content.lastIndexOf('\n') + 1);
    }
    return extractSummaryFromContent(content);
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => { /* best-effort close */ });
  }
}

// List the `limit` most-recent session transcripts in `projectDir`:
// readdir + stat everything (cheap — metadata only), sort newest-first,
// slice to `limit`, and only then read summaries — for exactly those files.
// Returns [{ sessionId, modified, summary }] in the same shape and order
// the old inline !sessions code produced (stable sort over readdir order on
// mtime ties, matching the old chain). Missing dir / vanished files are
// tolerated ([] / skipped) rather than thrown. `readSummary` is injectable
// so tests can count exactly which files get their contents read.
export async function listSessionSummaries(projectDir, { limit = 15, readSummary = readSessionSummary } = {}) {
  let names;
  try {
    names = await fsp.readdir(projectDir);
  } catch {
    return [];
  }

  const statted = await Promise.all(
    names.filter(f => f.endsWith('.jsonl')).map(async (f) => {
      const filePath = path.join(projectDir, f);
      try {
        const stat = await fsp.stat(filePath);
        return { sessionId: f.replace('.jsonl', ''), filePath, modified: stat.mtimeMs };
      } catch {
        return null; // deleted between readdir and stat — skip
      }
    })
  );

  const top = statted
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);

  return Promise.all(top.map(async ({ sessionId, filePath, modified }) => ({
    sessionId,
    modified,
    summary: await readSummary(filePath),
  })));
}

// Async replacement for !resume's id resolution (issue #102): the old code
// ran readdirSync and then fs.statSync INSIDE the sort comparator — an
// O(n log n) storm of synchronous metadata calls on the event loop. Same
// chain, one stat per file: readdir -> filter .jsonl -> strip the extension
// (the old `.replace('.jsonl', '')`, first occurrence, preserved verbatim)
// -> sort newest-first by mtime. Ordering matches the old comparator
// exactly, including readdir order on mtime ties (stable sort, same base
// order). Unlike listSessionSummaries above, errors are NOT swallowed: the
// old statSync threw out of the comparator if a file vanished mid-resolve,
// and silently skipping instead would renumber the list and let
// `/resume <n>` land on the WRONG session — an error is the safer of the
// two. Callers gate on pathExists first, exactly where the old code ran
// existsSync.
export async function listSessionIdsByMtime(projectDir) {
  const names = await fsp.readdir(projectDir);
  const statted = await Promise.all(
    names
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .map(async (id) => ({
        id,
        modified: (await fsp.stat(path.join(projectDir, id + '.jsonl'))).mtimeMs,
      }))
  );
  return statted.sort((a, b) => b.modified - a.modified).map(e => e.id);
}

// Async drop-in for the fs.existsSync checks on the !resume / !sessions
// paths (issue #102). Same boolean contract, no event-loop stall.
export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
