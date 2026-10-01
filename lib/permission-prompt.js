// Pure helpers for the print-mode permission prompt flow (spec:
// docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md).
//
// Print-mode sessions spawn with `--permission-mode auto` and route every gated
// MCP call through the ask-user MCP server's permission_request tool to the
// bridge, which is the deciding layer (the classifier in permission-eval.js is
// the automatic tier on top; see permissionSpawnArgs and decidePermissionOutcome
// below). Undecided calls surface as a Matron button card. The card's button VALUES
// are namespaced `perm:<requestId>:<verdict>` and ride the journal
// prompt_reply picker path (lib/picker-dispatch.js), exactly like
// `timer:cancel:<id>`. The registry here is the bridge-side pending store the
// tool polls via GET /permission-request/:id — the /secret/:id shape:
// answered entries are consumed on read; unanswered entries expire by TTL in
// lockstep with the tool's own poll deadline, which fail-closes to deny.

import { randomUUID } from 'crypto';
import { classifyPermission } from './permission-eval.js';
import { hookEntry, nodeHookEntry } from './hook-command.js';

export const DENY_MESSAGE = 'The user denied this tool use from Matron.';

const PREVIEW_MAX = 500;

// One expiry policy for the whole request lifecycle: the ask-user tool's poll
// deadline AND the bridge registry's TTL both resolve through here, so a card
// can never outlive the poller that would honor it. Out-of-range overrides
// (NaN, non-positive, infinite, > 1 h) fall back to the 5-minute default
// rather than producing an immediate deny or an unbounded wait.
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300000;
export const MAX_PERMISSION_TIMEOUT_MS = 3600000;

export function resolvePermissionTimeoutMs(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PERMISSION_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_PERMISSION_TIMEOUT_MS
    ? ms
    : DEFAULT_PERMISSION_TIMEOUT_MS;
}

// Bidirectional control characters (RLO/LRO, embeddings, isolates, marks) can
// make a card display reordered text while Claude receives the original value
// — a prompt-injection display-spoof vector. Strip them from everything we
// render; Claude still gets the raw input via updatedInput.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

// Anything a renderer may treat as a line break: CR, LF, NEL, and the Unicode
// line and paragraph separators.
const NOTICE_LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;

function stripBidi(text) {
  return String(text).replace(BIDI_CONTROLS, '');
}

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
  const name = stripBidi(toolName);
  let preview = stripBidi(previewFor(toolName, input));
  if (preview.length > PREVIEW_MAX) preview = `${preview.slice(0, PREVIEW_MAX)}…`;
  return {
    plain: `🔐 Permission: Claude wants to run ${name}\n${preview}`,
    html: `🔐 <b>Permission:</b> Claude wants to run <code>${escapeHtml(name)}</code>`
      + `<br><pre><code>${escapeHtml(preview)}</code></pre>`,
  };
}

export function permissionButtons(requestId, toolName) {
  return {
    buttons: [
      { id: 'perm-allow', label: 'Allow once', value: `perm:${requestId}:allow` },
      { id: 'perm-always', label: `Always allow ${stripBidi(toolName)} (session)`, value: `perm:${requestId}:always` },
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

// Resolve a session's bypassMode: an explicit --bypass/--auto flag wins;
// otherwise the value persisted for the room; otherwise the box default
// (index.js MATRON_PERMISSION_MODE, bypass unless set to 'auto'). Sessions
// persisted before the feature carry no bypassMode and land on the box
// default — which, being bypass, is also exactly how they ran before.
export function resolveBypassMode(flag, persisted, boxDefaultBypass = true) {
  if (typeof flag === 'boolean') return flag;
  if (typeof persisted === 'boolean') return persisted;
  return boxDefaultBypass === true;
}

// The spawn-arg fragment that replaces the hardwired
// '--dangerously-skip-permissions' in index.js print-mode spawns.
//
// The gated (non-bypass) path makes the BRIDGE the deciding layer for MCP calls
// WITHOUT changing which settings sources the CLI loads: the user, project and
// local settings files (with their CLAUDE.md, `env` block, hooks and permission
// rules) all load normally. The bridge decides gated `mcp__*` calls through a
// PreToolUse hook it adds in the session's inline `--settings` (see
// buildPrintSessionSettings). Hooks merge additively across settings sources, so
// the gate runs alongside the user's own hooks, never instead of them.
export function permissionSpawnArgs(bypass) {
  return bypass
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'auto', '--permission-prompt-tool', 'mcp__ask-user__permission_request'];
}

// Claude Code refuses `--dangerously-skip-permissions` when it runs as root:
// it prints "cannot be used with root/sudo privileges for security reasons"
// and exits 1, unless IS_SANDBOX=1 or CLAUDE_CODE_BUBBLEWRAP is set. This
// mirrors that predicate exactly (uid 0, IS_SANDBOX must be the string "1")
// so a bridge deployed as root downgrades to auto mode instead of
// crash-looping every bypass spawn. Codex has no equivalent check.
export function isRootOutsideSandbox(opts = {}) {
  // Resolve getuid via an explicit key check rather than a destructuring
  // default: `{ getuid = process.getuid }` rebinds an *explicitly-passed*
  // `undefined` back to the real `process.getuid`, so a caller (or test)
  // cannot inject "no getuid" to simulate a non-POSIX platform. On a POSIX
  // root host that rebinding makes `process.getuid()` return 0 and the
  // predicate wrongly reports root-outside-sandbox. Honor an explicit
  // `undefined`; fall back to `process.getuid` only when the key is absent.
  const getuid = 'getuid' in opts ? opts.getuid : process.getuid;
  const { env = process.env } = opts;
  if (typeof getuid !== 'function') return false;
  if (getuid() !== 0) return false;
  if (env.IS_SANDBOX === '1') return false;
  if (env.CLAUDE_CODE_BUBBLEWRAP) return false;
  return true;
}

export const ROOT_BYPASS_WARNING =
  'The bridge is running as root, and Claude Code refuses --dangerously-skip-permissions under root. '
  + 'This session falls back to auto permission mode with Matron permission cards. '
  + 'Run the bridge as an unprivileged user, or set IS_SANDBOX=1 in its environment to allow bypass as root.';

// Applied to the resolved bypassMode right before the spawn args are built.
// The persisted per-room choice is left untouched: the downgrade is a
// property of the host, not of the session, so moving the bridge off root
// (or setting IS_SANDBOX=1) restores bypass on the next spawn.
export function guardRootBypass(bypass, opts) {
  if (bypass && isRootOutsideSandbox(opts)) return { bypass: false, downgraded: true };
  return { bypass, downgraded: false };
}

// How long an ANSWERED entry survives waiting for its poller to collect the
// verdict. The unanswered TTL expires in lockstep with the tool's poll
// deadline (see resolvePermissionTimeoutMs); a tap can land in the final
// sub-second before that deadline, so the verdict gets a short grace window
// for the ≤500 ms-later poll instead of being reaped with the card.
const ANSWERED_GRACE_MS = 60000;

// Bridge-side pending-permission store. Pass ttlMs = the same resolved
// permission timeout the ask-user tool polls with: an unanswered card then
// expires exactly when the tool fail-closes to deny, so a late tap can never
// record a verdict (answer() === null → informative no-op) after Claude has
// already received the timeout denial.
export function createPermissionRegistry({
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  mintId = randomUUID,
  ttlMs = DEFAULT_PERMISSION_TIMEOUT_MS,
} = {}) {
  const entries = new Map();
  return {
    create({ roomId, toolName }) {
      const id = mintId();
      const timer = setTimer(() => { entries.delete(id); }, ttlMs);
      entries.set(id, { roomId, toolName, answered: false, behavior: null, message: null, timer });
      return { id };
    },
    // Records a verdict atomically: room affinity and the closed verdict set
    // are checked BEFORE any state changes, so a refused answer leaves the
    // entry pending — the right room can still answer, and a poller never
    // sees a verdict from a tap the bridge refused to honor.
    answer(id, verdict, expectedRoomId) {
      const entry = entries.get(id);
      if (!entry || entry.answered) return null;
      if (verdict !== 'allow' && verdict !== 'always' && verdict !== 'deny') return null;
      if (expectedRoomId !== undefined && entry.roomId !== expectedRoomId) return null;
      clearTimer(entry.timer);
      entry.timer = setTimer(() => { entries.delete(id); }, ANSWERED_GRACE_MS);
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
    // Withdraws a request whose card never reached the user (delivery
    // failure): the POST route cancels and responds non-OK so the tool
    // denies immediately instead of polling a card nobody can see.
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      clearTimer(entry.timer);
      entries.delete(id);
      return true;
    },
    size() { return entries.size; },
  };
}

// --- Classifier → transport decision (spec: MCP permission classifier, #208) ---
//
// The classifier (lib/permission-eval.js) is the pure decision layer; this maps
// its verdict to what the POST /permission-request route returns to the
// permission_request tool. Three outcomes:
//   allow → respond `{behavior:'allow'}` immediately, no card (same tier as an
//           earlier "Always allow" tap: a silent, session-scoped allow).
//   deny  → respond `{behavior:'deny', message: DENY_MESSAGE}` immediately AND
//           surface a plain room notice, so a policy denial is VISIBLE without a
//           card. (ask-user.js honours a POST-level deny in addition to allow.)
//   card  → everything else — `ask`, `default-gated`, and any snapshot marked
//           uncertain (classifyPermission fails closed: uncertain never widens
//           to allow) — falls through UNCHANGED to today's card mint.
export function decidePermissionOutcome(snapshot, toolName) {
  const verdict = classifyPermission(snapshot, toolName);
  if (verdict === 'allow') {
    return { kind: 'allow', body: { behavior: 'allow' } };
  }
  if (verdict === 'deny') {
    return {
      kind: 'deny',
      body: { behavior: 'deny', message: DENY_MESSAGE },
      // stripBidi the tool name like the card path (renderPermissionCard /
      // permissionButtons): a raw name with bidi control characters could
      // display-spoof the notice text. Line breaks (including NEL and the
      // Unicode line/paragraph separators) are collapsed too, so the one-line
      // notice can't be split into what reads as a second message.
      notice: `⛔ blocked \`${stripBidi(toolName).replace(NOTICE_LINE_BREAKS, ' ')}\` by policy`,
    };
  }
  // 'ask' and 'default-gated' both mint a card. Fail-closed: an uncertain
  // snapshot can only ever land here (classifyPermission never returns 'allow'
  // when uncertain), so it prompts rather than silently allowing.
  return { kind: 'card' };
}

// The full POST /permission-request decision sequence, extracted so the ordering
// the route depends on is unit-testable and can't silently drift. Mirrors the
// handler in index.js exactly: an "Always allow (session)" grant is a silent
// allow that short-circuits BEFORE the classifier; otherwise the classifier
// decides (allow-silent / deny-visible / card). Returns WHAT to do — the handler
// still owns the HTTP write, the deny room notice, and the card mint. The
// grant-allow carries source:'grant' so callers/tests can tell it apart from a
// classifier allow.
export function resolvePermissionRequest({ permAllowedTools, snapshot, toolName }) {
  if (permAllowedTools && permAllowedTools.has(toolName)) {
    return { kind: 'allow', body: { behavior: 'allow' }, source: 'grant' };
  }
  return decidePermissionOutcome(snapshot, toolName);
}

// Map the bridge's POST /permission-request JSON response to the ask-user
// permission_request tool's immediate action. Kept here (not inline in
// ask-user.js) so the branches are unit-testable — ask-user.js registers its MCP
// server on import and can't be imported directly. Three actions:
//   allow → the bridge decided allow (a grant or a classifier allow), no card.
//   deny  → the bridge decided deny (a classifier policy deny), no card. Fail
//           CLOSED: a malformed response or a missing request id also denies.
//   poll  → the bridge minted a card; poll requestId until it is answered.
export function classifyPermissionPostResponse(data) {
  if (!data || typeof data !== 'object') {
    return { action: 'deny', message: 'Matron bridge returned an invalid permission response.' };
  }
  if (data.behavior === 'allow') return { action: 'allow' };
  if (data.behavior === 'deny') return { action: 'deny', message: data.message || DENY_MESSAGE };
  const { requestId } = data;
  if (typeof requestId !== 'string' || requestId === '') {
    return { action: 'deny', message: 'Matron bridge returned an invalid permission request id.' };
  }
  return { action: 'poll', requestId };
}

// --- Session-scoped "Always allow" grant helpers (!permissions command) ---
//
// The grant tier is `session.permAllowedTools` — an in-memory Set of EXACT tool
// names written by the card's "Always allow (session)" tap. It is cleared on
// restart (nothing durable, no journal parking), so these operate on the live
// Set only. Names are exact (`mcp__server__tool`), never wildcards.
export function listSessionGrants(permAllowedTools) {
  if (!permAllowedTools) return [];
  return [...permAllowedTools].sort();
}

// Revoke one grant by exact name. Returns true if a grant was removed, false if
// the name wasn't granted (so the caller can report "not currently granted").
export function revokeSessionGrant(permAllowedTools, toolName) {
  if (!permAllowedTools || typeof toolName !== 'string') return false;
  return permAllowedTools.delete(toolName);
}

// MCP servers the bridge itself serves. They are allow-listed in the inline
// settings and never gated (gating the permission_request tool would deadlock).
const INFRA_MCP_SERVERS = ['ask-user', 'show-file'];

// True for an MCP tool call the bridge's gate hook should decide.
export function isGatedMcpTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return false;
  const server = toolName.slice('mcp__'.length).split('__')[0];
  return server !== '' && !INFRA_MCP_SERVERS.includes(server);
}

// PreToolUse hook timeout (seconds) and the hook's own fetch deadline (ms). The
// fetch gives up well before the hook timeout so the hook can still print its
// fail-closed "ask" (a timed-out hook would not block the call at all).
export const PERMISSION_GATE_HOOK_TIMEOUT_S = 30;
export const PERMISSION_GATE_FETCH_TIMEOUT_MS = 10_000;

// Hook entries come from lib/hook-command.js: the `.sh` scripts as shell-form
// commands on POSIX, the `.mjs` ports in exec form (node.exe + args, no
// shell) on Windows.

// The inline `--settings` the bridge passes to every print-mode spawn. Additive:
// it contributes the infra MCP allow rule and the bridge's own hooks, and the CLI
// merges those with whatever the on-disk settings define. A gated session also
// gets the permission gate: a PreToolUse hook on `mcp__.*` that asks the bridge
// (POST /permission-check) and answers allow / deny / ask.
//
// The gate's authority is pinned at spawn: the bridge port and room id are baked
// into the hook command, not read from the environment, because a settings
// `env` block reaches hooks and must not be able to redirect the decision. And
// `disableAllHooks: false` is set explicitly for gated sessions: the inline
// --settings layer outranks the user, project and local settings files, so an
// on-disk `disableAllHooks: true` cannot switch the gate off (the real-CLI test
// in test/permission-gate.test.js checks that precedence).
//
// The cost: a user who set `disableAllHooks: true` to silence their own hooks
// gets them back in gated sessions, because the CLI has no per-source switch.
// That is accepted. The gate is the bridge's authorisation boundary for MCP
// calls, and a project settings file is written by whoever controls the
// checkout, so letting it turn the gate off would hand that boundary to the
// repository. Hooks a user does not want can be removed from their settings
// instead. Bypass sessions gate nothing and leave the key alone.
export function buildPrintSessionSettings({ bypass, hooksDir, apiPort, roomId, platform = process.platform, execPath = process.execPath }) {
  const hook = (name, extra = {}) => hookEntry({ hooksDir, name, platform, execPath, ...extra });
  const preToolUse = [{
    matcher: 'Bash',
    hooks: [hook('matron-bash-tee')],
  }];
  if (!bypass) {
    preToolUse.push({
      matcher: 'mcp__.*',
      hooks: [nodeHookEntry({
        hooksDir,
        name: 'permission-gate',
        args: ['--port', String(apiPort), '--room', String(roomId)],
        timeout: PERMISSION_GATE_HOOK_TIMEOUT_S,
        platform,
        execPath,
      })],
    });
  }
  return {
    ...(bypass ? {} : { disableAllHooks: false }),
    permissions: { allow: INFRA_MCP_SERVERS.map(s => `mcp__${s}`) },
    hooks: {
      PreCompact: [{
        hooks: [hook('compact-notify', { timeout: 5 })],
      }],
      PreToolUse: preToolUse,
    },
  };
}

// The POST /permission-check decision (what the gate hook asks). Same sequence
// as resolvePermissionRequest, but it never mints a card: a call that needs the
// user comes back as `ask`, which makes the CLI route it to the
// permission_request tool, which mints the card through POST /permission-request.
export function resolvePermissionCheck({ permAllowedTools, snapshot, toolName }) {
  const outcome = resolvePermissionRequest({ permAllowedTools, snapshot, toolName });
  if (outcome.kind === 'allow') return { body: { decision: 'allow' } };
  if (outcome.kind === 'deny') {
    return { body: { decision: 'deny', message: outcome.body.message }, notice: outcome.notice };
  }
  return { body: { decision: 'ask' } };
}

// Map the bridge's /permission-check response (or the lack of one) to the
// PreToolUse hook output. Fail CLOSED: anything but a well-formed allow or deny
// is `ask`, so an unreachable or confused bridge never lets a call through
// silently (the permission_request tool then denies if the bridge is still down).
export function permissionGateHookOutput(data) {
  const out = (permissionDecision, permissionDecisionReason) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
  });
  if (data && data.decision === 'allow') return out('allow', 'Allowed by the Matron bridge permission policy.');
  if (data && data.decision === 'deny') {
    return out('deny', typeof data.message === 'string' && data.message ? data.message : DENY_MESSAGE);
  }
  if (data && data.decision === 'ask') return out('ask', 'Needs approval in Matron.');
  return out('ask', 'The Matron bridge permission check was unavailable, so this call needs approval.');
}
