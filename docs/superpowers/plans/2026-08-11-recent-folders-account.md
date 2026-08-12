# recent_folders Account Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach `account: {email}` to the `recent_folders` RPC reply so clients (and later, agents) can see which claude account a box is logged in to.

**Architecture:** Reuse the existing `getAccountEmail()` cache in `index.js` (already feeds session-status frames). Inject it into `createRpcRequestHandler` as a new dep, spread the block into the reply with the same best-effort/omit-when-empty convention as `activity`/`limits`.

**Tech Stack:** Node ESM, vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-recent-folders-account-design.md`

## Global Constraints

- The `account` key is omitted entirely when the email is null/empty — never `null`, never `{}`.
- A throwing dep must never fail the reply (capacity is best-effort).
- Run tests with `npx vitest run test/journal-rpc-handlers.test.js`.

---

### Task 1: `account` block in the recent_folders reply

**Files:**
- Modify: `lib/journal-rpc.js` (deps at ~line 47, handler at ~line 100–110)
- Modify: `index.js` (the deps object at ~line 698–700 where `getActivity`/`getLimits` are wired)
- Test: `test/journal-rpc-handlers.test.js` (the `recent_folders` describe, capacity tests at ~line 110–145)

**Interfaces:**
- Consumes: `getAccountEmail()` (index.js, already exists — returns `string | null`).
- Produces: reply key `account: { email: string }`, optional.

- [ ] **Step 1: Write the failing tests** — extend the existing capacity tests in `test/journal-rpc-handlers.test.js`:

```js
it('attaches the account block when an email is known', () => {
  const { handler, responses } = harness({ getAccountEmail: () => 'pat@yearbook.com' });
  handler(REQ('recent_folders', {}));
  expect(responses[0].result.account).toEqual({ email: 'pat@yearbook.com' });
});

it('omits the account key entirely when the email is null, empty, or the dep throws', () => {
  for (const getAccountEmail of [() => null, () => '', () => { throw new Error('boom'); }]) {
    const { handler, responses } = harness({ getAccountEmail });
    handler(REQ('recent_folders', {}));
    expect('account' in responses[0].result).toBe(false);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/journal-rpc-handlers.test.js`
Expected: the two new tests FAIL (`account` undefined vs expected object is fine for test 1; test 2 may pass vacuously — if so, that's acceptable, test 1 is the driver).

- [ ] **Step 3: Implement** — in `lib/journal-rpc.js`, add the dep with the same default idiom as its siblings:

```js
  getActivity = () => null,
  getLimits = () => null,
  getAccountEmail = () => null,
```

and in the `recent_folders` handler, next to the activity/limits reads:

```js
      let accountEmail = null;
      try { accountEmail = getAccountEmail(); } catch { /* capacity is best-effort */ }
      respond(request, true, {
        folders,
        ...(activity ? { activity } : {}),
        ...(limits ? { limits } : {}),
        ...(accountEmail ? { account: { email: accountEmail } } : {}),
      });
```

In `index.js`, wire the real function into the same deps object that carries `getActivity`/`getLimits`:

```js
  getAccountEmail: () => getAccountEmail(),
```

(`getAccountEmail` is hoisted (a function declaration), so referencing it from the deps object is safe regardless of declaration order.)

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: all tests PASS, including the untouched activity/limits ones.

- [ ] **Step 5: Commit**

```bash
git add lib/journal-rpc.js index.js test/journal-rpc-handlers.test.js
git commit -m "feat(rpc): report the logged-in account email on recent_folders"
```
