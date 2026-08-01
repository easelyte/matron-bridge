---
title: Agent-initiated inline media share (`show_file`)
date: 2026-08-01
status: draft
revision: 3
repo: easelyte/claude-matrix-bridge (branch agent-inline-media)
risk: medium
execution_tier: slim
related_principles:
  - P59 Extend the Canonical Primitive
  - P67 Isolate Untrusted Agents by Capability
  - P15 Data Egress Needs Explicit Permission
  - P8 Guard Boundary Inputs
  - P3 Fail Visible
  - P34 Observability Before Automation
open_decisions:
  - "share default-on vs explicit opt-in (Component 1 / Security): spec commits to default-on, workdir-scoped; operator can flip to opt-in. Reviewers split on requires_operator_judgement — surfaced."
rejected_alternatives:
  - "B (image-only show_image): drops PDF/file support; real artifact class, trim not worth it."
  - "A (unscoped MVP, scope later): the path guard IS the security-load-bearing part (P67/P15)."
  - "Output-marker trigger: fragile parse, pollutes reply stream, no structured error path."
  - "Data-URI inline embed: a second render path for marginal gain; violates P59."
  - "Denylist-only scope (rev1): a neutrally-named secret sails through; not an egress boundary (P15)."
  - "roomId in request body as routing identity (rev1): agent can enumerate /sessions and spoof (P67). Replaced with per-session capability token."
  - "/tmp as a default allowed root (rev2): globally shared, so it relocates the neutral-name leak under a shared root (Codex rev2 B1). Replaced with workdir-only default + opt-in roots."
  - "Separate token→roomId map (rev2): cleanup misses ~9 teardown seams / survives session replacement (P67). Replaced with token stored on the session object."
---

# Agent-initiated inline media share (`show_file`)

## Problem

When a bridge (Claude Code) session generates a file on the VPS — a rendered PNG, an SVG
diagram, a PDF report, a screenshot — there is no way for the session to put it in front of
the operator. The operator must SSH into the VPS and open the file by hand. The prior
workaround (an HMAC viewer link) fails for binary/image content: the viewer's `/view` route
renders every file as escaped UTF-8 text in a `<pre>` block, so an image comes out as garbage;
the binary-safe `/download` route forces an attachment download and has no bridge caller. The
result is the friction the operator hit: "give me a link to the SVG" → "I can't."

## What already exists (do NOT rebuild)

Agent→operator inline media is already built on two of the three layers. This spec adds only
the missing trigger on the third. See the **Downstream contract verification** appendix for the
file:line evidence that each downstream claim already holds.

- **Journal server** (`easelyte/matron-journal`) accepts agent-published `image`/`file`
  events with a top-level `blob_ref`. `POST /media` (Bearer agent token) stores a blob and
  returns `{media_id, size, content_type, sha256}`; `GET /media/:id` serves it with the stored
  content-type verbatim. `AGENT_PUBLISH_TYPES` includes `image` and `file`. Media cap
  `DEFAULT_MEDIA_MAX_BYTES = 50 MB`. **Nothing to build.**
- **Web client** (`easelyte/matron-web`) renders these inline: `components.tsx:3018`
  `case "image"` → `AuthenticatedMedia` (auth-fetches `/media/:id`, inline `<img>`);
  `case "file"` (`:3033`) → inline attachment reading `payload.filename` (`:3042`) with size +
  icon. Bubble side is decided by `event.sender` (`:3086`), set server-side from the WebSocket
  connection identity — **not** from any payload field. **Nothing to build.**
- **Bridge** (`easelyte/claude-matrix-bridge`) owns the plumbing:
  `journalPublisher.uploadMedia({bytes, contentType, name})` (`lib/journal-publisher.js:507`)
  and `publishImage` / `publishFile` (`:643` / `:640`); the fd-pinned, sensitivity-checked,
  size-capped reader `validateAndOpen(path, {workdir, maxBytes})` (`lib/file-link-guard.js:93`);
  and per-session env injection into the claude child at spawn (`BRIDGE_ROOM_ID` /
  `MATRON_BRIDGE_API_PORT` set at both spawn sites, `index.js:1098-1104` and `:1658-1664`). The
  only caller of `publishImage`/`publishFile` today is `journalMirrorUserMedia`
  (`index.js:957-977`), which mirrors the operator's OWN uploads. There is no agent-initiated
  caller.

**Archaeology (2026-08-01):** upstream `Matronhq/{matron-bridge,matron-web,matron-journal}` has
no branch, PR, or commit building an agent-initiated outbound media trigger. Greenfield on our
fork; no upstream conflict.

## The gap

A trigger the Claude session can invoke to say "show this file to the operator." Everything
downstream of an agent-authored `image`/`file` publish already works.

## Design

Three small pieces, bridge repo only. The MCP tool runs as a separate stdio process (no agent
token, no WS), so — like `request_secret` / `share_sensitive_data` — it POSTs a bridge HTTP
endpoint, and the bridge process does the guarded read, upload, and publish.

### Component 1 — MCP tool `show_file` on its own opt-in `share` extra server (`show-file-mcp.js`)

Registered as a **new `mcpExtras` group** `share`, NOT on the always-on `ask-user` base server.
`mcpExtras` groups are selected per session at spawn (`index.js:171` `mcpConfigPathFor(extras)`,
`:534` `journalStartSessionForRpc({mcpExtras})`; extras merged by `lib/mcp-config.js`
`buildMcpServers`). This is the isolation seam: a session that does not select `share` never
gets the tool (Acceptance #8), which is how #458's curated session type will exclude it — using
the existing additive selection, no tool-subtraction infra invented.

**`share` is included in the DEFAULT extras (open decision — see frontmatter).** The two claude
spawn sites currently default `mcpExtras` to `[]` (`index.js:1036-1038`, `:1601-1603`); this spec
adds `share` to that default so every ordinary session gets `show_file` with no flag (the
frictionless goal). `share` is a lightweight stdio server (not a ~400 MB browser stack), so the
"default to no extras for lean sessions" rationale does not apply. **Scope of default-on is
bounded by the workdir-only path scope (Security), so a default-on session can only show files
from its own workdir.** #458 introduces the operator-vs-curated session discriminator and sets
curated extras explicitly without `share`. *Operator may flip this to explicit opt-in (a named
`--share` flag, default off); that trades the no-flag UX for a stricter default.*

The tool mirrors the `share_sensitive_data` shape (single synchronous `server.tool(...)` that
`fetch`es a bridge endpoint and returns `{content:[{type:'text',text}]}` — NOT the polling shape
of `request_secret`):

```
server.tool(
  'show_file',
  'Display a file to the operator inline in the chat: a rendered image (PNG/JPG/SVG/GIF/WebP)
   renders as an inline picture; any other file (PDF, report, archive) appears as a
   downloadable attachment. Use this instead of describing a filepath the operator cannot
   open. The file must exist and be under the session workdir.',
  {
    path: z.string().refine((p) => require('node:path').isAbsolute(p), 'path must be absolute'),
    caption: z.string().max(4096).optional(),   // journal caption clamp
  },
  handler → POST ${BRIDGE_API}/show-file { path, caption, token: SHOW_FILE_TOKEN }
)
```

Env injected into the claude child at spawn (alongside the existing `BRIDGE_ROOM_ID`):
`BRIDGE_API_URL` (or `MATRON_BRIDGE_API_PORT`) and `SHOW_FILE_TOKEN`.

Return contract: success → `Shown to operator: <basename> (image|file).` ("shown" = uploaded and
queued; see Component 3 on the delivery guarantee). Denial → `Could not show <basename>: <reason>`
where reason ∈ {`relative-path`, `symlink`, `sensitive`, `not-a-file`, `unreadable`, `too-large`
(from `validateAndOpen`), `outside-scope`, `upload-failed`, `queue-failed` (helper-level)}. Any
other error → `Could not show <basename>: internal error`.

### Component 2 — bridge HTTP endpoint `POST /show-file` (`index.js`)

Added to `apiServer` (`index.js:6579`) beside `/secret` (`:6645`) and `/share-sensitive`
(`:6719`). The entire handler body is wrapped in try/catch so an uncaught error returns
`502 {"error":"internal error"}`, NOT the shared API catch's misleading `400 {"error":"Invalid
JSON"}` (`index.js:7037`).

1. **Reject oversized requests before buffering:** cap the request body at 64 KB (path + caption
   + token are small); over-cap → `413`. Parse `{path, caption, token}`; missing `path` or `token`
   → `400`.
2. **Resolve session by token, never by a client-supplied room id.** At session spawn the bridge
   mints `SHOW_FILE_TOKEN = randomUUID()` and stores it **on the session object**
   (`session.showFileToken`), then injects it into the claude child env. The endpoint resolves the
   session by scanning `sessions.values()` for `s.showFileToken === token` (N is small — linear
   scan, P18); no match → `403 {"error":"invalid token"}`. Storing the token on the session object
   (not a separate `token→roomId` map) means it is created and destroyed with the session in one
   place — it cannot outlive the session, cannot be missed at any of the ~9 `sessions.delete`
   teardown seams, and can never resolve to a replacement session in the same room (the token is
   bound to the object, not the reusable roomId). This closes the rev-1 forgery hole and the rev-2
   cleanup-seam gap (P67).
3. Delegate to the emit helper (Component 3). Status map: `sensitive` → 403; `outside-scope` → 403;
   `too-large` → 413; `not-a-file`/`unreadable`/`symlink`/`relative-path` → 404;
   `upload-failed`/`queue-failed` → 502; unexpected throw → 502 `internal error`; ok →
   `200 {ok:true, media_id, kind}`.

### Component 3 — emit helper `journalShareAgentMedia(session, {path, caption})` (`index.js`)

The one piece of new logic. Almost entirely reuse (P59):

1. **Read + guard (reuse `validateAndOpen` with NO workdir).**
   `const { content, realPath } = await validateAndOpen(path, { maxBytes: SHOW_FILE_MAX_BYTES })`
   (no `workdir` arg). `validateAndOpen` (`file-link-guard.js:93`) opens with `O_NOFOLLOW`,
   resolves the real path via `/proc/self/fd`, checks the sensitivity denylist, asserts `isFile`,
   caps size — throwing `FileLinkDenied(reason)` for `relative-path`/`symlink`/`sensitive`/
   `not-a-file`/`unreadable`/`too-large`. Catch it and surface `err.reason`. `SHOW_FILE_MAX_BYTES
   = 50 MB` (aligned to the journal `DEFAULT_MEDIA_MAX_BYTES`; new exported constant).
2. **Scope check (helper-level, on the fd-pinned `realPath`).** Assert `realPath` is contained by
   at least one allowed root — `[session.workdir, ...SHOW_FILE_ARTIFACT_ROOTS]` — using the guard's
   boundary-safe `contains()` (export it from `file-link-guard.js`). None contain → return
   `{denied: 'outside-scope'}`, no upload. Checking the **already-resolved `realPath`** (not the
   input `path`) keeps this TOCTOU-safe and reuses the guard's own containment logic rather than a
   parallel multi-`workdir` loop inside `validateAndOpen` (the single-root helper stays unchanged,
   P59). `SHOW_FILE_ARTIFACT_ROOTS` grammar: colon-separated absolute paths (like `$PATH`); each
   must be absolute + existing at bridge startup; a malformed/nonexistent/relative entry fails loud
   at startup (V4 fail-visible), never silently broadens or narrows. Default: **empty** (workdir
   only). `/tmp` is deliberately NOT a default — it is globally shared, so making it an allowed root
   would let one session show another session's neutrally-named file (rev-2 finding).
3. **Upload (reuse `uploadMedia`).**
   `const media = await journalPublisher.uploadMedia({ bytes: content, contentType: mime, name: basename })`.
   Fails open → `null` ⇒ return `{denied:'upload-failed'}`, skip publish.
4. **Publish (reuse `publishImage`/`publishFile` via the buffering wrapper).** Payload:
   ```
   { blob_ref: media.media_id, content_type: media.content_type,
     name: basename, filename: basename,          // filename is the key the web renderer reads
     size: media.size, caption }                   // caption omitted when absent
   ```
   **`filename` is required** — the web file-render path reads `payload.filename`
   (`components.tsx:3042`) and the sidebar snippet reads it (`types.ts:536`); without it every
   attachment renders as the generic label and downloads as `attachment`. The client's own outbound
   path sends both (`client.ts:905-906`), so we send both. Publish through
   `journalPublish(session, kind === 'image' ? 'publishImage' : 'publishFile', payload)` — the
   buffering wrapper that upserts the convo before the first publish. **Do NOT use
   `journalPublishUserItem` (`index.js:682`)** — it also fires `markRead`, which for an agent-sent
   item would suppress the unread badge on a message the operator has not yet seen. If the
   synchronous enqueue throws → return `{denied:'queue-failed'}`.
   The event lands on the **agent** bubble because the journal server stamps `sender:
   agent:${conn.name}` on every publish from the bridge's agent-kind connection (`ws.js:645`) —
   connection-identity routing, independent of payload. (`payload.from` has no consumer anywhere;
   the field is not sent.)
5. Return `{ ok: true, media_id, kind, realPath, size: content.length, sha256: media.sha256 }` —
   fields the endpoint needs for the audit log (Observability). **Delivery is best-effort:** `ok`
   means the blob uploaded and the event enqueued, matching every journal event (text/diff/
   tool_output) — the in-memory queue delivers live and replays on reconnect, but a crash before
   reconnect or a queue overflow can drop it. The endpoint returns 502 only for synchronously-known
   failures (`upload-failed`, `queue-failed`); it does not claim the operator saw it (P3).
   **Orphan on `queue-failed`:** the rare synchronous enqueue failure leaves an uploaded-but-
   unreferenced blob. There is no media DELETE in the journal API, so no synchronous rollback;
   unreferenced blobs age out via the journal's existing blob retention/TTL (PR #12 tool-output
   purge established TTL-based media purge). Retrying re-uploads (idempotency deferred, below). This
   bound is acceptable given the rarity; documented rather than papered over.

### Data flow

```
Claude session
  └─ MCP tool show_file(path, caption)                       [show-file-mcp.js, `share` extra]
       └─ POST /show-file {path,caption,token:SHOW_FILE_TOKEN}   (body ≤64KB)
            └─ apiServer /show-file (try/catch-wrapped)        [index.js:6579+]
                 └─ session = scan sessions.values() for s.showFileToken===token   [403 if none]
                 └─ journalShareAgentMedia(session, {path,caption})
                      ├─ validateAndOpen(path,{maxBytes:50MB}) → {content, realPath}  [file-link-guard.js:93]
                      ├─ contains(realPath, [workdir, ...ARTIFACT_ROOTS])? else outside-scope
                      ├─ ext→mime, kind = image|file
                      ├─ uploadMedia(content,mime) → POST /media (journal)
                      └─ journalPublish(session, publishImage|publishFile, {blob_ref, filename, name, size, caption})
                           └─ journal stamps sender:agent:*, stores + fans out
                                └─ web case "image"|"file" → inline <img> / attachment(payload.filename)  [components.tsx:3018/3033/3042]
```

## Security model (P67, P15, P8)

The tool reads a local file and egresses its bytes — a **read-file + egress primitive**. Three
boundaries, all real:

- **Path scope = allowlist of roots, default the session workdir only.** `journalShareAgentMedia`
  denies (`outside-scope`) any `realPath` not contained by `[session.workdir,
  ...SHOW_FILE_ARTIFACT_ROOTS]`. Default roots = **just the session's own workdir** —
  `SHOW_FILE_ARTIFACT_ROOTS` defaults empty. Workdir-only means a default-on session can only
  egress files from its own working tree (its own work), which is why default-on is acceptable
  pre-#458. An operator who wants a shared scratch root adds it explicitly to
  `SHOW_FILE_ARTIFACT_ROOTS` (colon-separated absolute paths, validated at startup) accepting that
  a shared root is shared across that box's sessions. `/tmp` is NOT a default (globally shared →
  cross-session read). The sensitivity denylist inside `validateAndOpen` remains as
  defense-in-depth on top of the allowlist. "The agent has Bash anyway" is explicitly NOT the
  justification — egress is a separate permission from local read (P15).
- **Routing identity = per-session capability token stored on the session object**, never a
  client-supplied room id (Component 2). An agent cannot target another conversation, and the token
  cannot outlive or be misrouted across session replacement.
- **Curated-toolset (Nastia) — deferred to #458, provisioned here.** `show_file` is the `share`
  mcpExtras group; #458's curated session type omits `share` (existing additive selection) or, to
  give Nastia a scoped `show_file`, narrows her session's `SHOW_FILE_ARTIFACT_ROOTS`/workdir at the
  same call site. This spec puts `show_file` in the *default* extras but that default is a v1 policy
  #458 overrides per session type; it is NOT on the always-on base.
- **Size cap** `SHOW_FILE_MAX_BYTES = 50 MB` (file) enforced by `validateAndOpen`; request body
  capped at 64 KB; caption clamped to 4096.

## SVG handling (verified inline-renderable)

`.svg` publishes as an `image` event with `content_type: image/svg+xml`. The web client renders via
`AuthenticatedMedia`: `client.ts:1145` `mediaUrl()` → `URL.createObjectURL(blob)` → `<img>`. The
journal serves the stored content-type verbatim with no allowlist and no CSP restricting a `blob:`
SVG `<img>` (`http.js:432-460`, traced in review). Scripts do not execute in `<img>`-loaded SVG →
XSS-safe. No SVG→PNG pre-render, no new dependency.

## Observability (P34)

The `/show-file` handler emits one structured log line per call. On **success**, from the helper's
return: `{event:'show_file', roomId, realPath, kind, size, media_id, sha256, result:'ok'}` —
`realPath` identifies exactly which file left the host, `media_id`+`sha256` correlate the stored
blob. On **denial**, `validateAndOpen` throws before exposing `realPath`, so the line logs the
input `path` + `reason`: `{event:'show_file', roomId, path, result:<reason>}` (the input path is
sufficient to identify the attempt; the guard is deliberately not modified to leak its internal
realpath on throw). `uploadMedia` already warns on failure.

## Testing

- **Unit — ext→mime + kind:** png/jpg/svg/gif/webp→image; pdf/zip/unknown→file; case-insensitive.
- **Unit — emit helper** (mock `validateAndOpen`, `uploadMedia`, `journalPublish`): image→
  `publishImage`, non-image→`publishFile`; payload carries BOTH `filename` and `name`; `blob_ref`
  threaded; caption present/absent; each `validateAndOpen` reason surfaced with no upload;
  `uploadMedia`→null ⇒ `upload-failed`; enqueue-throw ⇒ `queue-failed`; helper return includes
  realPath/size/sha256 for the audit line.
- **Unit — scope check:** realPath under workdir → allowed; under a configured `ARTIFACT_ROOTS`
  entry → allowed; outside all roots (`/var/lib/app/prod.db`) → `outside-scope`, no upload; a
  `secrets.json` under an allowed root → `sensitive` (denylist fires within scope).
- **Unit — roots parsing:** valid colon-list → parsed; a relative/nonexistent entry → startup fails
  loud.
- **Unit — token routing:** missing token → 400; unknown token → 403; valid token resolves the
  right session; a body `roomId` is ignored; token absent from `sessions` after the session object
  is dropped.
- **Unit — denial mapping:** every reason → its status; an unexpected throw → 502 `internal error`,
  never `Invalid JSON`; body >64KB → 413.
- **Endpoint:** fixture PNG under workdir + valid token → 200 + publish with `filename`; oversize
  file → 413.
- **Run-it gate (empirical validation — catches what static review cannot).** On a live session:
  `show_file` a real PNG and SVG → both render inline (both themes); a PDF → attachment showing real
  filename + size.

## Out of scope / deferred follow-ups

- **>50 MB / huge non-previewable files → signed viewer `/download` link.** v1 returns `too-large`;
  upstream `feat/viewer-download` (#149) to build on later.
- **Curated-toolset scoping for Nastia** — #458; provisioned via the `share` extra + roots/workdir
  knob.
- **Latent mirror-path bug:** `journalMirrorUserMedia` sets `name` not `filename` and a dead
  `from:'user'` field — operator's own mirrored uploads may render with a generic label / wrong
  bubble side. Pre-existing; file as a separate bridge loop.
- **Idempotency (P32):** double-call double-posts; `uploadMedia` returns `sha256` for a future dedup
  guard. Combined with the `queue-failed` orphan bound, an explicit upload/publish two-phase
  reconciliation is a follow-up if orphan rate ever matters.
- **Retiring dead `redact_message`** (`index.js:6773`) — separate.

## Acceptance criteria

1. A bridge session calls `show_file('<workdir>/diagram.svg')` and the operator sees the diagram
   rendered inline, on the agent side, on the web client.
2. A non-image file (PDF) shows as an inline attachment with its **real filename** (`payload.filename`)
   and size.
3. A path whose `realPath` is outside all allowed roots → `outside-scope` (403); a sensitive path
   within an allowed root → `sensitive` (403); nothing uploaded/published in either case.
4. An oversize (>50 MB) file → `too-large` (413); a request body >64 KB → 413; nothing uploaded.
5. A `/show-file` call cannot inject media into another session's conversation: routing is by the
   per-session token on the session object; a client-supplied `roomId` is ignored; the token does
   not resolve after its session object is dropped.
6. Every `FileLinkDenied` reason and any unexpected error maps to a defined status + denial string
   (never the `Invalid JSON` fallthrough); on denial the model can fall back to a text reply.
7. No journal-server or web-client change is required for items 1–2; the diff is confined to
   `easelyte/claude-matrix-bridge`.
8. `show_file` is the opt-in `share` mcpExtras group, NOT on the always-on `ask-user` base; a
   session that does not select `share` does not get the tool. (Default extras include `share` per
   the open decision; #458's curated session type omits it.)

## Appendix — Downstream contract verification

Verified in review across all three repos:
- Journal accepts agent `image`/`file` publishes — `AGENT_PUBLISH_TYPES` includes both (`ws.js`);
  publish op requires `conn.kind==='agent'`.
- Media cap `DEFAULT_MEDIA_MAX_BYTES = 50 MB` (journal `server.js`).
- `POST /media` → `{media_id, size, content_type, sha256}`; `GET /media/:id` streams stored
  `content_type` verbatim (journal `http.js:401-465`).
- Web renders `image` inline (`components.tsx:3018` → `AuthenticatedMedia` `<img>`) and `file` as an
  attachment reading `payload.filename` (`:3033/:3042`); dual `filename`+`name` matches the client's
  own outbound path (`client.ts:905-906`).
- Bubble routing keys on `event.sender` = `agent:${conn.name}` (`ws.js:645`), independent of payload.
- Per-session child-env injection exists (`BRIDGE_ROOM_ID` at `index.js:1098-1104`, `:1658-1664`) —
  the token delivery mechanism.
- SVG: no content-type allowlist or CSP blocks a `blob:` `image/svg+xml` `<img>` (journal
  `http.js:432-460`; web `client.ts:1145`).
