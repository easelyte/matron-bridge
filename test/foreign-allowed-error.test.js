import { describe, it, expect } from 'vitest';
import { createForeignSessions, ALLOW_LABEL } from '../lib/foreign-session.js';
import { allowanceTurnText, allowedCallErrorLine, ALLOWED_ERROR_MAX } from '../lib/foreign-turn.js';

// When the one call an "Allow once" permitted fails, the bridge says so on
// the Allow once item itself and hands it back to the user, so the
// restricted turn has no reason to file a notice about its own failed call.
function rig({ reopenStatus = 200 } = {}) {
  const calls = [];
  const sent = [];
  const fs = createForeignSessions({
    sharing: { personRoom: async () => ({ status: 404, data: {} }) },
    items: {
      get: async () => ({ status: 404, data: {} }),
      create: async () => ({ status: 201, data: { item: { id: 'it_ask', num: 5 } } }),
      close: async () => ({ status: 200, data: {} }),
      reopen: async (id, body) => { calls.push(['reopen', id, body]); return { status: reopenStatus, data: {} }; },
      update: async (id, body) => { calls.push(['update', id, body]); return { status: 200, data: {} }; },
    },
    journalConvoIdFor: (s) => `convo-${s.roomId}`,
    sendText: (s, text) => { sent.push(text); return true; },
    publishNotice: () => {},
    isOccupied: () => false,
    flag: { set: () => {}, clear: () => {} },
    store: { load: () => ({}), save: () => {} },
    log: { warn: () => {} },
  });
  return { fs, calls, sent };
}

// An allowed Bash call, in the turn the tap starts.
async function allowedTurn(r) {
  const s = { roomId: 'sess-a', alive: true, foreignTurn: null };
  r.fs.begin(s, { roomId: 'room-1', person: 'alice', role: 'owner', mission: null });
  await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'cat gone.txt' }, why: 'w' });
  r.fs.end(s);
  r.fs.onItemReply(s, { item_id: 'it_ask', action: 'commented', comment: { action: ALLOW_LABEL } });
  expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'cat gone.txt' }, tool_use_id: 'toolu_1' })).decision).toBe('allow');
  return s;
}

describe('an allowed call that fails', () => {
  it('is commented on the Allow once item, which goes back to the user', async () => {
    const r = rig();
    const s = await allowedTurn(r);
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_1', is_error: true, content: [{ type: 'text', text: 'cat: gone.txt: No such file or directory' }] })).toBe(true);
    expect(r.calls[0]).toEqual(['reopen', 'it_ask', { comment: expect.stringMatching(/allowed \(Bash\) failed: cat: gone\.txt: No such file or directory\./), as_convo_id: 'convo-sess-a' }]);
    expect(r.calls[1]).toEqual(['update', 'it_ask', { awaiting: 'user' }]);
  });
  it('is reported once, and only for that call', async () => {
    const r = rig();
    const s = await allowedTurn(r);
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_other', is_error: true, content: 'x' })).toBe(false);
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_1', is_error: true, content: 'x' })).toBe(true);
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_1', is_error: true, content: 'x' })).toBe(false);
    expect(r.calls.filter((c) => c[0] === 'reopen')).toHaveLength(1);
  });
  it('says nothing when the call worked', async () => {
    const r = rig();
    const s = await allowedTurn(r);
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_1', is_error: false, content: 'ok' })).toBe(false);
    expect(r.calls).toEqual([]);
  });
  it('leaves the item alone when it could not be reopened', async () => {
    const r = rig({ reopenStatus: 500 });
    const s = await allowedTurn(r);
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_1', is_error: true, content: 'x' })).toBe(false);
    expect(r.calls.map((c) => c[0])).toEqual(['reopen']);
  });
  it('is not tracked without a tool_use_id on the hook input', async () => {
    const r = rig();
    const s = { roomId: 'sess-a', alive: true, foreignTurn: null };
    r.fs.begin(s, { roomId: 'room-1', person: 'alice', role: 'owner', mission: null });
    await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'ls' }, why: 'w' });
    r.fs.end(s);
    r.fs.onItemReply(s, { item_id: 'it_ask', action: 'commented', comment: { action: ALLOW_LABEL } });
    await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(await r.fs.onToolResult(s, { tool_use_id: 'toolu_1', is_error: true, content: 'x' })).toBe(false);
  });
  it('the turn tells the agent the bridge reports it', () => {
    const t = allowanceTurnText({ roomId: 'room-1', person: 'alice', role: 'owner', mission: null }, { toolName: 'Bash', decision: 'allow', toolInput: {} });
    expect(t).toMatch(/the bridge reports the error to your user on the Allow once item itself: do not file a foreign_notice about your own failed call/);
  });
});

describe('the error line', () => {
  it('is one line, cut short', () => {
    const line = allowedCallErrorLine('Bash', `first\nsecond ${'x '.repeat(400)}`);
    expect(line).not.toMatch(/\n/);
    expect(line.length).toBeLessThan(ALLOWED_ERROR_MAX + 200);
    expect(line).toContain('…');
  });
  it('drops anything shaped like a credential', () => {
    const line = allowedCallErrorLine('Bash', 'curl failed: Authorization: Bearer abc123 token=hunter2 sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(line).not.toMatch(/abc123|hunter2|sk-abcdef/);
    expect(allowedCallErrorLine('Bash', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPx invalid')).not.toMatch(/wJalr|K7MDENG/);
    expect(allowedCallErrorLine('Bash', 'connect postgres://app:hunter2@db/x refused')).not.toMatch(/hunter2/);
  });
  it('carries no image syntax', () => {
    expect(allowedCallErrorLine('Bash', 'bad ![x](https://example.com/t?u=1)')).not.toContain('![');
  });
});
