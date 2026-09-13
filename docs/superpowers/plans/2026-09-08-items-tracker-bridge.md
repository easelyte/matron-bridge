# Items Tracker (bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude Code seven `item_*` MCP tools over the journal's items routes, turn user-authored `item` marker events into a synthetic user turn (queued while busy, voice attachments transcribed and written back), add a **📌 Make task** action to the queued-message card, and tell the agent when to use the tracker via the bridge system prompt.

**Architecture:** A dependency-injected HTTP client (`lib/items-client.js`) talks to the journal's `/items` routes with the bridge's agent token. HTTP-agnostic handlers (`lib/items-tools.js`) validate tool input, resolve the session's conversation, upload local attachments through the existing guarded path, and return `{status, body}`; `index.js` mounts them as loopback routes and `ask-user.js` wraps them as tools. Inbound markers flow through the existing `createJournalInputConsumer` as a new `item` branch into `lib/items-turn.js`, which formats the turn and reuses the media router's transcribe/inject/queue seams. The queued card gains one action resolved in `lib/busy-queue.js`.

**Tech Stack:** Node ≥ 22 ESM, `@modelcontextprotocol/sdk` (`McpServer.tool`), zod, raw `node:http` loopback API, vitest (`npm test`), `npm run check` syntax list.

**Spec:** `docs/superpowers/specs/2026-09-08-task-decision-tracker-design.md` (sections *Routing*, *Queued card: "Make task"*, *Agent tools*, *Error handling*, *Testing*, *Rollout*). Journal routes are defined by the journal plan (`matron-journal/docs/superpowers/plans/2026-09-08-items-tracker-journal.md`); this plan assumes they are deployed.

## Global Constraints

- Journal HTTP base URL = `deriveMediaHttpBaseUrl(JOURNAL_WS_URL)` (`lib/journal-publisher.js:126`, exported); token = the same `JOURNAL_TOKEN_FILE` / `JOURNAL_TOKEN` value `index.js:436-451` resolves. Never log the token.
- Every tool result is `{ content: [{ type: 'text', text }] }`; failures read `` `<tool> failed: ${data.error || `HTTP ${status}`}` ``; thrown errors read `` `Error: ${err.message}` ``. No `isError`.
- Every loopback handler is `(data) => { status, body }`, mounted via `respondAgentChatRoute` (`index.js:9691`).
- A session is required for every tool: 400 without `roomId`, 404 `no active session for chat <roomId>`, 409 `journal conversation not established yet — try again shortly` when `journalConvoIdFor(session)` is null.
- Synthetic item turns are injected with `skipJournalMirror: true` (the marker is already in the journal) and, while `session.busy`, queued through the same `journalQueueMedia` seam voice notes use (`index.js:8231`), with `mirrorToJournal: false`.
- `reordered` markers never produce a turn. Markers whose `sender` is not `user:*` never produce a turn (the router's loop filter).
- New `lib/*.js` files are added to the `check` script in `package.json:15`.
- Every task ends with `npm test` green and `npm run check` green.

---

## File map

| File | Responsibility |
|---|---|
| `lib/items-client.js` (create) | `createItemsClient({ baseUrl, token, fetchImpl, timeoutMs })` → `list, get, create, comment, setTranscript, close, reopen, rank`, each resolving `{ status, data }`. |
| `lib/items-tools.js` (create) | `createItemsHandlers({ sessions, journalConvoIdFor, client, uploadLocalFile })` → the seven handlers. |
| `lib/send-attachment.js` (modify) | Extract `resolveAndUploadLocalFile({ session, reqPath, publisher, maxBytes })` from the handler so item attachments reuse the path guard + upload. |
| `lib/items-turn.js` (create) | `formatItemTurn(payload, { username })` and `createItemTurnRouter({ fetchMedia, transcribe, injectBlocks, queueText, publishNotice, setTranscript })`. |
| `lib/journal-input-router.js` (modify) | `item` branch → `routeItemToSession(session, { payload, seq }, ctx)`; `QUEUED_RELEASE_ACTIONS` gains `make_task`. |
| `lib/busy-queue.js` (modify) | Card action `📌 Make task`; `resolveQueueReleaseTap` branch calling a `makeTask` seam. |
| `ask-user.js` (modify) | Seven `server.tool` registrations. |
| `index.js` (modify) | Client construction, handlers, seven routes, router wiring, item-turn router wiring, `makeTask` seam. |
| `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md` (modify) | "Tasks & decisions" section. |
| `package.json` (modify) | `check` list. |
| `test/items-client.test.js`, `test/items-tools.test.js`, `test/items-turn.test.js` (create); `test/journal-input-router.test.js`, `test/busy-queue.test.js`, `test/send-attachment.test.js` (modify) | Tests. |

---

### Task 1: `lib/items-client.js`

**Files:**
- Create: `lib/items-client.js`
- Test: `test/items-client.test.js`
- Modify: `package.json` (`check` list)

**Interfaces:**
- Produces: `createItemsClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 })` returning:
  - `list(query)` → GET `/items?…` (`query` is a plain object; `undefined`/`null` values omitted)
  - `get(idOrNum)` → GET `/items/:id` (`#12` URL-encoded)
  - `create(body, { idemKey } = {})` → POST `/items`
  - `comment(id, body, { idemKey } = {})` → POST `/items/:id/comments`
  - `setTranscript(id, commentId, { blob_ref, transcript })` → PATCH `/items/:id/comments/:cid`
  - `close(id, body)`, `reopen(id, body)`, `rank(id, body)` → POST sub-routes
  - Every method resolves `{ status, data }` where `status` is the HTTP status (or `0` for transport failure / no base URL) and `data` is the parsed JSON object (`{ error: '…' }` on failure; `{ error: 'journal unreachable' }` for status 0). Never throws.

- [ ] **Step 1: Write the failing tests**

```js
// test/items-client.test.js
import { describe, it, expect, vi } from 'vitest';
import { createItemsClient } from '../lib/items-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  });
  return { fetchImpl, calls };
}

describe('createItemsClient', () => {
  it('lists with a filtered query string and bearer auth', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { items: [], next_cursor: null } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.list({ convo: 'c1', state: 'open', kind: undefined, since: null });
    expect(r).toEqual({ status: 200, data: { items: [], next_cursor: null } });
    expect(calls[0].url).toBe('https://j/items?convo=c1&state=open');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.method).toBe('GET');
  });

  it('get URL-encodes #num', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { item: {}, comments: [] } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    await c.get('#12');
    expect(calls[0].url).toBe('https://j/items/%2312');
  });

  it('create posts JSON with an idempotency key header', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { item: { id: 'it_1', num: 1 } } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.create({ kind: 'task', title: 'T', convo_id: 'c1' }, { idemKey: 'k' });
    expect(r.status).toBe(201);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k');
    expect(JSON.parse(calls[0].init.body)).toEqual({ kind: 'task', title: 'T', convo_id: 'c1' });
  });

  it('setTranscript PATCHes the comment sub-route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { comment: {} } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    await c.setTranscript('it_1', 'ic_2', { blob_ref: 'b', transcript: 'hi' });
    expect(calls[0].url).toBe('https://j/items/it_1/comments/ic_2');
    expect(calls[0].init.method).toBe('PATCH');
  });

  it('non-2xx passes status and error body through; transport failure is status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict' } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    expect(await c.close('it_1', { resolution: 'done' })).toEqual({ status: 409, data: { error: 'conflict' } });
    const boom = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createItemsClient({ baseUrl: '', token: 'tok', fetchImpl });
    expect(await none.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/items-client.test.js`
Expected: FAIL — cannot resolve `../lib/items-client.js`.

- [ ] **Step 3: Create `lib/items-client.js`**

```js
// HTTP client for the journal's task & decision tracker routes (spec:
// 2026-09-08 task-decision-tracker, "HTTP API"). Same stance as
// journal-publisher's fetchJson — Bearer auth against the derived HTTP base
// URL, a bounded timeout — but it RETURNS the status: the tool layer needs
// to tell a 404 (no such item) from a 409 (already closed) from a 400.
// Never throws; never logs the token.
export function createItemsClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  async function request(method, path, { body = null, idemKey = null } = {}) {
    if (!base) return { status: 0, data: { error: 'journal unreachable' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { Authorization: `Bearer ${token}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!data || typeof data !== 'object') data = res.ok ? {} : { error: `HTTP ${res.status}` };
      if (!res.ok && typeof data.error !== 'string') data = { ...data, error: `HTTP ${res.status}` };
      return { status: res.status, data };
    } catch {
      return { status: 0, data: { error: 'journal unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  const enc = (s) => encodeURIComponent(String(s));
  const qs = (query) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    list: (query) => request('GET', `/items${qs(query)}`),
    get: (idOrNum) => request('GET', `/items/${enc(idOrNum)}`),
    create: (body, { idemKey = null } = {}) => request('POST', '/items', { body, idemKey }),
    comment: (id, body, { idemKey = null } = {}) => request('POST', `/items/${enc(id)}/comments`, { body, idemKey }),
    setTranscript: (id, commentId, body) => request('PATCH', `/items/${enc(id)}/comments/${enc(commentId)}`, { body }),
    close: (id, body) => request('POST', `/items/${enc(id)}/close`, { body }),
    reopen: (id, body) => request('POST', `/items/${enc(id)}/reopen`, { body }),
    rank: (id, body) => request('POST', `/items/${enc(id)}/rank`, { body }),
  };
}
```

Add `&& node --check lib/items-client.js` to the `check` script in `package.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/items-client.test.js && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/items-client.js test/items-client.test.js package.json
git commit -m "items: journal items HTTP client"
```

---

### Task 2: Extract the guarded local-file upload from `send-attachment.js`

**Files:**
- Modify: `lib/send-attachment.js:44-150`
- Test: `test/send-attachment.test.js` (existing tests must stay green; add one)

**Interfaces:**
- Produces: `export async function resolveAndUploadLocalFile({ session, reqPath, publisher, maxBytes = MAX_ATTACHMENT_BYTES })` → either `{ ok: false, status, body: { error } }` (the exact statuses the handler returns today: 400 no workdir / not a file / empty, 403 guard, 404 not found, 413 too large, 502 upload failed) or `{ ok: true, media: { blob_ref, mime, name, size, isImage } }`.
- `handleSendAttachment` keeps its behaviour and response shape; it now calls the helper and then publishes the file/image event exactly as before.

- [ ] **Step 1: Write the failing test**

Append to `test/send-attachment.test.js` (reuse its existing temp-dir + fake `publisher` fixtures; look at how the first upload test builds `publisher.uploadMedia`):

```js
import { resolveAndUploadLocalFile } from '../lib/send-attachment.js';

describe('resolveAndUploadLocalFile', () => {
  it('uploads a file inside the workdir and returns the media descriptor', async () => {
    const { dir, publisher } = await makeUploadFixture(); // same helper the handler tests use
    const r = await resolveAndUploadLocalFile({ session: { workdir: dir }, reqPath: 'shot.png', publisher });
    expect(r.ok).toBe(true);
    expect(r.media).toMatchObject({ blob_ref: expect.any(String), mime: 'image/png', name: 'shot.png', isImage: true });
    expect(publisher.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('returns the guard error shape for a path outside the workdir', async () => {
    const { dir, publisher } = await makeUploadFixture();
    const r = await resolveAndUploadLocalFile({ session: { workdir: dir }, reqPath: '/etc/hosts', publisher });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });
});
```

If no `makeUploadFixture` helper exists, extract one from the existing "uploads and publishes" test so both share it (temp dir with a small `shot.png`, `publisher = { uploadMedia: vi.fn(async () => 'blob-1'), publishAttachment: vi.fn(...) }` — copy the exact method names the handler calls).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/send-attachment.test.js`
Expected: FAIL — `resolveAndUploadLocalFile` is not exported.

- [ ] **Step 3: Refactor**

Move everything in `handleSendAttachment` from the `absWorkdir` fail-closed check through the `publisher.uploadMedia` call into the new exported function, returning `{ ok: true, media: { blob_ref: media, mime: contentType, name, size: info.size, isImage } }` at the end (keep the same variable names). Then `handleSendAttachment` becomes: parse args → session → convo resolution (unchanged) → `const up = await resolveAndUploadLocalFile({ session, reqPath, publisher, maxBytes }); if (!up.ok) return { status: up.status, body: up.body };` → build the payload from `up.media` and publish exactly as before → the same `{ status: 200, body: { ok: true, kind, name, size } }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/send-attachment.test.js`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/send-attachment.js test/send-attachment.test.js
git commit -m "send-attachment: extract resolveAndUploadLocalFile for reuse by items"
```

---

### Task 3: `lib/items-tools.js` handlers

**Files:**
- Create: `lib/items-tools.js`
- Test: `test/items-tools.test.js`
- Modify: `package.json` (`check` list)

**Interfaces:**
- Consumes: Task 1 client, Task 2 `resolveAndUploadLocalFile` (injected as `uploadLocalFile(session, path)` → same return shape).
- Produces: `createItemsHandlers({ sessions, journalConvoIdFor, client, uploadLocalFile })` → `{ create, list, get, comment, close, reopen, reorder }`, each `async (data) => { status, body }`:
  - `create(data)`: `{ roomId, kind, title, body?, labels?, links?, attachments? (local paths), awaiting?, position?, supersedes?, on_behalf_of? }`. Uploads each path via `uploadLocalFile` (first failure aborts with that status), then `client.create({ kind, title, body, labels, links, attachments: uploaded, awaiting, position, supersedes, convo_id, on_behalf_of })`. Success → `{ status: 201, body: { item } }` (status passthrough).
  - `list(data)`: `{ roomId, scope = 'convo', kind?, state = 'open', awaiting?, label?, since? }` → `client.list({ convo: scope === 'convo' ? convoId : undefined, kind, state: state === 'any' ? undefined : state, awaiting, label, since, sort: 'rank' })`. Body passthrough.
  - `get(data)`: `{ roomId, id }` → `client.get(id)`.
  - `comment(data)`: `{ roomId, id, body?, attachments? }` → upload then `client.comment`.
  - `close(data)`: `{ roomId, id, resolution, comment? }`; `reopen(data)`: `{ roomId, id, comment? }`; `reorder(data)`: `{ roomId, id, position? | after? | before? }`.
  - Validation errors → 400 with a sentence naming the field. Status 0 from the client → `{ status: 502, body: { error: 'journal unreachable' } }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/items-tools.test.js
import { describe, it, expect, vi } from 'vitest';
import { createItemsHandlers } from '../lib/items-tools.js';

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const client = {
    create: vi.fn(async () => ({ status: 201, data: { item: { id: 'it_1', num: 1 } } })),
    list: vi.fn(async () => ({ status: 200, data: { items: [], next_cursor: null } })),
    get: vi.fn(async () => ({ status: 200, data: { item: { id: 'it_1' }, comments: [] } })),
    comment: vi.fn(async () => ({ status: 201, data: { item: {}, comment: { id: 'ic_1' } } })),
    close: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    reopen: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    rank: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    ...clientOverrides,
  };
  const uploadLocalFile = vi.fn(async (_s, p) => p.endsWith('.png')
    ? { ok: true, media: { blob_ref: 'b-' + p, mime: 'image/png', name: p, size: 3, isImage: true } }
    : { ok: false, status: 404, body: { error: `file not found: ${p}` } });
  const h = createItemsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, uploadLocalFile });
  return { h, client, session, uploadLocalFile };
}

describe('items handlers', () => {
  it('create: uploads local attachments, fills convo_id, passes the body through', async () => {
    const { h, client } = fixture();
    const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Which?', body: 'A or B', attachments: ['shot.png'], labels: ['ui'] });
    expect(r.status).toBe(201);
    expect(r.body.item.num).toBe(1);
    expect(client.create.mock.calls[0][0]).toMatchObject({
      kind: 'question', title: 'Which?', body: 'A or B', convo_id: 'c1', labels: ['ui'],
      attachments: [{ blob_ref: 'b-shot.png', mime: 'image/png', name: 'shot.png', size: 3 }],
    });
  });

  it('create: a failed upload aborts with that status and never calls the journal', async () => {
    const { h, client } = fixture();
    const r = await h.create({ roomId: '!r:s', kind: 'task', title: 'T', attachments: ['nope.txt'] });
    expect(r.status).toBe(404);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('create: validates kind and title', async () => {
    const { h } = fixture();
    expect((await h.create({ roomId: '!r:s', kind: 'bug', title: 'T' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'task', title: '' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'task', title: 'x'.repeat(201) })).status).toBe(400);
  });

  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('list: scope convo filters by the session convo; scope all does not; state any drops the filter', async () => {
    const { h, client } = fixture();
    await h.list({ roomId: '!r:s' });
    expect(client.list.mock.calls[0][0]).toMatchObject({ convo: 'c1', state: 'open', sort: 'rank' });
    await h.list({ roomId: '!r:s', scope: 'all', state: 'any', awaiting: 'user' });
    expect(client.list.mock.calls[1][0].convo).toBeUndefined();
    expect(client.list.mock.calls[1][0].state).toBeUndefined();
    expect(client.list.mock.calls[1][0].awaiting).toBe('user');
    expect((await h.list({ roomId: '!r:s', scope: 'mine' })).status).toBe(400);
  });

  it('get / close / reopen / reorder pass through; journal status 0 becomes 502', async () => {
    const { h, client } = fixture({ get: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect(await h.get({ roomId: '!r:s', id: '#3' })).toEqual({ status: 502, body: { error: 'journal unreachable' } });
    expect((await h.close({ roomId: '!r:s', id: 'it_1', resolution: 'done', comment: 'shipped' })).status).toBe(200);
    expect(client.close.mock.calls[0]).toEqual(['it_1', { resolution: 'done', comment: 'shipped' }]);
    expect((await h.close({ roomId: '!r:s', id: 'it_1', resolution: 'meh' })).status).toBe(400);
    expect((await h.reopen({ roomId: '!r:s', id: 'it_1' })).status).toBe(200);
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1', position: 'top' })).status).toBe(200);
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1' })).status).toBe(400);
  });

  it('comment: requires body or attachments; uploads attachments', async () => {
    const { h, client } = fixture();
    expect((await h.comment({ roomId: '!r:s', id: 'it_1' })).status).toBe(400);
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', attachments: ['a.png'] });
    expect(r.status).toBe(201);
    expect(client.comment.mock.calls[0][1].attachments[0].blob_ref).toBe('b-a.png');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/items-tools.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/items-tools.js`**

```js
// Loopback handlers behind the item_* MCP tools (spec: Agent tools).
// HTTP-agnostic, same {status, body} contract as lib/agent-chat.js and
// lib/send-attachment.js; index.js mounts them with respondAgentChatRoute.
const KINDS = new Set(['task', 'question', 'decision']);
const RESOLUTIONS = new Set(['done', 'answered', 'decided', 'reversed', 'cancelled']);
const AWAITING = new Set(['user', 'agent']);
const TITLE_MAX = 200;
const BODY_MAX = 32768;

const bad = (error) => ({ status: 400, body: { error } });

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}

export function createItemsHandlers({ sessions, journalConvoIdFor, client, uploadLocalFile }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  async function uploadAll(session, paths) {
    if (paths === undefined) return { ok: true, attachments: [] };
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p)) return { ok: false, err: bad('attachments must be an array of file paths') };
    if (paths.length > 20) return { ok: false, err: bad('at most 20 attachments') };
    const out = [];
    for (const p of paths) {
      const r = await uploadLocalFile(session, p);
      if (!r.ok) return { ok: false, err: { status: r.status, body: r.body } };
      out.push({ blob_ref: r.media.blob_ref, mime: r.media.mime, name: r.media.name, size: r.media.size });
    }
    return { ok: true, attachments: out };
  }

  const optStr = (v, name, max) => {
    if (v === undefined) return { ok: true };
    if (typeof v !== 'string' || v.length > max) return { ok: false, err: bad(`${name} must be a string of at most ${max} characters`) };
    return { ok: true };
  };

  return {
    async create(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'task', 'question' or 'decision'");
      if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > TITLE_MAX) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optStr(data.body, 'body', BODY_MAX); if (!b.ok) return b.err;
      if (data.awaiting !== undefined && data.awaiting !== null && !AWAITING.has(data.awaiting)) return bad("awaiting must be 'user', 'agent' or null");
      if (data.position !== undefined && data.position !== 'top' && data.position !== 'bottom') return bad("position must be 'top' or 'bottom'");
      if (data.on_behalf_of !== undefined && data.on_behalf_of !== 'user') return bad("on_behalf_of may only be 'user'");
      const up = await uploadAll(session, data.attachments);
      if (!up.ok) return up.err;
      const body = { kind: data.kind, title: data.title.trim(), convo_id: convoId };
      if (data.body !== undefined) body.body = data.body;
      if (data.labels !== undefined) body.labels = data.labels;
      if (data.links !== undefined) body.links = data.links;
      if (up.attachments.length) body.attachments = up.attachments;
      if (data.awaiting !== undefined) body.awaiting = data.awaiting;
      if (data.position !== undefined) body.position = data.position;
      if (data.supersedes !== undefined) body.supersedes = data.supersedes;
      if (data.on_behalf_of !== undefined) body.on_behalf_of = data.on_behalf_of;
      return passthrough(await client.create(body, { idemKey: typeof data.idem_key === 'string' ? data.idem_key : null }));
    },

    async list(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const scope = data.scope ?? 'convo';
      if (scope !== 'convo' && scope !== 'all') return bad("scope must be 'convo' or 'all'");
      const state = data.state ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'any') return bad("state must be 'open', 'closed' or 'any'");
      if (data.kind !== undefined && !KINDS.has(data.kind)) return bad('kind is invalid');
      if (data.awaiting !== undefined && !AWAITING.has(data.awaiting)) return bad('awaiting is invalid');
      return passthrough(await client.list({
        convo: scope === 'convo' ? convoId : undefined,
        kind: data.kind, state: state === 'any' ? undefined : state, awaiting: data.awaiting,
        label: data.label, since: data.since, sort: 'rank', limit: data.limit,
      }));
    },

    async get(data) {
      const { err } = callerSession(data);
      if (err) return err;
      if (typeof data.id !== 'string' && !Number.isInteger(data.id)) return bad('id is required');
      return passthrough(await client.get(data.id));
    },

    async comment(data) {
      const { err, session } = callerSession(data);
      if (err) return err;
      if (typeof data.id !== 'string' && !Number.isInteger(data.id)) return bad('id is required');
      const b = optStr(data.body, 'body', BODY_MAX); if (!b.ok) return b.err;
      const up = await uploadAll(session, data.attachments);
      if (!up.ok) return up.err;
      const text = typeof data.body === 'string' ? data.body : '';
      if (!text.trim() && up.attachments.length === 0) return bad('body or attachments is required');
      const body = { body: text };
      if (up.attachments.length) body.attachments = up.attachments;
      return passthrough(await client.comment(data.id, body, { idemKey: typeof data.idem_key === 'string' ? data.idem_key : null }));
    },

    async close(data) {
      const { err } = callerSession(data);
      if (err) return err;
      if (typeof data.id !== 'string' && !Number.isInteger(data.id)) return bad('id is required');
      if (!RESOLUTIONS.has(data.resolution)) return bad("resolution must be one of done, answered, decided, reversed, cancelled");
      const c = optStr(data.comment, 'comment', BODY_MAX); if (!c.ok) return c.err;
      const body = { resolution: data.resolution };
      if (data.comment !== undefined) body.comment = data.comment;
      return passthrough(await client.close(data.id, body));
    },

    async reopen(data) {
      const { err } = callerSession(data);
      if (err) return err;
      if (typeof data.id !== 'string' && !Number.isInteger(data.id)) return bad('id is required');
      const c = optStr(data.comment, 'comment', BODY_MAX); if (!c.ok) return c.err;
      const body = {};
      if (data.comment !== undefined) body.comment = data.comment;
      return passthrough(await client.reopen(data.id, body));
    },

    async reorder(data) {
      const { err } = callerSession(data);
      if (err) return err;
      if (typeof data.id !== 'string' && !Number.isInteger(data.id)) return bad('id is required');
      const body = {};
      if (data.position !== undefined) {
        if (data.position !== 'top' && data.position !== 'bottom') return bad("position must be 'top' or 'bottom'");
        body.position = data.position;
      }
      if (data.after !== undefined) body.after = data.after;
      if (data.before !== undefined) body.before = data.before;
      if (Object.keys(body).length === 0) return bad('position, after or before is required');
      return passthrough(await client.rank(data.id, body));
    },
  };
}
```

Add `&& node --check lib/items-tools.js` to the `check` script.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/items-tools.test.js && npm run check`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/items-tools.js test/items-tools.test.js package.json
git commit -m "items: loopback handlers for the item_* tools"
```

---

### Task 4: Mount routes in `index.js` and register tools in `ask-user.js`

**Files:**
- Modify: `index.js` (imports near `:111`; client + handlers after the `agentChatHandlers` block at `:9558-9603`; seven routes after the `/agent-*` chain ending `:10029`)
- Modify: `ask-user.js` (seven `server.tool` blocks before the transport connect at `:612`)
- Test: none automated for the wiring itself (the handlers are covered); Step 4 is a manual smoke.

**Interfaces:**
- Routes: `POST /items/create`, `/items/list`, `/items/get`, `/items/comment`, `/items/close`, `/items/reopen`, `/items/reorder`, each `{ roomId, …tool args }` → handler.
- `itemsClient` is a module-level `const` in `index.js`, also consumed by Tasks 5–6.

- [ ] **Step 1: Wire `index.js`**

Imports:

```js
import { createItemsClient } from './lib/items-client.js';
import { createItemsHandlers } from './lib/items-tools.js';
import { resolveAndUploadLocalFile } from './lib/send-attachment.js';
import { deriveMediaHttpBaseUrl } from './lib/journal-publisher.js';
```

After `agentChatHandlers`:

```js
// Task & decision tracker (spec 2026-09-08). One client for the tools, the
// queued-card "Make task" tap, and the inbound item-turn router.
const itemsClient = createItemsClient({
  baseUrl: JOURNAL_ENABLED ? deriveMediaHttpBaseUrl(JOURNAL_WS_URL) : '',
  token: _journalToken,
});
const itemsHandlers = createItemsHandlers({
  sessions,
  journalConvoIdFor,
  client: itemsClient,
  uploadLocalFile: (session, reqPath) => resolveAndUploadLocalFile({ session, reqPath, publisher: journalPublisher }),
});
```

(`_journalToken` is the resolved token variable at `index.js:436-451`; use its real name.)

Routes, after the last `/agent-…` block:

```js
      const itemsRoute = url.pathname.match(/^\/items\/(create|list|get|comment|close|reopen|reorder)$/);
      if (itemsRoute) {
        const name = itemsRoute[1];
        await respondAgentChatRoute(res, data, itemsHandlers[name],
          (status, b) => debug(`items/${name} ${status} ${b.error || (b.item ? `#${b.item.num ?? '?'}` : `${(b.items || []).length} items`)}`));
        return;
      }
```

- [ ] **Step 2: Register the tools in `ask-user.js`**

Shared helper placed above the tools:

```js
// Item tools share one shape: POST the args to the loopback route, render
// `data.error` / `HTTP <status>` on failure, and a compact English line or
// JSON on success. JSON is fine for the agent — these are data tools.
async function callItems(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/items/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `item_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}

const itemLine = (i) => `#${i.num} [${i.kind}${i.state === 'closed' ? `, ${i.resolution}` : i.awaiting ? `, awaiting ${i.awaiting}` : ''}] ${i.title}${i.comment_count ? ` (${i.comment_count} comments)` : ''}`;
```

Tools:

```js
server.tool(
  'item_create',
  "File an item in the user's task & decision tracker (a panel beside the chat). Use kind 'question' for EACH decision you need from the user instead of listing questions in prose — the user answers in the item's own thread and you receive their reply as a message. Use 'decision' to record a choice you made yourself (put the reasoning in body). Use 'task' for work to do later. Markdown body; attach screenshots or files by local path (they are uploaded and shown inline). Returns the item id and #number.",
  {
    kind: z.enum(['task', 'question', 'decision']),
    title: z.string().describe('One line, ≤200 chars'),
    body: z.string().optional().describe('Markdown. For a question: the options and your recommendation. For a decision: what and why.'),
    attachments: z.array(z.string()).optional().describe('Local file paths inside the working directory'),
    labels: z.array(z.string()).optional(),
    links: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional().describe('e.g. a GitHub issue or PR'),
    awaiting: z.enum(['user', 'agent']).nullable().optional().describe("Who acts next. Defaults: question→user, task→agent, decision→nobody"),
    position: z.enum(['top', 'bottom']).optional().describe('Where a task lands in the ordered task list'),
    supersedes: z.string().optional().describe('Item id of a decision this one replaces'),
  },
  async (args) => callItems('create', args, (d) => `Filed item ${itemLine(d.item)} (id ${d.item.id}).`),
);

server.tool(
  'item_list',
  "List tracker items. Default: this conversation's open items in list order. scope 'all' = every conversation of this user (other agents' items too). Check this at the start of a session and before asking the user for decisions.",
  {
    scope: z.enum(['convo', 'all']).optional(),
    kind: z.enum(['task', 'question', 'decision']).optional(),
    state: z.enum(['open', 'closed', 'any']).optional(),
    awaiting: z.enum(['user', 'agent']).optional(),
    label: z.string().optional(),
    since: z.number().int().optional().describe('Only items updated at/after this ms timestamp — cheap polling'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async (args) => callItems('list', args, (d) => d.items.length
    ? d.items.map(itemLine).join('\n') + (d.next_cursor ? '\n(more available — narrow the filters)' : '')
    : 'No items match.'),
);

server.tool(
  'item_get',
  'Read one item with its full comment thread (the user\'s answers, attachments, transcripts, status changes).',
  { id: z.string().describe("Item id ('it_…') or '#12'") },
  async (args) => callItems('get', args, (d) => JSON.stringify({ item: d.item, comments: d.comments }, null, 2)),
);

server.tool(
  'item_comment',
  'Add a comment to an item (text and/or attachments by local path). Does not change who the item is awaiting; use item_close when acted on.',
  { id: z.string(), body: z.string().optional(), attachments: z.array(z.string()).optional() },
  async (args) => callItems('comment', args, (d) => `Commented on #${d.item.num}.`),
);

server.tool(
  'item_close',
  "Close an item with a resolution: 'answered' (a question you have acted on), 'done'/'cancelled' (task), 'decided' or 'reversed' (decision). Optional closing comment.",
  { id: z.string(), resolution: z.enum(['done', 'answered', 'decided', 'reversed', 'cancelled']), comment: z.string().optional() },
  async (args) => callItems('close', args, (d) => `Closed #${d.item.num} as ${d.item.resolution}.`),
);

server.tool(
  'item_reopen',
  'Reopen a closed item, with an optional comment.',
  { id: z.string(), comment: z.string().optional() },
  async (args) => callItems('reopen', args, (d) => `Reopened #${d.item.num} (awaiting ${d.item.awaiting ?? 'nobody'}).`),
);

server.tool(
  'item_reorder',
  'Move a task in the ordered list: to the top/bottom, or after/before another item id.',
  { id: z.string(), position: z.enum(['top', 'bottom']).optional(), after: z.string().optional(), before: z.string().optional() },
  async (args) => callItems('reorder', args, (d) => `Moved #${d.item.num}.`),
);
```

- [ ] **Step 3: Syntax + full tests**

Run: `npm run check && npm test`
Expected: PASS.

- [ ] **Step 4: Manual smoke against a running journal**

With a journal that has the items routes, start the bridge, open a session, and in the chat ask the agent: "Use item_create to file a question titled Smoke?". Confirm the app shows the marker/card and `item_list` returns it. If the journal is older, `item_create` must answer `item_create failed: HTTP 404` (not a stack trace).

- [ ] **Step 5: Commit**

```bash
git add index.js ask-user.js
git commit -m "items: item_* MCP tools and loopback routes"
```

---

### Task 5: Inbound `item` markers → synthetic turn (`lib/items-turn.js` + router branch)

**Files:**
- Create: `lib/items-turn.js`
- Modify: `lib/journal-input-router.js` (`:22` types, `:201-230` deps, `:521-527` gate, new branch between the text and media branches at `:619-621`), `index.js` (wiring next to `journalMediaRouter` at `:8144`; consumer deps at `:9205+`)
- Test: `test/items-turn.test.js` (new), `test/journal-input-router.test.js` (append)
- Modify: `package.json` (`check` list)

**Interfaces:**
- `formatItemTurn(payload, { username })` → string or `null` (for `reordered`, or a payload with no `item_id`/`num`/`title`). Exact text for `commented`:

  ```
  📌 Item #12 "Which auth library?" — dan replied:
  use the one we already have in the monorepo
  [voice note v.m4a — transcript: …]           ← one line per attachment; "(transcription failed)" / "(no transcript)" when absent
  (question, now awaiting: agent. item_get it_… for the full thread; item_close when acted on.)
  ```
  For `created` (by user): `📌 dan filed a new task #13 "…":` + body (if the marker carries `comment.body`, which the journal fills with the item body for user-created items — see note) + trailer. For `closed`: `📌 dan closed item #12 "…" as reversed.` + comment. For `reopened`: `📌 dan reopened item #12 "…":` + comment + trailer.
- `createItemTurnRouter({ fetchMedia, transcribe, injectBlocks, queueText, publishNotice, setTranscript, log })` → `async (session, { payload }, ctx)`. Steps: `formatItemTurn` → null ⇒ return. For each `comment.attachments[]` with `mime` starting `audio/` and no `transcript`: `fetchMedia(blob_ref)` → `transcribe(buffer, mime)` → on success `setTranscript(item_id, comment.id, { blob_ref, transcript })` (best effort) and substitute the line; on failure substitute "(transcription failed)". Then, if `session.busy` → `queueText(session, { text, preview: `📌 #${num} ${title}` })`; else `injectBlocks(session, [{ type: 'text', text }])`; if that returns false → `publishNotice(convoId, "Couldn't deliver your item reply — the session isn't available.")`.
- Router: `routeItemToSession(session, { payload, seq }, ctx)` dep; `ITEM_TYPE = 'item'` is an input type only when the seam is wired (same pattern as media).

Note on `created` markers: the journal marker for `created` carries no `comment`. The bridge needs the body for a user-filed task, so the router fetches it: `createItemTurnRouter` also takes `getItem(id)` (wired to `itemsClient.get`) and, for `action === 'created'`, uses `item.body` from the fetched item when the marker has no comment. If the fetch fails, the turn still goes out with the title only.

- [ ] **Step 1: Write the failing tests**

```js
// test/items-turn.test.js
import { describe, it, expect, vi } from 'vitest';
import { formatItemTurn, createItemTurnRouter } from '../lib/items-turn.js';

const base = { item_id: 'it_1', num: 12, kind: 'question', title: 'Which auth library?', by: 'user', awaiting: 'agent', resolution: null };

describe('formatItemTurn', () => {
  it('renders a user reply with the comment body and a trailer', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { id: 'ic_1', body: 'use A', attachments: [] } }, { username: 'dan' });
    expect(t).toBe('📌 Item #12 "Which auth library?" — dan replied:\nuse A\n(question, now awaiting: agent. item_get it_1 for the full thread; item_close when acted on.)');
  });
  it('renders attachment lines with transcript / missing transcript', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { id: 'ic_1', body: '', attachments: [
      { blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 1, transcript: 'hello there' },
      { blob_ref: 'b2', mime: 'image/png', name: 'p.png', size: 1, transcript: null },
    ] } }, { username: 'dan' });
    expect(t).toContain('[voice note v.m4a — transcript: hello there]');
    expect(t).toContain('[attachment p.png (image/png) — item_get shows it]');
  });
  it('closed / reopened / created shapes', () => {
    expect(formatItemTurn({ ...base, action: 'closed', resolution: 'reversed', awaiting: null, comment: { id: 'c', body: 'no', attachments: [] } }, { username: 'dan' }))
      .toBe('📌 dan closed item #12 "Which auth library?" as reversed.\nno');
    expect(formatItemTurn({ ...base, kind: 'task', action: 'created', awaiting: 'agent' }, { username: 'dan', body: 'do it' }))
      .toBe('📌 dan filed a new task #12 "Which auth library?":\ndo it\n(task, now awaiting: agent. item_get it_1 for the full thread; item_close when acted on.)');
    expect(formatItemTurn({ ...base, action: 'reopened', comment: { id: 'c', body: 'again', attachments: [] } }, { username: 'dan' }))
      .toContain('📌 dan reopened item #12');
  });
  it('returns null for reordered and for malformed payloads', () => {
    expect(formatItemTurn({ ...base, action: 'reordered' }, { username: 'dan' })).toBeNull();
    expect(formatItemTurn({ action: 'commented' }, { username: 'dan' })).toBeNull();
  });
});

describe('createItemTurnRouter', () => {
  function fixture(over = {}) {
    const deps = {
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => 'spoken words'),
      injectBlocks: vi.fn(() => true),
      queueText: vi.fn(async () => {}),
      publishNotice: vi.fn(),
      setTranscript: vi.fn(async () => ({ status: 200, data: {} })),
      getItem: vi.fn(async () => ({ status: 200, data: { item: { body: 'fetched body' }, comments: [] } })),
      log: { warn: () => {}, error: () => {} },
      ...over,
    };
    return { deps, route: createItemTurnRouter(deps) };
  }

  it('injects immediately when idle, skipping the journal mirror', async () => {
    const { deps, route } = fixture();
    await route({ busy: false, journalConvoId: 'c1' }, { payload: { ...base, action: 'commented', comment: { id: 'ic', body: 'use A', attachments: [] } } }, { username: 'dan' });
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1][0].text).toContain('dan replied');
    expect(deps.queueText).not.toHaveBeenCalled();
  });

  it('queues while busy with a short preview', async () => {
    const { deps, route } = fixture();
    await route({ busy: true }, { payload: { ...base, action: 'commented', comment: { id: 'ic', body: 'x', attachments: [] } } }, { username: 'dan' });
    expect(deps.queueText).toHaveBeenCalledTimes(1);
    expect(deps.queueText.mock.calls[0][1]).toMatchObject({ preview: '📌 #12 Which auth library?' });
    expect(deps.injectBlocks).not.toHaveBeenCalled();
  });

  it('transcribes audio attachments, writes the transcript back, and puts it in the turn', async () => {
    const { deps, route } = fixture();
    await route({ busy: false }, { payload: { ...base, action: 'commented', comment: { id: 'ic', body: '', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 1, transcript: null }] } } }, { username: 'dan' });
    expect(deps.fetchMedia).toHaveBeenCalledWith('b1');
    expect(deps.setTranscript).toHaveBeenCalledWith('it_1', 'ic', { blob_ref: 'b1', transcript: 'spoken words' });
    expect(deps.injectBlocks.mock.calls[0][1][0].text).toContain('transcript: spoken words');
  });

  it('a failed transcription still delivers the turn', async () => {
    const { deps, route } = fixture({ transcribe: vi.fn(async () => { throw new Error('no whisper'); }) });
    await route({ busy: false }, { payload: { ...base, action: 'commented', comment: { id: 'ic', body: '', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 1 }] } } }, { username: 'dan' });
    expect(deps.injectBlocks.mock.calls[0][1][0].text).toContain('(transcription failed)');
    expect(deps.setTranscript).not.toHaveBeenCalled();
  });

  it('created markers fetch the item body; reordered markers do nothing', async () => {
    const { deps, route } = fixture();
    await route({ busy: false }, { payload: { ...base, kind: 'task', action: 'created' } }, { username: 'dan' });
    expect(deps.getItem).toHaveBeenCalledWith('it_1');
    expect(deps.injectBlocks.mock.calls[0][1][0].text).toContain('fetched body');
    await route({ busy: false }, { payload: { ...base, action: 'reordered' } }, { username: 'dan' });
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
  });

  it('an undeliverable turn publishes a notice', async () => {
    const { deps, route } = fixture({ injectBlocks: vi.fn(() => false) });
    await route({ busy: false, journalConvoId: 'c1' }, { payload: { ...base, action: 'commented', comment: { id: 'ic', body: 'x', attachments: [] } } }, { username: 'dan' });
    expect(deps.publishNotice).toHaveBeenCalledWith('c1', expect.stringContaining("Couldn't deliver"));
  });
});
```

Append to `test/journal-input-router.test.js` inside `describe('createJournalInputConsumer')`:

```js
  it('routes a user item marker to routeItemToSession when the seam is wired, and ignores it otherwise', () => {
    const payload = { item_id: 'it_1', num: 1, kind: 'question', title: 'Q', action: 'commented', by: 'user', awaiting: 'agent', resolution: null, comment: { id: 'ic', body: 'x', attachments: [] } };
    const deps = makeDeps({ routeItemToSession: vi.fn() });
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ type: 'item', seq: 7, payload }));
    expect(deps.routeItemToSession).toHaveBeenCalledTimes(1);
    const [session, item, ctx] = deps.routeItemToSession.mock.calls[0];
    expect(session).toEqual({ claudeSessionId: 'convo-1' });
    expect(item).toEqual({ payload, seq: 7 });
    expect(ctx).toEqual({ username: 'dan' });
    // agent-authored marker (the bridge's own API write echo): dropped
    consumer(baseFrame({ type: 'item', sender: 'agent:dev-2', payload }));
    expect(deps.routeItemToSession).toHaveBeenCalledTimes(1);
    // unwired seam: pass-through
    const bare = createJournalInputConsumer(makeDeps());
    bare(baseFrame({ type: 'item', payload }));
    expect(bare).toBeTypeOf('function');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/items-turn.test.js test/journal-input-router.test.js`
Expected: FAIL — module missing; router test: `routeItemToSession` never called.

- [ ] **Step 3: Create `lib/items-turn.js`**

```js
// Inbound side of the tracker (spec: Routing). A user-authored 'item' marker
// on a conversation this bridge owns becomes one synthetic user turn, so the
// agent hears the answer without a round trip. Everything I/O-shaped is
// injected (same discipline as lib/journal-media.js).
const TRAILER = (p) => `(${p.kind}, now awaiting: ${p.awaiting ?? 'nobody'}. item_get ${p.item_id} for the full thread; item_close when acted on.)`;

function attachmentLine(a) {
  const isAudio = typeof a.mime === 'string' && a.mime.startsWith('audio/');
  if (isAudio) {
    if (a.transcript === '(transcription failed)') return `[voice note ${a.name} — (transcription failed)]`;
    return a.transcript ? `[voice note ${a.name} — transcript: ${a.transcript}]` : `[voice note ${a.name} — (no transcript)]`;
  }
  return `[attachment ${a.name} (${a.mime}) — item_get shows it]`;
}

export function formatItemTurn(payload, { username, body = null } = {}) {
  const p = payload && typeof payload === 'object' ? payload : null;
  if (!p || typeof p.item_id !== 'string' || !Number.isInteger(p.num) || typeof p.title !== 'string') return null;
  if (p.action === 'reordered') return null;
  const who = username || 'the user';
  const head = `#${p.num} "${p.title}"`;
  const comment = p.comment && typeof p.comment === 'object' ? p.comment : null;
  const lines = [];
  if (comment && typeof comment.body === 'string' && comment.body.trim()) lines.push(comment.body.trim());
  for (const a of Array.isArray(comment?.attachments) ? comment.attachments : []) lines.push(attachmentLine(a));
  if (p.action === 'closed') {
    return [`📌 ${who} closed item ${head} as ${p.resolution ?? 'closed'}.`, ...lines].join('\n');
  }
  if (p.action === 'created') {
    if (!lines.length && typeof body === 'string' && body.trim()) lines.push(body.trim());
    return [`📌 ${who} filed a new ${p.kind} ${head}:`, ...lines, TRAILER(p)].join('\n');
  }
  if (p.action === 'reopened') {
    return [`📌 ${who} reopened item ${head}:`, ...lines, TRAILER(p)].join('\n');
  }
  return [`📌 Item ${head} — ${who} replied:`, ...lines, TRAILER(p)].join('\n');
}

export function createItemTurnRouter({ fetchMedia, transcribe, injectBlocks, queueText, publishNotice, setTranscript, getItem = null, log = console }) {
  const warn = (m) => { try { log.warn(m); } catch { /* never throw */ } };

  async function transcribeAudio(payload) {
    const comment = payload.comment;
    if (!comment || !Array.isArray(comment.attachments)) return payload;
    const attachments = [];
    for (const a of comment.attachments) {
      const isAudio = typeof a?.mime === 'string' && a.mime.startsWith('audio/');
      if (!isAudio || (typeof a.transcript === 'string' && a.transcript)) { attachments.push(a); continue; }
      let transcript = null;
      try {
        const fetched = await fetchMedia(a.blob_ref);
        if (fetched?.buffer) transcript = await transcribe(fetched.buffer, a.mime);
      } catch (e) {
        warn(`[items-turn] transcription failed for ${a.blob_ref}: ${e?.message ?? e}`);
      }
      if (transcript && String(transcript).trim()) {
        transcript = String(transcript).trim();
        try { await setTranscript(payload.item_id, comment.id, { blob_ref: a.blob_ref, transcript }); }
        catch (e) { warn(`[items-turn] transcript write-back failed: ${e?.message ?? e}`); }
        attachments.push({ ...a, transcript });
      } else {
        attachments.push({ ...a, transcript: '(transcription failed)' });
      }
    }
    return { ...payload, comment: { ...comment, attachments } };
  }

  return async function routeItemToSession(session, { payload }, ctx = {}) {
    if (!payload || payload.action === 'reordered') return;
    let enriched = await transcribeAudio(payload);
    let body = null;
    if (enriched.action === 'created' && !enriched.comment && typeof getItem === 'function') {
      try {
        const r = await getItem(enriched.item_id);
        if (r?.status === 200 && typeof r.data?.item?.body === 'string') body = r.data.item.body;
      } catch (e) { warn(`[items-turn] item fetch failed: ${e?.message ?? e}`); }
    }
    const text = formatItemTurn(enriched, { username: ctx.username, body });
    if (!text) return;
    if (session?.busy) {
      await queueText(session, { text, preview: `📌 #${enriched.num} ${enriched.title}` });
      return;
    }
    if (!injectBlocks(session, [{ type: 'text', text }])) {
      publishNotice(session?.journalConvoId ?? session?.claudeSessionId ?? null, "Couldn't deliver your item reply — the session isn't available.");
    }
  };
}
```

- [ ] **Step 4: Router branch**

In `lib/journal-input-router.js`:

- Add `routeItemToSession = null,` to the destructured deps (after `routeMediaToSession`), and document it in the comment block above.
- At the gate (`:521-527`) add `const isItem = type === 'item' && typeof routeItemToSession === 'function';` and change the guard to `if (!INPUT_TYPES.has(type) && !isMedia && !isItem) return;`.
- At the room carve-out (`:459`) widen to `if (!INPUT_TYPES.has(type) && !MEDIA_TYPES.has(type) && type !== 'item') return;` so a marker on a room convo the bridge owns still routes (it is filtered by the `user:` rule like everything else).
- Insert between the text branch and `if (isMedia)`:

```js
      if (isItem) {
        // A tracker marker the user wrote (comment / filed task / close /
        // reopen). The route builds the synthetic turn; a reorder is dropped
        // there (spec: reorders never produce a turn).
        routeItemToSession(session, { payload, seq: frame.seq }, ctx);
        return;
      }
```

- [ ] **Step 5: Wire `index.js`**

Next to `journalMediaRouter`:

```js
const itemTurnRouter = createItemTurnRouter({
  fetchMedia: (blobRef) => journalPublisher.fetchMedia(blobRef),
  transcribe: (buffer, mime) => transcribeAudio(buffer, mime, { modelPath: WHISPER_MODEL_PATH, language: WHISPER_LANGUAGE }),
  // No journal mirror: the marker is already the durable record.
  injectBlocks: (session, blocks) => sendToSession(session, blocks, { skipJournalMirror: true }),
  queueText: (session, { text, preview }) => journalQueueMedia(session, {
    blocks: [{ type: 'text', text }], mirrorToJournal: false, preview, fullText: text,
  }),
  publishNotice: journalPublishNotice,
  setTranscript: (id, cid, body) => itemsClient.setTranscript(id, cid, body),
  getItem: (id) => itemsClient.get(id),
  log: console,
});
```

and in the `createJournalInputConsumer({...})` call add `routeItemToSession: (session, item, ctx) => { session._agentRestartCount = 0; itemTurnRouter(session, item, ctx).catch((e) => console.warn(`[items-turn] ${e?.message ?? e}`)); },`.

Add `import { createItemTurnRouter } from './lib/items-turn.js';` and `&& node --check lib/items-turn.js` to `check`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/items-turn.test.js test/journal-input-router.test.js && npm run check && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/items-turn.js lib/journal-input-router.js index.js package.json test/items-turn.test.js test/journal-input-router.test.js
git commit -m "items: user item markers become a synthetic turn (queued while busy, voice notes transcribed)"
```

---

### Task 6: Queued card "📌 Make task"

**Files:**
- Modify: `lib/busy-queue.js` (`:363-373` actions; `resolveQueueReleaseTap` — new branch before `if (value !== 'cancel') return false;`), `lib/journal-input-router.js:28` (`QUEUED_RELEASE_ACTIONS`), `index.js:8284` (tap call site: pass `makeTask`)
- Test: `test/busy-queue.test.js` (append), `test/journal-input-router.test.js` (one assertion)

**Interfaces:**
- Card actions become `[send, (send_one), make_task, cancel]` with `make_task` = `{ id: 'make_task', label: '📌 Make task', intent: 'neutral' }`. Only offered when `allowMakeTask` (new option, default `false`; `index.js` passes `true` for journal-origin text and voice entries, `false` for file/image entries).
- `resolveQueueReleaseTap` gains a dep `makeTask: async (session, { text }) => ({ ok: true, num, id }) | { ok: false, error })`. Branch: resolve the tapped item id → index (same lookup as `send_one`); require the entry to be text-only blocks (`entry.every(b => b.type === 'text')`), else treat as stale (return `true`); `detachQueuedAt`; call `makeTask` with the joined text; on `ok` → `cancelQueuedItem`-style release for the card (reuse `cancelQueuedItem(session, { itemId, promptId, convoId, queueRelease, emitRelease })` **after** the detach — read `cancelQueuedItem` first: if it splices by id itself, call it instead of `detachQueuedAt` and skip the manual detach) and `notify(`📌 Filed as task #${num}. The agent will be told when this turn ends.`)`; on failure → `restoreDetachedQueueItem` and `notify(`Couldn't file that as a task (${error}). It is still queued.`)`.
- `makeTask` in `index.js`: `itemsClient.create({ kind: 'task', title: firstLine(text).slice(0, 200), body: rest, convo_id: journalConvoIdFor(session), on_behalf_of: 'user' })` → `{ ok: true, num, id }` on 201, else `{ ok: false, error }`. The journal's `created` marker (by 'user', sender agent) is dropped by the router's `user:` filter, so the bridge queues the agent's notification itself: `journalQueueMedia(session, { blocks: [{ type: 'text', text: formatItemTurn({...}) }], mirrorToJournal: false, preview: `📌 #${num} filed`, fullText })` — using the same `formatItemTurn` as Task 5 with `action: 'created'`, `by: 'user'`, and the body.

- [ ] **Step 1: Write the failing tests**

Append to `test/busy-queue.test.js`:

```js
describe('make_task', () => {
  it('the card offers 📌 Make task when allowed', async () => {
    const session = makeSession({ queuedMessages: [], queueNotifications: [] });
    const deps = matrixDeps();
    const sendButtonMessage = vi.fn(async () => {});
    session.sendButtonMessage = sendButtonMessage;
    await notifyQueuedMessage(session, 'hello', { ...deps, queueRelease: { noteQueued: vi.fn() }, convoId: 'c1', allowMakeTask: true });
    const payload = sendButtonMessage.mock.calls[0][5];
    expect(payload.actions.map((a) => a.id)).toEqual(['send', 'make_task', 'cancel']);
    const without = vi.fn(async () => {});
    session.sendButtonMessage = without;
    await notifyQueuedMessage(session, 'hello', { ...deps, queueRelease: { noteQueued: vi.fn() }, convoId: 'c1' });
    expect(without.mock.calls[0][5].actions.map((a) => a.id)).toEqual(['send', 'cancel']);
  });

  it('a make_task tap files the tapped text, retires the card, and notifies; failure restores the item', async () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'Refactor the auth module\nkeep the public API' }], [{ type: 'text', text: 'second' }]],
      queueNotifications: [{ eventId: null, plain: 'p1', id: 'pr_1::0' }, { eventId: null, plain: 'p2', id: 'pr_2::0' }],
    });
    const makeTask = vi.fn(async () => ({ ok: true, num: 7, id: 'it_7' }));
    const notify = vi.fn();
    const emitRelease = vi.fn();
    const handled = resolveQueueReleaseTap('make_task', session, {
      ...matrixDeps(), entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0'] }, convoId: 'c1',
      queueRelease: { listLive: () => [], resolve: vi.fn() }, emitRelease, notify, makeTask,
    });
    expect(handled).toBe(true);
    await vi.waitFor(() => expect(makeTask).toHaveBeenCalledTimes(1));
    expect(makeTask.mock.calls[0][1]).toEqual({ text: 'Refactor the auth module\nkeep the public API' });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('Filed as task #7')));
    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'second' }]]);
    expect(session.queueNotifications.map((n) => n.id)).toEqual(['pr_2::0']);

    const failing = vi.fn(async () => ({ ok: false, error: 'journal unreachable' }));
    const notify2 = vi.fn();
    resolveQueueReleaseTap('make_task', session, {
      ...matrixDeps(), entry: { prompt_id: 'pr_2', itemIds: ['pr_2::0'] }, convoId: 'c1',
      queueRelease: { listLive: () => [], resolve: vi.fn() }, emitRelease, notify: notify2, makeTask: failing,
    });
    await vi.waitFor(() => expect(notify2).toHaveBeenCalledWith(expect.stringContaining('still queued')));
    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'second' }]]);
  });
});
```

Check the real `cancelQueuedItem` / `queueRelease` shapes in the existing `cancel` tests (`grep -n "cancelQueuedItem" test/busy-queue.test.js`) and give the fake `queueRelease` the same methods those tests use.

In `test/journal-input-router.test.js`, find the test that pins `QUEUED_RELEASE_ACTIONS` (grep `send_one`) and add `'make_task'` to its expected set.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/busy-queue.test.js test/journal-input-router.test.js`
Expected: FAIL — actions lack `make_task`; the tap returns `false`.

- [ ] **Step 3: Implement**

`lib/busy-queue.js`:

- `notifyQueuedMessage` options gain `allowMakeTask = false`. Build actions as: `send`, then `send_one` if `multi`, then `{ id: 'make_task', label: '📌 Make task', intent: 'neutral' }` if `allowMakeTask`, then `cancel`.
- `resolveQueueReleaseTap` deps gain `makeTask = null`. Insert before `if (value !== 'cancel') return false;`:

```js
    // "Make task" — file the tapped message in the tracker instead of
    // sending it (spec: Queued card). Async by necessity (a journal write);
    // the tap is acknowledged synchronously and the outcome lands as a
    // notice. The card retires through the same cancel release as a cancel
    // tap — from the queue's point of view the message left without being
    // sent — but only AFTER the journal accepted the item, so a failure
    // leaves the message queued and the card live.
    if (value === 'make_task') {
      if (typeof makeTask !== 'function') return false;
      const tappedId = Array.isArray(entry.itemIds) ? entry.itemIds[0] : null;
      const queue = session.queuedMessages;
      const notifs = session.queueNotifications;
      if (!tappedId || !Array.isArray(queue) || !Array.isArray(notifs)) return true;
      const index = notifs.findIndex(notification => notification?.id === tappedId);
      if (index < 0 || index >= queue.length) return true;
      if (!queue[index].every(b => b && b.type === 'text')) return true; // media entries never offered the action
      const text = queue[index].map(b => b.text).join('\n');
      const { blocks, notification } = detachQueuedAt(session, index);
      Promise.resolve(makeTask(session, { text })).then((r) => {
        if (r && r.ok) {
          cancelQueuedItem(session, { itemId: tappedId, promptId: entry.prompt_id, convoId, queueRelease, emitRelease });
          if (typeof notify === 'function') notify(`📌 Filed as task #${r.num}. The agent will be told when this turn ends.`);
        } else {
          restoreDetachedQueueItem(session, { index, blocks, notification });
          if (typeof notify === 'function') notify(`Couldn't file that as a task (${r?.error || 'unknown error'}). It is still queued.`);
        }
      }).catch((e) => {
        restoreDetachedQueueItem(session, { index, blocks, notification });
        if (typeof notify === 'function') notify(`Couldn't file that as a task (${e?.message || e}). It is still queued.`);
      });
      return true;
    }
```

Read `cancelQueuedItem` (`:462-468`) before wiring: if it splices the queue by item id itself, the detach above must happen **after** the journal write instead (so: on success call `cancelQueuedItem` without a prior detach; on failure do nothing). Pick whichever keeps the queue arrays consistent and make the test above match.

`lib/journal-input-router.js:28`: `const QUEUED_RELEASE_ACTIONS = new Set(['send', 'send_one', 'make_task', 'cancel']);`

`index.js`:

- At the tap call site (`:8284`) add:

```js
      makeTask: async (session, { text }) => {
        const convoId = journalConvoIdFor(session);
        const nl = text.indexOf('\n');
        const title = (nl < 0 ? text : text.slice(0, nl)).trim().slice(0, 200) || 'Task';
        const body = nl < 0 ? '' : text.slice(nl + 1).trim();
        const r = await itemsClient.create({ kind: 'task', title, body, convo_id: convoId, on_behalf_of: 'user' });
        if (r.status !== 201 && r.status !== 200) return { ok: false, error: r.data?.error || `HTTP ${r.status}` };
        const item = r.data.item;
        // The journal's own 'created' marker carries our agent sender, so the
        // router drops it; queue the agent's heads-up here instead.
        const turn = formatItemTurn({ item_id: item.id, num: item.num, kind: 'task', title: item.title, action: 'created', by: 'user', awaiting: item.awaiting ?? 'agent', resolution: null }, { username: session.journalUsername || 'the user', body });
        await journalQueueMedia(session, { blocks: [{ type: 'text', text: turn }], mirrorToJournal: false, preview: `📌 #${item.num} filed`, fullText: turn });
        return { ok: true, num: item.num, id: item.id };
      },
```

  (`session.journalUsername` — if no such field exists, pass the `ctx.username` captured when the tap's `prompt_reply` was routed; check `journalOnPromptReply`'s signature at `index.js:9220` and thread `username` through if needed.)

- Where journal text is queued (`index.js:7936-7996`) and in `journalQueueMedia`, pass `allowMakeTask: true` for text and voice-note entries (`mirrorToJournal: true` ones) and `false` for saved file/image entries. Import `formatItemTurn` from `./lib/items-turn.js`.

- [ ] **Step 4: Run tests**

Run: `npm run check && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/busy-queue.js lib/journal-input-router.js index.js test/busy-queue.test.js test/journal-input-router.test.js
git commit -m "items: 📌 Make task on the queued card files the message as a task and queues the agent's heads-up"
```

---

### Task 7: System prompt guidance and deploy notes

**Files:**
- Modify: `BRIDGE_CLAUDE.md` (new `## Tasks & decisions` section after `## Agent-to-agent chat`), `BRIDGE_CODEX.md` (matching section using the HTTP routes, since Codex has no MCP tools here)
- Modify: `README.md` or `docs/` deploy notes if a "journal version required" list exists (grep `journal` in `README.md`)

- [ ] **Step 1: Write the section**

`BRIDGE_CLAUDE.md`:

```markdown
## Tasks & decisions (`item_*` tools)

The user has a task & decision tracker beside the chat. Use it instead of prose lists:

- **Need a decision?** File one `item_create` with `kind: "question"` per decision, with the options and your recommendation in `body`, attaching screenshots by path. Then say in chat which items you're waiting on (`#12, #13`) and continue with what doesn't depend on them. The user answers in the item's thread; the reply reaches you as a message starting `📌 Item #N`. Read the full thread with `item_get` if you need it, act, then `item_close` with `resolution: "answered"`.
- **Made a call yourself?** Record it: `kind: "decision"`, the what and the why in `body`. If the user later challenges it (a `📌` reply on that item), either close it as `reversed` and file the replacement with `supersedes`, or comment and keep it.
- **Work for later** goes in as `kind: "task"`; close with `done` or `cancelled`. Tasks the user files reach you as `📌 dan filed a new task`.
- At the start of a session, and before asking the user anything, run `item_list` (and `item_list` with `scope: "all"` when picking up work from another session) — the answer may already be there.
- Items are shared by every session of this user. Refer to them by `#number`. Do not paste an item's contents back into chat; link it by number.
- This replaces "put it in a GitHub issue": use `links` on an item when an issue or PR exists.
```

`BRIDGE_CODEX.md`: the same guidance, phrased as `curl` calls against `${JOURNAL_HTTP_BASE}/items` with the agent token file (`Authorization: Bearer $(cat "$JOURNAL_TOKEN_FILE")`), mirroring the existing "Journal history" section's style. Include one create example and one list example.

- [ ] **Step 2: Verify the prompt still loads**

Run: `node -e "import('./index.js').catch(e=>{console.error(e.message);process.exit(1)})" --input-type=module 2>&1 | head -3` is too heavy (index.js starts the bridge). Instead: `node -e "const fs=require('fs');const s=fs.readFileSync('BRIDGE_CLAUDE.md','utf8');if(!s.includes('item_create'))process.exit(1);console.log('ok', s.length)"`
Expected: `ok <bytes>`.

- [ ] **Step 3: Commit and open the PR**

```bash
git add BRIDGE_CLAUDE.md BRIDGE_CODEX.md
git commit -m "items: tell the agent when to use the tracker"
git push -u origin items-tracker
gh pr create --title "Items: task & decision tracker (bridge side)" --body "$(cat <<'EOF'
Implements the bridge half of docs/superpowers/specs/2026-09-08-task-decision-tracker-design.md:
- item_create / item_list / item_get / item_comment / item_close / item_reopen / item_reorder MCP tools over the journal's /items routes
- user item markers → synthetic `📌` turn (queued while busy; voice-note attachments transcribed and written back)
- 📌 Make task action on the queued card (files the message as a user-created task, agent hears at turn end)
- system-prompt guidance

Requires matron-journal with the items routes deployed first (older journals: tools answer `HTTP 404`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

- **Agent tools** → Tasks 3–4 (all seven; descriptions steer usage; local-path attachments uploaded through the guarded path from Task 2).
- **Routing** → Task 5 (synthetic turn text, busy-queue deferral via `journalQueueMedia`, transcription + write-back, `reordered` dropped, own echoes dropped by the `user:` filter, undeliverable → notice).
- **Queued card "Make task"** → Task 6 (action, tap resolution, `on_behalf_of: 'user'`, heads-up queued for turn end, failure leaves the message queued).
- **Error handling** → status passthrough with `HTTP 404` on an old journal (Task 1/3/4), transcription failure still delivers (Task 5).
- **System prompt** → Task 7.
- **Rollout** → journal first; PR body says so.
- Open detail deliberately left to the executor with a stated check: whether `cancelQueuedItem` splices by id (Task 6 Step 3) and the username source for the tap path (Task 6 Step 3).
