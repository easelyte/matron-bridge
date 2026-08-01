---
title: Agent-initiated inline media share (`show_file`)
date: 2026-08-01
status: draft
revision: 2
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
rejected_alternatives:
  - "B (image-only show_image): drops file/attachment + PDF support; PDFs/reports are a real artifact class, trim not worth it."
  - "A (unscoped MVP, scope later): the path guard IS the security-load-bearing part (P67/P15); shipping unscoped first cuts the wrong corner."
  - "Output-marker trigger ([[show:/path]] in model text): fragile parse, pollutes reply stream, no structured error path. MCP tool is the established pattern."
  - "Data-URI inline embed (no upload): a second render path for marginal gain on tiny SVGs; violates P59 (parallel path). The media store already renders images inline."
  - "Denylist-only path scope (revision 1): rejected in review — a neutrally-named sensitive file (/var/lib/app/prod.db) sails through the finite pattern list, so denylist-only is not an egress boundary (P15). Replaced with workdir + artifact-roots allowlist."
  - "roomId in the request body as routing identity (revision 1): rejected in review — any shell-capable agent can enumerate /sessions and post to another room (P67). Replaced with a per-session capability token."
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
the missing trigger on the third. See the **Downstream contract verification** appendix for the
file:line evidence that each downstream claim below already holds.

- **Journal server** (`easelyte/matron-journal`) accepts agent-published `image`/`file`
  events with a top-level `blob_ref` and stores/fans them out. `POST /media` (Bearer agent
  token) stores a blob and returns `{media_id, size, content_type, sha256}`; `GET /media/:id`
  serves it with its stored content-type verbatim. `AGENT_PUBLISH_TYPES` already includes
  `image` and `file`. Media cap `DEFAULT_MEDIA_MAX_BYTES = 50 MB`. **Nothing to build.**
- **Web client** (`easelyte/matron-web`) already renders these inline:
  `components.tsx:3019` `case "image"` → `AuthenticatedMedia` (auth-fetches `/media/:id`,
  inline `<img>`); `case "file"` (`:3034`) → inline attachment link reading `payload.filename`
  (`:3042`) with size + icon. Bubble side is decided by `event.sender` (`:3086`), which the
  journal server sets from the WebSocket connection identity — **not** from any payload field.
  **Nothing to build.**
- **Bridge** (`easelyte/claude-matrix-bridge`) already owns the plumbing:
  `journalPublisher.uploadMedia({bytes, contentType, name})` (`lib/journal-publisher.js:507`)
  and `publishImage` / `publishFile` (`:643` / `:640`). The fd-pinned, sensitivity-checked,
  size-capped file reader `validateAndOpen(path, {workdir, maxBytes})`
  (`lib/file-link-guard.js:93`) already exists. **The only caller of `publishImage`/`publishFile`
  is `journalMirrorUserMedia` (`index.js:957-977`), which mirrors the operator's OWN uploads.**
  There is no agent-initiated caller.

**Archaeology (2026-08-01):** upstream `Matronhq/{matron-bridge,matron-web,matron-journal}`
has no branch, PR, or commit building an agent-initiated outbound media trigger. Dan's media
work is all inbound (operator→Claude) plus file-edit diffs. This work is greenfield on our fork
and does not conflict upstream.

## The gap

One thing is missing: a trigger the Claude session can invoke that says "show this file to the
operator." Everything downstream of an agent-authored `image`/`file` publish already works.

## Design

Three small pieces, in the bridge repo only. The MCP tool cannot call `uploadMedia` directly
(it runs as a separate stdio process without the agent token or WS connection), so — exactly
like the existing `request_secret` / `share_sensitive_data` tools — it POSTs to a new bridge
HTTP endpoint, and the bridge process does the guarded read, upload, and publish.

### Component 1 — MCP tool `show_file` on its own opt-in extra server (`show-file-mcp.js`)

Registered as a **new `mcpExtras` group** (`share`), NOT on the always-on `ask-user` base
server. The bridge's `mcpExtras` groups are selected per session at spawn (`index.js:163`,
`mcpConfigPathFor(extras)`, `journalStartSessionForRpc({mcpExtras})`); operator/full-tools
sessions include `share` by default (it is a lightweight stdio server, not a ~400 MB browser
stack, so the "default to no extras" lean-session rule does not apply to it), and #458's curated
sessions omit it by not selecting the group. This is why Acceptance #7 holds with **existing**
additive infra — no tool-subtraction mechanism is invented. (Revision-1 registered on `ask-user`;
review flagged that as an always-on leak to every session, contradicting Acceptance #7.)

The tool mirrors the `share_sensitive_data` shape (`ask-user.js:67-98`: a single synchronous
`server.tool(name, description, zodSchema, handler)` that `fetch`es a bridge endpoint and returns
`{content:[{type:'text', text}]}` — NOT the polling shape of `request_secret`).

```
server.tool(
  'show_file',
  'Display a file to the operator inline in the chat: a rendered image (PNG/JPG/SVG/GIF/WebP)
   renders as an inline picture; any other file (PDF, report, archive) appears as a
   downloadable attachment. Use this instead of describing a filepath the operator cannot
   open. The file must already exist on disk.',
  {
    path: z.string()
      .refine((p) => require('node:path').isAbsolute(p), 'path must be absolute'),
    caption: z.string().optional().describe('Optional caption shown with the file'),
  },
  handler → POST ${BRIDGE_API}/show-file { path, caption, token: SHOW_FILE_TOKEN }
)
```

The handler sends the per-session capability token (see Component 2), NOT a `roomId`. Env:
`BRIDGE_API_URL` (or `MATRON_BRIDGE_API_PORT`, matching `ask-user.js:13-15`) and
`SHOW_FILE_TOKEN`, both injected into the claude child env at session spawn.

Return contract (so the model knows the outcome and does NOT then narrate a filepath):
- success → `Shown to operator: <basename> (image|file).` — note "shown" here means uploaded and
  queued for delivery; see Component 3 on the delivery guarantee.
- denial → `Could not show <basename>: <reason>` for any of the eight `FileLinkDenied` reasons
  (`relative-path`, `symlink`, `sensitive`, `outside-scope`, `bad-workdir`, `not-a-file`,
  `unreadable`, `too-large`) or `upload-failed` / `queue-failed`. Any other/unexpected error →
  `Could not show <basename>: internal error`. The model can then fall back to a text reply.

### Component 2 — bridge HTTP endpoint `POST /show-file` (`index.js`)

Added to `apiServer` (`index.js:6579`) alongside `/secret` (`:6645`) and `/share-sensitive`
(`:6719`).

1. Parse `{ path, caption, token }`; `400 {"error":"path and token are required"}` if either is
   missing.
2. **Resolve session by token, not by a client-supplied room id.** At session spawn the bridge
   mints a random `SHOW_FILE_TOKEN` (`randomUUID`), stores `token → {roomId}` in an in-memory
   map, and injects it into the claude child env. The endpoint looks up the session from the
   token; unknown/expired token → `403 {"error":"invalid token"}`. This closes the revision-1
   forgery hole where `roomId` was a trusted body field an agent could enumerate via `/sessions`
   and spoof (P67). The token is cleared when the session ends.
3. Delegate to the emit helper (Component 3). Map its result:
   - `sensitive` / `outside-scope` / `bad-workdir` → 403
   - `too-large` → 413
   - `not-a-file` / `unreadable` / `symlink` / `relative-path` → 404
   - `upload-failed` / `queue-failed` → 502
   - unexpected throw → **502 `{"error":"internal error"}`** — the handler MUST wrap its body in
     try/catch so an uncaught error does not fall through to the shared API catch, which
     mislabels everything as `400 {"error":"Invalid JSON"}` (`index.js:7037`).
   - ok → `200 {ok:true, media_id, kind:'image'|'file'}`.

### Component 3 — emit helper `journalShareAgentMedia(session, {path, caption})` (`index.js`)

The one piece of genuinely new logic. Almost entirely reuse (P59):

1. **Read + guard (reuse `validateAndOpen`).**
   `const { content, realPath } = await validateAndOpen(path, { workdir: <allowed root>, maxBytes: SHOW_FILE_MAX_BYTES })`.
   `validateAndOpen` (`file-link-guard.js:93`) opens with `O_NOFOLLOW`, resolves the real path
   via `/proc/self/fd`, re-checks the sensitivity denylist, asserts `isFile`, enforces workdir
   containment, and caps size — throwing `FileLinkDenied(reason)` for any of the eight reasons.
   Catch it and surface `err.reason` as the denial. `SHOW_FILE_MAX_BYTES = 50 MB` (aligned to the
   journal server's `DEFAULT_MEDIA_MAX_BYTES`; new exported constant). See **Security** for how
   the allowed root(s) are chosen — the tool tries each configured root and denies with
   `outside-scope` if the path is contained by none.
2. **Derive content-type + kind** from `realPath`'s extension via a small extension→mime map
   (`.png→image/png`, `.jpg/.jpeg→image/jpeg`, `.gif→image/gif`, `.webp→image/webp`,
   `.svg→image/svg+xml`, else `application/octet-stream`), case-insensitive. `kind =
   mime.startsWith('image/') ? 'image' : 'file'`. Deriving from extension (not sniffing) matches
   how `journalMirrorUserMedia` chooses image-vs-file.
3. **Upload (reuse `uploadMedia`).**
   `const media = await journalPublisher.uploadMedia({ bytes: content, contentType: mime, name: basename })`.
   Fails open → `null`; on `null` return `{ denied: 'upload-failed' }` and skip the publish (a
   media event without a blob is useless — same contract as the mirror path).
4. **Publish (reuse `publishImage`/`publishFile` via the buffering wrapper).**
   Build the payload:
   ```
   { blob_ref: media.media_id, content_type: media.content_type,
     name: basename, filename: basename,          // filename is the key the web renderer reads
     size: media.size, caption }                   // caption omitted when absent
   ```
   **`filename` is required, not `name`.** The web file-render path reads `payload.filename`
   (`components.tsx:3042`) and the sidebar snippet reads `payload.filename` (`types.ts:536`);
   without it every non-image attachment renders as the generic label "attachment" and downloads
   as `attachment` (revision 1 copied the mirror's `name`-only shape and would have shipped
   broken). The client's own outbound path sends both (`client.ts:904-906`), so we send both.
   Publish through `journalPublish(session, kind === 'image' ? 'publishImage' : 'publishFile',
   payload)` — the buffering wrapper that upserts the convo before the first publish and buffers
   if the convo id is not yet established. **Do NOT use `journalPublishUserItem` (`index.js:682`)**
   — it additionally fires `markRead`, correct for the operator's own upload (they've seen it) but
   for an agent-sent item it would suppress the unread badge on a message the operator has not yet
   seen.
   The event lands on the **agent** bubble because the journal server stamps `sender:
   agent:${conn.name}` on every publish from the bridge's agent-kind connection (`ws.js:645`) —
   this is connection-identity routing, independent of any payload field. (Revision 1 wrongly
   attributed routing to a `from:'assistant'` payload field; `payload.from` has no consumer in the
   journal server or web client. The field is dropped from the payload.)
5. Return `{ ok: true, media_id: media.media_id, kind }`. **Delivery is best-effort:** `ok` means
   the blob uploaded and the event was enqueued, matching how every journal event (text, diff,
   tool_output) already works — the in-memory publish queue delivers on the live socket and
   replays on reconnect, but a crash before reconnect or a queue overflow can drop it. The endpoint
   returns 502 only for the synchronously-known failures (upload returned null, enqueue threw); it
   does NOT and cannot promise the operator saw it (P3 — the contract is honest about this rather
   than reporting a delivery it can't verify).

### Data flow

```
Claude session
  └─ MCP tool show_file(path, caption)                       [show-file-mcp.js, stdio, `share` extra]
       └─ POST http://127.0.0.1:9812/show-file {path,caption,token:SHOW_FILE_TOKEN}
            └─ apiServer /show-file                            [index.js:6579+, try/catch-wrapped]
                 └─ session = lookupByToken(token)             [403 if unknown]
                 └─ journalShareAgentMedia(session, {path,caption})
                      ├─ validateAndOpen(path,{workdir:allowedRoot,maxBytes:50MB}) → bytes  [file-link-guard.js:93]
                      ├─ ext→mime, kind = image|file
                      ├─ journalPublisher.uploadMedia(bytes,mime)  → POST /media (journal server)
                      └─ journalPublish(session, publishImage|publishFile, {blob_ref, filename, name, size, caption})
                           └─ journal server stamps sender:agent:*, stores + fans out
                                └─ web client case "image"|"file" → inline <img> / attachment (reads payload.filename)  [components.tsx:3019/3034/3042]
```

## Security model (P67, P15, P8)

The tool reads a local file and egresses its bytes to the operator's journal — a
**read-arbitrary-file primitive**. Two boundaries, both real:

- **Path scope = allowlist of roots (workdir + configured artifact roots), NOT a denylist.**
  `validateAndOpen` is called with a `workdir` (allowed root); a path contained by none of the
  configured roots is denied `outside-scope`. Default allowed roots: the **session's workdir**
  plus a small bridge-configured `SHOW_FILE_ARTIFACT_ROOTS` list (default `['/tmp']`, extendable
  via env). Rationale: agents routinely write generated artifacts to `/tmp` or a scratch dir, so
  a workdir-only scope would reproduce the friction (the motivating `/root/spider-box-guide/*.svg`
  case) — but an open denylist is not an egress boundary at all: a neutrally-named secret
  (`/var/lib/app/prod.db`, a customer CSV) matches no pattern and would leak (P15). The allowlist
  is the boundary; the sensitivity denylist inside `validateAndOpen` is defense-in-depth on top of
  it. "The agent has Bash anyway" is explicitly NOT the justification — outbound egress is a
  separate permission from local read (P15).
- **Routing identity = per-session capability token, never a client-supplied room id.** See
  Component 2. The token binds each `/show-file` call to the session that spawned its MCP process,
  so an agent cannot target another conversation. This is the P67 boundary: actor/routing identity
  is not a model-reachable request field.
- **Curated-toolset (Nastia) interaction — deferred to #458, provisioned here.** Because
  `show_file` is its own `mcpExtras` group (not on the always-on base), #458's curated session
  type keeps the capability out simply by not selecting the `share` extra — the existing additive
  selection is the mechanism, no new subtraction infra required. If #458 instead wants Nastia to
  have a *scoped* `show_file`, it narrows `SHOW_FILE_ARTIFACT_ROOTS`/workdir for that session type
  at the same call site. **This spec does not put `show_file` in any curated toolset.**
- **Size cap** `SHOW_FILE_MAX_BYTES = 50 MB`, enforced by `validateAndOpen` before the whole file
  is read into a Buffer; oversize → `too-large`, no upload.

## SVG handling (verified inline-renderable)

`.svg` is published as an `image` event with `content_type: image/svg+xml`. The web client renders
it via `AuthenticatedMedia`: `client.ts:1145` `mediaUrl()` → `URL.createObjectURL(blob)` →
`<img src={objectURL}>`. The journal server serves the stored content-type verbatim with no
allowlist (`http.js:432-460`), and there is no CSP or sanitization step restricting a `blob:` SVG
`<img>` (traced during review). Scripts do not execute in `<img>`-loaded SVG, so this is XSS-safe
even for agent-generated markup. No SVG→PNG pre-render and no new dependency is required.
(Revision 1 deferred this to a plan-time POC with a headless-chromium fallback; the render path was
traced and confirmed in review, so the deferral and the fallback overhang are removed.)

## Observability (P34)

The `/show-file` handler emits one structured log line per call sufficient to reconstruct an
egress incident: `{event:'show_file', roomId, realPath, kind, size, media_id, sha256,
result:'ok'|denyReason}`. `realPath` (not just basename) identifies exactly which file left the
host; `media_id`+`sha256` correlate the stored blob to the source; `result` records the outcome.
`uploadMedia` already warns on every failure mode. No new automation loop; this is an
operator-invoked path, so a per-call line is sufficient.

## Testing

- **Unit — extension→mime + kind routing:** `.png/.jpg/.svg/.gif/.webp → image`; `.pdf/.zip/
  unknown → file`; case-insensitive extension.
- **Unit — emit helper** (mock `validateAndOpen`, `uploadMedia`, `journalPublish`):
  image ext → `publishImage`; non-image ext → `publishFile`; payload carries BOTH `filename` and
  `name` = basename; `blob_ref` threaded; caption passed when present, omitted when absent;
  `uploadMedia`→null ⇒ no publish + `upload-failed`; each of the eight `FileLinkDenied` reasons ⇒
  the matching denial, no upload.
- **Unit — denial mapping:** every `FileLinkDenied` reason maps to its documented HTTP status; an
  unexpected (non-`FileLinkDenied`) throw maps to 502 `internal error`, NOT the shared
  `Invalid JSON` fallthrough.
- **Unit — path scope:** a path under the session workdir → allowed; under a `SHOW_FILE_ARTIFACT_
  ROOTS` entry (`/tmp/x.png`) → allowed; outside all roots (`/var/lib/app/prod.db`) → `outside-scope`;
  a `secrets.json` inside an allowed root → `sensitive` (denylist still fires within scope).
- **Unit — token routing:** missing token → 400; unknown token → 403; valid token resolves to the
  correct session; a body `roomId` is ignored.
- **Endpoint — `POST /show-file`:** fixture PNG under an allowed root + valid token → 200 + publish
  invoked with `filename`; oversize fixture → 413 + no publish.
- **Run-it gate (2026-08-01 principle candidate — empirical validation catches what static review
  cannot).** Before ship, on a live session: `show_file` a real PNG and a real SVG and confirm both
  render inline on the web client (both themes), and a PDF renders as an attachment showing its real
  filename and size. This gate must pass.

## Out of scope / deferred follow-ups

- **>50 MB or genuinely non-previewable-huge files → signed viewer `/download` link.** Rare for
  generated diagrams; v1 returns `too-large`. Upstream already has `feat/viewer-download` (#149)
  to build on when wanted.
- **Curated-toolset scoping / inclusion for Nastia** — belongs to #458; provisioned via the
  `share` mcpExtras group + the `SHOW_FILE_ARTIFACT_ROOTS`/workdir knob.
- **Latent mirror-path bug (found in review):** `journalMirrorUserMedia` (`index.js:962-970`) sets
  `name` but not `filename`, and sets a `from:'user'` field that no consumer reads while
  `sender:agent:*` is stamped regardless — so the operator's own mirrored uploads may render with a
  generic attachment label and/or on the wrong bubble side. Pre-existing, out of scope here; file
  as a separate bridge loop.
- **Idempotency (P32):** an agent double-calling `show_file` double-posts. Low harm; `uploadMedia`
  returns `sha256` if a dedup guard is wanted later. Not built in v1.
- **Retiring the dead `redact_message` tool** (already noted stale at `index.js:6773`) — separate.

## Acceptance criteria

1. A bridge session can call `show_file('/abs/path/to/diagram.svg')` (path under the session
   workdir or a configured artifact root) and the operator sees the diagram rendered inline in the
   chat, on the agent side, on the web client.
2. A non-image file (PDF) shows as an inline downloadable attachment with its **real filename**
   (via `payload.filename`) and size.
3. A path outside all allowed roots is refused `outside-scope`; a sensitive path within an allowed
   root (`secrets.json`, `.env`, `*.pem`, `~/.ssh/*`) is refused `sensitive`; nothing is uploaded or
   published in either case.
4. An oversize (>50 MB) file is refused `too-large`; nothing uploaded.
5. A `/show-file` call carrying another session's identity cannot inject media into that
   conversation: routing is by the per-session capability token, and a client-supplied `roomId` is
   ignored.
6. The tool returns a short success/denial string to the model; every `FileLinkDenied` reason and
   any unexpected error maps to a defined status + denial string (never the `Invalid JSON`
   fallthrough); on denial the model can fall back to a text reply.
7. No change to the journal server or web client is required for items 1–2 (existing render path);
   the diff is confined to `easelyte/claude-matrix-bridge`.
8. `show_file` is registered as the opt-in `share` mcpExtras group, NOT on the always-on `ask-user`
   base server; a session that does not select `share` does not get the tool.

## Appendix — Downstream contract verification

Evidence that "What already exists" holds, so acceptance items 1–2 rest on grounded contracts, not
assertions (verified in review across all three repos):

- Journal accepts agent `image`/`file` publishes — `AGENT_PUBLISH_TYPES` includes both (`ws.js`);
  publish op requires `conn.kind==='agent'`.
- Server media cap `DEFAULT_MEDIA_MAX_BYTES = 50 MB` (journal `server.js`).
- `POST /media` returns `{media_id, size, content_type, sha256}`; `GET /media/:id` streams the
  stored `content_type` verbatim (journal `http.js:401-465`).
- Web renders `image` inline (`components.tsx:3019` → `AuthenticatedMedia` `<img>`) and `file` as an
  attachment reading `payload.filename` (`:3034/:3042`).
- Bubble routing keys on `event.sender` (`components.tsx:3086`), set server-side to
  `agent:${conn.name}` for the bridge connection (`ws.js:645`) — independent of payload.
- SVG: no content-type allowlist or CSP blocks a `blob:` `image/svg+xml` `<img>` (journal
  `http.js:432-460`; web `client.ts:1145` → `createObjectURL`).
