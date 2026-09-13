# MCP/Plugin Memory Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-matrix-bridge sessions lean by default (small-VPS friendly) with per-machine opt-in for heavy MCP servers and plugins, cutting a default session from ~860 MB to ~460 MB.

**Architecture:** Two independent layers. **Layer A** (stdio `mcpServers`): pass `--strict-mcp-config` so sessions stop inheriting the user's global servers; reuse the existing `mcpExtras` flag machinery, generalized to load a gitignored per-machine overlay (`mcp-config.local.json`) and to register `--<name>` flags dynamically; add a `MCP_DEFAULT_EXTRAS` env baseline that is unioned with per-session flags. **Layer B** (plugin MCPs): set `CLAUDE_CODE_PLUGIN_CACHE_DIR` to a bridge-owned empty dir by default (no plugin MCPs load) while leaving `~/.claude` — creds, transcripts, `--resume` — untouched; operators point `BRIDGE_PLUGIN_CACHE_DIR` at the real/curated cache to re-enable.

**Tech Stack:** Node.js (ESM), vitest, the `claude` CLI (v2.1.160), node-pty (iv-mode).

**Spec:** `docs/superpowers/specs/2026-06-02-bridge-mcp-memory-optimization-design.md`

**Verified facts the plan relies on (claude 2.1.160, this machine):**
- `--strict-mcp-config` drops user/project `mcpServers` (circleci, chrome-devtools, linear-server) but NOT plugin MCPs.
- `CLAUDE_CODE_PLUGIN_CACHE_DIR=<empty dir>` removes every `plugin:*` MCP server; `~/.claude` (creds/transcripts) is untouched, so `--resume` keeps working.
- `transcriptPathFor` (`lib/interactive-session.js`) hardcodes `~/.claude/projects/...` — unaffected because we do NOT set `CLAUDE_CONFIG_DIR`.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `lib/mcp-config.js` | Modify | Pure helpers: config merge, dynamic flag parsing, extras resolution, default-extras parsing |
| `test/mcp-config.test.js` | Modify | Unit tests for the above (TDD) |
| `index.js` | Modify | Wiring: load merged config, constants, resolve effective extras, spawn flags/env at both spawn sites, command-handler call sites + display |
| `mcp-config.local.example.json` | Create | Documented example of the per-machine overlay |
| `.gitignore` | Modify | Ignore all generated configs + the local overlay |
| `.env.example` | Modify | Document `MCP_DEFAULT_EXTRAS`, `BRIDGE_PLUGIN_CACHE_DIR` |
| `README.md` | Modify | Document the new knobs + extras flags |
| `BRIDGE_CLAUDE.md` | Modify | Mention `--<extra>` flags alongside `--browser` |

`index.js` is a large side-effectful entrypoint with no unit-test harness (the suite tests `lib/` only). Therefore **all testable logic lives in `lib/mcp-config.js`** (Tasks 1) and `index.js` changes (Tasks 2–4) are verified with `npm run check` (syntax), `npm run lint`, and manual smoke tests (Task 7).

---

## Task 1: Pure helpers in `lib/mcp-config.js` (TDD)

**Files:**
- Modify: `lib/mcp-config.js`
- Test: `test/mcp-config.test.js`

This task changes two existing signatures (`knownMcpExtras`, `extractMcpExtraFlags`) and adds three pure helpers (`mergeMcpConfigs`, `parseDefaultExtras`, `resolveExtras`). Existing tests that call the old signatures are updated in the same task.

- [ ] **Step 1: Write failing tests for the new/updated helpers**

Replace the `extractMcpExtraFlags` describe block and add new blocks. Edit `test/mcp-config.test.js`:

Change the existing `extractMcpExtraFlags` tests to pass a known-names list (new 2nd arg), and add coverage for the new helpers. Append/replace so the file contains:

```js
import { describe, it, expect } from 'vitest';
import {
  buildMcpServers,
  extractMcpExtraFlags,
  knownMcpExtras,
  mergeMcpConfigs,
  parseDefaultExtras,
  resolveExtras,
} from '../lib/mcp-config.js';

const KNOWN = ['browser', 'circleci'];

describe('extractMcpExtraFlags', () => {
  it('pulls a known --flag out of the token list', () => {
    expect(extractMcpExtraFlags(['--browser', '/some/dir'], KNOWN))
      .toEqual({ extras: ['browser'], rest: ['/some/dir'] });
    expect(extractMcpExtraFlags(['/some/dir', '--circleci'], KNOWN))
      .toEqual({ extras: ['circleci'], rest: ['/some/dir'] });
  });

  it('leaves unknown --flags as positional tokens', () => {
    expect(extractMcpExtraFlags(['--browser', '--not-a-flag', '/dir'], KNOWN))
      .toEqual({ extras: ['browser'], rest: ['--not-a-flag', '/dir'] });
  });

  it('returns empty extras when none requested', () => {
    expect(extractMcpExtraFlags(['/dir'], KNOWN)).toEqual({ extras: [], rest: ['/dir'] });
    expect(extractMcpExtraFlags([], KNOWN)).toEqual({ extras: [], rest: [] });
  });

  it('does not consume positional args that share Object.prototype names', () => {
    expect(extractMcpExtraFlags(['constructor'], KNOWN)).toEqual({ extras: [], rest: ['constructor'] });
    expect(extractMcpExtraFlags(['__proto__'], KNOWN)).toEqual({ extras: [], rest: ['__proto__'] });
    expect(extractMcpExtraFlags(['--__proto__'], KNOWN)).toEqual({ extras: [], rest: ['--__proto__'] });
    expect(extractMcpExtraFlags(['hasOwnProperty', '--browser'], KNOWN))
      .toEqual({ extras: ['browser'], rest: ['hasOwnProperty'] });
  });
});

describe('knownMcpExtras', () => {
  it('returns the mcpExtras keys of the supplied config', () => {
    const cfg = { mcpServers: {}, mcpExtras: { browser: {}, circleci: {} } };
    expect(knownMcpExtras(cfg).sort()).toEqual(['browser', 'circleci']);
  });
  it('returns [] when there are no extras', () => {
    expect(knownMcpExtras({ mcpServers: {} })).toEqual([]);
    expect(knownMcpExtras(undefined)).toEqual([]);
  });
});

describe('mergeMcpConfigs', () => {
  const base = { mcpServers: { 'ask-user': { command: 'node' } }, mcpExtras: { browser: { 'chrome-devtools': {} } } };

  it('returns base unchanged when overlay is null/undefined', () => {
    expect(mergeMcpConfigs(base, null)).toEqual(base);
    expect(mergeMcpConfigs(base, undefined)).toEqual(base);
  });

  it('merges overlay mcpExtras into base by key', () => {
    const overlay = { mcpExtras: { circleci: { circleci: { command: 'node', args: ['/x/server.js'] } } } };
    const out = mergeMcpConfigs(base, overlay);
    expect(Object.keys(out.mcpExtras).sort()).toEqual(['browser', 'circleci']);
    expect(out.mcpExtras.circleci.circleci.args).toEqual(['/x/server.js']);
  });

  it('merges overlay mcpServers too', () => {
    const overlay = { mcpServers: { extra: { command: 'node' } } };
    const out = mergeMcpConfigs(base, overlay);
    expect(Object.keys(out.mcpServers).sort()).toEqual(['ask-user', 'extra']);
  });

  it('does not mutate base', () => {
    const snap = JSON.parse(JSON.stringify(base));
    mergeMcpConfigs(base, { mcpExtras: { circleci: {} } });
    expect(base).toEqual(snap);
  });
});

describe('parseDefaultExtras', () => {
  it('splits a comma list and trims', () => {
    expect(parseDefaultExtras('circleci, browser')).toEqual(['circleci', 'browser']);
  });
  it('returns [] for empty/undefined', () => {
    expect(parseDefaultExtras('')).toEqual([]);
    expect(parseDefaultExtras(undefined)).toEqual([]);
    expect(parseDefaultExtras('  ')).toEqual([]);
  });
  it('drops empty segments', () => {
    expect(parseDefaultExtras('circleci,,')).toEqual(['circleci']);
  });
});

describe('resolveExtras', () => {
  it('unions machine default with session extras, default first, deduped', () => {
    expect(resolveExtras(['circleci'], ['browser'])).toEqual(['circleci', 'browser']);
    expect(resolveExtras(['circleci'], ['circleci'])).toEqual(['circleci']);
    expect(resolveExtras([], ['browser'])).toEqual(['browser']);
    expect(resolveExtras(['circleci'], [])).toEqual(['circleci']);
  });
  it('tolerates missing args', () => {
    expect(resolveExtras()).toEqual([]);
    expect(resolveExtras(['circleci'])).toEqual(['circleci']);
  });
});
```

Keep the existing `buildMcpServers` describe block as-is (it is unaffected).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp-config.test.js`
Expected: FAIL — `mergeMcpConfigs`/`parseDefaultExtras`/`resolveExtras` are not exported, and `extractMcpExtraFlags`/`knownMcpExtras` don't accept the new args.

- [ ] **Step 3: Update `lib/mcp-config.js` to the new API**

In `lib/mcp-config.js`, delete the hardcoded `EXTRA_FLAG_TO_NAME` Map and the comment block above it, and replace the `knownMcpExtras` + `extractMcpExtraFlags` definitions with the dynamic versions; add the three new helpers. The file's `buildMcpServers`, `resolveAskUser`, and the `macifyMcpServers` import stay unchanged.

Replace this block:

```js
const EXTRA_FLAG_TO_NAME = new Map([
  ['--browser', 'browser'],
]);

export function knownMcpExtras() {
  return Array.from(EXTRA_FLAG_TO_NAME.values());
}

export function extractMcpExtraFlags(tokens) {
  const extras = [];
  const rest = [];
  for (const tok of tokens) {
    const mapped = EXTRA_FLAG_TO_NAME.get(tok);
    if (mapped) extras.push(mapped);
    else rest.push(tok);
  }
  return { extras, rest };
}
```

with:

```js
// The set of valid extra names is derived from the merged config's
// `mcpExtras` keys (committed + machine-local overlay), so adding an extra to
// mcp-config[.local].json automatically enables its `--<name>` flag.
export function knownMcpExtras(baseConfig) {
  return Object.keys(baseConfig?.mcpExtras || {});
}

// Strip recognised `--<name>` flags from a tokenised command line. `knownNames`
// is the list from knownMcpExtras(). A Set membership test (not object lookup)
// keeps prototype names like `__proto__`/`constructor` from matching.
export function extractMcpExtraFlags(tokens, knownNames = []) {
  const known = new Set(knownNames);
  const extras = [];
  const rest = [];
  for (const tok of tokens) {
    const m = /^--(.+)$/.exec(tok);
    if (m && known.has(m[1])) extras.push(m[1]);
    else rest.push(tok);
  }
  return { extras, rest };
}

// Shallow-merge a gitignored machine-local overlay into the committed config.
// Overlay `mcpServers`/`mcpExtras` entries are merged key-by-key (overlay
// wins). Used so machine-specific servers (e.g. circleci with an absolute
// path) stay out of the shared repo.
export function mergeMcpConfigs(base, overlay) {
  if (!overlay) return base;
  return {
    ...base,
    mcpServers: { ...(base?.mcpServers || {}), ...(overlay.mcpServers || {}) },
    mcpExtras: { ...(base?.mcpExtras || {}), ...(overlay.mcpExtras || {}) },
  };
}

// Parse the comma-separated MCP_DEFAULT_EXTRAS env value into a clean list.
export function parseDefaultExtras(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// Effective extras for a session = machine default (always applied) unioned
// with the session's own extras (explicit flags or persisted). Default first,
// deduped. Per the design there is intentionally no per-session opt-out.
export function resolveExtras(defaultExtras = [], sessionExtras = []) {
  return [...new Set([...defaultExtras, ...sessionExtras])];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp-config.test.js`
Expected: PASS (all describe blocks, including the untouched `buildMcpServers`).

- [ ] **Step 5: Commit**

```bash
git add lib/mcp-config.js test/mcp-config.test.js
git commit -m "feat(mcp): dynamic extra flags, config overlay merge, extras resolution helpers"
```

---

## Task 2: Load merged config + constants + command-handler wiring in `index.js`

**Files:**
- Modify: `index.js` (import ≈18; loader ≈68–98; command handlers ≈2712, 2762, 2800, 2821, 2836, 2967)

- [ ] **Step 1: Update the import**

Change line ≈18 from:

```js
import { buildMcpServers, extractMcpExtraFlags, knownMcpExtras } from './lib/mcp-config.js';
```
to:
```js
import {
  buildMcpServers, extractMcpExtraFlags, knownMcpExtras,
  mergeMcpConfigs, parseDefaultExtras, resolveExtras,
} from './lib/mcp-config.js';
```

- [ ] **Step 2: Load the merged config + define constants; replace the sanity loop**

Replace this region (≈68–98):

```js
const RAW_MCP_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-config.json'), 'utf-8'));
const mcpConfigPathCache = new Map(); // sorted-extras-key -> generated file path
```
with:
```js
function loadLocalMcpOverlay() {
  const p = path.join(__dirname, 'mcp-config.local.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.warn(`[mcp-config] Ignoring malformed mcp-config.local.json: ${e.message}`);
    return null;
  }
}
const RAW_MCP_CONFIG = mergeMcpConfigs(
  JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-config.json'), 'utf-8')),
  loadLocalMcpOverlay(),
);
const KNOWN_MCP_EXTRAS = knownMcpExtras(RAW_MCP_CONFIG);
// Per-machine baseline of extras applied to every session (e.g. "circleci").
const DEFAULT_MCP_EXTRAS = parseDefaultExtras(process.env.MCP_DEFAULT_EXTRAS);
const mcpConfigPathCache = new Map(); // sorted-extras-key -> generated file path
```

Then replace the sanity-check loop (≈92–97):

```js
// Sanity check: make sure the bridge's known extras stay in sync with what
// the config file declares.
for (const ex of knownMcpExtras()) {
  if (!RAW_MCP_CONFIG.mcpExtras?.[ex]) {
    console.warn(`[mcp-config] Flag --${ex} is recognised but no matching mcpExtras block exists; sessions opting in will get no extra servers.`);
  }
}
```
with:
```js
// Warn if a machine default names an extra that no config block defines.
for (const ex of DEFAULT_MCP_EXTRAS) {
  if (!KNOWN_MCP_EXTRAS.includes(ex)) {
    console.warn(`[mcp-config] MCP_DEFAULT_EXTRAS lists "${ex}" but no mcpExtras["${ex}"] block exists (in mcp-config.json or mcp-config.local.json); it will be ignored.`);
  }
}
```

(The eager `mcpConfigPathFor([])` call just below stays as-is.)

- [ ] **Step 3: Update the four `extractMcpExtraFlags` call sites to pass known names**

At lines ≈2712, 2800, 2836, 2967, add `, KNOWN_MCP_EXTRAS` as the second argument. Concretely:

```js
// ≈2712 (!start)
const { extras: mcpExtras, rest: positional } = extractMcpExtraFlags(parts.slice(1), KNOWN_MCP_EXTRAS);
// ≈2800 (!restart)
const { extras: restartFlagExtras } = extractMcpExtraFlags(parts.slice(1), KNOWN_MCP_EXTRAS);
// ≈2836 (!resume)
const { extras: resumeExtras, rest: resumeTokens } = extractMcpExtraFlags(parts.slice(1), KNOWN_MCP_EXTRAS);
// ≈2967 (!workdir)
const { extras: workdirExtras, rest: workdirTokens } = extractMcpExtraFlags(parts.slice(1), KNOWN_MCP_EXTRAS);
```

- [ ] **Step 4: Make the `/start` and `/restart` confirmation notes show the EFFECTIVE extras**

At ≈2762 (!start), replace:
```js
const extrasNote = mcpExtras.length > 0 ? ` (extras: ${mcpExtras.join(', ')})` : '';
```
with:
```js
const effectiveStartExtras = resolveExtras(DEFAULT_MCP_EXTRAS, mcpExtras);
const extrasNote = effectiveStartExtras.length > 0 ? ` (extras: ${effectiveStartExtras.join(', ')})` : '';
```

At ≈2821 (!restart), replace:
```js
const extrasLine = effectiveRestartExtras.length > 0
  ? `\nExtras: ${effectiveRestartExtras.join(', ')}`
```
with (note: `effectiveRestartExtras` here is the existing session-level variable; show the resolved set):
```js
const shownRestartExtras = resolveExtras(DEFAULT_MCP_EXTRAS, effectiveRestartExtras);
const extrasLine = shownRestartExtras.length > 0
  ? `\nExtras: ${shownRestartExtras.join(', ')}`
```
and update the following line that references `effectiveRestartExtras.join(', ')}` inside the same ternary to use `shownRestartExtras`. (Leave the `createSession(... { mcpExtras: effectiveRestartExtras })` call at ≈2810 unchanged — it must persist the session-level set, not the resolved one.)

- [ ] **Step 5: Syntax + lint check**

Run: `npm run check && npm run lint`
Expected: PASS (no syntax errors, no lint warnings).

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(mcp): load machine-local overlay + MCP_DEFAULT_EXTRAS, dynamic flag wiring"
```

---

## Task 3: Layer A — `--strict-mcp-config` + effective extras at both spawn sites

**Files:**
- Modify: `index.js` (print-mode ≈290–302; iv-mode ≈508–549)

- [ ] **Step 1: Print-mode spawn — resolve effective extras + add strict flag**

At ≈290, the resolution stays but add the effective set right after it. Replace:
```js
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
```
with:
```js
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
  // Machine default is always applied; mcpExtras (persisted/explicit) stacks on top.
  const effectiveExtras = resolveExtras(DEFAULT_MCP_EXTRAS, mcpExtras);
```

Then in the `args` array (≈302) replace:
```js
    '--mcp-config', mcpConfigPathFor(mcpExtras),
```
with:
```js
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPathFor(effectiveExtras),
```

(`session.mcpExtras = mcpExtras` at ≈356 stays — we persist the session-level set, not the resolved one.)

- [ ] **Step 2: Iv-mode spawn — same change**

At ≈508 replace:
```js
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
```
with:
```js
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
  const effectiveExtras = resolveExtras(DEFAULT_MCP_EXTRAS, mcpExtras);
```

Then in the `claudeArgs.push(...)` block (≈549) replace:
```js
    '--mcp-config', mcpConfigPathFor(mcpExtras),
```
with:
```js
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPathFor(effectiveExtras),
```

(`session.mcpExtras = mcpExtras` at ≈585 stays unchanged.)

- [ ] **Step 3: Syntax check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(mcp): pass --strict-mcp-config and effective extras at both spawn sites"
```

---

## Task 4: Layer B — `CLAUDE_CODE_PLUGIN_CACHE_DIR` (default empty)

**Files:**
- Modify: `index.js` (new constant near other constants ≈100–135; print-mode env ≈349; iv-mode env ≈553)

- [ ] **Step 1: Define the plugin-cache dir constant and ensure it exists**

Near the other module-level constants (after `DEFAULT_MCP_EXTRAS`, e.g. just below the sanity-warning loop), add:
```js
// Plugin MCP servers (context7, serena, …) load from this dir. Default: a
// bridge-owned EMPTY dir so sessions are lean (no plugin MCPs) while ~/.claude
// — creds, transcripts, --resume — stays untouched. Point BRIDGE_PLUGIN_CACHE_DIR
// at the real cache (~/.claude/plugins) or a curated subset to re-enable plugins.
const PLUGIN_CACHE_DIR = process.env.BRIDGE_PLUGIN_CACHE_DIR
  || path.join(os.homedir(), '.claude-matrix-bridge', 'empty-plugin-cache');
try {
  fs.mkdirSync(PLUGIN_CACHE_DIR, { recursive: true });
} catch (e) {
  console.warn(`[plugin-cache] Could not create ${PLUGIN_CACHE_DIR}: ${e.message}`);
}
```

- [ ] **Step 2: Inject into the print-mode spawn env**

In the `spawn('claude', args, { ... env: { ... } })` block (≈349), add the line after `MATRON_BASH_TEE_ENABLED`:
```js
      MATRON_BASH_TEE_ENABLED: showBashOutputAtSpawn ? '1' : '0',
      CLAUDE_CODE_PLUGIN_CACHE_DIR: PLUGIN_CACHE_DIR,
```

- [ ] **Step 3: Inject into the iv-mode spawn env**

In the `createInteractiveSession({ ... env: { ... } })` block (≈553), add after `MATRON_BASH_TEE_ENABLED`:
```js
      MATRON_BASH_TEE_ENABLED: showBashOutputAtSpawn ? '1' : '0',
      CLAUDE_CODE_PLUGIN_CACHE_DIR: PLUGIN_CACHE_DIR,
```

- [ ] **Step 4: Syntax + lint check**

Run: `npm run check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(plugins): default sessions to an empty plugin cache dir (lean), env-overridable"
```

---

## Task 5: Dotfiles, example overlay, and docs

**Files:**
- Modify: `.gitignore`
- Create: `mcp-config.local.example.json`
- Modify: `.env.example`, `README.md`, `BRIDGE_CLAUDE.md`

- [ ] **Step 1: Widen `.gitignore`**

Replace the line `.mcp-config-generated.json` with:
```
.mcp-config-generated*.json
mcp-config.local.json
```

- [ ] **Step 2: Create the example overlay**

Create `mcp-config.local.example.json`:
```json
{
  "_comment": "Per-machine, gitignored overlay. Copy to mcp-config.local.json. Adds machine-specific opt-in MCP servers as `mcpExtras` (enable a `--<name>` flag) and/or always-on `mcpServers`. Keep secrets out of literals.",
  "mcpExtras": {
    "circleci": {
      "circleci": {
        "command": "node",
        "args": ["/absolute/path/to/circleci-mcp/server.js"]
      }
    }
  }
}
```

- [ ] **Step 3: Document env vars in `.env.example`**

After the `# Claude Code defaults` block, add:
```
# MCP / plugin memory (small-VPS friendly; see docs/superpowers/specs)
# Comma-separated extras applied to EVERY session on this machine (names must
# match mcpExtras keys in mcp-config.json or mcp-config.local.json), e.g. circleci
MCP_DEFAULT_EXTRAS=
# Dir that plugin MCP servers (context7, serena, …) load from. Unset = a
# bridge-owned EMPTY dir (no plugin MCPs, lean). Point at ~/.claude/plugins to
# re-enable all plugins, or a curated dir for a subset.
BRIDGE_PLUGIN_CACHE_DIR=
```

- [ ] **Step 4: Document in `README.md`**

Add a subsection (under the MCP/configuration area; if none exists, append a new `## Memory & MCP tuning` section) with:
```markdown
## Memory & MCP tuning

Sessions are lean by default so the bridge runs on small VPS boxes. Only the
bridge's own `ask-user` MCP loads per session; everything else is opt-in.

- **Stdio MCP extras** — defined under `mcpExtras` in `mcp-config.json`
  (committed; e.g. `browser`) or `mcp-config.local.json` (gitignored,
  per-machine; e.g. `circleci`). Enable per session with `/start --<name>`
  (e.g. `/start --browser --circleci`). Sessions run with `--strict-mcp-config`,
  so servers from your personal `~/.claude.json` do NOT leak in.
- **Per-machine default** — `MCP_DEFAULT_EXTRAS=circleci` turns an extra on for
  every session on this machine. Explicit `--flags` stack on top (no per-session
  opt-out; change the env and restart to go lean).
- **Plugin MCP servers** (context7, serena, …) — disabled by default via an
  empty `CLAUDE_CODE_PLUGIN_CACHE_DIR`. Set `BRIDGE_PLUGIN_CACHE_DIR` to
  `~/.claude/plugins` (all plugins) or a curated dir to re-enable. Your
  interactive `~/.claude` (creds, transcripts) is never modified.
```

- [ ] **Step 5: Update `BRIDGE_CLAUDE.md` browser note**

Find the browser-tools paragraph that tells users to run `/restart --browser` and add a sentence: "Other opt-in MCP extras use the same flag form (e.g. `/start --circleci`); available extras depend on this machine's `mcp-config.json` / `mcp-config.local.json`."

- [ ] **Step 6: Syntax check (docs don't affect runtime, but confirm nothing else broke) + commit**

Run: `npm run check`
Expected: PASS.

```bash
git add .gitignore mcp-config.local.example.json .env.example README.md BRIDGE_CLAUDE.md
git commit -m "docs(mcp): document MCP_DEFAULT_EXTRAS, BRIDGE_PLUGIN_CACHE_DIR, local overlay"
```

---

## Task 6: Configure dev-3 (operational — NOT committed)

This machine currently runs bridge sessions WITH circleci + context7 + serena. After Tasks 1–4 the default is lean, so make deliberate per-machine choices. These files/settings are gitignored or live outside the repo.

- [ ] **Step 1: Add circleci as a machine-local extra**

Create `~/claude-matrix-bridge/mcp-config.local.json` (gitignored):
```json
{
  "mcpExtras": {
    "circleci": {
      "circleci": {
        "command": "node",
        "args": ["/home/danbarker/circleci-mcp/server.js"]
      }
    }
  }
}
```

- [ ] **Step 2: Default circleci on for this machine**

Add to the bridge's environment. Preferred: a systemd drop-in (consistent with the existing `iv-mode.conf`):

```bash
sudo systemctl edit claude-matrix-bridge.service
# In the editor, add:
# [Service]
# Environment=MCP_DEFAULT_EXTRAS=circleci
```
(Alternatively add `MCP_DEFAULT_EXTRAS=circleci` to `~/claude-matrix-bridge/.env`.)

- [ ] **Step 3: DECISION — plugin MCPs in bridge sessions on dev-3**

Default (leave `BRIDGE_PLUGIN_CACHE_DIR` unset) → bridge sessions get **no** context7/serena (this is the ~345 MB/session saving; serena/context7 remain available in your interactive `claude`, just not in bridge rooms). To re-enable for bridge sessions, set `BRIDGE_PLUGIN_CACHE_DIR=/home/danbarker/.claude/plugins` (brings back ALL plugins, heavier). **Recommended: leave unset (lean).** Confirm the choice before Step 4.

- [ ] **Step 4: (deferred to Task 7) restart + verify**

---

## Task 7: Verify and restart

**Files:** none (verification only).

- [ ] **Step 1: Full CI gate**

Run: `npm run ci`
Expected: PASS (lint, `node --check`, vitest, `npm audit --audit-level=high`). If the audit step flags pre-existing advisories unrelated to this change, note them but do not block.

- [ ] **Step 2: Confirm strict mode drops user mcpServers (read-only, no API turn)**

Run:
```bash
cd ~/claude-matrix-bridge
node -e 'import("./lib/mcp-config.js").then(async m=>{const fs=require("fs");const base=JSON.parse(fs.readFileSync("mcp-config.json","utf8"));const overlay=fs.existsSync("mcp-config.local.json")?JSON.parse(fs.readFileSync("mcp-config.local.json","utf8")):null;const cfg=m.mergeMcpConfigs(base,overlay);console.log("known extras:",m.knownMcpExtras(cfg));})'
```
Expected: prints `known extras: [ 'browser', 'circleci' ]` (circleci present because the local overlay loaded).

- [ ] **Step 3: Confirm empty plugin cache disables plugin MCPs (read-only)**

Run:
```bash
mkdir -p ~/.claude-matrix-bridge/empty-plugin-cache
CLAUDE_CODE_PLUGIN_CACHE_DIR=~/.claude-matrix-bridge/empty-plugin-cache timeout 60 claude mcp list 2>&1 | grep -c '^plugin:'
```
Expected: `0` (no `plugin:*` servers). Without the override, `claude mcp list` shows several `plugin:*` lines.

- [ ] **Step 4: Restart the service**

Run:
```bash
sudo systemctl restart claude-matrix-bridge.service
systemctl --no-pager status claude-matrix-bridge.service | head -12
```
Expected: `active (running)`. NOTE: this terminates all active bridge sessions (they auto-resume on next message).

- [ ] **Step 5: Smoke-test a real session and measure**

From Matrix, `/start` a fresh room, send one message, then on the host:
```bash
cg=$(systemctl show claude-matrix-bridge.service -p ControlGroup | cut -d= -f2)
for p in $(cat /sys/fs/cgroup$cg/cgroup.procs); do printf "%s %s\n" "$(cat /proc/$p/comm 2>/dev/null)" "$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null)"; done | sort | uniq -c
```
Expected for a default lean session: an `ask-user` node MCP and the `claude` process, but NO `context7`/`serena`/`uv`/`python` MCP processes for that session. With `MCP_DEFAULT_EXTRAS=circleci`, a `circleci` node process should appear. Confirm `--resume` works by sending a follow-up message after an idle reap (or `/restart`) and verifying the session continues.

- [ ] **Step 6: Confirm the empty plugin cache dir did not get repopulated**

Run: `ls -la ~/.claude-matrix-bridge/empty-plugin-cache`
Expected: still empty (no marketplace/plugin files written by spawned sessions). If claude populated it, note what appeared — Layer B may need `CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH=0` added to the spawn env.

---

## Self-Review (completed during planning)

- **Spec coverage:** Layer A strict-mcp-config (Task 3), mcpExtras + local overlay + dynamic flags (Tasks 1–2), `MCP_DEFAULT_EXTRAS` + merge-no-opt-out semantics (Tasks 1–3), Layer B `BRIDGE_PLUGIN_CACHE_DIR` default-empty (Task 4), secrets-out-of-committed-config (Task 5 overlay is gitignored), docs/.env/.gitignore (Task 5), dev-3 per-machine config incl. the "always circleci" case (Task 6), verification incl. resume regression + plugin-cache-repopulation check (Task 7). context7-remote is marked optional in the spec and intentionally omitted from this plan (YAGNI; can be added as an overlay extra later). Full `CLAUDE_CONFIG_DIR` isolation and shared-MCP supervisor are out of scope per spec.
- **Placeholder scan:** none — every code step shows complete code; the one runtime unknown (does claude repopulate the empty cache dir) is an explicit verification step with a concrete fallback, not a placeholder.
- **Type/name consistency:** `mergeMcpConfigs`, `parseDefaultExtras`, `resolveExtras`, `knownMcpExtras(baseConfig)`, `extractMcpExtraFlags(tokens, knownNames)` used identically across lib, tests, and index.js wiring. `effectiveExtras` (spawn) vs `session.mcpExtras` (persisted session-level) distinction is consistent at both spawn sites.
