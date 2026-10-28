import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createLoginExpiryNotice,
  isLoginExpiredText,
  loginExpiredFromAssistantEvent,
  loginExpiredMessage,
  loginExpiredCardText,
  loginButtons,
} from '../lib/login-expiry.js';
import { isPickerFrame, pickerFrameValues } from '../lib/journal-input-router.js';
import { handlePickerValue } from '../lib/picker-dispatch.js';

const RAW = 'Failed to authenticate: OAuth session expired and could not be refreshed';

// The record Claude Code 2.1.x writes when the stored login can't be refreshed.
function errorRecord(text = RAW, extra = {}) {
  return {
    type: 'assistant',
    isSidechain: false,
    isApiErrorMessage: true,
    error: 'authentication_failed',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  };
}

describe('isLoginExpiredText', () => {
  it.each([
    RAW,
    'Failed to authenticate. OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    `  ${RAW}\n`,
  ])('matches %j', (text) => {
    expect(isLoginExpiredText(text)).toBe(true);
  });

  it.each([
    // Not fixed by logging in again.
    'Failed to authenticate. API Error: 403 Unable to verify organization membership.',
    // A reply that quotes the error is not the error.
    `The session posted "${RAW}" earlier.`,
    `${RAW}\n\nHere is what I found in the logs.`,
    '',
    null,
    undefined,
  ])('does not match %j', (text) => {
    expect(isLoginExpiredText(text)).toBe(false);
  });
});

describe('loginExpiredFromAssistantEvent', () => {
  it('recognises the error record', () => {
    expect(loginExpiredFromAssistantEvent(errorRecord())).toBe(true);
  });

  it('trusts the wording on a synthetic record without the error flag', () => {
    const e = errorRecord();
    delete e.isApiErrorMessage;
    expect(loginExpiredFromAssistantEvent(e)).toBe(true);
  });

  it('ignores a real model saying the same sentence', () => {
    const e = errorRecord();
    delete e.isApiErrorMessage;
    e.message.model = 'claude-opus-5-5';
    expect(loginExpiredFromAssistantEvent(e)).toBe(false);
  });

  it('ignores subagent records, other errors and multi-block messages', () => {
    expect(loginExpiredFromAssistantEvent(errorRecord(RAW, { isSidechain: true }))).toBe(false);
    expect(loginExpiredFromAssistantEvent(errorRecord("You've reached your Fable limit."))).toBe(false);
    const multi = errorRecord();
    multi.message.content.push({ type: 'tool_use', id: 't', name: 'Bash', input: {} });
    expect(loginExpiredFromAssistantEvent(multi)).toBe(false);
    expect(loginExpiredFromAssistantEvent({ type: 'result', result: RAW })).toBe(false);
    expect(loginExpiredFromAssistantEvent(null)).toBe(false);
  });
});

describe('loginExpiredMessage', () => {
  it('names the box and the login step', () => {
    const m = loginExpiredMessage('box-a');
    expect(m).toContain('**box-a**');
    expect(m).toContain('`/login`');
    expect(m).not.toContain('OAuth');
  });
  it('falls back to "this box"', () => {
    expect(loginExpiredMessage('')).toContain('this box');
  });
});

function fakeClient(responses = [{ status: 201, data: { item: { num: 7 } } }]) {
  const calls = [];
  let i = 0;
  return {
    calls,
    create: vi.fn(async (body, opts) => {
      calls.push({ body, opts });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    }),
  };
}

describe('createLoginExpiryNotice', () => {
  const day1 = Date.parse('2026-01-05T09:00:00Z');

  it('files one notice naming the box, keyed by box and day', async () => {
    const client = fakeClient();
    const n = createLoginExpiryNotice({ client, box: () => 'box-a', now: () => day1 });
    await n.maybeFile('convo-1');
    await n.maybeFile('convo-2');
    expect(client.create).toHaveBeenCalledTimes(1);
    const { body, opts } = client.calls[0];
    expect(body.kind).toBe('notice');
    expect(body.title).toBe('Claude needs you to log in again on box-a');
    expect(body.body).toContain('/login');
    expect(body.convo_id).toBe('convo-1');
    expect(body).not.toHaveProperty('actions');
    expect(opts.idemKey).toBe('claude-login-expired-2026-01-05');
  });

  it('files again on a later day', async () => {
    const client = fakeClient();
    let t = day1;
    const n = createLoginExpiryNotice({ client, box: 'box-a', now: () => t });
    await n.maybeFile('convo-1');
    t += 24 * 3600 * 1000;
    await n.maybeFile('convo-1');
    expect(client.calls.map((c) => c.opts.idemKey)).toEqual([
      'claude-login-expired-2026-01-05',
      'claude-login-expired-2026-01-06',
    ]);
  });

  it('falls back to a task on a journal without notices', async () => {
    const client = fakeClient([{ status: 400 }, { status: 201 }]);
    const n = createLoginExpiryNotice({ client, box: 'box-a', now: () => day1 });
    await n.maybeFile('convo-1');
    expect(client.calls[1].body).toMatchObject({ kind: 'task', awaiting: 'user' });
    expect(client.calls[1].opts.idemKey).toBe(client.calls[0].opts.idemKey);
  });

  it('retries after a failure and never throws', async () => {
    const client = fakeClient([{ status: 0 }, { status: 201 }]);
    const n = createLoginExpiryNotice({ client, box: 'box-a', now: () => day1 });
    await n.maybeFile('convo-1');
    await n.maybeFile('convo-1');
    expect(client.create).toHaveBeenCalledTimes(2);
    const broken = { create: vi.fn(async () => { throw new Error('down'); }) };
    await expect(createLoginExpiryNotice({ client: broken, box: 'box-a' }).maybeFile('c')).resolves.toBeUndefined();
  });

  it('does nothing without a journal or a convo', async () => {
    const client = fakeClient();
    await createLoginExpiryNotice({ client: null, box: 'box-a' }).maybeFile('c');
    await createLoginExpiryNotice({ client, box: 'box-a' }).maybeFile(null);
    expect(client.create).not.toHaveBeenCalled();
  });
});

// index.js cannot be imported in-process, so the wiring is pinned by source
// inspection (see test/stall-wiring.test.js).
describe('login-expiry wiring (source inspection)', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const slice = (a, b) => {
    const s = index.indexOf(a);
    expect(s).toBeGreaterThan(-1);
    return index.slice(s, index.indexOf(b, s + a.length));
  };

  it('swaps the error record text in the assistant case', () => {
    const c = slice("    case 'assistant': {", "    case 'result': {");
    expect(c).toContain('if (loginExpiredFromAssistantEvent(event)) {');
    expect(c).toContain("const line = noteLoginExpired(session, messageId ?? Symbol('login-card'));");
    expect(c).toContain('textParts = line ? [line] : [];');
  });

  it('swaps a login error in the print-mode result text', () => {
    const c = slice("    case 'result': {", '    default:');
    expect(c).toContain('if (isLoginExpiredText(text)) text = noteLoginExpired(session);');
  });

  it('files the notice against the session conversation', () => {
    const fn = slice('function noteLoginExpired(session, key = null) {', '\n}');
    expect(fn).toContain('loginExpiryNotice.maybeFile(journalConvoIdFor(session))');
  });

  it('posts a non-blocking card with the Log in button, falling back to the text line', () => {
    const fn = slice('function noteLoginExpired(session, key = null) {', '\n}');
    expect(fn).toContain("options: loginButtons(), mode: 'pick_one', blocking: false");
    expect(fn).toContain("if (!journalPublish(session, 'publishPrompt', card)) return loginExpiredMessage(box);");
  });

  it('journalPublish reports whether the frame was accepted', () => {
    const fn = slice('function journalPublish(session, method, payload, options) {', '\n}');
    expect(fn).toContain('if (!JOURNAL_ENABLED) return false;');
    expect(fn).toContain('return journalPublisher[method](convoId, payload, options) !== false;');
  });

  it('wires the tap to the same handler a typed /login runs', () => {
    expect(index).toContain('startLogin: startLoginFromButton,');
    const fn = slice('function startLoginFromButton(session, sendReply) {', '\n}');
    expect(fn).toContain("handleCommand(session.roomId, '!login', sendReply, ctx.sendHtml, ctx.sender)");
  });
});

describe('login-expired card', () => {
  it('names the box and says to tap Log in or send /login', () => {
    const text = loginExpiredCardText('ang');
    expect(text).toContain('ang');
    expect(text).toContain('Tap Log in');
    expect(text).toContain('/login');
    expect(loginExpiredCardText('')).toContain('this box');
  });

  it('is a picker frame offering login:start', () => {
    const payload = { question: loginExpiredCardText('ang'), options: loginButtons(), mode: 'pick_one' };
    expect(isPickerFrame(payload)).toBe(true);
    expect([...pickerFrameValues(payload)]).toEqual(['login:start']);
  });

  it('a tap dispatches to startLogin', () => {
    const startLogin = vi.fn();
    const sendReply = vi.fn();
    const session = { roomId: 'room-1' };
    expect(handlePickerValue('login:start', 'room-1', session, { startLogin, sendReply })).toBe(true);
    expect(startLogin).toHaveBeenCalledWith(session, sendReply);
  });

  it('rejects any other login value without touching a seam', () => {
    const startLogin = vi.fn();
    for (const bad of ['login:', 'login:logout', 'login:start:1', 'login:START']) {
      expect(handlePickerValue(bad, 'room-1', {}, { startLogin })).toBe(false);
    }
    expect(startLogin).not.toHaveBeenCalled();
  });

  it('reports a login that failed to start', async () => {
    const sendReply = vi.fn();
    const startLogin = vi.fn(() => Promise.reject(new Error('boom')));
    handlePickerValue('login:start', 'room-1', {}, { startLogin, sendReply });
    await new Promise(r => setTimeout(r, 0));
    expect(sendReply).toHaveBeenCalledWith('⚠️ Could not start the login: boom');
  });
});
