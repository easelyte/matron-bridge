// Ratchet: a bridge-composed turn that joins a busy session's queue must not
// raise the "Send this queued message now?" card. Every production call that
// feeds the user-message queue (journalRouteTextToSession, journalQueueMedia)
// therefore either passes `bridgeOrigin: true` or is on the short allowlist
// below of callers that carry text a person wrote, or is a flag-forwarding
// caller whose own caller decides per turn. A new call site fails here
// until its author decides which kind it is.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

const CALLEES = ['journalRouteTextToSession', 'journalQueueMedia'];

// "<callee> in <enclosing function or property>" -> why it is user-authored.
const USER_AUTHORED = {
  'journalRouteTextToSession in journalOnText': 'text typed in a Matron chat',
  'journalQueueMedia in queueMedia': 'media, voice notes and files the user sent',
};

// Callers that carry both kinds of text and forward the router's per-turn flag
// instead of fixing it: the item-turn router sets bridgeOrigin for a tracker
// comment another agent wrote, and leaves it unset for the user's own replies
// and taps (lib/items-turn.js).
const FLAG_FORWARDED = {
  'journalQueueMedia in queueText': 'tracker comments: agent-authored ones are bridge-origin, the user\'s replies and taps are not',
};

// Argument text of the call whose "(" is at `open`, up to the matching ")".
function argsAt(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced call in index.js');
}

// The nearest declaration above: `function name(` or an object-literal
// property holding a function (`name: (...) =>`, `name: async (...) =>`).
function enclosing(src, at) {
  const lines = src.slice(0, at).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:async )?function (\w+)\(/) || lines[i].match(/^\s+(\w+): (?:async )?\(/);
    if (m) return m[1];
  }
  return '(top level)';
}

function productionCalls(src) {
  const calls = [];
  for (const callee of CALLEES) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.])${callee}\\b`, 'g'))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const line = src.slice(lineStart, src.indexOf('\n', m.index));
      if (/^\s*\/\//.test(line)) continue; // prose
      if (/^(?:async )?function /.test(line)) continue; // the definition
      const rest = src.slice(m.index + callee.length);
      if (!rest.startsWith('(')) {
        calls.push({ callee, where: enclosing(src, m.index), args: null });
        continue;
      }
      calls.push({ callee, where: enclosing(src, m.index), args: argsAt(src, m.index + callee.length) });
    }
  }
  return calls;
}

describe('bridge-origin ratchet', () => {
  const calls = productionCalls(source);

  it('finds the production call sites at all', () => {
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });

  it('every call passes bridgeOrigin: true or is a named user-authored caller', () => {
    const unmarked = calls
      .filter((c) => !(c.args && /\bbridgeOrigin: true\b/.test(c.args)))
      .map((c) => `${c.callee} in ${c.where}`)
      .filter((id) => !(id in USER_AUTHORED) && !(id in FLAG_FORWARDED));
    expect(unmarked, 'these callers queue without bridgeOrigin: true; pass it if the text is bridge-composed, or add the caller to USER_AUTHORED if a person wrote it').toEqual([]);
  });

  it('a flag-forwarding caller passes the per-turn bridgeOrigin value, never a fixed true', () => {
    for (const id of Object.keys(FLAG_FORWARDED)) {
      const matching = calls.filter((c) => `${c.callee} in ${c.where}` === id);
      expect(matching.length, `${id} is listed but no such call exists`).toBeGreaterThan(0);
      for (const c of matching) {
        expect(c.args ?? '').toMatch(/\bbridgeOrigin\b(?!: true)/);
        expect(c.args ?? '').not.toMatch(/bridgeOrigin: true/);
      }
    }
  });

  it('a user-authored caller never claims bridgeOrigin, and the allowlist has no stale entries', () => {
    for (const id of Object.keys(USER_AUTHORED)) {
      const matching = calls.filter((c) => `${c.callee} in ${c.where}` === id);
      expect(matching.length, `${id} is allowlisted but no such call exists`).toBeGreaterThan(0);
      for (const c of matching) expect(c.args ?? '').not.toMatch(/bridgeOrigin: true/);
    }
  });
});
