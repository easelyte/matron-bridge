// This box's Claude Code memories, read-only, for the `local_memories` and
// `local_memory_get` agent RPCs (mission "Show each box's Claude Code
// memories in Matron", 2026-09-29). Two kinds of file:
//
//   - CLAUDE.md instruction files: the global ~/.claude/CLAUDE.md and, for
//     each folder the picker knows (the same sources as `recent_folders`),
//     <folder>/CLAUDE.md and <folder>/.claude/CLAUDE.md.
//   - Auto-memory: ~/.claude/projects/<project>/memory/*.md — one fact per
//     file with a YAML-ish frontmatter (name, description, metadata.type)
//     and a MEMORY.md index of `- [Title](file.md) — hook` lines.
//
// `index()` lists them (metadata only, trimmed to the journal's 16 KiB RPC
// frame with a per-project `more` count); `get()` returns one file's body,
// paged. Both go through ONE allow-list check: a path is served only if it
// is, lexically, one of the locations above AND its realpath (symlinks
// followed) is too — so a link planted in a memory dir that points at
// ~/.bashrc is refused, and what `index()` lists is exactly what `get()`
// will serve. Nothing here writes.

import nodeFs from 'fs';
import path from 'path';
import { encodeProjectSegment } from './transcript-dir.js';

// The journal caps the whole `agent_response` frame at 16 KiB
// (MATRON_RPC_MAX_BYTES, matron-journal docs/protocol.md "Agent RPC"). The
// envelope around `result` (op, request_id <=128 chars, to_device_id, ok) is
// well under 1 KiB, so results stay at 15 KiB.
export const LOCAL_MEMORIES_RESULT_MAX_BYTES = 15 * 1024;
// A `get` result is the body plus path (<=1024 chars), size, mtime, offset,
// next_offset: 2 KiB of headroom covers the longest path with room to spare.
const DEFAULT_BODY_MAX_BYTES = LOCAL_MEMORIES_RESULT_MAX_BYTES - 2048;
// Files past this are not read at all (index: metadata only; get: too_large).
// A memory file is 1-7 KB, a big CLAUDE.md ~30 KB; this is a safety cap, not
// a budget.
const DEFAULT_FILE_MAX_BYTES = 512 * 1024;
const PATH_MAX_CHARS = 1024;
const FOLDERS_MAX = 50;
const NAME_MAX = 100;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 200;
const HOOK_MAX = 200;
const INDEX_FILE = 'MEMORY.md';

// Claude Code names a project directory after the realpath of its folder
// (lib/transcript-dir.js encodeProjectSegment: every non-alphanumeric char
// to `-`, plus a hash suffix past 200 chars). Lossy, so the index only ever
// DEcodes by encoding the folders it already knows and matching — never by
// guessing a path from a dir name.

const unquote = (raw) => {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const q = v[0];
    const inner = v.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'");
  }
  return v;
};

// {name, description, type} from a memory file's leading `---` block.
// Tolerant: missing or unterminated frontmatter reads as empty strings;
// `type` is taken from `metadata:`'s indented `type:` or a top-level one.
export function parseMemoryFrontmatter(text) {
  const out = { name: '', description: '', type: '' };
  if (typeof text !== 'string') return out;
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return out;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return out;
  let inMetadata = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const m = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    if (!indented) {
      inMetadata = key === 'metadata';
      if (key === 'name') out.name = unquote(rest);
      else if (key === 'description') out.description = unquote(rest);
      else if (key === 'type') out.type = unquote(rest);
    } else if (inMetadata && key === 'type') {
      out.type = unquote(rest);
    }
  }
  return out;
}

// MEMORY.md's `- [Title](file.md) — hook` lines, keyed by the linked file's
// basename. Lines that are not a list item with a link are ignored.
export function parseMemoryIndex(text) {
  const byFile = new Map();
  if (typeof text !== 'string') return byFile;
  const re = /^\s*[-*]\s*\[([^\]]*)\]\(([^)\s]+)\)\s*(?:[—–-]+\s*(.*))?$/;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const file = path.posix.basename(m[2]);
    if (!file) continue;
    byFile.set(file, { title: m[1].trim(), hook: (m[3] || '').trim() });
  }
  return byFile;
}

const humanize = (stem) => {
  const words = stem.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : stem;
};

const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const isLeadSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isTrailSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

// First body line that is neither blank nor a heading — the description
// fallback for a memory with no frontmatter description.
const firstBodyLine = (text) => {
  let body = text;
  if (/^---\r?\n/.test(text)) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
    if (m) body = text.slice(m[0].length);
  }
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return '';
};

export function createLocalMemories({
  homeDir,
  fs = nodeFs,
  maxResultBytes = LOCAL_MEMORIES_RESULT_MAX_BYTES,
  maxBodyBytes = DEFAULT_BODY_MAX_BYTES,
  maxFileBytes = DEFAULT_FILE_MAX_BYTES,
} = {}) {
  if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir)) throw new Error('createLocalMemories: homeDir must be an absolute path');
  const home = path.resolve(homeDir);
  const claudeDir = path.join(home, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');

  const realpathOrNull = (p) => {
    try { return fs.realpathSync(p); } catch { return null; }
  };

  // The known folders, resolved and deduped, oldest-first order preserved
  // from the caller (which hands them newest-first), capped.
  const normalizeFolders = (folders) => {
    const out = [];
    const seen = new Set();
    for (const f of Array.isArray(folders) ? folders : []) {
      if (typeof f !== 'string' || !f || !path.isAbsolute(f)) continue;
      const r = path.resolve(f);
      if (seen.has(r)) continue;
      seen.add(r);
      out.push(r);
      if (out.length >= FOLDERS_MAX) break;
    }
    return out;
  };

  // Lexical allow-list: is `p` (already resolved) one of the served
  // locations, given this home and these folders?
  const allowedUnder = (p, homeRoot, folders) => {
    const cd = path.join(homeRoot, '.claude');
    if (p === path.join(cd, 'CLAUDE.md')) return true;
    const rel = path.relative(path.join(cd, 'projects'), p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const seg = rel.split(path.sep);
      if (seg.length === 3 && seg[0] && seg[0] !== '.' && seg[0] !== '..' && seg[1] === 'memory'
        && seg[2].endsWith('.md') && seg[2] !== '.md') return true;
    }
    for (const folder of folders) {
      if (p === path.join(folder, 'CLAUDE.md') || p === path.join(folder, '.claude', 'CLAUDE.md')) return true;
    }
    return false;
  };

  // The roots as given and as the filesystem resolves them — home itself
  // may sit behind a symlink (macOS /private/var), and so may a folder.
  // Computed once per request: index() checks every candidate file through
  // resolveAllowed, and re-resolving 50 folders per file would be
  // thousands of blocking realpath calls on the bridge's event loop.
  const rootsFor = (rawFolders) => {
    const folders = normalizeFolders(rawFolders);
    return {
      folders,
      realHome: realpathOrNull(home) ?? home,
      realFolders: folders.map((f) => realpathOrNull(f)).filter(Boolean),
    };
  };

  // The one gate both methods go through. Input: an absolute path string
  // and the request's roots (rootsFor). Returns {ok:true, real, stat} for a
  // regular file that is allow-listed both as given and as resolved, else
  // {ok:false, code}. Nothing is read.
  const resolveAllowed = (p, roots) => {
    if (typeof p !== 'string' || !p || p.length > PATH_MAX_CHARS || p.includes('\0') || !path.isAbsolute(p)) {
      return { ok: false, code: 'bad_request' };
    }
    const resolved = path.resolve(p);
    if (!allowedUnder(resolved, home, roots.folders)) return { ok: false, code: 'forbidden' };
    const real = realpathOrNull(resolved);
    if (!real) return { ok: false, code: 'not_found' };
    // Re-check the resolved target against the resolved roots.
    if (!allowedUnder(real, roots.realHome, roots.realFolders)) return { ok: false, code: 'forbidden' };
    let stat;
    try { stat = fs.statSync(real); } catch { return { ok: false, code: 'not_found' }; }
    if (!stat.isFile()) return { ok: false, code: 'not_found' };
    return { ok: true, real, stat };
  };

  const fileEntry = (p, roots) => {
    const r = resolveAllowed(p, roots);
    if (!r.ok) return null;
    return { path: p, size: r.stat.size, mtime: Math.round(r.stat.mtimeMs), real: r.real };
  };

  const readCapped = (real, size) => {
    if (size > maxFileBytes) return null;
    try { return fs.readFileSync(real, 'utf8'); } catch { return null; }
  };

  const listProjectDirs = () => {
    let entries;
    try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => n && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\\'))
      .sort();
  };

  const buildProject = (dir, folderByDir, roots, offset) => {
    const memoryDir = path.join(projectsDir, dir, 'memory');
    let names;
    try { names = fs.readdirSync(memoryDir); } catch { return null; }
    let index = null;
    let indexMap = new Map();
    const memories = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md') || name === '.md') continue;
      const entry = fileEntry(path.join(memoryDir, name), roots);
      if (!entry) continue; // not a regular allow-listed file (a dir, a link out, gone)
      const { real, ...meta } = entry;
      if (name === INDEX_FILE) {
        index = meta;
        indexMap = parseMemoryIndex(readCapped(real, meta.size) ?? '');
        continue;
      }
      const text = readCapped(real, meta.size);
      const fm = parseMemoryFrontmatter(text ?? '');
      const stem = name.slice(0, -3);
      // No `path` per memory: it is always `${memory_dir}/${file}` and the
      // frame is the scarce resource here (a 40-memory project is ~20 KB
      // with paths, ~15 KB without).
      memories.push({
        file: name,
        name: cap(fm.name || stem, NAME_MAX),
        title: '', // filled from the index below
        description: cap(fm.description || (text ? firstBodyLine(text) : ''), DESCRIPTION_MAX),
        type: cap(fm.type, NAME_MAX),
        hook: '',
        size: meta.size,
        mtime: meta.mtime,
      });
    }
    for (const m of memories) {
      const idx = indexMap.get(m.file);
      m.title = cap(idx?.title || humanize(m.name), TITLE_MAX);
      m.hook = cap(idx?.hook || '', HOOK_MAX);
    }
    if (!index && memories.length === 0) return null;
    memories.sort((a, b) => (b.mtime - a.mtime) || a.file.localeCompare(b.file));
    const start = Math.min(offset, memories.length);
    return {
      dir,
      path: folderByDir.get(dir) ?? null,
      memory_dir: memoryDir,
      index,
      offset: start,
      memories: memories.slice(start),
      more: 0,
    };
  };

  return {
    // {folders: [abs path], project?: dir name, offset?: n,
    // claudeMdOffset?: n} -> the index reply. `project` narrows to one
    // project dir (no claude_md); `offset` skips that many (newest-first)
    // memories of each listed project — with `project`, the way to page
    // past `more`. `claudeMdOffset` asks for a claude_md-only page (no
    // projects) skipping that many entries — the way past `more_claude_md`.
    // Never throws for a filesystem reason: what cannot be read is left out.
    index({ folders: rawFolders = [], project, offset = 0, claudeMdOffset } = {}) {
      const roots = rootsFor(rawFolders);
      const { folders } = roots;
      const skip = Number.isInteger(offset) && offset > 0 ? offset : 0;
      const singleProject = project !== undefined;
      // A claude_md-only page: the reply carries no projects and skips the
      // first claudeMdOffset entries — how a client reads past
      // `more_claude_md`.
      const claudeMdPage = claudeMdOffset !== undefined;
      const claudeMdSkip = Number.isInteger(claudeMdOffset) && claudeMdOffset > 0 ? claudeMdOffset : 0;
      const claudeMd = [];
      const seenClaudeMd = new Set();
      const pushClaudeMd = (entry) => {
        // The home dir is usually a known folder too, so its .claude/CLAUDE.md
        // would list twice: once as the global file, once as a folder's.
        if (seenClaudeMd.has(entry.path)) return;
        seenClaudeMd.add(entry.path);
        claudeMd.push(entry);
      };
      // A single-project page is for reading past `more`: the caller has
      // the CLAUDE.md list from the full reply already, so it is left out
      // and the whole budget goes to that project's memories.
      const global = singleProject ? null : fileEntry(path.join(claudeDir, 'CLAUDE.md'), roots);
      if (global) pushClaudeMd({ path: global.path, size: global.size, mtime: global.mtime });
      // A folder matches its project dir by its realpath (what Claude Code
      // encodes) and, in case the link has since moved, as given too.
      const folderByDir = new Map();
      for (const folder of folders) {
        for (const form of new Set([realpathOrNull(folder) ?? folder, folder])) {
          const dir = encodeProjectSegment(form);
          if (!folderByDir.has(dir)) folderByDir.set(dir, folder);
        }
        if (singleProject) continue;
        for (const candidate of [path.join(folder, 'CLAUDE.md'), path.join(folder, '.claude', 'CLAUDE.md')]) {
          const e = fileEntry(candidate, roots);
          if (e) pushClaudeMd({ path: e.path, size: e.size, mtime: e.mtime, folder });
        }
      }
      let dirs = claudeMdPage ? [] : listProjectDirs();
      if (singleProject) {
        dirs = typeof project === 'string' && dirs.includes(project) ? [project] : [];
      }
      const projects = dirs
        .map((dir) => buildProject(dir, folderByDir, roots, skip))
        .filter(Boolean)
        .sort((a, b) => {
          const newest = (p) => Math.max(p.index?.mtime ?? 0, ...p.memories.map((m) => m.mtime));
          return (newest(b) - newest(a)) || a.dir.localeCompare(b.dir);
        });
      const result = { home, claude_md: claudeMd, projects };
      if (claudeMdPage) {
        result.claude_md_offset = Math.min(claudeMdSkip, claudeMd.length);
        claudeMd.splice(0, result.claude_md_offset);
      }
      // Frame budget, three stages, each only when the one before is
      // exhausted. (1) Drop the oldest memory of the fullest project,
      // counting each drop in that project's `more`; the client pages the
      // rest with `project: dir, offset: offset + memories.length`. (2) Drop
      // whole projects, least recently active first, naming each in
      // `more_projects` so the client can fetch it by `project: dir`.
      // (3) Drop CLAUDE.md entries from the end (oldest folders last in
      // the list), counted in `more_claude_md`; the client reads them with
      // `claude_md_offset: claude_md_offset + claude_md.length`.
      while (jsonBytes(result) > maxResultBytes) {
        let fullest = null;
        for (const p of projects) {
          if (p.memories.length > 0 && (!fullest || p.memories.length > fullest.memories.length)) fullest = p;
        }
        if (fullest) {
          fullest.memories.pop();
          fullest.more += 1;
        } else if (projects.length > 0) {
          const dropped = projects.pop();
          (result.more_projects ??= []).push(dropped.dir);
        } else if (claudeMd.length > 0) {
          claudeMd.pop();
          result.more_claude_md = (result.more_claude_md ?? 0) + 1;
        } else {
          break; // nothing left to trim: `home` alone cannot exceed the budget
        }
      }
      return result;
    },

    // {path, offset?, folders} -> {ok:true, result:{path, size, mtime,
    // offset, body, next_offset}} | {ok:false, error:{code, detail?}}.
    // `offset`/`next_offset` are in UTF-16 code units of the decoded text
    // (JS string indices), never split a surrogate pair, and a page's JSON
    // form stays within maxBodyBytes.
    get({ path: p, offset = 0, folders: rawFolders = [] } = {}) {
      if (!Number.isInteger(offset) || offset < 0) return { ok: false, error: { code: 'bad_request' } };
      const r = resolveAllowed(p, rootsFor(rawFolders));
      if (!r.ok) return { ok: false, error: { code: r.code } };
      if (r.stat.size > maxFileBytes) {
        return { ok: false, error: { code: 'too_large', detail: `${r.stat.size} bytes; cap ${maxFileBytes}` } };
      }
      let text;
      try { text = fs.readFileSync(r.real, 'utf8'); } catch { return { ok: false, error: { code: 'not_found' } }; }
      let start = Math.min(offset, text.length);
      // An offset pointing at the trail half of a pair (a client that
      // computed it by bytes, say) steps back so the pair goes whole.
      if (start > 0 && start < text.length && isTrailSurrogate(text.charCodeAt(start))) start -= 1;
      let end = text.length;
      if (jsonBytes(text.slice(start, end)) > maxBodyBytes) {
        // Largest end whose JSON-escaped slice fits (binary search), then
        // step back off a lead surrogate so the pair goes whole on the
        // next page.
        let lo = start;
        let hi = end;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (jsonBytes(text.slice(start, mid)) <= maxBodyBytes) lo = mid; else hi = mid - 1;
        }
        end = lo;
        if (end > start && isLeadSurrogate(text.charCodeAt(end - 1))) end -= 1;
        // A budget too small for even one character must still make progress.
        if (end === start && start < text.length) end = start + (isLeadSurrogate(text.charCodeAt(start)) ? 2 : 1);
      }
      return {
        ok: true,
        result: {
          path: path.resolve(p),
          size: r.stat.size,
          mtime: Math.round(r.stat.mtimeMs),
          offset: start,
          body: text.slice(start, end),
          next_offset: end < text.length ? end : null,
        },
      };
    },
  };
}
