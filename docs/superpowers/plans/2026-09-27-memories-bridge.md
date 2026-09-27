# Memories (bridge half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every session `memory_save` / `memory_list` / `memory_get` / `memory_delete` MCP tools backed by the journal's `/memories` routes, and put the memory index into the Coordinator's instructions at every spawn and on every live `assigned` turn.

**Architecture:** Same three-layer shape as items and missions: `ask-user.js` tools POST to the bridge loopback, `lib/memory-tools.js` handlers validate and call `lib/memory-client.js`, which talks to the journal. A cached `lib/memory-lookup.js` (the `createCoordinatorLookup` pattern) holds the user's memories; `lib/coordinator.js` renders them into a block that `claudeCoordinatorArgs`, `codexCoordinatorOptions` and `coordinatorTurnText` append after the Coordinator brief. The router gains an `onMemoryEvent` seam so a `memory` marker forces a refresh.

**Tech Stack:** Node ≥22 ESM, vitest 5 (`npx vitest run <file>`), eslint (`npm run lint`), zod in `ask-user.js`. No new dependencies.

**Spec:** matron-journal `docs/superpowers/specs/2026-09-27-memories-design.md` (Bridge section). Journal PR: Matronhq/matron-journal#94.

## Global Constraints

- Worktree `~/matron-bridge-memories`, branch `feat/memories`. `~/matron-bridge` is the LIVE bridge on this box — never edit it.
- Journal contract (PR #94): `GET /memories` → `{memories}`; `GET /memories/:key` → `{memory}`; `PUT /memories/:name` `{description, body?, type?, convo_id?}` → 201 created / 200 updated `{memory}`, 400 `bad_request`, 404 `not_found`, 409 `too_many`; `DELETE /memories/:key` → 200 `{memory}`. Marker type `memory`, payload `{memory_id, action, created, by, name?, type?, description?}`.
- Validation mirrored from the journal so a bad call gets a specific reason: name `^[a-z0-9][a-z0-9-]{0,63}$`; description 1–200 chars, one line (`/[\u0000-\u001f\u007f-\u009f  ]/` refused), trimmed; body ≤ 8192 UTF-8 bytes; type ∈ `user|feedback|project|reference`.
- Error mapping in handlers: status 0 → 502 `journal unreachable`; 404 on `GET /memories` → "this journal deployment does not have the /memories routes yet — deploy the journal update (matron-journal PR #94)"; 404 on a named memory → `no memory named "<name>"`; 409 → `the journal holds the maximum of 200 memories — delete one first`.
- The memory block is appended only for a Coordinator; ordinary sessions' prompts are byte-identical to today's.
- Block cap 16 KB: list what fits, then `… N more — call memory_list.`
- Every new `lib/*.js` file goes into the `check` script in `package.json`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Journal never answered (`known:false`)** at a Coordinator spawn: expected a block that says memories could not be loaded and to call `memory_list`, never an empty "you have no memories" — Task 3 `renderMemoryBlock` test.
2. **A `memory` marker without a name** (privacy-stripped payload): expected the seam still fires and a refresh happens — Task 4 router test uses `{memory_id, action:'saved'}` only.
3. **`memory_save` with a description containing a newline**: expected a 400 with the reason, no journal call — Task 2 handler test.
4. **A respawn on `assigned` before the memory cache is warm**: expected `journalOnCoordinator` awaits `memoryLookup.refresh({force:true})` before `recreateSession` — Task 5 wiring test pins the order.
5. **`memory_save` updating an existing memory without `body`**: expected the journal clears the body (spec), so the tool description must say to send the body back — Task 6 wiring test asserts the description text.

---

## File Structure

- Create `lib/memory-client.js` — `createMemoryClient({baseUrl, token, fetchImpl, timeoutMs}) -> {list, get, save, remove}`.
- Create `lib/memory-tools.js` — `createMemoryHandlers({sessions, journalConvoIdFor, client}) -> {save, list, get, delete}` plus the validation constants.
- Create `lib/memory-format.js` — `memoryLine`, `formatMemoryList`, `formatMemoryDetail`, `formatSaveAck`, `formatDeleteAck`.
- Create `lib/memory-lookup.js` — `createMemoryLookup(...) -> {refresh, snapshot}`.
- Modify `lib/coordinator.js` — `renderMemoryBlock`, `memoryBlock` param on the three shape helpers.
- Modify `lib/journal-input-router.js` — `onMemoryEvent` seam.
- Modify `ask-user.js` — `callMemory` + four tools.
- Modify `index.js` — client, handlers, `/memory/(save|list|get|delete)` route, lookup, refresh sites, spawn-site plumbing.
- Modify `BRIDGE_COORDINATOR.md`, `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`, `package.json`.
- Tests: `test/memory-client.test.js`, `test/memory-tools.test.js`, `test/memory-format.test.js`, `test/memory-lookup.test.js`, `test/memory-wiring.test.js`; additions to `test/coordinator.test.js`, `test/coordinator-wiring.test.js`, `test/journal-input-router.test.js`.

---

### Task 1: Journal client

**Files:** Create `lib/memory-client.js`; Test `test/memory-client.test.js`; Modify `package.json` (check script).

**Interfaces:** Produces `createMemoryClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 })` returning `{ list() , get(key), save(name, body), remove(key) }`, each `-> Promise<{status, data}>`; status 0 with `data.error = 'journal unreachable'` on any transport failure; never throws.

- [ ] **Test** (`fakeFetch` as in `test/missions-client.test.js`): `save('avoid-eric', {description:'x', convo_id:'c1'})` → `PUT https://j/memories/avoid-eric` with `Authorization: Bearer tok`, `Content-Type: application/json`, body echoed; `list()` → `GET /memories`; `get('me_1')` → `GET /memories/me_1`; `remove('a b')` → `DELETE /memories/a%20b`; a throwing fetch → `{status:0, data:{error:'journal unreachable'}}`; a non-JSON 500 → `{status:500, data:{error:'HTTP 500'}}`; `baseUrl` trailing slash stripped; empty base → status 0 without calling fetch.
- [ ] **Implement** as a copy of `lib/items-client.js`'s `request` with the four verbs.
- [ ] Add `node --check lib/memory-client.js` to `check`. Run `npx vitest run test/memory-client.test.js`. Commit `memory: journal client`.

### Task 2: Handlers and formatters

**Files:** Create `lib/memory-tools.js`, `lib/memory-format.js`; Test `test/memory-tools.test.js`, `test/memory-format.test.js`; `package.json`.

**Interfaces:**
- `createMemoryHandlers({ sessions, journalConvoIdFor, client })` → `{ save(data), list(data), get(data), delete(data) }`, each `-> Promise<{status, body}>`. `data.roomId` resolves the session (400 without, 404 no session, 409 no convo yet, exactly as items-tools). `save` body: `{memory, created: boolean}`. `delete` body: `{memory}`.
- Exported constants `MEMORY_TYPES`, `NAME_RE`, `DESCRIPTION_MAX`, `BODY_MAX`.
- `memoryLine(m)` → `` `name` (type): description — updated <iso> by <user|agent> ``; `formatMemoryList({memories})` → lines or `(no memories yet)`; `formatMemoryDetail({memory})` → name/type/description/body/origin lines; `formatSaveAck({memory, created})` → `` Saved memory `name` (created|updated): description ``; `formatDeleteAck({memory})` → `` Deleted memory `name` ``.

- [ ] **Tests (tools)**: save fills `convo_id` from the session and passes description/body/type; save 201 → `{status:201, body:{memory, created:true}}`, 200 → `created:false`; name `Bad Name` → 400 with a message naming the rule and no client call; description with `\n` → 400; description of 201 chars → 400; body of 8193 bytes → 400; type `rule` → 400; journal 409 → 409 with the max-200 message; journal status 0 → 502; list 404 → 404 with the deploy message; get/delete 404 → `no memory named "x"`; missing roomId → 400; unknown room → 404; no convo yet → 409.
- [ ] **Tests (format)**: one per renderer plus "unknown shapes degrade, never throw" (`formatMemoryList(null)`, `formatSaveAck({})`).
- [ ] **Implement**; add both files to `check`; run both test files; commit `memory: loopback handlers and renderers`.

### Task 3: Lookup cache and the block

**Files:** Create `lib/memory-lookup.js`; Modify `lib/coordinator.js`; Test `test/memory-lookup.test.js`, `test/coordinator.test.js`; `package.json`.

**Interfaces:**
- `createMemoryLookup({ baseUrl, token, fetchImpl, timeoutMs = 5_000, minRefreshMs = 30_000, now, log })` → `{ refresh({force}) -> Promise<{known, memories, fetched}>, snapshot() -> {known, memories} }`. Semantics as `createCoordinatorLookup` minus `apply`/epochs: unknown until the first 200; a failure after a good answer keeps the last list and warns once; a 404 is `known:true, memories:[]` warned once as "journal predates /memories"; a throttled call returns `fetched:false` without a request; a forced call always requests (chained behind an in-flight one).
- `renderMemoryBlock({ known, memories })` → string. Known with entries: the heading, the paragraph, then `- name (type): description` per memory sorted by name. Known and empty: heading + paragraph + `You have no memories yet.` Unknown: heading + `Your memories could not be loaded from the journal — call memory_list before deciding anything a standing rule might cover.` Cap: stop adding lines once the block would exceed 16 384 bytes and end with `… N more — call memory_list.`
- `claudeCoordinatorArgs({ coordinator, basePrompt, block, baseDisallowed, memoryBlock = '' })` appends `\n\n${memoryBlock}` after the block when `coordinator && memoryBlock`. Same for `codexCoordinatorOptions({ …, memoryBlock = '' })` and `coordinatorTurnText(role, block, memoryBlock = '')` (assigned only).

- [ ] **Tests (lookup)**: mirror the six `createCoordinatorLookup` tests with `{memories:[…]}` bodies; an unreadable body (`{}`) is a failure not an empty list.
- [ ] **Tests (block + plumbing)**: the four render cases (entries, empty, unknown, cap with 200 memories of 200-char descriptions → truncated with the `… N more` line and total ≤ 16 384 bytes); non-coordinator args unchanged with a memoryBlock given; coordinator args end with the block; `coordinatorTurnText('released', 'B', 'M')` is the released line only.
- [ ] **Implement**; add `lib/memory-lookup.js` to `check`; run; commit `memory: lookup cache and Coordinator block`.

### Task 4: Router seam

**Files:** Modify `lib/journal-input-router.js`; Test `test/journal-input-router.test.js`.

**Interfaces:** New option `onMemoryEvent(convoId, { seq, action, memoryId })` (optional). Fires for `type === 'memory'` from any sender, before the room carve-out and the `user:` filter, exactly like `coordinator`; never input (no text route, no resume, no unknown-convo notice); a throwing seam is warned and contained; unwired is a silent drop.

- [ ] **Tests**: copy the four coordinator-seam tests for `memory` with payloads `{memory_id:'me_1', action:'saved'}` and a stripped `{memory_id:'me_2', action:'deleted'}`.
- [ ] **Implement**; run the router test file; commit `memory: router seam for memory markers`.

### Task 5: index.js wiring

**Files:** Modify `index.js`; Test `test/coordinator-wiring.test.js` (new describe), `test/memory-wiring.test.js`.

- [ ] Imports: `createMemoryClient`, `createMemoryHandlers`, `createMemoryLookup`, `renderMemoryBlock`.
- [ ] After `missionsClient`: `const memoryClient = createMemoryClient({ baseUrl: journalHttpBase, token: _journalToken });`
- [ ] After `coordinatorLookup`: `const memoryLookup = createMemoryLookup({ baseUrl: journalHttpBase, token: _journalToken });` and a helper `const memoryBlockNow = () => renderMemoryBlock(memoryLookup.snapshot());`
- [ ] `handleJournalReconnect`: `memoryLookup.refresh({ force: true });` after the coordinator refresh. Boot block: same.
- [ ] `coordinatorRoleAtSpawn`: `memoryLookup.refresh();` next to `coordinatorLookup.refresh();`.
- [ ] Three spawn sites: add `memoryBlock: memoryBlockNow()` to the `claudeCoordinatorArgs` / `codexCoordinatorOptions` calls.
- [ ] `journalOnCoordinator`: after `const truth = await coordinatorLookup.refresh({ force: true });` add `if (role === 'assigned') await memoryLookup.refresh({ force: true });`; the final line becomes `coordinatorTurnText(role, COORDINATOR_BLOCK, memoryBlockNow())`.
- [ ] Router seams: `onMemoryEvent: () => { memoryLookup.refresh({ force: true }); },`
- [ ] After `missionsHandlers`: `const memoryHandlers = createMemoryHandlers({ sessions, journalConvoIdFor, client: memoryClient });` and the route block `url.pathname.match(/^\/memory\/(save|list|get|delete)$/)` mounted with `respondAgentChatRoute`.
- [ ] Wiring tests pin each of the above by source inspection (the `body()` helper style of `coordinator-wiring.test.js`), including the refresh-before-respawn order in `journalOnCoordinator`.
- [ ] `npm run check`, run the wiring tests, commit `memory: wire the lookup, handlers and spawn block`.

### Task 6: MCP tools and instructions

**Files:** Modify `ask-user.js`, `BRIDGE_COORDINATOR.md`, `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`; Test `test/memory-wiring.test.js`.

- [ ] `callMemory(name, args, render)` POSTs `${BRIDGE_API}/memory/${name}` with `{ roomId: ROOM_ID, ...args }`; non-2xx → `` memory_${name} failed: <error> ``.
- [ ] Tools: `memory_save {name, description, body?, type?}`, `memory_list {}`, `memory_get {name}`, `memory_delete {name}` with descriptions that say: memories are the user's standing rules and facts about how they want their agents to work, shared by every session and read by the Coordinator at spawn; the description is the one line the Coordinator sees, so make it the actionable rule; the same name overwrites the whole memory, so send the body back when updating; not for project facts (those go in the session's own Claude Code memory dir).
- [ ] `BRIDGE_COORDINATOR.md`: a "Remember what the user tells you" section. `BRIDGE_CLAUDE.md` / `BRIDGE_CODEX.md`: one paragraph under the tracker section.
- [ ] Wiring test: the four tool names registered with their exact `callMemory` renderers; the `memory_save` description contains "send the body back"; the three md files mention `memory_save`.
- [ ] `npm run lint && npm run check && npm test`; commit `memory: MCP tools and instructions`.

### Task 7: PR

- [ ] Push, open the PR (spec + journal PR link), CI green, Bugbot `success`, address findings, merge.
