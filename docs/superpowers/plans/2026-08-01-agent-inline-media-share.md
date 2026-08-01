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

**Intra-Phase-2 ordering:** T-2.5 (add `timeoutMs` to `uploadMedia`) lands before or with T-2.2
step 4, which passes `timeoutMs`. If T-2.2 is implemented first, its `uploadMedia` call simply
passes an ignored param until T-2.5 wires the AbortController — harmless, but implement T-2.5
alongside T-2.2 for a working deadline.

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

- **Two spawn/construct functions** build sessions and MUST both be wired: `createSession`
  (print mode; spawn env `:1098-1104`, session object `:1111+`) and
  `createInteractiveSessionForRoom` (interactive mode; a SEPARATE top-level function at `:1597`,
  spawn env `:1658-1664`, session object `:1672+`). Mirror how `showBashOutputAtSpawn` is
  independently computed in each. Wiring only `createSession` silently 403s every interactive-mode
  session.
- In each function mint the token **before** the `spawn()` call — `spawn()` precedes the
  session-object declaration, so referencing `session` at spawn is a temporal-dead-zone
  `ReferenceError`. Use a pre-spawn local: `const showFileToken = randomUUID();`
- Inject `SHOW_FILE_TOKEN = showFileToken` and `BRIDGE_API_URL` (or rely on the existing
  `MATRON_BRIDGE_API_PORT`) into the claude child env alongside `BRIDGE_ROOM_ID`
  (`:1098-1104`, `:1658-1664`), then store `session.showFileToken = showFileToken` on the
  constructed session object.
- No separate token map: the token lives on the session object and dies with it (no teardown-seam
  cleanup — the ~9 `sessions.delete` sites drop the object and the token with it).

**Acceptance:** every spawned claude child (print AND interactive mode) has `SHOW_FILE_TOKEN` in env
== its session's `showFileToken`; two concurrent sessions have distinct tokens; both spawn seams
tested.

### T-2.2: Emit helper `journalShareAgentMedia` + config constants

**File:** `index.js`

- **Imports (blocker if skipped):** `index.js:52` imports only `checkFileLink` from
  `lib/file-link-guard.js`, and `path` is a namespace import at `:9`. Extend the guard import to add
  `validateAndOpen` and `FileLinkDenied`, and use `path.basename(...)` — a bare
  `validateAndOpen`/`FileLinkDenied`/`basename` is unbound → `ReferenceError` (502 on every call).
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

- Cap the request body at 64 KB **for the `/show-file` route specifically** → `413` if exceeded.
  The `apiServer` `req.on('data', ...)` accumulator (`index.js:6639-6640`) is shared across all POST
  routes and caps nothing today; gate the cap on `url.pathname === '/show-file'` and enforce it
  DURING accumulation (abort + 413 once the running length exceeds 64 KB) — do NOT apply it globally
  (would regress `/share-sensitive`'s `content` field) and do NOT defer to the `end` handler (the
  whole body would already be buffered, violating "do not buffer past the cap").
- Wrap the entire handler body in try/catch → on any unexpected throw, `res.writeHead(502)` +
  `{"error":"internal error"}` (never fall through to the shared `Invalid JSON` catch, `:7037`).
- Parse `{ path, caption, token }`; missing `path` or `token` → `400`.
- Resolve session: `let session; for (const s of sessions.values()) if (s.showFileToken === token) { session = s; break; }` → no match → `403 {"error":"invalid token"}`. Ignore any body `roomId`.
- `const r = await journalShareAgentMedia(session, { path, caption });`
- Status map: `r.ok` → `200 {ok:true, media_id:r.media_id, kind:r.kind}`; else by `r.denied`:
  `sensitive`/`outside-scope` → 403; `too-large` → 413; `not-a-file`/`unreadable`/`symlink`/
  `relative-path`/`bad-workdir` → 404; `upload-failed` → 502.
- **Audit log** (one structured line, via **unconditional `console.log`/`console.warn`** — NOT the
  `DEBUG=1`-gated `debug()` helper at `index.js:378`, so this security-relevant egress trail (P34)
  isn't silently killed by a future debug-quieting): on ok `{event:'show_file', roomId: session.roomId, realPath:
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
  `BRIDGE_API_URL` || `MATRON_BRIDGE_API_PORT`, `ask-user.js:13-15`). The repo is `"type":"module"`
  (pure ESM — no `require` anywhere), so `import path from 'node:path'` at module scope.
- Register one tool `show_file` with the spec's description; zod schema `{ path: z.string().refine(p
  => path.isAbsolute(p), 'path must be absolute'), caption: z.string().max(4096).optional() }` —
  **use the module-scope `path.isAbsolute`, NOT `require('node:path')`** (undefined in ESM →
  `ReferenceError` inside the refine on every call, before the handler runs). `.tool()` positional
  form matches `ask-user.js` (live in prod); if the installed SDK version has deprecated it for
  `registerTool()`, switch to the object form. Handler POSTs `${BRIDGE_API}/show-file` with `{ path,
  caption, token:
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
- Register `share` in `knownMcpExtras()` / `EXTRA_FLAG_TO_NAME` **only** to support the opt-in
  `--share` veto flag (below). Note: the `index.js:193` startup check warns only when a *known flag*
  lacks a matching config block — it does NOT warn about a config block that isn't a known flag — so
  omitting `share` from `knownMcpExtras()` triggers no warning either way (the earlier "will warn
  otherwise" rationale was incorrect). Registration is for the veto path, not to silence a warning.

**Acceptance:** a `share`-enabled session spawned in a non-bridge workdir starts the `show_file`
server successfully (no ENOENT); the generated `.mcp-config-generated.share.json` points at the
absolute `show-file-mcp.js`.

### T-3.3: Default-on via effective-extras union (inheritance-safe)

**File:** `index.js` (+ `lib/mcp-config.js` if the union helper lives there)

- Define `DEFAULT_MCP_EXTRAS` behind an **env kill-switch** so default-on can be disabled without a
  code edit + redeploy + restart on the live bridge (matches the spec's "operator-veto-able" language
  and the repo's kill-switch convention for new capabilities):
  `const DEFAULT_MCP_EXTRAS = process.env.SHOW_FILE_DEFAULT_ON === '0' ? [] : ['share'];`. Setting
  `SHOW_FILE_DEFAULT_ON=0` in the bridge env + restart turns default-on off (the `--share` flag still
  opts a session in). This is the cheap circuit-breaker for a default-on file-egress primitive.
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
- kill-switch: with `SHOW_FILE_DEFAULT_ON=0`, `DEFAULT_MCP_EXTRAS=[]` so `resolvedExtras=[]` →
  effective `[]` (no `share` injected); a `--share`-flagged session still resolves to `['share']`.

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
- **Interactive-mode session** (a room with `MATRON_INTERACTIVE_MODE=1`) also gets a working
  `show_file` — verifies the token was wired into `createInteractiveSessionForRoom`, not just
  `createSession` (the two-spawn-function gap). At minimum one iv-mode PNG show.
- **Kill-switch:** with `SHOW_FILE_DEFAULT_ON=0` set, a fresh no-flag session does NOT have
  `show_file`, and a `--share` session does — confirms the veto path.

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

## Appendix: Verified Claims (research pass 2026-08-01)

✓ Claim: Node `fetch` honors an `AbortController` signal to abort an in-flight/stalled request; `controller.abort()` rejects the fetch. Verified (MDN AbortSignal / javascript.info/fetch-abort) — the T-2.5 `setTimeout`→`abort()` upload-deadline pattern is sound.
✓ Claim: `@modelcontextprotocol/sdk` `McpServer` + `server.tool(name, desc, zodSchema, handler)` + `StdioServerTransport` is a valid registration shape. Verified (modelcontextprotocol/typescript-sdk) — live in this repo's `ask-user.js`. Caveat: newer SDK examples favor object-based `registerTool()`; `.tool()` is not documented as removed — spot-check against the installed SDK version before merge.
✓ Claim: zod `.refine()` attaches a custom predicate; `.string().max(n)` bounds length. Verified (zod.dev).
✓ Claim: Node `path.isAbsolute()` checks absoluteness; `fs.promises.realpath()` resolves `.`/`..`/symlinks to a canonical path. Verified (nodejs.org/api/fs).
