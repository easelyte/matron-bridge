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
// answered entries are consumed on read; unanswered entries expire by TTL in
// lockstep with the tool's own poll deadline, which fail-closes to deny.

import { randomUUID } from 'crypto';

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
export function permissionSpawnArgs(bypass) {
  return bypass
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'auto', '--permission-prompt-tool', 'mcp__ask-user__permission_request'];
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
