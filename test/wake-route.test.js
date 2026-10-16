import { describe, it, expect, vi } from 'vitest';
import { createWakeHandler, WAKE_COALESCE_MS } from '../lib/wake-route.js';

const CONVO = 'convo-a';
const TEXT = 'check the overnight queue';

function setup({ session = { alive: true, busy: false }, resumed = null, ...overrides } = {}) {
  let clock = 1_000_000;
  const deps = {
    convoId: CONVO,
    text: TEXT,
    findSession: vi.fn(() => session),
    resumeConvo: vi.fn(() => resumed),
    routeText: vi.fn(async () => {}),
    publishNotice: vi.fn(),
    isPending: vi.fn((s) => !!s.busy),
    now: () => clock,
    ...overrides,
  };
  const handle = createWakeHandler(deps);
  return { handle, deps, advance: (ms) => { clock += ms; } };
}

describe('wake route', () => {
  it.each([
    ['no convo id', { convoId: '' }],
    ['no text', { text: '' }],
    ['neither', { convoId: undefined, text: undefined }],
  ])('is off when unconfigured (%s)', async (_label, overrides) => {
    const { handle, deps } = setup(overrides);
    expect(await handle()).toEqual({ status: 404, body: { error: 'wake is not configured' } });
    expect(deps.findSession).not.toHaveBeenCalled();
    expect(deps.routeText).not.toHaveBeenCalled();
  });

  it('delivers the fixed text to a live session, with a visible notice', async () => {
    const session = { alive: true };
    const { handle, deps } = setup({ session });
    expect(await handle()).toEqual({ status: 200, body: { ok: true, resumed: false } });
    expect(deps.findSession).toHaveBeenCalledWith(CONVO);
    expect(deps.resumeConvo).not.toHaveBeenCalled();
    expect(deps.routeText).toHaveBeenCalledWith(session, TEXT);
    expect(deps.publishNotice).toHaveBeenCalledWith(`⏰ Wake: "${TEXT}"`, session);
  });

  it('resumes a reaped session, then delivers to the resumed one', async () => {
    const resumed = { alive: true };
    const { handle, deps } = setup({ session: { alive: false }, resumed });
    expect(await handle()).toEqual({ status: 200, body: { ok: true, resumed: true } });
    expect(deps.resumeConvo).toHaveBeenCalledWith(CONVO);
    expect(deps.routeText).toHaveBeenCalledWith(resumed, TEXT);
  });

  it('answers 503 and delivers nothing when the session cannot be resumed', async () => {
    const { handle, deps } = setup({ session: null, resumed: null });
    const res = await handle();
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual(expect.any(String));
    expect(deps.routeText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith(expect.stringContaining('was not delivered'), null);
  });

  it('coalesces a second wake within the window while the first is still pending', async () => {
    const session = { alive: true, busy: false };
    const { handle, deps, advance } = setup({ session });
    await handle();
    session.busy = true;
    advance(WAKE_COALESCE_MS - 1);
    expect(await handle()).toEqual({ status: 200, body: { ok: true, coalesced: true } });
    expect(deps.routeText).toHaveBeenCalledTimes(1);

    // Once the window has passed, a wake delivers again even if busy (it queues).
    advance(1);
    expect(await handle()).toEqual({ status: 200, body: { ok: true, resumed: false } });
    expect(deps.routeText).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce within the window once the first delivery has been taken up', async () => {
    const session = { alive: true, busy: false };
    const { handle, deps, advance } = setup({ session });
    await handle();
    advance(1000);
    expect(await handle()).toEqual({ status: 200, body: { ok: true, resumed: false } });
    expect(deps.routeText).toHaveBeenCalledTimes(2);
  });

  it('coalesces a wake that arrives while the first is still being delivered', async () => {
    let finish;
    const routeText = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { handle } = setup({ session: { alive: true, busy: false }, routeText });
    const first = handle();
    const second = handle();
    finish();
    expect(await first).toEqual({ status: 200, body: { ok: true, resumed: false } });
    expect(await second).toEqual({ status: 200, body: { ok: true, coalesced: true } });
    expect(routeText).toHaveBeenCalledTimes(1);
  });

  it('reports a failed in-progress delivery to the wake that waited on it', async () => {
    let fail;
    const routeText = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { handle } = setup({ routeText });
    const first = handle();
    const second = handle();
    fail(new Error('pipe closed'));
    expect((await first).status).toBe(500);
    expect((await second).status).toBe(500);
  });

  it('answers 500 with a failure notice when delivery throws, and a retry delivers again', async () => {
    const session = { alive: true, busy: true };
    const routeText = vi.fn().mockRejectedValueOnce(new Error('pipe closed')).mockResolvedValue(undefined);
    const { handle, deps } = setup({ session, routeText });
    expect(await handle()).toEqual({ status: 500, body: { error: 'wake delivery failed' } });
    expect(deps.publishNotice).toHaveBeenLastCalledWith(expect.stringContaining('could not be delivered'), session);
    expect(await handle()).toEqual({ status: 200, body: { ok: true, resumed: false } });
    expect(routeText).toHaveBeenCalledTimes(2);
  });

  it('answers 503 when the session refuses the text', async () => {
    const session = { alive: true };
    const { handle, deps } = setup({ session, routeText: vi.fn(async () => false) });
    const res = await handle();
    expect(res.status).toBe(503);
    expect(deps.publishNotice).toHaveBeenLastCalledWith(expect.stringContaining('did not accept'), session);
  });

  it('takes no request input: whatever is passed in, the configured text and convo are used', async () => {
    const session = { alive: true };
    const { handle, deps } = setup({ session });
    expect(handle.length).toBe(0);
    await handle({ convoId: 'convo-b', text: 'something else', body: '{"text":"x"}' });
    expect(deps.findSession).toHaveBeenCalledWith(CONVO);
    expect(deps.routeText).toHaveBeenCalledWith(session, TEXT);
    expect(deps.findSession).not.toHaveBeenCalledWith('convo-b');
  });
});
