# Plan — Agent-initiated inline media share (`show_file`)

Spec: `docs/superpowers/specs/2026-08-01-agent-inline-media-share-design.md` (rev 5, converged)
Repo: `easelyte/claude-matrix-bridge` (branch `agent-inline-media`)
Risk: medium · Execution tier: slim

Adds the one missing trigger for agent→operator inline media: an MCP tool + a bridge
`/show-file` endpoint + a guarded emit helper, reusing the journal server + web client render
paths that already work. Bridge-repo-only diff.

## Dependency graph

```
Phase 1 (guard: allowedRoots extension)  ──▶ Phase 2 (bridge: helper + endpoint + token + upload deadline)
                                                   │
Phase 3 (MCP tool + share extra + default) ◀──────┘  (T-3.1 tool can be authored in parallel; E2E needs Phase 2)
                                                   │
                                                   ▼
                                          Phase 4 (run-it gate — live E2E)
```

Phase 1 blocks Phase 2 (the helper calls the extended guard). Phase 2 blocks Phase 4. Phase 3's
tool file (T-3.1) can be written any time, but its wiring (T-3.2/3.3) and the run-it gate need
Phase 2 live. Execute phases in order 1 → 2 → 3 → 4.

## Spec-coverage map

| Spec part | Task(s) |
|---|---|
| Component 1 — MCP tool `show_file`, absolute entrypoint, `share` extra, default-on | T-3.1, T-3.2, T-3.3 |
| Component 2 — `POST /show-file`, 64KB cap, token-resolve, status map, try/catch | T-2.3 |
| Component 3 — emit helper, guard reuse, mime/kind, upload, publish, best-effort return | T-2.2, T-2.4 |
| Component 3 step 1 — `validateAndOpen` `allowedRoots` extension | T-1.1, T-1.2 |
| Component 3 step 3 — upload deadline | T-2.5 |
| Capability token (Security / Component 2 step 2) | T-2.1 |
| `SHOW_FILE_ARTIFACT_ROOTS` parse + fail-loud | T-2.2 |
| Observability (audit line) | T-2.3 |
| SVG (verified — no code, render path reused) | T-4.1 (run-it verify) |
| Acceptance #1–#8 | T-4.1 + per-task acceptance below |

## Phase 1 — Guard: `allowedRoots` extension

### T-1.1: Extend `validateAndOpen` with `allowedRoots`

**File:** `lib/file-link-guard.js`

Add an optional `allowedRoots: string[]` to `validateAndOpen(filePath, { workdir, allowedRoots, maxBytes })`.
After the fd `realPath` is resolved (via `/proc/self/fd`, `:108`) and **before** the sensitivity
check (`:111`) and before the file is read (`:127`):

- If `allowedRoots` is provided and non-empty: `fsp.realpath()`-resolve each root (a root that
  fails to resolve throws `FileLinkDenied('bad-workdir')`), then throw
  `FileLinkDenied('outside-scope')` unless the internal boundary-safe `contains(realRoot, realPath)`
  (`:63`) is true for at least one resolved root.
- Ordering: this check runs before `isSensitivePath` so an out-of-scope path returns `outside-scope`
  (precedence, P19) and is never read.
- Back-compat: when `allowedRoots` is absent/empty the existing single-`workdir` branch (`:112-119`)
  is unchanged; existing viewer callers (`generateFileLink` → `validateAndOpen`) behave exactly as
  today.

**Acceptance:** `allowedRoots` present → containment enforced pre-read via realpath-resolved roots;
`allowedRoots` absent → byte-identical behavior to current for the single-`workdir` and no-scope
callers.

### T-1.2: Unit tests for the extension

**File:** `test/` (mirror the existing guard test layout; `lib/file-link-guard.js` test file)

Cases:
- realPath under one of several roots → returns `{content, realPath}`.
- realPath outside all roots → throws `FileLinkDenied('outside-scope')`, and asserts the file was
  **not read** (spy/marker that the read path wasn't reached — e.g. a root-only fixture where a read
  would observably differ, or assert via a non-readable-but-stat-able fixture that stat/sensitivity
  weren't the throw site).
- outside-scope **precedence**: a path that is both sensitive-named AND outside all roots → throws
  `outside-scope`, not `sensitive`; a path that is oversized AND outside all roots → `outside-scope`,
  not `too-large`.
- symlinked root/workdir: root `/tmp/t-<x>/link → /tmp/t-<x>/real`, file `/tmp/t-<x>/real/a.png`,
  `allowedRoots:['/tmp/t-<x>/link']` → allowed (canonicalization).
- a root that does not resolve → `bad-workdir`.
- back-compat: `allowedRoots` omitted, single `workdir` set → unchanged pass/deny; no args → unchanged.

**Acceptance:** all cases green; the outside-scope-before-read assertion is explicit.

## Phase 2 — Bridge: emit helper + endpoint + token + upload deadline

### T-2.1: Per-session capability token

**File:** `index.js`

- At session creation (`createSession`), set `session.showFileToken = randomUUID()`.
- Inject `SHOW_FILE_TOKEN` (value = `session.showFileToken`) and `BRIDGE_API_URL` (or rely on the
  existing `MATRON_BRIDGE_API_PORT`) into the claude child process env at **both** spawn sites,
  alongside the existing `BRIDGE_ROOM_ID` (`index.js:1098-1104`, `:1658-1664`).
- No separate token map: the token lives on the session object and dies with it (no teardown-seam
  cleanup needed — the ~9 `sessions.delete` sites drop the object and the token with it).

**Acceptance:** every spawned claude child has `SHOW_FILE_TOKEN` in env == its session's
`showFileToken`; two concurrent sessions have distinct tokens.

### T-2.2: Emit helper `journalShareAgentMedia` + config constants

**File:** `index.js`

- Constants: `SHOW_FILE_MAX_BYTES = 50 * 1024 * 1024`; `SHOW_FILE_UPLOAD_TIMEOUT_MS =
  Number(process.env.SHOW_FILE_UPLOAD_TIMEOUT_MS) || 30000`; `SHOW_FILE_ARTIFACT_ROOTS` parsed at
  startup from `process.env.SHOW_FILE_ARTIFACT_ROOTS` (colon-separated). Parse rule: split on `:`,
  drop empty segments; each remaining entry must be absolute AND exist (`fs.existsSync`) — otherwise
  **throw at startup** (fail loud, V4/P3) with the offending entry named. Default: `[]`.
- `async function journalShareAgentMedia(session, { path: filePath, caption })`:
  1. `const roots = [session.workdir, ...SHOW_FILE_ARTIFACT_ROOTS];`
  2. `try { var { content, realPath } = await validateAndOpen(filePath, { allowedRoots: roots, maxBytes: SHOW_FILE_MAX_BYTES }); } catch (e) { if (e instanceof FileLinkDenied) return { denied: e.reason }; throw e; }`
  3. Derive `mime` from `realPath` extension (case-insensitive map: png/jpg/jpeg/gif/webp/svg → image
     types; else `application/octet-stream`); `kind = mime.startsWith('image/') ? 'image' : 'file'`.
  4. `const media = await journalPublisher.uploadMedia({ bytes: content, contentType: mime, name: basename(realPath), timeoutMs: SHOW_FILE_UPLOAD_TIMEOUT_MS });` (timeout param added in T-2.5).
     `if (!media) return { denied: 'upload-failed' };`
  5. Build payload `{ blob_ref: media.media_id, content_type: media.content_type, name: basename,
     filename: basename, size: media.size, ...(caption ? { caption } : {}) }` and
     `journalPublish(session, kind === 'image' ? 'publishImage' : 'publishFile', payload);` (NOT
     `journalPublishUserItem` — no `markRead`). Do not set `from`.
  6. `return { ok: true, media_id: media.media_id, kind, realPath, size: content.length, sha256: media.sha256 };`

**Acceptance:** helper returns `{ok, media_id, kind, realPath, size, sha256}` on success; a
`FileLinkDenied` reason surfaces as `{denied: reason}` with no upload; `uploadMedia` → null yields
`{denied:'upload-failed'}`; payload carries both `filename` and `name`; `SHOW_FILE_ARTIFACT_ROOTS`
with a bad entry aborts startup.

### T-2.3: `POST /show-file` endpoint

**File:** `index.js` (in `apiServer`, `:6579`, beside `/secret`/`/share-sensitive`)

- Cap the request body at 64 KB during accumulation → `413` if exceeded (do not buffer past the cap).
- Wrap the entire handler body in try/catch → on any unexpected throw, `res.writeHead(502)` +
  `{"error":"internal error"}` (never fall through to the shared `Invalid JSON` catch, `:7037`).
- Parse `{ path, caption, token }`; missing `path` or `token` → `400`.
- Resolve session: `let session; for (const s of sessions.values()) if (s.showFileToken === token) { session = s; break; }` → no match → `403 {"error":"invalid token"}`. Ignore any body `roomId`.
- `const r = await journalShareAgentMedia(session, { path, caption });`
- Status map: `r.ok` → `200 {ok:true, media_id:r.media_id, kind:r.kind}`; else by `r.denied`:
  `sensitive`/`outside-scope` → 403; `too-large` → 413; `not-a-file`/`unreadable`/`symlink`/
  `relative-path`/`bad-workdir` → 404; `upload-failed` → 502.
- **Audit log** (one structured line): on ok `{event:'show_file', roomId: session.roomId, realPath:
  r.realPath, kind:r.kind, size:r.size, media_id:r.media_id, sha256:r.sha256, result:'ok'}`; on denial
  `{event:'show_file', roomId: session.roomId, path, result:r.denied}` (input path — realPath not
  available on a guard throw).

**Acceptance:** AC #3/#4/#5/#6 status codes exact; body >64 KB → 413; unexpected throw → 502 (not
`Invalid JSON`); audit line emitted with the documented fields.

### T-2.4: Unit tests — helper + endpoint

**File:** `test/`

- Helper (mock `validateAndOpen`, `journalPublisher.uploadMedia`, `journalPublish`): image ext →
  `publishImage`; non-image → `publishFile`; payload has BOTH `filename` and `name`; caption
  present/absent; each `FileLinkDenied` reason → `{denied:reason}` no upload; `uploadMedia`→null →
  `upload-failed`; success return includes realPath/size/sha256.
- Endpoint: missing token → 400; unknown token → 403; valid token resolves the right session; body
  `roomId` ignored; each denial reason → its status; unexpected throw → 502 `internal error`; body
  >64 KB → 413; fixture PNG under workdir + valid token → 200 + `journalPublish` called with a
  `filename`.

**Acceptance:** all green.

### T-2.5: Upload deadline in `uploadMedia`

**File:** `lib/journal-publisher.js`

- Add an optional `timeoutMs` to `uploadMedia({ bytes, filePath, contentType, name, timeoutMs })`
  (`:507`). Create an `AbortController`, `setTimeout(() => controller.abort(), timeoutMs)` when
  `timeoutMs` is set, pass `signal: controller.signal` to the `fetch` (`:518`), clear the timer in a
  `finally`. On abort/any failure the existing fail-open path returns `null` (+ one warn). Mirror the
  inbound `fetchMedia` AbortController pattern (`:566-590`). No behavior change when `timeoutMs` is
  omitted (existing callers unaffected).

**Acceptance:** a stalled upload aborts at `timeoutMs` and returns `null` (→ `upload-failed`); omit
`timeoutMs` → unchanged behavior; unit test with a hung fetch asserts bounded return, no hang.

## Phase 3 — MCP tool + `share` extra + default selection

### T-3.1: `show-file-mcp.js` MCP server

**File:** `show-file-mcp.js` (repo root, beside `ask-user.js`)

- Mirror `ask-user.js` structure (`McpServer`, `StdioServerTransport`, `BRIDGE_API` resolution from
  `BRIDGE_API_URL` || `MATRON_BRIDGE_API_PORT`, `ask-user.js:13-15`).
- Register one tool `show_file` with the spec's description; zod schema `{ path: z.string().refine(p
  => require('node:path').isAbsolute(p), 'path must be absolute'), caption: z.string().max(4096).
  optional() }`; handler POSTs `${BRIDGE_API}/show-file` with `{ path, caption, token:
  process.env.SHOW_FILE_TOKEN }` and returns `{content:[{type:'text', text}]}` — success/denial
  strings per spec; a relative path is rejected client-side by the refine before the POST.

**Acceptance:** server starts under stdio; a valid call returns the success string; a denial returns
the mapped denial string; a relative path is refused by the schema.

### T-3.2: Register `share` extra with an ABSOLUTE entrypoint

**Files:** `mcp-config.json`, `lib/mcp-config.js`

- Add `mcpExtras.share.show-file` server block to `mcp-config.json` (shape like the `browser` extra).
- **Entrypoint must resolve to an absolute path** — a relative `args` (`./show-file-mcp.js`) would
  ENOENT because claude runs with the session workdir as `cwd` (`index.js:1025`) and the generic
  resolver canonicalizes `command`, not `args` (`lib/mcp-config.js:105`). Either (a) extend
  `buildMcpServers` to rewrite the `share` server's script `args` to `path.join(askUserBaseDir,
  'show-file-mcp.js')` (mirroring the `ask-user` special-case at `:89`), or (b) generalize the
  resolver to absolutize a relative script `args` for any Node extra. Prefer (a) for a minimal,
  targeted change; note (b) as the cleaner generalization if the reviewer prefers it.
- Ensure `knownMcpExtras()` includes `share` (the startup sanity check at `index.js:193` will warn
  otherwise).

**Acceptance:** a `share`-enabled session spawned in a non-bridge workdir starts the `show_file`
server successfully (no ENOENT); the generated `.mcp-config-generated.share.json` points at the
absolute `show-file-mcp.js`.

### T-3.3: Default-on via effective-extras union (inheritance-safe)

**File:** `index.js` (+ `lib/mcp-config.js` if the union helper lives there)

- Define `DEFAULT_MCP_EXTRAS = ['share']`.
- Union the default into the **effective** extras **only** at the `mcpConfigPathFor(extras)` boundary
  (`index.js:171` and its call sites) — i.e. compute `effective = Array.from(new Set([...resolvedExtras,
  ...DEFAULT_MCP_EXTRAS]))` and pass `effective` to `mcpConfigPathFor`. **Do NOT** add the default to
  the parsed/explicit extras array used for override-vs-inherit detection (`extractMcpExtraFlags`
  result; the `extras.length > 0` checks at `index.js:4754`, `:4768`, `:4992`). This preserves: fresh
  no-flag → `['share']`; no-flag restart/resume of a persisted `['share','browser']` → inherits both,
  union idempotent, `browser` preserved; explicit `--browser` → `['browser','share']`.

**Acceptance:** fresh no-flag session → `show_file` present; no-flag restart of a `['share','browser']`
session → `browser` still present (regression guard); the parsed-extras override signal is unchanged.

### T-3.4: Tests — extra wiring + default selection

**File:** `test/`

- `share` extra resolves to an absolute entrypoint path (unit on the builder / resolver).
- effective-extras union: `resolvedExtras=[]` → effective `['share']`; `['browser']` → `['browser',
  'share']`; `['share','browser']` → `['share','browser']` (idempotent); and the parsed override
  array is NOT mutated by the union (restart-inheritance regression guard).

**Acceptance:** all green; the inheritance-preservation case is explicit.

## Phase 4 — Run-it gate (live E2E)

### T-4.1: Live verification on a real session

**Non-code acceptance gate** (empirical validation — catches what static tests cannot; spec Testing
§ run-it gate). On a live `share`-enabled session:

- `show_file` a real **PNG** → renders inline as an image on the web client (verify both light and
  dark themes).
- `show_file` a real **SVG** → renders inline as an image (confirms `image/svg+xml` `<img>` render).
- `show_file` a real **PDF** → renders as an attachment showing its real filename and size.
- `show_file` a **sensitive** path (`secrets.json` under workdir) → denied `sensitive`, nothing posted.
- `show_file` an **outside-scope** path (`/var/lib/...` or any path outside workdir + roots) → denied
  `outside-scope`, nothing posted.
- A second concurrent session cannot post to the first's conversation (token isolation) — optional
  spot-check if two sessions are convenient.

**Acceptance:** PNG + SVG render inline (both themes); PDF shows real filename + size; sensitive and
outside-scope both denied with nothing posted. Record the outcome in the ship notes.

## Deliberate exceptions / notes

- **Best-effort delivery (not confirmed):** `journalPublish`/`safePublish` swallow enqueue failures
  and return void, so `ok` means uploaded + handed to the fire-and-forget publisher. No `queue-failed`
  signal exists; `upload-failed` is the only synchronous 502. Documented, not a gap (spec Component 3).
- **Orphan blob on a swallowed publish failure:** bounded by the journal's blob TTL (PR #12); no media
  DELETE API, so no synchronous rollback. A two-phase upload/publish reconciliation + idempotency
  (P32) is a deferred follow-up if orphan rate ever matters.
- **`show_file` default-on** is a v1 policy; #458's curated (Nastia) session type overrides it by not
  selecting `share`. Operator-veto-able to explicit opt-in (`--share` flag, `DEFAULT_MCP_EXTRAS=[]`).
- **Latent mirror-path bug** (`journalMirrorUserMedia` `name`/`from` fields) is pre-existing and out
  of scope — file as a separate bridge loop.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
