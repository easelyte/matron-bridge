---
title: Agent-initiated inline media share (`show_file`)
date: 2026-08-01
status: converged
revision: 5
repo: easelyte/claude-matrix-bridge (branch agent-inline-media)
risk: medium
execution_tier: slim
related_principles:
  - P59 Extend the Canonical Primitive
  - P67 Isolate Untrusted Agents by Capability
  - P15 Data Egress Needs Explicit Permission
  - P8 Guard Boundary Inputs
  - P3 Fail Visible
  - P19 Check-Act Ordering
  - P34 Observability Before Automation
open_decisions:
  - "share default-on vs explicit opt-in: spec commits to default-on (workdir-scoped), veto-able to an opt-in `--share` flag."
rejected_alternatives:
  - "B (image-only): drops PDF/file support."
  - "A (unscoped MVP): the path guard IS the security-load-bearing part."
  - "Output-marker / data-URI triggers: fragile / parallel path (P59)."
  - "Denylist-only scope (rev1): a neutrally-named secret sails through (P15)."
  - "roomId in body as routing identity (rev1): forgeable via /sessions (P67). -> per-session token."
  - "/tmp default root (rev2): shared -> cross-session leak. -> workdir-only default."
  - "Separate token->roomId map (rev2): cleanup misses teardown seams. -> token on session object."
  - "Helper-level contains() after validateAndOpen (rev3): dropped realpath-normalization and let out-of-scope files be read first (Sonnet+Codex rev3). -> containment moved BACK INTO validateAndOpen as an allowedRoots extension."
  - "queue-failed denial (rev3): safePublish swallows enqueue throws, so it is unobservable. -> removed; publish is honestly fire-and-forget after upload."
---

# Agent-initiated inline media share (`show_file`)

## Problem

When a bridge (Claude Code) session generates a file on the VPS — a rendered PNG, an SVG
diagram, a PDF report, a screenshot — there is no way for the session to put it in front of
the operator, who must SSH in and open it by hand. The prior workaround (an HMAC viewer link)
fails for binary/image content: `/view` renders every file as escaped text in a `<pre>`, and
the binary `/download` route forces a download and has no bridge caller. Hence the friction:
"give me a link to the SVG" → "I can't."

## What already exists (do NOT rebuild)

Two of the three layers already carry agent→operator inline media; this spec adds only the
missing bridge trigger. See the **Downstream contract verification** appendix for file:line
evidence.

- **Journal server** accepts agent-published `image`/`file` events with a top-level `blob_ref`.
  `POST /media` (Bearer agent token) → `{media_id, size, content_type, sha256}`; `GET /media/:id`
  serves the stored content-type verbatim. `AGENT_PUBLISH_TYPES` includes both; cap
  `DEFAULT_MEDIA_MAX_BYTES = 50 MB`. **Nothing to build.**
- **Web client** renders `case "image"` (`components.tsx:3018`) inline via `AuthenticatedMedia`
  `<img>` and `case "file"` (`:3033`) as an attachment reading `payload.filename` (`:3042`).
  Bubble side = `event.sender` (`:3086`), set server-side from the connection identity, not any
  payload field. **Nothing to build.**
- **Bridge** owns the plumbing: `uploadMedia` (`lib/journal-publisher.js:507`),
  `publishImage`/`publishFile` (`:643`/`:640`), the fd-pinned guard `validateAndOpen`
  (`lib/file-link-guard.js:93`), and per-session child-env injection at both spawn sites
  (`index.js:1098-1104`, `:1658-1664`). The only caller of `publishImage`/`publishFile` is the
  operator-upload mirror `journalMirrorUserMedia` (`index.js:957-977`) — no agent-initiated caller.

**Archaeology (2026-08-01):** upstream has no agent-outbound media trigger. Greenfield on our fork.

## The gap

A trigger the Claude session can invoke to say "show this file." Everything downstream of an
agent-authored publish already works.

## Design

Three bridge-only pieces. The MCP tool runs as a separate stdio process (no agent token, no WS),
so — like `share_sensitive_data` — it POSTs a bridge HTTP endpoint that does the guarded read,
upload, and publish.

### Component 1 — MCP tool `show_file` on its own opt-in `share` extra (`show-file-mcp.js`)

A **new `mcpExtras` group** `share`, NOT on the always-on `ask-user` base. `mcpExtras` groups are
selected per session at spawn and merged by `lib/mcp-config.js` `buildMcpServers`
(`mcpConfigPathFor(extras)`, `index.js:171`). A session that does not select `share` never gets the
tool (Acceptance #8) — this is how #458's curated session type excludes it, using existing additive
selection with no tool-subtraction infra.

**Entrypoint resolution (P14):** the existing `node ./ask-user.js` relative `args` works only
because `buildMcpServers` special-cases `ask-user` (`lib/mcp-config.js:89`); the generic resolver
canonicalizes a relative `command`, not relative `args` (`:105`), and claude runs with the session
workdir as `cwd` (`index.js:1025`). So the `share` server MUST use an **absolute** entrypoint path
for `show-file-mcp.js` (resolved from `__dirname` when the generated config is written), or extend
the builder's resolver to canonicalize its `args` the same way. A relative `args` would ENOENT in
any non-bridge-workdir session.

**Default selection (P14; open decision):** `share` is default-on so ordinary sessions get
`show_file` with no flag. **Critically, the default is unioned into the EFFECTIVE extras only at
config-generation time — it must NOT be merged into the explicit/parsed extras array**, because
restart and resume use array-emptiness of the *parsed* extras to distinguish an explicit override
from inheriting the persisted set (`index.js:4754`, `:4768`, `:4992`; `extractMcpExtraFlags` returns
`[]` on no flags, `lib/mcp-config.js:38`). If `['share']` were merged into the parsed array, a
no-flag restart of a `['share','browser']` session would look like an explicit override and silently
drop `browser` (rev-4 regression caught in review). Correct seam: keep the parsed set untouched for
override/inherit detection, and at each `mcpConfigPathFor(extras)` call (`index.js:171` and its call
sites, plus `journalStartSessionForRpc`, `:534`) pass `effective = union(resolvedExtras,
DEFAULT_MCP_EXTRAS)` where `DEFAULT_MCP_EXTRAS = ['share']`. Then: fresh no-flag → `['share']`;
no-flag restart of `['share','browser']` → inherit `['share','browser']`, union is idempotent, browser
preserved; explicit `--browser` → `['browser','share']`. `share` is lightweight (not a ~400 MB browser
stack), so the "lean-session default none" rationale does not apply. Bounded by workdir-only scope
(Security). *Operator may flip to explicit opt-in — register `--share` in `EXTRA_FLAG_TO_NAME` like
`--browser` and set `DEFAULT_MCP_EXTRAS = []`; trades the no-flag UX for a stricter default and is
the zero-plumbing option (the union step above is then unnecessary).*

Tool (mirrors the synchronous `share_sensitive_data` shape, not the polling `request_secret`):

```
server.tool('show_file',
  'Display a file to the operator inline: an image (PNG/JPG/SVG/GIF/WebP) renders as a picture,
   any other file (PDF, report) as a downloadable attachment. The file must exist and be under
   the session workdir.',
  { path: z.string().refine(p => require('node:path').isAbsolute(p), 'path must be absolute'),
    caption: z.string().max(4096).optional() },
  handler → POST ${BRIDGE_API}/show-file { path, caption, token: SHOW_FILE_TOKEN })
```

Env injected into the claude child at spawn (beside the existing `BRIDGE_ROOM_ID`): `BRIDGE_API_URL`
(or `MATRON_BRIDGE_API_PORT`) and `SHOW_FILE_TOKEN`.

Return: success → `Shown to operator: <basename> (image|file).` ("shown" = uploaded + handed to the
publisher; delivery is best-effort — Component 3). Denial → `Could not show <basename>: <reason>`,
reason ∈ {`relative-path`, `symlink`, `sensitive`, `outside-scope`, `not-a-file`, `unreadable`,
`too-large` (all from `validateAndOpen`), `upload-failed` (helper)}. Any other error → `internal
error`.

### Component 2 — bridge HTTP endpoint `POST /show-file` (`index.js`)

Added to `apiServer` (`index.js:6579`) beside `/secret`/`/share-sensitive`. **The whole handler body
is wrapped in try/catch → `502 {"error":"internal error"}`**, so an uncaught error never falls
through to the shared API catch's misleading `400 {"error":"Invalid JSON"}` (`index.js:7037`).

1. Cap the request body at 64 KB before buffering (path+caption+token are small) → `413` over-cap.
   Parse `{path, caption, token}`; missing `path`/`token` → `400`.
2. **Resolve session by token, never by a client-supplied room id.** At spawn the bridge mints
   `SHOW_FILE_TOKEN = randomUUID()`, stores it **on the session object** (`session.showFileToken`),
   and injects it into the claude child env. The endpoint scans `sessions.values()` for
   `s.showFileToken === token` (N small, P18); no match → `403`. Storing it on the session object
   (not a separate map) means it is created and destroyed with the session, cannot be missed at any
   `sessions.delete` teardown seam, and can never resolve to a replacement session in the same room
   (bound to the object, not the reusable roomId). Closes the rev-1 forgery hole and rev-2
   cleanup-seam gap (P67).
3. Delegate to Component 3. Status map: `sensitive`/`outside-scope` → 403; `too-large` → 413;
   `not-a-file`/`unreadable`/`symlink`/`relative-path` → 404; `upload-failed` → 502; unexpected
   throw → 502; ok → `200 {ok:true, media_id, kind}`.

### Component 3 — emit helper `journalShareAgentMedia(session, {path, caption})` (`index.js`)

The one piece of new logic; almost entirely reuse (P59).

1. **Read + guard + scope in one canonical call (extend `validateAndOpen` with `allowedRoots`).**
   `validateAndOpen` currently realpath-resolves a single `workdir` and throws `outside-workdir`
   (`file-link-guard.js:112-119`). Extend it (P59 — extend the canonical primitive, do not fork it)
   to accept `allowedRoots: string[]`: after resolving the fd `realPath`, it `fsp.realpath()`-
   resolves each root and, **before** the sensitivity check and **before** reading the file, throws
   `FileLinkDenied('outside-scope')` if `realPath` is contained by none (reuses the internal
   boundary-safe `contains()`, `:63`). This fixes three rev-3 findings at once: (a) canonicalization
   — roots are realpath-normalized, so a symlinked workdir (this repo's nested checkouts are
   symlinks into the workspace on dev machines; macOS `/tmp`→`/private/tmp`) no longer falsely
   denies in-workdir files; (b) check-act ordering (P19) — an out-of-scope file is rejected before
   it is read/buffered; (c) reason precedence — an out-of-scope path returns `outside-scope`, not
   `sensitive`/`too-large`. The single-`workdir` param is retained for the existing viewer callers
   (back-compat: `allowedRoots` absent ⇒ today's behavior).
   The helper calls `validateAndOpen(path, { allowedRoots: [session.workdir, ...SHOW_FILE_ARTIFACT_
   ROOTS], maxBytes: SHOW_FILE_MAX_BYTES })` → `{content, realPath}`. `SHOW_FILE_MAX_BYTES = 50 MB`.
2. **Derive content-type + kind** from `realPath`'s extension (case-insensitive): `png→image/png`,
   `jpg/jpeg→image/jpeg`, `gif→image/gif`, `webp→image/webp`, `svg→image/svg+xml`, else
   `application/octet-stream`; `kind = mime.startsWith('image/') ? 'image' : 'file'`.
3. **Upload (reuse `uploadMedia`) — with a deadline.** `uploadMedia` today awaits `fetch` with no
   `AbortSignal` (`journal-publisher.js:507-518`), so a stalled journal would wedge the whole
   synchronous tool indefinitely (the inbound `fetchMedia` path already uses an `AbortController` —
   mirror it). Add a bounded deadline (`SHOW_FILE_UPLOAD_TIMEOUT_MS`, default 30 000) to the upload;
   on timeout or any failure it fails open → `null` ⇒ return `{denied:'upload-failed'}`, no publish.
4. **Publish (reuse the buffering wrapper).** Payload:
   `{ blob_ref: media.media_id, content_type: media.content_type, name: basename, filename: basename,
   size: media.size, caption }` (caption omitted when absent). **`filename` is required** — the web
   file-render path reads `payload.filename` (`components.tsx:3042`); the client's own outbound path
   sends both `name` and `filename` (`client.ts:905-906`), so we send both. Publish via
   `journalPublish(session, kind==='image' ? 'publishImage' : 'publishFile', payload)` — the
   buffering wrapper (upserts the convo before the first publish). **Not `journalPublishUserItem`
   (`index.js:682`)** — it also fires `markRead`, which would suppress the unread badge on an
   agent-sent message. The event lands on the **agent** bubble via connection-identity routing
   (`sender: agent:${conn.name}`, `ws.js:645`); `payload.from` has no consumer and is not sent.
5. Return `{ ok:true, media_id, kind, realPath, size: content.length, sha256: media.sha256 }` for the
   audit log. **Delivery is best-effort and unconfirmable:** `journalPublish`/`safePublish` return
   void and swallow enqueue exceptions (`journal-publisher.js:491`), so once the upload succeeds
   there is no synchronous publish-failure signal — the event is fire-and-forget into the in-memory
   queue (delivers live, replays on reconnect, may drop on crash/overflow, exactly like every text/
   diff/tool_output event). `ok` therefore means "uploaded and handed to the publisher," and the
   endpoint's only 502 is `upload-failed`. This is honest about what can be known (P3) rather than
   claiming a delivery it cannot verify. **Orphan bound:** a swallowed enqueue failure leaves an
   uploaded-but-unreferenced blob; the journal has no media DELETE, so no synchronous rollback —
   unreferenced blobs age out via the journal's existing blob TTL (PR #12 tool-output purge).
   Acceptable given rarity; a proper upload/publish two-phase reconciliation is a follow-up.

### Data flow

```
show_file(path, caption)                                     [show-file-mcp.js, `share` extra, abs entrypoint]
 └ POST /show-file {path,caption,token}  (body ≤64KB)
    └ apiServer /show-file (try/catch → 502 internal error)  [index.js:6579+]
       └ session = scan sessions.values() for showFileToken===token   [403 if none]
       └ journalShareAgentMedia(session,{path,caption})
          ├ validateAndOpen(path,{allowedRoots:[workdir,...ROOTS],maxBytes:50MB})   [scope+guard+read, before-read outside-scope]
          ├ ext→mime, kind
          ├ uploadMedia(content,mime, deadline 30s) → POST /media       [null ⇒ upload-failed]
          └ journalPublish(session, publishImage|publishFile, {blob_ref,filename,name,size,caption})   [fire-and-forget]
               └ journal stamps sender:agent:*, fans out
                    └ web case image|file → inline <img> / attachment(payload.filename)   [components.tsx:3018/3033/3042]
```

## Security model (P67, P15, P8, P19)

Read-file + egress primitive. Three boundaries:

- **Path scope = allowlist of realpath-canonicalized roots, default the session workdir only**,
  enforced inside `validateAndOpen` before the file is read (P19). `SHOW_FILE_ARTIFACT_ROOTS`
  defaults empty; workdir-only means a default-on session can only egress files from its own working
  tree, which is why default-on is acceptable pre-#458. Extra roots are opt-in
  (`SHOW_FILE_ARTIFACT_ROOTS` = colon-separated absolute paths; each must be absolute + existing at
  startup, else fail loud — V4; each is realpath-resolved). `/tmp` is NOT a default (globally shared
  → cross-session read). The `validateAndOpen` sensitivity denylist remains as defense-in-depth. "The
  agent has Bash anyway" is NOT the justification — egress is a separate permission from local read
  (P15).
- **Routing identity = per-session capability token on the session object**, never a client-supplied
  room id. An agent cannot target another conversation; the token cannot outlive or misroute across
  session replacement.
- **Curated-toolset (Nastia) — #458.** `show_file` is the `share` mcpExtras group; #458's curated
  session type omits `share` (existing additive selection) or narrows its `SHOW_FILE_ARTIFACT_ROOTS`
  /workdir at the same seam. Default-on is a v1 policy #458 overrides per session type; the tool is
  NOT on the always-on base.
- **Size caps:** file `SHOW_FILE_MAX_BYTES = 50 MB`; request body 64 KB; caption 4096.

## SVG handling (verified inline-renderable)

`.svg` publishes as an `image` (`content_type: image/svg+xml`). The web client renders via
`client.ts:1145` `mediaUrl()` → `URL.createObjectURL(blob)` → `<img>`; the journal serves the stored
content-type verbatim with no allowlist and no CSP restricting a `blob:` SVG `<img>`
(`http.js:432-460`, traced in review). Scripts do not run in `<img>`-loaded SVG → XSS-safe. No
SVG→PNG pre-render, no new dependency.

## Observability (P34)

One structured line per call. Success (from the helper return): `{event:'show_file', roomId,
realPath, kind, size, media_id, sha256, result:'ok'}`. Denial: `validateAndOpen` throws before
exposing `realPath` (including for `outside-scope`, now decided inside the guard), so the line logs
the input `path` + `reason`: `{event:'show_file', roomId, path, result:<reason>}` — the input path
identifies the attempt; the guard is deliberately not modified to leak its internal realpath on throw.
`uploadMedia` already warns on failure.

## Testing

- **Unit — ext→mime + kind:** png/jpg/svg/gif/webp→image; pdf/zip/unknown→file; case-insensitive.
- **Unit — `validateAndOpen` allowedRoots extension:** realPath under a root → returns content;
  outside all roots → throws `outside-scope` **before** reading (assert no read occurred) and takes
  precedence over `sensitive`/`too-large` for an out-of-scope path; a **symlinked** root/workdir
  (`/srv/current → /srv/releases/42`) with a file under the target → allowed (canonicalization);
  `allowedRoots` absent → unchanged single-`workdir` behavior (back-compat).
- **Unit — roots parsing:** valid colon-list → parsed; relative/nonexistent entry → startup fails
  loud.
- **Unit — emit helper** (mock `validateAndOpen`, `uploadMedia`, `journalPublish`): image→
  `publishImage`, non-image→`publishFile`; payload carries BOTH `filename` and `name`; caption
  present/absent; each `validateAndOpen` reason surfaced with no upload; `uploadMedia`→null (incl.
  timeout) ⇒ `upload-failed`; helper return includes realPath/size/sha256.
- **Unit — upload deadline:** a stalled upload aborts at `SHOW_FILE_UPLOAD_TIMEOUT_MS` → `upload-
  failed`, not a hang.
- **Unit — token routing:** missing → 400; unknown → 403; valid resolves the right session; a body
  `roomId` is ignored; token gone after the session object is dropped.
- **Unit — denial mapping + body cap:** every reason → its status; unexpected throw → 502 `internal
  error` (never `Invalid JSON`); body >64 KB → 413.
- **Endpoint:** fixture PNG under workdir + valid token → 200 + publish with `filename`.
- **Run-it gate (empirical — catches what static review cannot):** on a live session, `show_file` a
  real PNG and SVG → both render inline (both themes); a PDF → attachment with real filename + size.

## Out of scope / deferred follow-ups

- **>50 MB / huge non-previewable → signed viewer `/download` link** (upstream `feat/viewer-download`
  #149). v1 returns `too-large`.
- **Curated scoping for Nastia** — #458.
- **Latent mirror-path bug:** `journalMirrorUserMedia` sets `name` not `filename` and a dead
  `from:'user'` field — operator's own mirrored uploads may render with a generic label / wrong
  bubble. Pre-existing; separate bridge loop.
- **Upload/publish two-phase reconciliation + idempotency (P32):** double-call double-posts;
  `queue-failed` is unobservable and orphans are TTL-bounded, so a durable reconcile is a follow-up
  if orphan rate ever matters. `uploadMedia` returns `sha256` for a future dedup key.
- **Retiring dead `redact_message`** (`index.js:6773`).

## Acceptance criteria

1. A bridge session calls `show_file('<workdir>/diagram.svg')` and the operator sees it rendered
   inline, agent side, on the web client.
2. A non-image file (PDF) shows as an inline attachment with its real filename (`payload.filename`)
   and size.
3. A path whose `realPath` is outside all allowed roots → `outside-scope` (403), **decided before the
   file is read** and taking precedence over `sensitive`/`too-large`; a sensitive path inside an
   allowed root → `sensitive` (403); nothing uploaded/published in either case.
4. An oversize (>50 MB) file → `too-large` (413); a request body >64 KB → 413; a stalled upload →
   `upload-failed` within the deadline (no hang); nothing uploaded in the size cases.
5. A `/show-file` call cannot inject media into another session's conversation: routing is by the
   per-session token on the session object; a body `roomId` is ignored; the token does not resolve
   after its session object is dropped.
6. Every `FileLinkDenied` reason and any unexpected error maps to a defined status + denial string
   (never `Invalid JSON`); on denial the model can fall back to a text reply.
7. No journal-server or web-client change is required for items 1–2; the diff is confined to
   `easelyte/claude-matrix-bridge` (plus the back-compat `validateAndOpen` `allowedRoots` extension,
   which is bridge-repo code).
8. `show_file` is the opt-in `share` mcpExtras group with an absolute entrypoint, NOT on the always-on
   `ask-user` base; a session that does not select `share` does not get the tool (default extras
   include `share` per the open decision; #458's curated session type omits it).

## Appendix — Downstream contract verification

- Journal accepts agent `image`/`file` publishes — `AGENT_PUBLISH_TYPES` includes both (`ws.js`);
  publish op requires `conn.kind==='agent'`.
- `DEFAULT_MEDIA_MAX_BYTES = 50 MB` (journal `server.js`).
- `POST /media` → `{media_id,size,content_type,sha256}`; `GET /media/:id` streams stored
  `content_type` verbatim (`http.js:401-465`).
- Web renders `image` inline (`components.tsx:3018`) and `file` reading `payload.filename`
  (`:3033/:3042`); dual `filename`+`name` matches the client's outbound path (`client.ts:905-906`);
  sidebar snippet reads `payload.filename` (`types.ts:535`).
- Bubble routing keys on `event.sender = agent:${conn.name}` (`ws.js:645`), independent of payload.
- Per-session child-env injection exists (`BRIDGE_ROOM_ID`, `index.js:1098-1104`, `:1658-1664`).
- `validateAndOpen` single-`workdir` path already realpaths the workdir before `contains`
  (`file-link-guard.js:112-119`) — the `allowedRoots` extension generalizes that proven step.
- SVG: no content-type allowlist / CSP blocks a `blob:` `image/svg+xml` `<img>` (`http.js:432-460`;
  `client.ts:1145`).
