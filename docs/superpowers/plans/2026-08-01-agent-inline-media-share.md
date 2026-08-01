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
check (`:111`) and before the file is read (`fd.read` at `:128`):

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
== its session's `showFileToken`; two concurrent sessions have distinct tokens. Spawn-env injection is
verified via the T-4.1 run-it gate in BOTH modes — not a unit test (this repo does not unit-test
`index.js` spawn wiring; `BRIDGE_ROOM_ID` injection has no unit test either).

### T-2.2: Emit logic as a dependency-injected module + config constants

**Files:** `lib/show-file.js` (new — the emit logic, dependency-injected so T-2.4 can unit-test it;
`index.js` binds a TCP port + runs `main()` at module scope, `:7044`/`:7518`, and is never
unit-imported, so the logic must NOT live there — same testability rule that put T-3.3's functions in
`lib/mcp-config.js`, and keeps the ~7.5k-line `index.js` monolith from growing, P18) + `index.js`
(config parsing at the boundary + a thin endpoint wrapper in T-2.3).

- **`lib/show-file.js`** exports `async function shareAgentMedia({ filePath, caption, pinnedRoots,
  maxBytes, uploadTimeoutMs, deps })` where `deps = { validateAndOpen, FileLinkDenied, uploadMedia,
  publish }` are injected (real ones in index.js; mocks in the test), and `pinnedRoots` is the
  **pre-pinned** roots object from `pinAllowedRoots([workdir, ...artifactRoots])` (Phase-1 hardening:
  `validateAndOpen` now REJECTS raw string roots with `bad-workdir` and only accepts the pinned
  `{[PINNED_ROOTS]:true, roots:[{realPath,dev,ino}]}` object, so the workdir+artifact roots are pinned
  ONCE at the boundary in T-2.3, not rebuilt per request). It imports `path` itself
  (`import path from 'node:path'`) for `path.basename` and the ext→mime map. Returns
  `{ok, media_id, kind, realPath, size, sha256}` or `{denied: reason}`.
- **`index.js` config constants** (parsed once at the boundary, passed into `shareAgentMedia`):
  - `SHOW_FILE_MAX_BYTES = 50 * 1024 * 1024`.
  - `SHOW_FILE_UPLOAD_TIMEOUT_MS`: parse + **validate** as a finite positive integer within a sane
    upper bound (≤ 300000). `const t = Number(process.env.SHOW_FILE_UPLOAD_TIMEOUT_MS); const
    SHOW_FILE_UPLOAD_TIMEOUT_MS = Number.isInteger(t) && t > 0 && t <= 300000 ? t : 30000;` — an
    out-of-range/`-1`/`Infinity`/non-numeric value falls back to 30000 with an **unconditional
    `console.warn`** naming the bad value (a `Number(env) || 30000` alone would let `-1`/`Infinity`
    clamp Node's timer to ~1 ms and fail every upload). Fail-loud-at-startup is an acceptable
    alternative; pick the warn-and-default form for a config typo, matching the deliberate
    non-fatal-vs-fatal split (ARTIFACT_ROOTS below is fatal because a bad root is a security-scope
    error, not a perf knob).
  - `SHOW_FILE_ARTIFACT_ROOTS`: parse at startup from `process.env.SHOW_FILE_ARTIFACT_ROOTS`
    (colon-separated). Split on `:`, drop empty segments; each remaining entry must be absolute AND
    exist (`fs.existsSync`, already bound in index.js) — otherwise **throw at startup** (fail loud,
    V4/P3) naming the offending entry. Default: `[]`.
  - Extend the `lib/file-link-guard.js` import in index.js (`:52` imports only `checkFileLink`) to
    also export `validateAndOpen` + `FileLinkDenied` for injection into `shareAgentMedia`'s `deps`.
- **`shareAgentMedia` body** (in `lib/show-file.js`):
  1. (Roots are pre-pinned by the caller — `pinnedRoots` param, see T-2.3.)
  2. `try { var { content, realPath } = await deps.validateAndOpen(filePath, { allowedRoots: pinnedRoots, maxBytes }); } catch (e) { if (e instanceof deps.FileLinkDenied) return { denied: e.reason }; throw e; }`
  3. Derive `mime` from `realPath` extension (case-insensitive map: png/jpg/jpeg/gif/webp/svg → image
     types; else `application/octet-stream`); `kind = mime.startsWith('image/') ? 'image' : 'file'`.
  4. `const filename = path.basename(realPath);` (from the module-scope `import path from 'node:path'`),
     then `const media = await deps.uploadMedia({ bytes: content, contentType: mime, name: filename,
     timeoutMs: uploadTimeoutMs });` (timeout param added in T-2.5). `if (!media) return { denied:
     'upload-failed' };`
  5. Build payload `{ blob_ref: media.media_id, content_type: media.content_type, name: filename,
     filename, size: media.size, ...(caption ? { caption } : {}) }` and
     `deps.publish(kind === 'image' ? 'publishImage' : 'publishFile', payload);`. index.js injects
     `publish: (method, payload) => journalPublish(session, method, payload)` — the buffering wrapper,
     NOT `journalPublishUserItem` (which also fires `markRead`). Do not set `from`.
  6. `return { ok: true, media_id: media.media_id, kind, realPath, size: content.length, sha256: media.sha256 };`

**Acceptance:** `shareAgentMedia` (in `lib/show-file.js`, injected mocks) returns
`{ok, media_id, kind, realPath, size, sha256}` on success; a `deps.FileLinkDenied` reason surfaces as
`{denied: reason}` with no upload; `deps.uploadMedia` → null yields `{denied:'upload-failed'}`; payload
carries both `filename` and `name`; `SHOW_FILE_ARTIFACT_ROOTS` with a bad entry aborts startup; an
invalid `SHOW_FILE_UPLOAD_TIMEOUT_MS` (`-1`, `Infinity`, non-numeric, `>300000`) warns + falls back to
30000 (asserted via the parse helper).

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
- **Pin the roots once per session (cached on the session), then call the helper.** `pinAllowedRoots`
  is async and captures each root's `{realPath,dev,ino}`, so pin lazily on first use and cache:
  `try { session.showFilePinnedRoots ??= await pinAllowedRoots([session.workdir, ...SHOW_FILE_ARTIFACT_ROOTS]); } catch (e) { /* FileLinkDenied('bad-workdir') → 404, don't 500 */ }`
  (import `pinAllowedRoots` from `lib/file-link-guard.js` alongside `validateAndOpen`/`FileLinkDenied`).
  Then: `const r = await shareAgentMedia({ filePath: path, caption, pinnedRoots:
  session.showFilePinnedRoots, maxBytes: SHOW_FILE_MAX_BYTES, uploadTimeoutMs:
  SHOW_FILE_UPLOAD_TIMEOUT_MS, deps: { validateAndOpen, FileLinkDenied, uploadMedia:
  journalPublisher.uploadMedia, publish: (m, p) => journalPublish(session, m, p) } });` (imported from
  `lib/show-file.js`).
- Status map via a **pure `denialToStatus(reason)` function also exported from `lib/show-file.js`** (so
  it's unit-testable): `r.ok` → `200 {ok:true, media_id:r.media_id, kind:r.kind}`; else
  `denialToStatus(r.denied)`: `sensitive`/`outside-scope` → 403; `too-large` → 413;
  `not-a-file`/`unreadable`/`symlink`/`relative-path`/`bad-workdir` → 404; `upload-failed` → 502.
- **Audit log** (one structured line, via **unconditional `console.log`/`console.warn`** — NOT the
  `DEBUG=1`-gated `debug()` helper at `index.js:378`, so this security-relevant egress trail (P34)
  isn't silently killed by a future debug-quieting): on ok `{event:'show_file', roomId: session.roomId, realPath:
  r.realPath, kind:r.kind, size:r.size, media_id:r.media_id, sha256:r.sha256, result:'ok'}`; on denial
  `{event:'show_file', roomId: session.roomId, path, result:r.denied}` (input path — realPath not
  available on a guard throw).

**Acceptance:** AC #3/#4/#5/#6 status codes exact; body >64 KB → 413; unexpected throw → 502 (not
`Invalid JSON`); audit line emitted with the documented fields.

### T-2.4: Unit tests — `lib/show-file.js`

**File:** `test/` (new `show-file.test.js`, direct import of `lib/show-file.js` — no `index.js` import,
no port binding; endpoint wiring is verified live in T-4.1, consistent with the repo not unit-testing
`index.js` HTTP handlers — `/secret`, `/share-sensitive` have no unit tests either).

- `shareAgentMedia` (injected mock `deps`): image ext → `deps.publish('publishImage', ...)`; non-image
  → `deps.publish('publishFile', ...)`; payload has BOTH `filename` and `name`; caption present/absent;
  each `deps.FileLinkDenied` reason → `{denied:reason}` with no `deps.uploadMedia` call;
  `deps.uploadMedia`→null → `{denied:'upload-failed'}`; success return includes realPath/size/sha256.
- `denialToStatus`: each reason → its documented HTTP status; an unknown reason → 502 (safe default).
- timeout-parse helper: `-1`/`Infinity`/non-numeric/`>300000` → 30000 (+warn); a valid int → itself.

**Acceptance:** all green. Endpoint-level cases (token 400/403, body-cap 413, `roomId` ignored) are
covered by the T-4.1 run-it gate.

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
  resolver canonicalizes `command`, not `args` (`lib/mcp-config.js:105`). Extend `buildMcpServers`
  to rewrite the `share` server's script `args` to the absolute `` `${askUserBaseDir}/show-file-mcp.js` ``
  (string construction — `askUserBaseDir` is already a param of `buildMcpServers`), mirroring the
  `ask-user` special-case at `:89`. **Use string construction, NOT `path.join`** — `lib/mcp-config.js`
  imports only `macifyMcpServers` (`:14`) and has no `path` binding, and with default-on the eager
  `mcpConfigPathFor([])` at `index.js:190` builds the `share` server at module init, so a bare
  `path.join` there would `ReferenceError` and prevent the bridge from starting. (If `path.join` is
  preferred, add `import path from 'node:path'` to `lib/mcp-config.js` first.)
- Register `share` in `knownMcpExtras()` / `EXTRA_FLAG_TO_NAME` **only** to support the opt-in
  `--share` veto flag (below). Note: the `index.js:193` startup check warns only when a *known flag*
  lacks a matching config block — it does NOT warn about a config block that isn't a known flag — so
  omitting `share` from `knownMcpExtras()` triggers no warning either way (the earlier "will warn
  otherwise" rationale was incorrect). Registration is for the veto path, not to silence a warning.

**Acceptance:** a `share`-enabled session spawned in a non-bridge workdir starts the `show_file`
server successfully (no ENOENT); the generated `.mcp-config-generated.share.json` points at the
absolute `show-file-mcp.js`.

### T-3.3: Default-on via effective-extras union (inheritance-safe)

**Files:** `lib/mcp-config.js` (pure logic — currently has zero `process.env` reads, so it is the
clean testable home) + `index.js` (call sites only).

- Add two **pure, argument-taking** functions to `lib/mcp-config.js` (exported, so T-3.4 can unit-test
  them by direct import like the existing `mcp-config.test.js` — index.js binds a TCP port at module
  scope `:7044` and is never unit-imported, so this logic must NOT live there):
  - `resolveDefaultExtras(envVal)` → `envVal === '0' ? [] : ['share']` (the env kill-switch, evaluated
    from a passed-in value, not by reading `process.env` inside the function).
  - `effectiveExtras(resolvedExtras, defaultExtras)` → `Array.from(new Set([...resolvedExtras,
    ...defaultExtras]))` (dedup union).
- In `index.js`: `const DEFAULT_MCP_EXTRAS = resolveDefaultExtras(process.env.SHOW_FILE_DEFAULT_ON);`
  (the single `process.env` read stays at the call boundary). Setting `SHOW_FILE_DEFAULT_ON=0` in the
  bridge env + restart turns default-on off (the `--share` flag still opts a session in) — the cheap
  circuit-breaker for a default-on file-egress primitive.
- Compute `const effectiveMcpExtras = effectiveExtras(mcpExtras, DEFAULT_MCP_EXTRAS)` ONCE per spawn
  in both `createSession` and `createInteractiveSessionForRoom`, right after the parsed `mcpExtras` is
  resolved (`index.js:1036-1038` and the interactive equivalent) and **before** the Phase-2
  `shareEnabled` gate. Use `effectiveMcpExtras` for BOTH: (a) `mcpConfigPathFor(effectiveMcpExtras)`
  (so the `share` MCP server is spawned), AND (b) **the `shareEnabled = ...includes('share')` gate the
  Phase-2 fix added at `index.js:1065`/`:1640`** — that gate currently reads the parsed `mcpExtras`, so
  without this it would compute `shareEnabled=false` for a default-on no-flag session and mint no token
  (breaking AC#1). Change those two gate lines to read `effectiveMcpExtras.includes('share')`.
- **Do NOT** add the default to the parsed/explicit `mcpExtras` array used for override-vs-inherit
  detection (`extractMcpExtraFlags` result; the `extras.length > 0` checks around `index.js:4754`,
  `:4769`, `:4992`) or to what gets persisted — only the derived `effectiveMcpExtras` carries the
  default. This preserves: fresh no-flag → effective `['share']`; no-flag restart/resume of a persisted
  `['share','browser']` → inherits both, union idempotent, `browser` preserved; explicit `--browser` →
  effective `['browser','share']`.

**Acceptance:** fresh no-flag session → `show_file` present; no-flag restart of a `['share','browser']`
session → `browser` still present (regression guard); the parsed-extras override signal is unchanged.

### T-3.4: Tests — extra wiring + default selection

**File:** `test/` (extend the existing `mcp-config.test.js`; all three below are direct-import unit
tests of the pure `lib/mcp-config.js` functions — no monolith import, no port binding).

- `buildMcpServers` resolves the `share` extra to an absolute entrypoint path.
- `effectiveExtras`: `([],['share'])` → `['share']`; `(['browser'],['share'])` → `['browser','share']`;
  `(['share','browser'],['share'])` → `['share','browser']` (idempotent); the input `resolvedExtras`
  array is NOT mutated (restart-inheritance regression guard — assert the caller's parsed array is
  untouched).
- `resolveDefaultExtras`: `resolveDefaultExtras('0')` → `[]` (kill-switch); `resolveDefaultExtras(undefined)`
  → `['share']`; and `effectiveExtras([], resolveDefaultExtras('0'))` → `[]` (no `share`), while a
  `--share`-flagged session (`resolvedExtras=['share']`) still yields `['share']` even with the
  kill-switch on.

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
- **Default-on egress consent (Phase-3 review blocker, operator-accepted OVERRIDE).** Codex flagged
  default-on `share` as egress-without-explicit-consent (P15) and noted the union is *unconditional* —
  a session started with an explicit extras list omitting `share` still gets it, so there is no
  per-session opt-out. Overridden: default-on was the operator's explicit, veto-able decision. The
  per-session opt-out (a tri-state where an explicit session-level deny skips the union) is a **#458
  prerequisite**, deliberately NOT built here — no curated session exists yet, so there is no consumer
  that needs to opt out today (building the guard before its consumer exists is the anti-pattern). #458
  MUST add the per-session `share` deny before it ships curated (Nastia) sessions, or those sessions
  will inherit default-on egress. Filed as a #458 dependency.
- **Idempotency (Phase-3 review major, spec-deferred).** A lost HTTP success response after a
  successful upload+publish would duplicate the media on retry (P32). Already documented out-of-scope
  in the spec; a request-UUID dedup cache is the follow-up if it ever matters.
- **Cross-session OS-isolation (final-review blockers B1/B2, accepted residuals — #458).** The final
  full-branch review flagged that the per-session capability token is a same-UID environment bearer:
  a `Bash`-capable session can read another session's `SHOW_FILE_TOKEN` via `/proc/<pid>/environ` and
  post into its conversation (B1). This is only exploitable between two same-UID `Bash` sessions —
  i.e. the operator's own sessions (self-principal); #458's curated (Nastia) toolset has NO `Bash`, so
  it cannot read `/proc` or steal a token. True multi-principal isolation (distinct OS uids/namespaces
  or peer-credential IPC) is #458's explicit domain (the operator's "toolset boundary contains blast
  radius" + later separate-server option). **B2** (macOS parent-symlink race between `open()` and
  `realpath()`) is macOS-only and pre-existing — the Linux production bridge resolves via fd-pinned
  `/proc/self/fd` (immune); the guard already documents the macOS limitation as single-user-dev
  acceptable. Both accepted for the current single-principal deployment; #458 MUST close B1 before
  shipping a second principal. Fixed in the same review: session-kill-on-pin-failure (fail-closed),
  short-read/truncation (read-loop + re-stat), saturated denial mapping, per-session in-flight cap.
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
