# local_memories / local_memory_get: a box's Claude Code memories, read-only

**Date:** 2026-09-29
**Status:** Implemented (this PR)
**Depends on:** 2026-07-15 agent RPC design (the `recent_folders` dispatch path)

## Problem

Each box carries Claude Code memories the journal knows nothing about: the
global `~/.claude/CLAUDE.md`, each repo's `CLAUDE.md` / `.claude/CLAUDE.md`,
and Claude Code's auto-memory under `~/.claude/projects/<project>/memory/`
(one fact per file with a `name` / `description` / `metadata.type`
frontmatter, plus a `MEMORY.md` index of `- [Title](file.md) — hook` lines).
The Matron Memories screen shows the journal memories only, so the two
cannot be compared for duplication. Step 1 of that mission is a way for a
client to read a box's local memories over the RPC path the folder picker
already uses. Nothing is written.

## Methods

Both are agent RPCs beside `recent_folders` (`lib/journal-rpc.js`),
answered from `lib/local-memories.js`. Every path in a reply is absolute.
Times are ms since the epoch.

### `local_memories {project?, offset?, claude_md_offset?}`

```json
{
  "home": "/home/dan",
  "claude_md": [
    { "path": "/home/dan/.claude/CLAUDE.md", "size": 1203, "mtime": 1790547504790 },
    { "path": "/home/dan/repo/CLAUDE.md", "size": 30878, "mtime": 1790375312934, "folder": "/home/dan/repo" }
  ],
  "projects": [
    {
      "dir": "-home-dan-repo",
      "path": "/home/dan/repo",
      "memory_dir": "/home/dan/.claude/projects/-home-dan-repo/memory",
      "index": { "path": ".../memory/MEMORY.md", "size": 590, "mtime": 1790000000000 },
      "offset": 0,
      "memories": [
        { "file": "x.md", "name": "x", "title": "X rule", "description": "…", "type": "project", "hook": "…", "size": 1570, "mtime": 1790618965691 }
      ],
      "more": 0
    }
  ]
}
```

- `claude_md`: the global file first (no `folder`), then `CLAUDE.md` and
  `.claude/CLAUDE.md` of every **known folder** — the picker's folder
  history (persisted sessions + the durable folders store) plus the default
  workdir, the same sources `recent_folders` uses. Missing files are left
  out; a file reachable two ways is listed once. A single-project page
  (`project` given) omits `claude_md` — the full reply already carried it.
- `projects`: every `~/.claude/projects/*/memory/` that has at least one
  `.md` file or a `MEMORY.md`, newest activity first. `path` is the folder
  a known folder encodes to (Claude Code's dir name is the folder's
  realpath with every non-alphanumeric character replaced by `-` and a hash
  suffix past 200 chars — `lib/transcript-dir.js` `encodeProjectSegment`,
  matched against each folder as resolved and as given; lossy, so it is only
  ever matched, never decoded) or `null`. `index` is the `MEMORY.md` entry
  or `null`. Memories are newest first; `name`/`description`/`type` come
  from the frontmatter (falling back to the file stem and the first body
  line), `title`/`hook` from the matching index line (title falling back to
  the humanized name). Each memory's own path is `memory_dir + "/" + file`.
  `description`, `title` and `hook` are capped (200 / 120 / 200 chars).
- **Frame cap.** The journal caps an `agent_response` at 16 KiB. The result
  is kept under 15 KiB in three stages, each only once the previous is
  exhausted: (1) drop the oldest memory of the fullest project, adding one
  to that project's `more` — read past it with `{project: dir, offset:
  offset + memories.length}` until `more` is 0 (`offset` skips that many
  newest-first memories; the reply echoes it); (2) drop whole projects,
  least recently active first, naming each in `more_projects: [dir]` so
  the client fetches it with `project: dir`; (3) drop `claude_md` entries
  from the end, counted in `more_claude_md` — read them with
  `{claude_md_offset: claude_md_offset + claude_md.length}`, a
  claude_md-only page (no `projects`, echoes `claude_md_offset`) until
  `more_claude_md` is absent. `more_projects` / `more_claude_md` are absent
  when nothing was dropped.
- Errors: `bad_request` for a non-string `project`, a non-integer /
  negative `offset` or `claude_md_offset`, or `claude_md_offset` combined
  with `project` (they are separate pages). An unknown `project` answers
  `projects: []`.

### `local_memory_get {path, offset?}`

```json
{ "path": "/home/dan/repo/CLAUDE.md", "size": 30878, "mtime": 1790375312934,
  "offset": 0, "body": "…", "next_offset": 13151 }
```

- Serves exactly the files `local_memories` lists: `~/.claude/CLAUDE.md`,
  `~/.claude/projects/<dir>/memory/<file>.md` (one segment each, `.md`
  only, `MEMORY.md` included), and `<known folder>/CLAUDE.md` /
  `<known folder>/.claude/CLAUDE.md`.
- **Allow-list, twice.** The path must be an absolute string (≤ 1024 chars,
  no NUL); it is `path.resolve`d (so `..` traversal is normalised away) and
  checked against the list lexically, then `realpath`ed and the target
  checked again against the realpath'd roots — a symlink planted in a
  memory dir pointing at `~/.bashrc` is `forbidden`; a symlink to another
  allow-listed file is served. Only regular files. Nothing outside the list
  is ever stat'ed, so existence does not leak.
- **Size cap.** Files over 512 KiB are `too_large` (with `detail`). The
  body is **paged**: a page's JSON form stays within ~13 KiB so the frame
  fits; `offset` / `next_offset` are indices into the decoded text (UTF-16
  code units), never split a surrogate pair (an `offset` landing on the
  trail half of a pair steps back one, and the reply's `offset` says so),
  and `next_offset` is `null` on the last page. An `offset` past the end
  answers an empty last page.
- Errors: `bad_request` (malformed path or offset), `forbidden`,
  `not_found` (allow-listed but missing, or not a regular file),
  `too_large`.

## Security

Same trust as `recent_folders`: the journal only delivers requests from the
user's own devices, and the reply goes to the stamped requester. The
allow-list makes the method a reader of a fixed set of the user's own
instruction and memory files, not a general file reader: no directory
listing outside `~/.claude/projects/*/memory/`, no nested paths, no
non-`.md` files, folder CLAUDE.md files only for folders this box has
already used as workdirs. `index()` runs every candidate through the same
gate as `get()`, so what is listed is exactly what is served.

## Testing

`test/local-memories.test.js` (real temp homes: frontmatter and index
parsing, the listing, the frame trim and `more`, offset paging, and every
allow-list refusal including traversal, nested/non-`.md` files, symlinks
out and in, size cap, body paging over multibyte text) and
`test/journal-rpc-handlers.test.js` (dispatch: folder sourcing, param
validation, ok/error relay, the one-reply guarantee on a throw).

## Out of scope (later steps of the mission)

The Apple Memories screen ("On your boxes" section) is step 2 in
matron-apple; Android, a "save as journal memory" action and a journal
mirror of each box's index (so asleep boxes show too) come later.
