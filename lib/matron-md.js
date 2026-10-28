// MATRON.md: a repository's instructions for Matron sessions only.
//
// CLAUDE.md and AGENTS.md are read by every Claude Code or Codex run in a
// repository, inside Matron or not, so instructions about the tracker, rooms
// or missions put there confuse a plain run that has none of those tools. A
// repository puts them in MATRON.md instead, and the bridge adds them to the
// instructions it already gives each session (lib/coordinator.js), so only a
// Matron session ever sees them.
//
// Which files: every MATRON.md from the repository root down to the
// session's workdir, root first, so the deeper (more specific) file reads
// last. The root is the nearest ancestor holding a `.git` entry (a directory
// in a clone, a file in a worktree or submodule); a workdir outside any
// repository reads only its own MATRON.md. There is no lazy loading of
// nested files the way Claude Code loads a nested CLAUDE.md on first touch:
// the bridge cannot see which files a session opens, so a subdirectory's
// MATRON.md applies only to a session whose workdir is inside it.
//
// When: read afresh on every spawn (start, resume, respawn, restart), never
// cached, so an edit takes effect at the session's next restart. A `cd`
// inside a session changes nothing, as with CLAUDE.md.
//
// Synchronous because createSession is, and it never throws: an unreadable
// file is skipped with a warning, and the session starts without it.
import fs from 'node:fs';
import path from 'node:path';

export const MATRON_MD_NAME = 'MATRON.md';
export const MATRON_MD_MAX_BYTES = 24 * 1024;
// Ancestors walked looking for the repository root before giving up; a
// workdir nested deeper than this inside a repository is not a real case.
const MAX_DEPTH = 64;

const HEADING = '## Repository instructions for Matron sessions (MATRON.md)';
const INTRO = [
  "These come from the repository you are working in, like its CLAUDE.md or AGENTS.md, and are given only to Matron sessions.",
  'They add to CLAUDE.md and AGENTS.md, and where the two disagree in a Matron session, follow these.',
  "The user's memories (below) take precedence over them, and so do the bridge's rules on sensitive data and on turns started by another person.",
  'Files are listed from the repository root down to your working directory; a deeper file is the more specific one.',
].join(' ');
export const MATRON_MD_TRUNCATED = `[MATRON.md instructions truncated: more than ${MATRON_MD_MAX_BYTES / 1024} KB in total. The rest was not loaded.]`;

const isEntry = (fsImpl, p) => {
  try {
    fsImpl.statSync(p);
    return true;
  } catch {
    return false;
  }
};

const realOr = (fsImpl, p) => {
  try {
    return fsImpl.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const isWithin = (dir, p) => {
  const r = path.relative(dir, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

// The directories to read, root first: from the repository root (nearest
// ancestor with `.git`) down to workdir, or just workdir outside a repo.
// The workdir's real path is walked, so a symlinked workdir still finds
// the repository it points into.
export function matronMdDirs(workdir, { fsImpl = fs } = {}) {
  if (typeof workdir !== 'string' || !workdir) return [];
  const start = realOr(fsImpl, workdir);
  const chain = [];
  let dir = start;
  for (let i = 0; i < MAX_DEPTH; i++) {
    chain.push(dir);
    if (isEntry(fsImpl, path.join(dir, '.git'))) return chain.reverse();
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [start];
}

// One MATRON.md through a single descriptor, so what is checked is what is
// read: { buf, size } with at most `cap` bytes (plus a few, so a cut can
// find a character boundary), or null when it is not a regular file. Never
// reads more than that, however big the file is.
function readCapped(fsImpl, file, cap) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) return null;
    const want = Math.min(st.size, cap + 4);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fsImpl.readSync(fd, buf, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: buf.subarray(0, got), size: st.size };
  } finally {
    fsImpl.closeSync(fd);
  }
}

// At most maxBytes of buf as UTF-8, never splitting a character.
function decodeToBytes(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

const SILENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

// { files: [{ path, rel, bytes }], block, truncated }. `rel` is the file's
// path relative to the repository root (or just `MATRON.md`), `bytes` its
// size on disk, `block` the prompt section ('' when nothing was found).
// `files` lists only what was loaded: once the cap is reached, deeper files
// are neither read nor listed, and `truncated` says so.
//
// A MATRON.md that is a symlink is followed only to a file inside the
// repository (or, outside one, the workdir): a branch must not be able to
// pull an arbitrary file the bridge can read into a session's prompt.
export function loadMatronMd(workdir, { fsImpl = fs, maxBytes = MATRON_MD_MAX_BYTES, log = console } = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };
  const dirs = matronMdDirs(workdir, { fsImpl });
  const root = dirs[0];
  const files = [];
  const sections = [];
  let budget = maxBytes;
  let truncated = false;
  for (const [i, dir] of dirs.entries()) {
    if (truncated) break;
    const file = path.join(dir, MATRON_MD_NAME);
    if (budget <= 0) {
      // The cap is spent exactly: no deeper file is read or listed, but if
      // there is one, the instructions were cut short and must say so.
      truncated = dirs.slice(i).some((d) => isEntry(fsImpl, path.join(d, MATRON_MD_NAME)));
      break;
    }
    let read;
    try {
      const real = fsImpl.realpathSync(file);
      if (!isWithin(root, real)) {
        warn(`[matron-md] ${file} points outside ${root} — skipped`);
        continue;
      }
      read = readCapped(fsImpl, real, budget);
    } catch (e) {
      if (!SILENT_CODES.has(e?.code)) warn(`[matron-md] could not read ${file}: ${e.message} — skipped`);
      continue;
    }
    if (!read) continue;
    const rel = path.relative(root, file) || MATRON_MD_NAME;
    files.push({ path: file, rel, bytes: read.size });
    if (read.size > budget) {
      truncated = true;
      warn(`[matron-md] ${file} takes MATRON.md instructions over ${maxBytes} bytes — truncated`);
    }
    const body = decodeToBytes(read.buf, budget).trim();
    budget -= Buffer.byteLength(body, 'utf8');
    if (body) sections.push(`### ${rel}\n\n${body}`);
  }
  if (!sections.length) return { files, block: '', truncated };
  if (truncated) sections.push(MATRON_MD_TRUNCATED);
  return { files, block: [HEADING, INTRO, ...sections].join('\n\n'), truncated };
}

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// 'MATRON.md (3.1 KB), editor/MATRON.md (410 B)', with ', truncated' when
// the cap cut it; '' when the spawn found no file.
export function matronMdFileList(loaded) {
  const files = Array.isArray(loaded?.files) ? loaded.files : [];
  if (!files.length) return '';
  const list = files.map((f) => `${f.rel} (${size(f.bytes)})`).join(', ');
  return `${list}${loaded.truncated ? ', truncated' : ''}`;
}

// The line the start, resume and restart messages and /status carry:
// 'MATRON.md: MATRON.md (3.1 KB)'. '' when no file was found.
export function matronMdStatusLine(loaded) {
  const list = matronMdFileList(loaded);
  return list ? `MATRON.md: ${list}` : '';
}
