# Auto Permission Mode + Matron Permission Prompt Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print-mode Claude sessions spawn with `--permission-mode auto` + a Matron-backed `--permission-prompt-tool` instead of `--dangerously-skip-permissions`; a per-session `--bypass` flag restores the old behavior.

**Architecture:** A new MCP tool `permission_request` in `ask-user.js` POSTs to the bridge and polls for an answer (the `request_secret` shape). The bridge posts a Matron button card; the tap rides the existing journal `prompt_reply` picker path (`perm:` namespace, like `timer:`). A new pure module `lib/permission-prompt.js` holds card rendering, button building, tap parsing, the pending-request registry, and spawn-arg assembly. `--bypass` is parsed like `--browser` and persisted as `bypassMode`.

**Tech Stack:** Node >= 22 ESM, vitest, `@modelcontextprotocol/sdk` + zod (already deps — add nothing).

**Spec:** `docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md` (committed in Task 1; read it before starting).

## Global Constraints

- ESM only (`import`/`export`), Node >= 22. No new npm dependencies.
- `npm run check` enumerates files explicitly — any new `lib/*.js` file MUST be added to the `check` script in `package.json`.
- Lib modules are pure/side-effect-free with injectable timers (see `lib/room-reply-waiters.js`); `ask-user.js` handlers stay thin and are NOT unit-tested (existing convention).
- Tap values are namespaced and validated against closed sets (defense-in-depth, see `lib/picker-dispatch.js`).
- User-facing flags get unicode-dash normalization (`—bypass` → `--bypass`), see `LEADING_UNICODE_DASHES` in `lib/mcp-config.js`.
- Comment style: block comments explain constraints/why, matching the density of neighboring code.
- The live bridge may run from the main checkout `/Users/danbarker/Dev/matron-bridge` via launchd — do ALL work in the worktree created in Task 1. Never commit on the main checkout's current branch.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Worktree + commit spec and plan

**Files:**
- Create: worktree at `../matron-bridge-auto-perm` on new branch `feat/auto-permission-mode` off `master`
- Copy in: `docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md`, `docs/superpowers/plans/2026-08-10-auto-permission-mode.md` (both exist untracked in the main checkout `/Users/danbarker/Dev/matron-bridge`)

**Interfaces:**
- Produces: the working directory for every later task. All subsequent paths are relative to the worktree root.

- [ ] **Step 1: Create the worktree** (or use the `superpowers:using-git-worktrees` skill if executing agents have it)

```bash
cd /Users/danbarker/Dev/matron-bridge
git worktree add ../matron-bridge-auto-perm -b feat/auto-permission-mode master
```

- [ ] **Step 2: Copy the spec and plan in (untracked files don't follow the worktree)**

```bash
mkdir -p ../matron-bridge-auto-perm/docs/superpowers/specs ../matron-bridge-auto-perm/docs/superpowers/plans
cp docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md ../matron-bridge-auto-perm/docs/superpowers/specs/
cp docs/superpowers/plans/2026-08-10-auto-permission-mode.md ../matron-bridge-auto-perm/docs/superpowers/plans/
```

- [ ] **Step 3: Install deps and verify the baseline is green**

```bash
cd ../matron-bridge-auto-perm
npm install
npm test
```
Expected: all tests PASS (baseline).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers
git commit -m "docs: spec + plan for auto permission mode and Matron permission prompt tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/permission-prompt.js` — card, buttons, tap parse, spawn args

**Files:**
- Create: `lib/permission-prompt.js`
- Test: `test/permission-prompt.test.js`
- Modify: `package.json` (append `&& node --check lib/permission-prompt.js` to the `check` script)

**Interfaces:**
- Produces (used by Tasks 3, 5, 7, 8, 9):
  - `renderPermissionCard({toolName, input})` → `{plain: string, html: string}`
  - `permissionButtons(requestId, toolName)` → `{buttons: [{id, label, value}], mode: 'pick_one'}` with ids `perm-allow|perm-always|perm-deny` and values `perm:<uuid>:allow|always|deny`
  - `parsePermTap(value)` → `{requestId, verdict}` or `null`
  - `permissionSpawnArgs(bypass)` → `string[]` CLI-arg fragment
  - `DENY_MESSAGE` — the deny reason string constant

- [ ] **Step 1: Write the failing tests**

Create `test/permission-prompt.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  renderPermissionCard,
  permissionButtons,
  parsePermTap,
  permissionSpawnArgs,
} from '../lib/permission-prompt.js';

const UUID = '01234567-89ab-cdef-0123-456789abcdef';

describe('permissionButtons', () => {
  it('builds the three verdict buttons with perm-namespaced ids and values', () => {
    const { buttons, mode } = permissionButtons(UUID, 'Bash');
    expect(mode).toBe('pick_one');
    expect(buttons).toEqual([
      { id: 'perm-allow', label: 'Allow once', value: `perm:${UUID}:allow` },
      { id: 'perm-always', label: 'Always allow Bash (session)', value: `perm:${UUID}:always` },
      { id: 'perm-deny', label: 'Deny', value: `perm:${UUID}:deny` },
    ]);
  });
});

describe('parsePermTap', () => {
  it('round-trips every button value permissionButtons emits', () => {
    for (const b of permissionButtons(UUID, 'WebFetch').buttons) {
      const parsed = parsePermTap(b.value);
      expect(parsed).not.toBeNull();
      expect(parsed.requestId).toBe(UUID);
      expect(['allow', 'always', 'deny']).toContain(parsed.verdict);
    }
  });

  it('rejects malformed and foreign values', () => {
    expect(parsePermTap('perm:not-a-uuid:allow')).toBeNull();
    expect(parsePermTap(`perm:${UUID}:maybe`)).toBeNull();
    expect(parsePermTap(`perm:${UUID}`)).toBeNull();
    expect(parsePermTap('model:sonnet')).toBeNull();
    expect(parsePermTap('')).toBeNull();
    expect(parsePermTap(null)).toBeNull();
    expect(parsePermTap(42)).toBeNull();
  });
});

describe('renderPermissionCard', () => {
  it('shows the command (and description) for Bash', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'Bash',
      input: { command: 'rm -rf build', description: 'Clean build dir' },
    });
    expect(plain).toContain('Bash');
    expect(plain).toContain('rm -rf build');
    expect(plain).toContain('Clean build dir');
    expect(html).toContain('<code>');
  });

  it('shows compact JSON for non-Bash tools and escapes html', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'WebFetch',
      input: { url: 'https://x.test/<b>' },
    });
    expect(plain).toContain('"url"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>"');
  });

  it('truncates long previews to ~500 chars', () => {
    const { plain } = renderPermissionCard({
      toolName: 'Bash',
      input: { command: 'x'.repeat(2000) },
    });
    expect(plain.length).toBeLessThan(700);
    expect(plain).toContain('…');
  });

  it('tolerates missing/unserializable input', () => {
    expect(() => renderPermissionCard({ toolName: 'Weird' })).not.toThrow();
    const cyc = {}; cyc.self = cyc;
    expect(() => renderPermissionCard({ toolName: 'Weird', input: cyc })).not.toThrow();
  });
});

describe('permissionSpawnArgs', () => {
  it('default: auto mode plus the prompt tool', () => {
    expect(permissionSpawnArgs(false)).toEqual([
      '--permission-mode', 'auto',
      '--permission-prompt-tool', 'mcp__ask-user__permission_request',
    ]);
  });

  it('bypass: the old skip-permissions flag', () => {
    expect(permissionSpawnArgs(true)).toEqual(['--dangerously-skip-permissions']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/permission-prompt.test.js`
Expected: FAIL — cannot resolve `../lib/permission-prompt.js`.

- [ ] **Step 3: Implement the module**

Create `lib/permission-prompt.js`:

```js
// Pure helpers for the print-mode permission prompt flow (spec:
// docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md).
//
// Print-mode sessions spawn with `--permission-mode auto` and route the rare
// remaining permission prompts through the ask-user MCP server's
// permission_request tool to a Matron button card. The card's button VALUES
// are namespaced `perm:<requestId>:<verdict>` and ride the journal
// prompt_reply picker path (lib/picker-dispatch.js), exactly like
// `timer:cancel:<id>`. The registry here is the bridge-side pending store the
// tool polls via GET /permission-request/:id — the /secret/:id shape:
// answered entries are consumed on read; unanswered entries expire by TTL so
// the map never leaks (the tool's own 5-minute timeout fires first and
// fail-closes to deny).

import { randomUUID } from 'node:crypto';

export const DENY_MESSAGE = 'The user denied this tool use from Matron.';

const PREVIEW_MAX = 500;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function previewFor(toolName, input) {
  if (toolName === 'Bash' && input && typeof input.command === 'string') {
    return input.description
      ? `${input.command}\n# ${input.description}`
      : input.command;
  }
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input);
  }
}

export function renderPermissionCard({ toolName, input }) {
  let preview = previewFor(toolName, input);
  if (preview.length > PREVIEW_MAX) preview = `${preview.slice(0, PREVIEW_MAX)}…`;
  return {
    plain: `🔐 Permission: Claude wants to run ${toolName}\n${preview}`,
    html: `🔐 <b>Permission:</b> Claude wants to run <code>${escapeHtml(toolName)}</code>`
      + `<br><pre><code>${escapeHtml(preview)}</code></pre>`,
  };
}

export function permissionButtons(requestId, toolName) {
  return {
    buttons: [
      { id: 'perm-allow', label: 'Allow once', value: `perm:${requestId}:allow` },
      { id: 'perm-always', label: `Always allow ${toolName} (session)`, value: `perm:${requestId}:always` },
      { id: 'perm-deny', label: 'Deny', value: `perm:${requestId}:deny` },
    ],
    mode: 'pick_one',
  };
}

// Strict shape validation (defense-in-depth like parsePickerValue): the
// request id must be a UUID and the verdict one of the three the buttons emit.
const PERM_TAP = /^perm:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(allow|always|deny)$/;

export function parsePermTap(value) {
  const m = typeof value === 'string' ? value.match(PERM_TAP) : null;
  return m ? { requestId: m[1], verdict: m[2] } : null;
}

// The spawn-arg fragment that replaces the hardwired
// '--dangerously-skip-permissions' in index.js print-mode spawns.
export function permissionSpawnArgs(bypass) {
  return bypass
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'auto', '--permission-prompt-tool', 'mcp__ask-user__permission_request'];
}
```

(`createPermissionRegistry` is Task 3 — same file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/permission-prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Add the file to `npm run check`**

In `package.json`, append `&& node --check lib/permission-prompt.js` to the end of the `"check"` script string. Run `npm run check` — expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/permission-prompt.js test/permission-prompt.test.js package.json
git commit -m "feat(permissions): pure card/button/tap/spawn-arg helpers for permission prompts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `createPermissionRegistry` — pending-request store

**Files:**
- Modify: `lib/permission-prompt.js` (append)
- Test: `test/permission-prompt.test.js` (append)

**Interfaces:**
- Produces (used by Task 7 and 8):
  - `createPermissionRegistry({setTimeout?, clearTimeout?, mintId?, ttlMs?})` →
    - `create({roomId, toolName})` → `{id}` (id from `mintId`, default `randomUUID`)
    - `answer(id, verdict)` → `{roomId, toolName, verdict, behavior}` or `null` (unknown / expired / already answered). `verdict` ∈ `allow|always|deny`; `behavior` is `'deny'` for deny, `'allow'` otherwise. Deny sets the entry's message to `DENY_MESSAGE`.
    - `read(id)` → `null` (unknown/expired) | `{answered: false}` | `{answered: true, behavior, message}` — answered reads delete the entry (the `/secret/:id` consume shape)
    - `size()` → number (test/introspection seam)

- [ ] **Step 1: Write the failing tests** — append to `test/permission-prompt.test.js`:

```js
import { createPermissionRegistry, DENY_MESSAGE } from '../lib/permission-prompt.js';

// Hand-rolled controllable timers, per the room-reply-waiters convention.
function fakeTimers() {
  const timers = new Map();
  let nextHandle = 1;
  return {
    setTimeout: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, ms }); return h; },
    clearTimeout: (h) => { timers.delete(h); },
    fire: (h) => { const t = timers.get(h); timers.delete(h); t?.fn(); },
    handles: () => [...timers.keys()],
    count: () => timers.size,
  };
}

describe('createPermissionRegistry', () => {
  const mkReg = (over = {}) => {
    const t = fakeTimers();
    let n = 0;
    const reg = createPermissionRegistry({
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
      mintId: () => `id-${++n}`,
      ...over,
    });
    return { reg, t };
  };

  it('create → allow answer → consumed read', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'room-1', toolName: 'Bash' });
    expect(reg.read(id)).toEqual({ answered: false });
    expect(reg.answer(id, 'allow')).toEqual({
      roomId: 'room-1', toolName: 'Bash', verdict: 'allow', behavior: 'allow',
    });
    expect(reg.read(id)).toEqual({ answered: true, behavior: 'allow', message: null });
    // consumed on answered read
    expect(reg.read(id)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it('always verdict reports behavior allow and the toolName', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'WebFetch' });
    expect(reg.answer(id, 'always')).toEqual({
      roomId: 'r', toolName: 'WebFetch', verdict: 'always', behavior: 'allow',
    });
  });

  it('deny carries DENY_MESSAGE through read', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    reg.answer(id, 'deny');
    expect(reg.read(id)).toEqual({ answered: true, behavior: 'deny', message: DENY_MESSAGE });
  });

  it('double answer returns null and keeps the first verdict', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    expect(reg.answer(id, 'deny')).not.toBeNull();
    expect(reg.answer(id, 'allow')).toBeNull();
    expect(reg.read(id).behavior).toBe('deny');
  });

  it('unknown id: answer and read return null', () => {
    const { reg } = mkReg();
    expect(reg.answer('nope', 'allow')).toBeNull();
    expect(reg.read('nope')).toBeNull();
  });

  it('TTL expiry deletes the entry (poller then 404s → tool fail-closes)', () => {
    const { reg, t } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    expect(t.count()).toBe(1);
    t.fire(t.handles()[0]);
    expect(reg.read(id)).toBeNull();
    expect(reg.answer(id, 'allow')).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it('answered read clears the TTL timer', () => {
    const { reg, t } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    reg.answer(id, 'allow');
    reg.read(id);
    expect(t.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/permission-prompt.test.js`
Expected: FAIL — `createPermissionRegistry` is not exported.

- [ ] **Step 3: Implement** — append to `lib/permission-prompt.js`:

```js
// Bridge-side pending-permission store. TTL (360 s) outlives the tool's own
// 5-minute poll deadline, so expiry only ever reaps entries whose poller is
// already gone; a tap after expiry gets answer() === null → informative no-op.
export function createPermissionRegistry({
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  mintId = randomUUID,
  ttlMs = 360000,
} = {}) {
  const entries = new Map();
  return {
    create({ roomId, toolName }) {
      const id = mintId();
      const timer = setTimer(() => { entries.delete(id); }, ttlMs);
      entries.set(id, { roomId, toolName, answered: false, behavior: null, message: null, timer });
      return { id };
    },
    answer(id, verdict) {
      const entry = entries.get(id);
      if (!entry || entry.answered) return null;
      entry.answered = true;
      entry.behavior = verdict === 'deny' ? 'deny' : 'allow';
      entry.message = verdict === 'deny' ? DENY_MESSAGE : null;
      return { roomId: entry.roomId, toolName: entry.toolName, verdict, behavior: entry.behavior };
    },
    read(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (!entry.answered) return { answered: false };
      clearTimer(entry.timer);
      entries.delete(id);
      return { answered: true, behavior: entry.behavior, message: entry.message };
    },
    size() { return entries.size; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/permission-prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/permission-prompt.js test/permission-prompt.test.js
git commit -m "feat(permissions): pending-request registry with consume-on-read and TTL

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `extractBypassFlag` in `lib/mcp-config.js`

**Files:**
- Modify: `lib/mcp-config.js`
- Test: `test/mcp-config.test.js` (append a describe block)

**Interfaces:**
- Produces (used by Task 10): `extractBypassFlag(tokens)` → `{bypass: true|false|null, rest: string[]}`. `--bypass` → `true`, `--auto` → `false` (the explicit way back), neither → `null` (caller falls back to persisted/carried value). Last flag wins. Unicode-dash forms normalize like `--browser` does.

- [ ] **Step 1: Write the failing tests** — append to `test/mcp-config.test.js` (import `extractBypassFlag` alongside the existing imports from `../lib/mcp-config.js`):

```js
describe('extractBypassFlag', () => {
  it('extracts --bypass and preserves positional args', () => {
    expect(extractBypassFlag(['--bypass', '/some/dir']))
      .toEqual({ bypass: true, rest: ['/some/dir'] });
    expect(extractBypassFlag(['/some/dir', '--bypass']))
      .toEqual({ bypass: true, rest: ['/some/dir'] });
  });

  it('extracts --auto as explicit false (returns a bypassed session to auto mode)', () => {
    expect(extractBypassFlag(['--auto'])).toEqual({ bypass: false, rest: [] });
  });

  it('returns null when neither flag is present', () => {
    expect(extractBypassFlag(['/dir'])).toEqual({ bypass: null, rest: ['/dir'] });
    expect(extractBypassFlag([])).toEqual({ bypass: null, rest: [] });
  });

  it('last flag wins when both appear', () => {
    expect(extractBypassFlag(['--bypass', '--auto']).bypass).toBe(false);
    expect(extractBypassFlag(['--auto', '--bypass']).bypass).toBe(true);
  });

  it('normalizes unicode dashes (mobile autocorrect)', () => {
    expect(extractBypassFlag(['—bypass'])).toEqual({ bypass: true, rest: [] });
    expect(extractBypassFlag(['–auto', '/dir'])).toEqual({ bypass: false, rest: ['/dir'] });
    expect(extractBypassFlag(['—notaflag'])).toEqual({ bypass: null, rest: ['—notaflag'] });
  });

  it('composes with extractMcpExtraFlags (bypass first, then extras)', () => {
    const { bypass, rest } = extractBypassFlag(['--bypass', '--browser', '/dir']);
    expect(bypass).toBe(true);
    expect(extractMcpExtraFlags(rest)).toEqual({ extras: ['browser'], rest: ['/dir'] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mcp-config.test.js`
Expected: FAIL — `extractBypassFlag` is not exported.

- [ ] **Step 3: Implement** — append to `lib/mcp-config.js` (after `extractMcpExtraFlags`, reusing `LEADING_UNICODE_DASHES`):

```js
// Per-session permission-mode flag (spec 2026-08-10-auto-permission-mode):
// `--bypass` restores the old --dangerously-skip-permissions spawn for this
// session; `--auto` explicitly returns to the default auto-permission spawn
// (needed so /restart can undo a persisted bypass). Neither present → null,
// so callers can fall back to the carried/persisted bypassMode. A Map is not
// needed here (two fixed flags), but unicode-dash normalization is — same
// mobile-autocorrect problem as --browser.
export function extractBypassFlag(tokens) {
  let bypass = null;
  const rest = [];
  for (const tok of tokens) {
    const normalised = tok.replace(LEADING_UNICODE_DASHES, '--');
    if (normalised === '--bypass') bypass = true;
    else if (normalised === '--auto') bypass = false;
    else rest.push(tok);
  }
  return { bypass, rest };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mcp-config.test.js`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add lib/mcp-config.js test/mcp-config.test.js
git commit -m "feat(permissions): parse per-session --bypass / --auto flags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `permission_request` MCP tool in `ask-user.js`

**Files:**
- Modify: `ask-user.js` (add one `server.tool(...)` block after `request_secret`, and one constant near `SECRET_TIMEOUT_MS`)

**Interfaces:**
- Consumes (Task 7 provides the bridge side): `POST /permission-request` body `{roomId, toolName, input}` → `{behavior:'allow'}` (short-circuit) or `{requestId}`; `GET /permission-request/:id` → `{answered:false}` | `{answered:true, behavior, message}` | 404.
- Produces: MCP tool `permission_request` whose text result is EXACTLY the JSON string Claude Code's `--permission-prompt-tool` protocol parses: `{"behavior":"allow","updatedInput":<input>}` or `{"behavior":"deny","message":"..."}`. Fail closed (deny) on bridge unreachable / non-OK / timeout.

- [ ] **Step 1: Add the timeout constant** — next to `SECRET_TIMEOUT_MS` (ask-user.js:12):

```js
const PERMISSION_TIMEOUT_MS = Number(process.env.PERMISSION_PROMPT_TIMEOUT_MS || 300000); // 5 min max wait for a permission tap
```

- [ ] **Step 2: Add the tool** — after the `request_secret` `server.tool(...)` block (ends ask-user.js:59):

```js
server.tool(
  'permission_request',
  'Internal: Claude Code invokes this automatically (via --permission-prompt-tool) to ask the user for tool permission through Matron. Never call it yourself.',
  {
    tool_name: z.string().describe('Name of the tool Claude wants to use'),
    input: z.any().describe('The input Claude wants to pass to the tool'),
    tool_use_id: z.string().optional().describe('The tool use id this permission request is for'),
    permission_suggestions: z.any().optional().describe('Permission rule suggestions from Claude Code (accepted and ignored)'),
  },
  async ({ tool_name, input }) => {
    // The return text IS the protocol: Claude Code JSON-parses it. Fail
    // CLOSED — any relay failure denies rather than silently allowing.
    const deny = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message }) }] });
    const allow = () => ({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: input ?? {} }) }] });
    try {
      const postRes = await fetch(`${BRIDGE_API}/permission-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, toolName: tool_name, input: input ?? {} }),
      });
      if (!postRes.ok) {
        return deny(`Matron bridge rejected the permission request (HTTP ${postRes.status}).`);
      }
      const data = await postRes.json();
      if (data.behavior === 'allow') return allow(); // session-allowlisted tool, no card

      const { requestId } = data;
      const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const pollRes = await fetch(`${BRIDGE_API}/permission-request/${requestId}`);
        if (!pollRes.ok) continue;
        const status = await pollRes.json();
        if (status.answered) {
          return status.behavior === 'allow'
            ? allow()
            : deny(status.message || 'The user denied this tool use from Matron.');
        }
      }
      return deny('The user did not answer the permission prompt within 5 minutes. You may continue other work that does not need this permission.');
    } catch (err) {
      return deny(`Permission relay error: ${err.message}`);
    }
  }
);
```

- [ ] **Step 3: Verify syntax**

Run: `node --check ask-user.js && npm run lint`
Expected: both exit 0. (No unit test — ask-user.js handlers are thin by convention.)

- [ ] **Step 4: Commit**

```bash
git add ask-user.js
git commit -m "feat(permissions): permission_request MCP tool relaying prompts to the bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Bridge HTTP routes (`POST /permission-request`, `GET /permission-request/:id`)

**Files:**
- Modify: `index.js` — import block (top, near the `handlePickerValue` import at index.js:90), module-level registry instance, and two route additions in the `apiServer` handler (index.js:7843)

**Interfaces:**
- Consumes: `createPermissionRegistry`, `renderPermissionCard`, `permissionButtons` from `./lib/permission-prompt.js` (Tasks 2–3); `sendButtonMessage(roomId, prompt, buttons, mode, plain, html)` (index.js:4920); `sessions` Map.
- Produces: the two endpoints Task 5's tool calls, and the module-level `permissionRegistry` + per-session `permAllowedTools` contract Task 8 consumes.

- [ ] **Step 1: Import and instantiate the registry**

Add to index.js imports:

```js
import { createPermissionRegistry, renderPermissionCard, permissionButtons } from './lib/permission-prompt.js';
```

Near the other module-level pending stores (grep `const pendingSecrets` in index.js) add:

```js
// Pending print-mode permission prompts (spec 2026-08-10-auto-permission-mode).
// The ask-user permission_request tool POSTs + polls; taps answer via the
// journal prompt_reply perm: path.
const permissionRegistry = createPermissionRegistry();
```

- [ ] **Step 2: Add the GET poll route**

In the `apiServer` handler, directly after the `GET /secret/:id` block (index.js:7846-7861), add:

```js
  // GET /permission-request/:id — permission_request MCP tool polls for a tap
  if (req.method === 'GET' && url.pathname.startsWith('/permission-request/')) {
    const permId = url.pathname.split('/')[2];
    const entry = permissionRegistry.read(permId);
    if (!entry) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Permission request not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entry));
    return;
  }
```

- [ ] **Step 3: Add the POST route**

In the POST dispatch chain (inside `req.on('end', ...)` after `JSON.parse`, where `if (url.pathname === '/secret')` lives at index.js:7968), add an `else if` branch:

```js
      } else if (url.pathname === '/permission-request') {
        const { roomId, toolName, input } = data;
        if (!roomId || typeof toolName !== 'string' || toolName === '') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and toolName are required' }));
          return;
        }
        const permSession = sessions.get(roomId);
        if (!permSession) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No session for roomId' }));
          return;
        }
        // Session-allowlisted (an earlier "Always allow" tap): short-circuit,
        // no card.
        if (permSession.permAllowedTools?.has(toolName)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ behavior: 'allow' }));
          return;
        }
        const { id: permRequestId } = permissionRegistry.create({ roomId, toolName });
        const card = renderPermissionCard({ toolName, input });
        const { buttons: permBtns, mode: permMode } = permissionButtons(permRequestId, toolName);
        sendButtonMessage(roomId, card.plain, permBtns, permMode, card.plain, card.html);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ requestId: permRequestId }));
      }
```

- [ ] **Step 4: Verify**

Run: `node --check index.js && npm run lint && npm test`
Expected: all pass (routes are exercised end-to-end manually in Task 11; the pure pieces are already unit-tested).

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(permissions): bridge routes for permission request create + poll

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Tap dispatch — `perm:` through the picker path

**Files:**
- Modify: `lib/picker-dispatch.js`, `lib/journal-input-router.js` (one regex), `index.js` (dispatch deps + answer handler)
- Test: `test/picker-dispatch.test.js` (append), `test/journal-input-router.test.js` (append one case)

**Interfaces:**
- Consumes: `parsePermTap` (Task 2), `permissionRegistry` + `session.permAllowedTools` (Task 6 / Task 9).
- Produces: `handlePickerValue` gains an injected `answerPermission(session, requestId, verdict, sendReply)` dep; `PICKER_OPTION_ID` in journal-input-router recognizes `perm-*` option ids so the card is classified as a picker frame (non-answerable, tap arrives with `answer.picker === true`).

- [ ] **Step 1: Write the failing tests**

Append to `test/picker-dispatch.test.js` (match the file's existing stub style — read it first; it injects vi.fn() switch fns):

```js
describe('perm: dispatch', () => {
  const UUID = '01234567-89ab-cdef-0123-456789abcdef';

  it('dispatches a valid perm tap to answerPermission', () => {
    const answerPermission = vi.fn();
    const sendReply = vi.fn();
    const session = {};
    const handled = handlePickerValue(`perm:${UUID}:always`, 'room-1', session, {
      answerPermission, sendReply,
    });
    expect(handled).toBe(true);
    expect(answerPermission).toHaveBeenCalledWith(session, UUID, 'always', sendReply);
  });

  it('rejects malformed perm values', () => {
    const answerPermission = vi.fn();
    expect(handlePickerValue('perm:nope:allow', 'r', {}, { answerPermission })).toBe(false);
    expect(handlePickerValue(`perm:${UUID}:sudo`, 'r', {}, { answerPermission })).toBe(false);
    expect(answerPermission).not.toHaveBeenCalled();
  });
});
```

Append to `test/journal-input-router.test.js` (find the existing `isPickerFrame` / `promptExpectsReply` tests and mirror their payload shape):

```js
it('classifies a permission card as a non-answerable picker frame', () => {
  const payload = {
    question: '🔐 Permission: Claude wants to run Bash',
    options: [
      { id: 'perm-allow', label: 'Allow once', value: 'perm:01234567-89ab-cdef-0123-456789abcdef:allow' },
      { id: 'perm-always', label: 'Always allow Bash (session)', value: 'perm:01234567-89ab-cdef-0123-456789abcdef:always' },
      { id: 'perm-deny', label: 'Deny', value: 'perm:01234567-89ab-cdef-0123-456789abcdef:deny' },
    ],
    mode: 'pick_one',
  };
  expect(isPickerFrame(payload)).toBe(true);
  expect(promptExpectsReply(payload)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/picker-dispatch.test.js test/journal-input-router.test.js`
Expected: FAIL — perm values unrecognized (`handled` false / `isPickerFrame` false).

- [ ] **Step 3: Implement `lib/picker-dispatch.js` changes**

Add the import:

```js
import { parsePermTap } from './permission-prompt.js';
```

Change the value regex (line 39) to include `perm`:

```js
const PICKER_VALUE = /^(model|effort|mode|timer|perm):(.+)$/;
```

In `parsePickerValue`, before the `ALLOWED[kind]` check, add:

```js
  if (kind === 'perm') {
    const p = parsePermTap(value);
    return p ? { kind, requestId: p.requestId, verdict: p.verdict } : null;
  }
```

In `handlePickerValue`, add `answerPermission` to the destructured deps and, next to the `timer` branch:

```js
  if (kind === 'perm') {
    answerPermission(session, parsed.requestId, parsed.verdict, sendReply);
    return true;
  }
```

Update the module header comment to mention the permission card (`perm:<requestId>:<verdict>`, lib/permission-prompt.js permissionButtons) riding the same path.

- [ ] **Step 4: Implement `lib/journal-input-router.js` change**

Line 52 — add `perm` to the non-answerable option-id shapes:

```js
const PICKER_OPTION_ID = /^(?:model|effort|mode|timer|perm)-/;
```

Extend the comment above it: `perm-*` are the permission-card verdict buttons (lib/permission-prompt.js).

- [ ] **Step 5: Implement the index.js answer handler and wiring**

Add near the other `*FromButton` helpers (grep `function cancelTimerFromButton` in index.js):

```js
// A perm:<id>:<verdict> tap (permission card). The registry is the source of
// truth — a tap on an expired or already-answered card is an informative
// no-op, never a crash. "Always" allowlists the tool for the SESSION (in
// memory only; not persisted — a restart re-prompts, by design).
function answerPermissionFromButton(session, requestId, verdict, sendReply) {
  const result = permissionRegistry.answer(requestId, verdict);
  if (!result) {
    sendReply('That permission request has expired or was already answered.');
    return;
  }
  if (verdict === 'always') {
    const target = sessions.get(result.roomId) || session;
    if (!target.permAllowedTools) target.permAllowedTools = new Set();
    target.permAllowedTools.add(result.toolName);
    sendReply(`✅ Always allowing ${result.toolName} for this session.`);
  } else if (verdict === 'deny') {
    sendReply(`⛔ Denied: ${result.toolName}`);
  } else {
    sendReply(`✅ Allowed once: ${result.toolName}`);
  }
}
```

In the journal prompt_reply picker branch (index.js:7023-7043):
1. Extend the alive-gate skip (line 7027) — a permission tap needs only the registry, and an expired-card tap may outlive the session:

```js
    const skipsAliveGate = typeof answer.choice === 'string'
      && (answer.choice.startsWith('timer:') || answer.choice.startsWith('perm:'));
    if (!session.alive && !skipsAliveGate) {
```

(Also update the comment above it to mention perm taps.)
2. Add `answerPermission: answerPermissionFromButton,` to the `handlePickerValue` deps object (line 7033-7041).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/picker-dispatch.test.js test/journal-input-router.test.js && node --check index.js`
Expected: PASS / exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/picker-dispatch.js lib/journal-input-router.js index.js test/picker-dispatch.test.js test/journal-input-router.test.js
git commit -m "feat(permissions): route perm: card taps through the picker dispatch path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Print-mode spawn — auto mode by default, `bypassMode` resolution

**Files:**
- Modify: `index.js` — `createSession` print branch (index.js:1185-1310), `persistSession` (index.js:512-525)

**Interfaces:**
- Consumes: `permissionSpawnArgs` (Task 2).
- Produces: `session.bypassMode` (boolean, print-mode Claude sessions only), `session.permAllowedTools` (Set), persisted `bypassMode` field. `createSession` honors `options.bypass` (boolean or absent) with fallback to persisted `bypassMode`. Task 9's command handlers rely on all of these.

- [ ] **Step 1: Import**

Add `permissionSpawnArgs` to the Task 6 import from `./lib/permission-prompt.js`.

- [ ] **Step 2: Resolve `bypassMode` and swap the spawn args**

In `createSession`'s print-mode section, next to the existing `mcpExtras` resolution (index.js:1191-1194), add the same explicit-wins-else-persisted pattern:

```js
  // bypassMode: explicit --bypass/--auto flag wins; otherwise the persisted
  // value. Sessions persisted before this feature have no bypassMode and thus
  // resume in auto mode — the intended migration (spec 2026-08-10).
  const bypassMode = typeof options.bypass === 'boolean'
    ? options.bypass
    : (persistedForRoom?.bypassMode === true);
```

In the `args` array (index.js:1219-1247), replace the line

```js
    '--dangerously-skip-permissions',
```

with

```js
    ...permissionSpawnArgs(bypassMode),
```

and inside the `--settings` JSON object (alongside `hooks`), add a `permissions` key so the bridge's own MCP plumbing never generates cards about itself:

```js
      permissions: {
        allow: ['mcp__ask-user', 'mcp__show-file'],
      },
```

- [ ] **Step 3: Session fields**

In the `session = {` object literal (index.js:1295+), add:

```js
    bypassMode,
    permAllowedTools: new Set(),
```

- [ ] **Step 4: Persist `bypassMode` via the auto-carry seam**

In `persistSession` (index.js:520-524), next to `derived.mcpExtras`:

```js
  if (typeof live?.bypassMode === 'boolean') derived.bypassMode = live.bypassMode;
```

- [ ] **Step 5: Haiku-class model warning**

After `printModel` is resolved and pushed (index.js:1248-1253), add:

```js
  // Auto mode needs Opus 4.6+/Sonnet 4.6+/Fable-class models; Haiku-class
  // sessions fall back to `default` permission mode and prompt for far more.
  if (!bypassMode && printModel && /haiku/i.test(printModel)) {
    const hw = notice('warning',
      `Model ${printModel} doesn't support auto permission mode — the session may fall back to default mode and prompt frequently. Use --bypass to restore the old behavior.`,
      `Model <code>${escapeHtml(printModel)}</code> doesn't support auto permission mode — the session may fall back to default mode and prompt frequently. Use <code>--bypass</code> to restore the old behavior.`);
    Promise.resolve(sendToRoom(roomId, hw.plain, hw.html)).catch(() => {});
  }
```

(`notice`, `escapeHtml`, `sendToRoom` all exist in index.js — the spawn-guard block at the top of `createSession` uses the same pattern.)

- [ ] **Step 6: Verify**

Run: `node --check index.js && npm run lint && npm test`
Expected: all pass. Then confirm the assembled args by eyeballing the debug line: `grep -n 'permissionSpawnArgs' index.js` shows exactly one spawn-arg use (print mode) — iv-mode (index.js:~1923) still carries `--dangerously-skip-permissions` untouched.

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(permissions): print-mode sessions default to auto permission mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Command handlers — flag parsing, restart carry, confirmations, /mode warning

**Files:**
- Modify: `index.js` — `!start` (index.js:5278-5340), `!restart` (index.js:5357-5420), `!resume` (index.js:5422+), `!workdir` (index.js:~5692), `applyModeSwitch` (grep `function applyModeSwitch`)

**Interfaces:**
- Consumes: `extractBypassFlag` (Task 4), `options.bypass` in `createSession` (Task 8), `session.bypassMode`.
- Produces: user-visible flag surface (`/start --bypass`, `/restart --auto`, …) and mode messaging.

- [ ] **Step 1: Import**

Add `extractBypassFlag` to the existing `./lib/mcp-config.js` import in index.js.

- [ ] **Step 2: `!start`** — at index.js:5284, extract bypass BEFORE the extras (so `rest` chains):

```js
      const { bypass: startBypass, rest: afterBypass } = extractBypassFlag(parts.slice(1));
      const { extras: mcpExtras, rest: afterMcp } = extractMcpExtraFlags(afterBypass);
```

Pass it through at the `createSession` call (index.js:5322):

```js
      const session = createSession(sessionRoomId, workdir, undefined, {
        agent: selectedAgent, mcpExtras,
        ...(startBypass != null ? { bypass: startBypass } : {}),
      });
```

Append a mode note to the start confirmation (index.js:5337-5338). Only print-mode Claude sessions carry `bypassMode` (iv/codex leave it undefined and get no note):

```js
      const permNote = session.bypassMode === true ? ' · ⚠️ permissions bypassed'
        : (session.bypassMode === false ? ' · 🛡 auto permissions' : '');
      await sendReply(`${agentLabel(selectedAgent)} session started in a new conversation${extrasNote}${permNote}.`);
```

- [ ] **Step 3: `!restart`** — at index.js:5369, chain the extraction:

```js
      const { bypass: restartBypass, rest: restartAfterBypass } = extractBypassFlag(restartArgs);
      const { extras: restartFlagExtras, rest: restartAfterMcp } = extractMcpExtraFlags(restartAfterBypass);
```

(The deferred-restart stash at index.js:5395 rebuilds from `restartArgs`, which still contains the original `--bypass`/`--auto` token — replay re-parses it. No change needed there.)

At the `recreateSession` call (index.js:5412), carry the current value when no flag was given:

```js
      recreateSession(roomId, {
        mcpExtras: effectiveRestartExtras,
        bypass: restartBypass != null ? restartBypass : existing.bypassMode === true,
      }, { sendReply, sendHtml });
```

- [ ] **Step 4: `!resume` and `!workdir`** — same chain shape. At index.js:5428:

```js
      const { bypass: resumeBypass, rest: resumeAfterBypass } = extractBypassFlag(parts.slice(1));
      const { extras: resumeExtras, rest: resumeAfterMcp } = extractMcpExtraFlags(resumeAfterBypass);
```

then find the `createSession` call inside the `!resume` case (grep `mcpExtras: resumeExtras` in index.js) and add `...(resumeBypass != null ? { bypass: resumeBypass } : {})` to its options. Repeat identically for `!workdir` (index.js:5692, `workdirExtras` / `mcpExtras: workdirExtras`), naming the variables `workdirBypass` / `workdirAfterBypass`.

- [ ] **Step 5: `/mode interactive` heads-up**

In `applyModeSwitch` (grep `function applyModeSwitch` in index.js), in the branch that switches TO interactive (`wantInteractive` true), before the switch proceeds, add:

```js
  // iv-mode has no auto-permission support yet (spec 2026-08-10 out-of-scope):
  // switching an auto session to interactive silently widens permissions, so
  // say it out loud rather than refusing the switch.
  if (wantInteractive && session.bypassMode === false) {
    sendReply('Heads-up: interactive mode currently runs with permissions bypassed (auto permission mode support is coming).');
  }
```

(Adjust the exact variable names to the function's actual signature — it receives the session and a `sendReply`-capable ctx; place the notice where the switch is already committed to happening, after any validation/early-returns.)

- [ ] **Step 6: Verify**

Run: `node --check index.js && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(permissions): --bypass/--auto session flags, restart carry, mode messaging

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Docs — README/help text

**Files:**
- Modify: whatever user-facing command help exists — run `grep -rn 'browser' README.md docs/*.md lib/command-dispatch.js 2>/dev/null | grep -iv superpowers` and update every surface that documents `--browser`/`--share` session flags to also document `--bypass` / `--auto`, plus a short "Permissions" paragraph:

> Print-mode sessions run with Claude Code's `auto` permission mode: routine work is auto-approved, dangerous actions are blocked, and the rare remaining prompts appear in Matron as Allow once / Always allow (session) / Deny cards (unanswered cards deny after 5 minutes). Start a session with `--bypass` to restore the old `--dangerously-skip-permissions` behavior; `/restart --auto` returns it to auto mode. Interactive (`/mode interactive`) sessions still run bypassed.

- [ ] **Step 1: Update the surfaces found by the grep** (README section on session flags, and the `!help` output if it lists flags — grep `'--browser'` in index.js/lib for the help string).
- [ ] **Step 2: Verify** — `npm run lint` (markdown untouched by lint, but catches any code-string edits).
- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(permissions): document auto permission mode and --bypass/--auto flags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full CI locally**

Run: `npm run ci`
Expected: lint, check, tests, audit all pass.

- [ ] **Step 2: Manual smoke of the tool protocol (no live Matron needed)**

Start the bridge from the worktree (`node index.js` with the usual env; do NOT touch the launchd service). In a scratch room/session:
1. `/start /tmp` → confirmation ends with `🛡 auto permissions`.
2. Ask Claude to do something routine (read a file) → no card, works.
3. Add a temporary ask rule to force a card: in the session's workdir create `.claude/settings.json` with `{"permissions":{"ask":["Bash(echo *)"]}}`, restart the session, ask Claude to `echo hi` → card appears with the three buttons; tap **Allow once** → command runs; repeat and tap **Always allow** → next `echo` produces no card; tap **Deny** on a fresh request → Claude reports the denial message.
4. Let one card sit 5 minutes → Claude receives the timeout deny and continues.
5. `/restart --bypass` → confirmation shows `⚠️ permissions bypassed`; `/restart --auto` → back to `🛡`.
6. `/mode interactive` on an auto session → heads-up message appears.

- [ ] **Step 3: Wrap up**

Use the `superpowers:finishing-a-development-branch` skill: push `feat/auto-permission-mode`, open a PR against `master` titled `feat(permissions): auto permission mode by default + Matron permission prompt tool`, body summarizing the spec decisions and linking `docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md`.
