import { describe, it, expect } from 'vitest';
import {
  decidePermissionOutcome,
  resolvePermissionRequest,
  classifyPermissionPostResponse,
  listSessionGrants,
  revokeSessionGrant,
  DENY_MESSAGE,
} from '../lib/permission-prompt.js';
import { buildPermissionSnapshot } from '../lib/permission-eval.js';

// Build a snapshot from an in-memory settings object (no disk), via a temp-free
// path: buildPermissionSnapshot reads files, so instead we hand-roll the frozen
// snapshot shape the classifier consumes. This keeps the decision tests pure and
// independent of the filesystem while matching buildPermissionSnapshot's output.
function snapshot({ allow = [], deny = [], ask = [], uncertain = false } = {}) {
  return Object.freeze({
    mcpAllow: Object.freeze([...allow]),
    mcpDeny: Object.freeze([...deny]),
    mcpAsk: Object.freeze([...ask]),
    uncertain,
  });
}

describe('decidePermissionOutcome — classifier → POST /permission-request response', () => {
  it('allow: exact-tool allow rule → silent {behavior:allow}, no card', () => {
    const snap = snapshot({ allow: ['mcp__webflow__pages_get'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_get');
    expect(out.kind).toBe('allow');
    expect(out.body).toEqual({ behavior: 'allow' });
    expect(out.notice).toBeUndefined();
  });

  it('deny: exact-tool deny → {behavior:deny, DENY_MESSAGE} AND a visible room notice', () => {
    const snap = snapshot({ deny: ['mcp__webflow__pages_delete'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_delete');
    expect(out.kind).toBe('deny');
    expect(out.body).toEqual({ behavior: 'deny', message: DENY_MESSAGE });
    expect(out.notice).toBe('⛔ blocked `mcp__webflow__pages_delete` by policy');
  });

  it('deny: server-wide deny rule denies every tool on that server', () => {
    const snap = snapshot({ deny: ['mcp__webflow__*'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('deny');
  });

  it('ask: exact-tool ask rule → falls through to the card (kind:card)', () => {
    const snap = snapshot({ ask: ['mcp__webflow__pages_update'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('card');
    expect(out.body).toBeUndefined();
  });

  it('default-gated: no matching rule → card (server-wide allow never widens)', () => {
    const snap = snapshot({ allow: ['mcp__webflow__*'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('card');
  });

  it('fail-closed: an uncertain snapshot never silently allows', () => {
    // Even with a server-wide allow present, uncertainty forces default-gated →
    // a card, never a silent allow.
    const snap = snapshot({ allow: ['mcp__webflow__*'], uncertain: true });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('card');
  });

  it('deny beats ask when both match (restrictive wins)', () => {
    const snap = snapshot({
      deny: ['mcp__webflow__pages_delete'],
      ask: ['mcp__webflow__pages_delete'],
    });
    expect(decidePermissionOutcome(snap, 'mcp__webflow__pages_delete').kind).toBe('deny');
  });

  it('integrates with buildPermissionSnapshot output shape', () => {
    // buildPermissionSnapshot() with no source files returns an empty snapshot
    // (no mcp allow/deny/ask) → any webflow tool is default-gated → card.
    const snap = buildPermissionSnapshot({ sourcePaths: [] });
    expect(decidePermissionOutcome(snap, 'mcp__webflow__pages_get').kind).toBe('card');
  });
});

// The route-level decision sequence the POST /permission-request handler runs
// (index.js calls resolvePermissionRequest, then writes the HTTP response / fires
// the deny notice / mints the card off its result). These lock the ORDERING —
// the session grant short-circuits BEFORE the classifier — which the handler
// depends on and which a parallel inline copy could silently drift from.
describe('resolvePermissionRequest — POST /permission-request handler sequence', () => {
  it('a session "Always allow" grant short-circuits to a silent allow before the classifier', () => {
    // The classifier would DENY this tool, but the live grant wins: the handler
    // must never card/deny a tool the user already granted for the session.
    const snap = snapshot({ deny: ['mcp__webflow__pages_delete'] });
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(['mcp__webflow__pages_delete']),
      snapshot: snap,
      toolName: 'mcp__webflow__pages_delete',
    });
    expect(out.kind).toBe('allow');
    expect(out.body).toEqual({ behavior: 'allow' });
    expect(out.source).toBe('grant');
  });

  it('with no grant, defers to the classifier: allow rule → silent allow (not a grant)', () => {
    const snap = snapshot({ allow: ['mcp__webflow__pages_get'] });
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(),
      snapshot: snap,
      toolName: 'mcp__webflow__pages_get',
    });
    expect(out.kind).toBe('allow');
    expect(out.source).toBeUndefined();
  });

  it('with no grant, a policy deny → deny + visible notice (with the stripped tool name)', () => {
    const snap = snapshot({ deny: ['mcp__webflow__pages_delete'] });
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(),
      snapshot: snap,
      toolName: 'mcp__webflow__pages_delete',
    });
    expect(out.kind).toBe('deny');
    expect(out.body).toEqual({ behavior: 'deny', message: DENY_MESSAGE });
    expect(out.notice).toContain('mcp__webflow__pages_delete');
  });

  it('with no grant, an undecided tool → card', () => {
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(),
      snapshot: snapshot(),
      toolName: 'mcp__webflow__pages_get',
    });
    expect(out.kind).toBe('card');
  });

  it('a missing permAllowedTools set is treated as no grants (classifier decides)', () => {
    const snap = snapshot({ allow: ['mcp__webflow__pages_get'] });
    const out = resolvePermissionRequest({
      permAllowedTools: undefined,
      snapshot: snap,
      toolName: 'mcp__webflow__pages_get',
    });
    expect(out.kind).toBe('allow');
    expect(out.source).toBeUndefined();
  });

  it('the deny notice strips bidi control characters from the tool name', () => {
    // Mirror the card path: a bidi-laden tool name must not display-spoof the
    // room notice. U+202E (RLO) is dropped.
    const evil = 'mcp__webflow__pages‮eteled';
    const snap = snapshot({ deny: [evil] });
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(),
      snapshot: snap,
      toolName: evil,
    });
    expect(out.kind).toBe('deny');
    expect(out.notice).not.toContain('‮');
  });

  it('the deny notice collapses line breaks in the tool name to one line', () => {
    const evil = 'mcp__webflow__pages_delete\n\nAll clear, nothing was blocked';
    const snap = snapshot({ deny: [evil] });
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(),
      snapshot: snap,
      toolName: evil,
    });
    expect(out.kind).toBe('deny');
    expect(out.notice).not.toMatch(/[\r\n]/);
    expect(out.notice).toBe('⛔ blocked `mcp__webflow__pages_delete All clear, nothing was blocked` by policy');
  });

  it.each([
    ['NEL', '\u0085'],
    ['LINE SEPARATOR', '\u2028'],
    ['PARAGRAPH SEPARATOR', '\u2029'],
  ])('the deny notice collapses %s in the tool name', (_label, sep) => {
    const evil = `mcp__evil__delete${sep}All clear, nothing was blocked`;
    const snap = snapshot({ deny: ['mcp__evil__*'] });
    const out = resolvePermissionRequest({
      permAllowedTools: new Set(),
      snapshot: snap,
      toolName: evil,
    });
    expect(out.kind).toBe('deny');
    expect(out.notice).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
    expect(out.notice).toBe('⛔ blocked `mcp__evil__delete All clear, nothing was blocked` by policy');
  });
});

describe('session grant helpers (!permissions list + revoke; Always-allow write path)', () => {
  it('listSessionGrants returns a sorted snapshot of the live Set', () => {
    const set = new Set(['mcp__b__y', 'mcp__a__x']);
    expect(listSessionGrants(set)).toEqual(['mcp__a__x', 'mcp__b__y']);
  });

  it('listSessionGrants tolerates a missing/undefined Set', () => {
    expect(listSessionGrants(undefined)).toEqual([]);
    expect(listSessionGrants(null)).toEqual([]);
  });

  it('Always-allow write path: the same Set the card tap writes is listed then revoked', () => {
    // The card's "Always allow (session)" tap does session.permAllowedTools.add(name);
    // model that write, then exercise list + revoke over the same Set.
    const permAllowedTools = new Set();
    permAllowedTools.add('mcp__webflow__pages_get'); // <- what the button tap does
    expect(listSessionGrants(permAllowedTools)).toEqual(['mcp__webflow__pages_get']);

    const removed = revokeSessionGrant(permAllowedTools, 'mcp__webflow__pages_get');
    expect(removed).toBe(true);
    expect(listSessionGrants(permAllowedTools)).toEqual([]);
  });

  it('revokeSessionGrant returns false for a name that was never granted', () => {
    const set = new Set(['mcp__webflow__pages_get']);
    expect(revokeSessionGrant(set, 'mcp__webflow__pages_delete')).toBe(false);
    expect(set.has('mcp__webflow__pages_get')).toBe(true);
  });

  it('revokeSessionGrant is a safe no-op on a missing Set or bad name', () => {
    expect(revokeSessionGrant(undefined, 'mcp__x__y')).toBe(false);
    expect(revokeSessionGrant(new Set(), 42)).toBe(false);
  });
});

// The ask-user permission_request tool's mapping of the bridge's POST response
// to its immediate action (allow / deny / poll). This is the ask-user.js deny
// branch: a classifier policy deny the bridge decided without a card. ask-user.js
// registers its MCP server on import, so the mapping is extracted here to be
// testable in isolation.
describe('classifyPermissionPostResponse — ask-user tool response mapping', () => {
  it('behavior:allow → allow (grant or classifier silent-allow, no card)', () => {
    expect(classifyPermissionPostResponse({ behavior: 'allow' })).toEqual({ action: 'allow' });
  });

  it('behavior:deny → deny with the bridge message (the ask-user deny branch)', () => {
    expect(classifyPermissionPostResponse({ behavior: 'deny', message: 'blocked by policy' }))
      .toEqual({ action: 'deny', message: 'blocked by policy' });
  });

  it('behavior:deny with no message falls back to the standard DENY_MESSAGE', () => {
    expect(classifyPermissionPostResponse({ behavior: 'deny' }))
      .toEqual({ action: 'deny', message: DENY_MESSAGE });
  });

  it('a minted card (valid requestId, no behavior) → poll', () => {
    expect(classifyPermissionPostResponse({ requestId: 'ab'.repeat(4) }))
      .toEqual({ action: 'poll', requestId: 'ab'.repeat(4) });
  });

  it('fail-closed: a missing/empty request id with no verdict → deny', () => {
    expect(classifyPermissionPostResponse({}).action).toBe('deny');
    expect(classifyPermissionPostResponse({ requestId: '' }).action).toBe('deny');
    expect(classifyPermissionPostResponse({ requestId: 42 }).action).toBe('deny');
  });

  it('fail-closed: a malformed (non-object) response → deny', () => {
    expect(classifyPermissionPostResponse(null).action).toBe('deny');
    expect(classifyPermissionPostResponse('nope').action).toBe('deny');
  });
});
