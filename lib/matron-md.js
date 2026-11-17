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
// A workdir outside any repository (a folder of clones, the home folder)
// gets no repository's instructions at all, and an agent there tends to work
// in a repository below it without ever reading them. So the block then ends
// with a pointer naming each repository directly below the workdir that has
// instructions for agents, and asking the agent to read them before working
// there. The files themselves are not loaded: a folder of clones and
// worktrees of one repository would repeat the same file many times over.
// For Claude the pointer names MATRON.md only, since Claude Code loads a
// nested CLAUDE.md by itself when it reads files below it. For Codex it also
// names AGENTS.md and CLAUDE.md, because Codex reads AGENTS.md only from the
// repository holding its working directory.
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

// Children of a non-repository workdir looked at for the pointer, and
// repositories named in it; the rest are counted, not named.
const POINTER_SCAN_MAX = 2000;
const POINTER_NAMES_MAX = 25;

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
const isRegularFile = (fsImpl, p) => {
  try {
    return fsImpl.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (fsImpl, p) => {
  try {
    return fsImpl.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The instruction files each agent is pointed at, in the order named.
const POINTER_FILES = {
  claude: [MATRON_MD_NAME],
  codex: [MATRON_MD_NAME, 'AGENTS.md', 'CLAUDE.md'],
};

// An instruction file counts only when it is a regular file inside its
// repository: a symlink pointing elsewhere is not named, as the loader would
// not load it either.
const isFileWithin = (fsImpl, root, p) => {
  try {
    return isWithin(fsImpl.realpathSync(root), fsImpl.realpathSync(p)) && isRegularFile(fsImpl, p);
  } catch {
    return false;
  }
};

// { repos: [{ name, files }], partial } for the repositories directly below
// `dir` holding one of the agent's instruction files, sorted by name. Hidden
// folders are skipped. `partial` is true when the folder had more entries
// than were checked.
export function reposWithInstructions(dir, { agent = 'claude', fsImpl = fs } = {}) {
  const wanted = POINTER_FILES[agent] || POINTER_FILES.claude;
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return { repos: [], partial: false };
  }
  const repos = [];
  for (const name of names.slice(0, POINTER_SCAN_MAX)) {
    if (typeof name !== 'string' || name.startsWith('.')) continue;
    const child = path.join(dir, name);
    if (!isDirectory(fsImpl, child) || !isEntry(fsImpl, path.join(child, '.git'))) continue;
    const files = wanted.filter((f) => isFileWithin(fsImpl, child, path.join(child, f)));
    if (files.length) repos.push({ name, files });
  }
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { repos, partial: names.length > POINTER_SCAN_MAX };
}

// The pointer section for a workdir outside any repository, or '' when the
// workdir is inside one or no repository below it has instructions.
export function repoInstructionsPointer(workdir, { agent = 'claude', fsImpl = fs } = {}) {
  if (typeof workdir !== 'string' || !workdir) return '';
  const dirs = matronMdDirs(workdir, { fsImpl });
  if (dirs.length !== 1 || isEntry(fsImpl, path.join(dirs[0], '.git'))) return '';
  const { repos, partial } = reposWithInstructions(dirs[0], { agent, fsImpl });
  if (!repos.length) return '';
  const named = repos.slice(0, POINTER_NAMES_MAX).map((r) => `\`${r.name}\` (${r.files.join(', ')})`);
  const more = repos.length - named.length;
  let list = `${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
  if (partial) list += ` (the folder holds more than ${POINTER_SCAN_MAX} entries, and the rest were not checked)`;
  return [
    '## Repositories below your working folder',
    `Your working folder is not inside a git repository, so no repository's instructions were loaded. These repositories directly below it have instructions for agents: ${list}. Before you work in one of them, read its files listed here; where a MATRON.md and a CLAUDE.md or AGENTS.md disagree, follow the MATRON.md.`,
  ].join('\n\n');
}

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
//
// `block` also carries the pointer to repositories below a workdir that is
// not inside one (repoInstructionsPointer), for the given agent.
export function loadMatronMd(workdir, { fsImpl = fs, maxBytes = MATRON_MD_MAX_BYTES, log = console, agent = 'claude' } = {}) {
  const loaded = loadMatronMdFiles(workdir, { fsImpl, maxBytes, log });
  let pointer = '';
  try {
    pointer = repoInstructionsPointer(workdir, { agent, fsImpl });
  } catch (e) {
    try { log.warn(`[matron-md] could not list repositories below ${workdir}: ${e.message}`); } catch { /* never throw */ }
  }
  if (!pointer) return loaded;
  return { ...loaded, block: [loaded.block, pointer].filter(Boolean).join('\n\n') };
}

function loadMatronMdFiles(workdir, { fsImpl, maxBytes, log }) {
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
