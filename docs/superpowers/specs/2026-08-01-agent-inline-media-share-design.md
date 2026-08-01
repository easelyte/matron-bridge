---
title: Agent-initiated inline media share (`show_file`)
date: 2026-08-01
status: draft
repo: easelyte/claude-matrix-bridge (branch journal-deploy)
risk: medium
execution_tier: slim
related_principles:
  - P59 Extend the Canonical Primitive
  - P67 Isolate Untrusted Agents by Capability
  - P15 Data Egress Needs Explicit Permission
  - P8 Guard Boundary Inputs
  - P34 Observability Before Automation
rejected_alternatives:
  - "B (image-only show_image): drops file/attachment + PDF support; PDFs/reports are a real artifact class, trim not worth it."
  - "A (unscoped MVP, scope later): the path guard IS the security-load-bearing part (P67/P15); shipping unscoped first cuts the wrong corner."
  - "Output-marker trigger ([[show:/path]] in model text): fragile parse, pollutes reply stream, no structured error path. MCP tool is the established pattern."
  - "Data-URI inline embed (no upload): a second render path for marginal gain on tiny SVGs; violates P59 (parallel path). The media store already renders images inline."
unresolved_questions:
  - "SVG: publish as image/svg+xml and rely on the client <img> render, or pre-render SVG→PNG via the chrome substrate? Default: as-is, verified at plan time (POC)."
  - "Path scope default for full-tools sessions: denylist-only (no workdir containment) vs workdir-contained. Default: denylist-only — see Security."
---

# Agent-initiated inline media share (`show_file`)

## Problem

When a bridge (Claude Code) session generates a file on the VPS — a rendered PNG, an SVG
diagram, a PDF report, a screenshot — there is no way for the session to put it in front of
the operator. The operator must SSH into the VPS and open the file by hand. The prior
workaround (an HMAC viewer link) fails for binary/image content: the viewer's `/view` route
renders every file as escaped UTF-8 text in a `<pre>` block (`viewer/server.js:180`), so an
image comes out as garbage; the binary-safe `/download` route forces an attachment download
and has no bridge caller. The result is the friction the operator hit: "give me a link to the
SVG" → "I can't."

## What already exists (do NOT rebuild)

Agent→operator inline media is already built on two of the three layers. This spec adds only
the missing trigger on the third.

- **Journal server** (`easelyte/matron-journal`) accepts agent-published `image`/`file`
  events with a top-level `blob_ref` and stores/fans them out. `POST /media` (Bearer agent
  token) stores a blob and returns `{media_id, size, content_type, sha256}`; `GET /media/:id`
  serves it with its stored content-type. `AGENT_PUBLISH_TYPES` already includes `image` and
  `file`. Media cap `DEFAULT_MEDIA_MAX_BYTES = 50 MB`. **Nothing to build.**
- **Web client** (`easelyte/matron-web`) already renders these inline:
  `components.tsx:3019` `case "image"` → `AuthenticatedMedia` (auth-fetches `/media/:id`,
  inline `<img>`); `case "file"` (`:3034`) → inline attachment link with size + icon.
  `event.sender.startsWith("user:")` (`:3086`) routes an `agent:*`-sender event to the agent
  bubble automatically. **Nothing to build.**
- **Bridge** (`easelyte/claude-matrix-bridge`) already owns the plumbing:
  `journalPublisher.uploadMedia({bytes, contentType, name})` (`lib/journal-publisher.js:507`)
  and `publishImage` / `publishFile` (`:643` / `:640`). The fd-pinned, sensitivity-checked,
  size-capped file reader `validateAndOpen(path, {workdir, maxBytes})`
  (`lib/file-link-guard.js:93`) already exists. **The only caller of `publishImage`/`publishFile`
  is `journalMirrorUserMedia` (`index.js:957-977`), which mirrors the operator's OWN uploads
  with `from:'user'`.** There is no agent-initiated caller.

**Archaeology (2026-08-01):** upstream `Matronhq/{matron-bridge,matron-web,matron-journal}`
has no branch, PR, or commit building an agent-initiated outbound media trigger. Dan's media
work is all inbound (operator→Claude: downscale-for-injection, caption delivery, auto-resume)
plus file-edit diffs. This work is greenfield on our fork and does not conflict upstream.

## The gap

One thing is missing: a trigger the Claude session can invoke that says "show this file to the
operator." Everything downstream of an agent-authored `image`/`file` publish already works.

## Design

Three small pieces, in the bridge repo only. The MCP tool cannot call `uploadMedia` directly
(it runs as a separate stdio process without the agent token or WS connection), so — exactly
like the existing `request_secret` / `share_sensitive_data` tools — it POSTs to a new bridge
HTTP endpoint, and the bridge process does the guarded read, upload, and publish.

### Component 1 — MCP tool `show_file` (`ask-user.js`)

Registered on the existing `ask-user` MCP server (already spawned, already wired in
`mcp-config.json` with `BRIDGE_API_URL=http://127.0.0.1:9812`). Mirrors the `request_secret`
tool shape (`ask-user.js:25-65`): a `server.tool(name, description, zodSchema, handler)` whose
handler `fetch`es a bridge endpoint and returns `{content:[{type:'text', text}]}`.

```
server.tool(
  'show_file',
  'Display a file to the operator inline in the chat: a rendered image (PNG/JPG/SVG/GIF/WebP)
   renders as an inline picture; any other file (PDF, report, archive) appears as a
   downloadable attachment. Use this instead of describing a filepath the operator cannot
   open. The file must already exist on disk.',
  {
    path: z.string().describe('Absolute path to the file on the VPS to show the operator'),
    caption: z.string().optional().describe('Optional caption shown with the file'),
  },
  handler → POST ${BRIDGE_API}/show-file { path, caption, roomId: ROOM_ID }
)
```

Return contract (so the model knows the outcome and does NOT then narrate a filepath):
- success → `Shown to operator: <basename> (image|file).`
- guard denial → `Could not show <basename>: <reason>` (`sensitive`, `outside-workdir`,
  `too-large`, `not-a-file`, `unreadable`). The model can then fall back to telling the
  operator in words.

### Component 2 — bridge HTTP endpoint `POST /show-file` (`index.js`)

Added to `apiServer` (`index.js:6579`) alongside `/secret` (`:6645`) and `/share-sensitive`
(`:6719`), following the same body-parse + `sessions.get(roomId)` pattern.

1. Parse `{ path, caption, roomId }`; 400 if `path` or `roomId` missing.
2. `const session = sessions.get(roomId)`; 404 if no active session for the room.
3. Delegate to the emit helper (Component 3). On its result:
   - denied → `res.writeHead(4xx)` with `{error: reason}` (403 for `sensitive`/`outside-workdir`,
     413 for `too-large`, 404 for `not-a-file`/`unreadable`, 502 for upload/publish failure).
   - ok → `res.writeHead(200)` `{ ok: true, media_id, kind: 'image'|'file' }`.

### Component 3 — emit helper `journalShareAgentMedia(session, {path, caption})` (`index.js`)

The one piece of genuinely new logic. Almost entirely reuse (P59):

1. **Read + guard (reuse `validateAndOpen`).**
   `const { content, realPath } = await validateAndOpen(path, { workdir: undefined, maxBytes: SHOW_FILE_MAX_BYTES })`.
   `validateAndOpen` (`file-link-guard.js:93`) opens with `O_NOFOLLOW`, resolves the real path
   via `/proc/self/fd`, re-checks the sensitivity denylist (`.env`, `secrets*`, `config.json`,
   `*.pem/key`, `.ssh/`, `.aws/`, …; `file-link-guard.js:27-52`), asserts `isFile`, and caps
   size — then returns the bytes read through the pinned fd. Any denial throws `FileLinkDenied`
   with a `.reason`; catch it and map to the tool's denial reasons. `SHOW_FILE_MAX_BYTES =
   50 MB` (aligned to the journal server's `DEFAULT_MEDIA_MAX_BYTES`; new exported constant).
   **Workdir scope:** see Security — default `workdir: undefined` (denylist-only) for
   full-tools sessions.
2. **Derive content-type + kind** from `realPath`'s extension via a small extension→mime map
   (`.png→image/png`, `.jpg/.jpeg→image/jpeg`, `.gif→image/gif`, `.webp→image/webp`,
   `.svg→image/svg+xml`, else `application/octet-stream`). `kind = mime.startsWith('image/')
   ? 'image' : 'file'`. Deriving from extension (not sniffing) matches how
   `journalMirrorUserMedia` chooses image-vs-file and keeps the helper pure/sync after the read.
3. **Upload (reuse `uploadMedia`).**
   `const media = await journalPublisher.uploadMedia({ bytes: content, contentType: mime, name: basename })`.
   Fails open → `null`; on `null` return `{ denied: 'upload-failed' }` and skip the publish
   (a media event without a blob is useless — same contract as the mirror path).
4. **Publish (reuse `publishImage`/`publishFile` via the buffered helper).**
   Build the payload mirroring `journalMirrorUserMedia` (`index.js:962-970`) but agent-authored:
   ```
   { blob_ref: media.media_id, content_type: media.content_type, name: basename,
     size: media.size, from: 'assistant', caption }   // caption omitted when absent
   ```
   `from: 'assistant'` matches the diff path (`publishDiff` payload, `index.js:748`) so the
   event sender-routes to the agent bubble. Publish through
   `journalPublishUserItem(session, kind === 'image' ? 'publishImage' : 'publishFile', payload)`
   (`index.js:972`) so it correctly buffers if the convo id is not yet established.
5. Return `{ ok: true, media_id: media.media_id, kind }`.

### Data flow

```
Claude session
  └─ MCP tool show_file(path, caption)                       [ask-user.js, stdio process]
       └─ POST http://127.0.0.1:9812/show-file {path,caption,roomId}
            └─ apiServer /show-file                            [index.js:6579+]
                 └─ session = sessions.get(roomId)
                 └─ journalShareAgentMedia(session, {path,caption})
                      ├─ validateAndOpen(path,{maxBytes:50MB}) → bytes   [file-link-guard.js:93]
                      ├─ ext→mime, kind = image|file
                      ├─ journalPublisher.uploadMedia(bytes,mime)  → POST /media (journal server)
                      └─ journalPublishUserItem(session, publishImage|publishFile, {blob_ref, from:'assistant', ...})
                           └─ journal server stores + fans out image|file event
                                └─ web client case "image"|"file" → inline <img> / attachment  [components.tsx:3019/3034]
```

## Security model (P67, P15, P8)

The tool reads a local file and egresses its bytes to the operator's journal. That is a
**read-arbitrary-file primitive**, so scope matters.

- **Denylist always on.** `validateAndOpen` re-checks the sensitivity denylist at read time
  through the pinned fd (`file-link-guard.js:111`), so `/etc/anton/secrets.json`,
  `**/.env`, `*.pem`, `~/.ssh/*`, `config.json`, etc. are refused even if named directly. This
  is defense-in-depth against accidentally showing a secret, not the primary boundary.
- **Default scope = denylist-only (no workdir containment) for full-tools (operator) sessions.**
  Rationale: an operator session already has `Bash`/`Read`, so `show_file` grants no new read
  capability — workdir containment would only reproduce the exact friction (agents routinely
  write artifacts to `/tmp` or a scratch dir outside the session workdir, e.g. the
  `/root/spider-box-guide/*.svg` case that motivated this). The denylist prevents the one real
  hazard (secret exposure). `validateAndOpen` is called with `workdir: undefined`.
- **Curated-toolset (Nastia) interaction — deferred to #458, noted here.** Under the shared-agent
  collaboration backbone, a curated integration-only toolset must NOT gain an arbitrary-file-read
  primitive. Two clean options, decided in #458 not here: (i) omit `show_file` from the curated
  toolset entirely (P67 — capability follows membership; worst-privilege-wins), or (ii) include
  it with `workdir`/artifacts-dir containment enabled. This spec leaves a single call-site knob
  (`workdir` argument to `validateAndOpen`) so #458 can flip it per-session without touching the
  helper. **This spec does not put `show_file` in any curated toolset.**
- **Size cap** `SHOW_FILE_MAX_BYTES = 50 MB`, enforced by `validateAndOpen` before the whole
  file is read into a Buffer; oversize → `too-large` denial, no upload.

## SVG handling

Default: publish `.svg` as an `image` event with `content_type: image/svg+xml` and let the web
client's `AuthenticatedMedia` render it via `<img src={objectURL}>`. Scripts do not execute in
`<img>`-loaded SVG, so this is XSS-safe even for agent-generated markup. **Plan-time POC (P7):**
confirm the client actually renders an `image/svg+xml` blob inline. If it does not, fall back to
rendering SVG→PNG via the existing chrome substrate (`docs/architecture/render-build-substrate.md`
— headless chromium already on the box) rather than adding a new dependency. This fallback is a
plan-stage decision, not a v1 requirement.

## Observability (P34)

The `/show-file` handler emits one structured log line per call:
`{event:'show_file', roomId, basename, kind, size, result:'ok'|denyReason}`. `uploadMedia`
already warns on every failure mode. No new automation loop; this is an operator-invoked path,
so a per-call line is sufficient.

## Testing

- **Unit — extension→mime + kind routing:** `.png/.jpg/.svg/.gif/.webp → image`; `.pdf/.zip/
  unknown → file`; case-insensitive extension.
- **Unit — emit helper** (mock `validateAndOpen`, `uploadMedia`, `journalPublishUserItem`):
  image ext → `publishImage` with `from:'assistant'`, `blob_ref` threaded, caption passed when
  present and omitted when absent; non-image ext → `publishFile`; `uploadMedia`→null ⇒ no
  publish + `upload-failed`; `FileLinkDenied('sensitive')` ⇒ `denied:'sensitive'`, no upload.
- **Endpoint — `POST /show-file`:** missing `path`/`roomId` → 400; unknown `roomId` → 404;
  fixture PNG in an allowed dir → 200 + publish invoked; a `secrets.json` fixture → 403 + no
  publish; an oversize fixture → 413 + no publish.
- **Run-it gate (2026-08-01 principle candidate — empirical validation catches what static
  review cannot).** Before ship, on a live session: `show_file` a real PNG and a real SVG and
  confirm both render inline on the web client (both themes), and that a `file` (PDF) renders as
  an attachment that downloads. Static tests cannot prove the client renders `image/svg+xml`
  inline; this gate must pass.

## Out of scope / deferred follow-ups

- **>50 MB or genuinely non-previewable-huge files → signed viewer `/download` link.** Rare for
  generated diagrams; v1 returns `too-large`. Upstream already has `feat/viewer-download` (#149)
  to build on when wanted.
- **Curated-toolset scoping / inclusion for Nastia** — belongs to #458.
- **Idempotency (P32):** an agent double-calling `show_file` double-posts. Low harm (a repeated
  image), and `uploadMedia` returns `sha256` if a dedup guard is wanted later. Not built in v1.
- **Retiring the dead `redact_message` tool** (already noted stale at `index.js:6773`) — separate.

## Acceptance criteria

1. A bridge session can call `show_file('/abs/path/to/diagram.svg')` and the operator sees the
   diagram rendered inline in the chat, on the agent side, on the web client.
2. A non-image file (PDF) shows as an inline downloadable attachment with its name and size.
3. A sensitive path (`secrets.json`, `.env`, `*.pem`, `~/.ssh/*`) is refused with a clear reason
   and nothing is uploaded or published.
4. An oversize (>50 MB) file is refused with `too-large`; nothing uploaded.
5. The tool returns a short success/denial string to the model; on denial the model can fall
   back to a text reply.
6. No change to the journal server or web client is required for items 1–2 (existing render
   path); the diff is confined to `easelyte/claude-matrix-bridge`.
7. `show_file` is NOT registered into any curated/integration-only toolset by this change.
