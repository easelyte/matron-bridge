import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Single source of truth for mapping an absolute workdir to the transcript
// directory name Claude Code writes under ~/.claude/projects/. Claude derives
// that name from the session's realpathed cwd, so every bridge site that reads,
// tails, resumes, or lists a transcript must encode the workdir the exact same
// way — otherwise it points at a directory Claude never created.
//
// The encoder matches the CLI byte for byte:
//   1. Replace EVERY non-alphanumeric char with `-` (so `/`, `.`, `_`, space,
//      etc all collapse to a dash). Encoding only `/` was the original bug:
//      a path like `/home/dan/my_app` must become `-home-dan-my-app`, and a
//      dotted path like `/home/dan/.config/ws` becomes `-home-dan--config-ws`
//      (double dash), not `-home-dan-.config-ws`.
//   2. Only when the dashed segment exceeds 200 chars, truncate to 200 and
//      append `-<hash>`, where the hash is a base36 of the 32-bit string hash
//      of the ORIGINAL (pre-dash) path. Claude hashes the raw path, not the
//      dashed segment, so we must too.

const MAX_ENCODED_LEN = 200;

// 32-bit string hash matching Claude Code's cwd hash: h = (h * 31 + c) | 0,
// seeded at 0, iterating UTF-16 code units. Kept identical to the CLI so the
// truncation suffix lands on the same directory the CLI wrote.
function hashPath(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i) | 0;
  }
  return hash;
}

// Encode a path to Claude Code's project-dir segment, byte for byte. Operates
// on the string as given — callers that need symlink resolution should pass a
// realpathed path (see resolveWorkdir / encodeProjectDir).
export function encodeProjectSegment(absPath) {
  const dashed = absPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (dashed.length <= MAX_ENCODED_LEN) return dashed;
  return `${dashed.slice(0, MAX_ENCODED_LEN)}-${Math.abs(hashPath(absPath)).toString(36)}`;
}

// Resolve a workdir the way Claude Code does before encoding: it realpaths the
// cwd, so a symlinked workdir lands in the same transcript dir the CLI writes
// to. path.resolve alone does NOT resolve symlinks, so we realpath and fall
// back to path.resolve when the path does not exist yet (realpathSync throws
// ENOENT for a not-yet-created dir) — that still yields a stable absolute
// encoding, and a workdir Claude has never run in has no transcript anyway.
//
// Residual edge: because the canonical target is recomputed from the live
// filesystem on each call rather than persisted at session creation, a session
// started through a symlink that is later RETARGETED or DELETED can resolve to
// a different (or lexical-fallback) directory and miss its transcript. For a
// stable symlink (the normal case) this matches the CLI exactly, which the
// prior `/`-only encoder never did. Resume paths recover from a miss of this
// class (and from mid-session cwd moves) via findTranscriptBySessionId below.
export function resolveWorkdir(workdir) {
  const resolved = path.resolve(workdir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// The encoded project-dir segment for a workdir (realpath + CLI encoding).
export function encodeProjectDir(workdir) {
  return encodeProjectSegment(resolveWorkdir(workdir));
}

// ~/.claude/projects/<encoded-workdir>
export function projectDirFor(workdir) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(workdir));
}

// ~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl
export function transcriptPathFor(workdir, sessionId) {
  return path.join(projectDirFor(workdir), `${sessionId}.jsonl`);
}

// ~/.claude/projects/<encoded-workdir>/<sessionId>/subagents
export function subagentsDirFor(workdir, sessionId) {
  return path.join(projectDirFor(workdir), sessionId, 'subagents');
}

// Chunk size for the backward cwd scan. Message entries carry a `cwd` field
// but queue-operation entries do not, and a single tool-result line can
// exceed any fixed window — so the scan walks the WHOLE file backwards in
// chunks rather than trusting one tail read (Bugbot, PR #216).
const CWD_SCAN_CHUNK = 256 * 1024;

// The cwd Claude last recorded inside a transcript, or null. The project-dir
// name cannot be decoded back to a path (the dash encoding is lossy), so the
// transcript's own per-entry `cwd` field is the only ground truth for where
// the session was actually running. Scans chunks from the end of the file,
// newest line first, carrying the partial first line of each chunk into the
// next (older) chunk so a line spanning a chunk boundary is still parsed
// whole. Returns on the first (i.e. latest) entry with a string cwd.
function lastRecordedCwd(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    let end = size;
    // `carry` holds the leading fragment of the chunk scanned last round —
    // the tail half of a line whose start lives in an older chunk.
    let carry = '';
    while (end > 0) {
      const start = Math.max(0, end - CWD_SCAN_CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, end - start, start);
      const lines = (buf.toString('utf8') + carry).split('\n');
      // Unless this chunk starts at byte 0, its first "line" is a fragment —
      // hold it back for the next round instead of parsing half a JSON line.
      carry = start > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line || !line.includes('"cwd"')) continue;
        try {
          const cwd = JSON.parse(line).cwd;
          if (typeof cwd === 'string' && cwd) return cwd;
        } catch {
          // malformed line — keep scanning older lines
        }
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Locate a session's transcript by id across EVERY project dir, and recover
// the workdir recorded inside it. A session that changes cwd mid-flight (the
// EnterWorktree tool is the common case) has its transcript relocated to the
// NEW cwd's project dir, so the workdir the bridge persisted at spawn goes
// stale; a resume that only checks transcriptPathFor(persistedWorkdir, id)
// misses, and planSessionIdentity then demotes it to a fresh spawn — the room
// keeps its identity but silently loses the whole conversation. Callers use
// this as the fallback when the expected path misses.
//
// Returns { transcriptPath, workdir } — workdir null when no entry carries a
// cwd — or null when no project dir holds a transcript for the id. When
// several do (a session that moved and left a transcript behind at each
// stop), the most recently modified wins: that is the live tail.
export function findTranscriptBySessionId(sessionId, { projectsRoot } = {}) {
  // The id becomes a filename component; anything but a plain uuid-ish token
  // is not a session id the bridge ever minted.
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
  const root = projectsRoot || path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  let best = null;
  for (const name of dirs) {
    const candidate = path.join(root, name, `${sessionId}.jsonl`);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { transcriptPath: candidate, mtimeMs: stat.mtimeMs };
    }
  }
  if (!best) return null;
  return { transcriptPath: best.transcriptPath, workdir: lastRecordedCwd(best.transcriptPath) };
}
