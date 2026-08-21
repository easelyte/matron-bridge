import { describe, expect, it, vi } from 'vitest';
import { processShowFile } from '../lib/show-file-handler.js';

// Drives the REAL extracted /show-file handler logic (lib/show-file-handler.js,
// the same function index.js wires into its POST handler). No source-text
// assertions: every case exercises token lookup, the concurrency/byte budget,
// and the publish/error paths through their observable return + side effects.

class MockFileLinkDenied extends Error {
  constructor(reason) {
    super(`denied: ${reason}`);
    this.reason = reason;
  }
}

const LIMITS = {
  maxInFlightPerSession: 1,
  maxInFlight: 2,
  maxBytes: 50 * 1024 * 1024,
  globalByteBudget: 2 * 50 * 1024 * 1024,
  uploadTimeoutMs: 30000,
};

function makeSessions(entries = [{ token: 'good-token', roomId: 'room-1' }]) {
  const sessions = new Map();
  for (const e of entries) {
    sessions.set(e.roomId, {
      showFileToken: e.token,
      roomId: e.roomId,
      showFilePinnedRoots: { pinned: true },
      _showFileInFlight: e.inFlight ?? 0,
    });
  }
  return sessions;
}

function makeDeps(overrides = {}) {
  return {
    validateShowFileBody: vi.fn(() => null),
    auditShowFile: vi.fn(),
    shareAgentMedia: vi.fn().mockResolvedValue({
      ok: true,
      media_id: 'media-123',
      kind: 'image',
      realPath: '/work/chart.png',
      size: 10,
      sha256: 'sha-abc',
    }),
    validateAndOpen: vi.fn(),
    FileLinkDenied: MockFileLinkDenied,
    uploadMedia: vi.fn(),
    journalPublish: vi.fn(),
    denialToStatus: vi.fn(() => 403),
    ...overrides,
  };
}

function run({ body, sessions, budget = { inFlight: 0, reservedBytes: 0 }, deps }) {
  return processShowFile({ body, sessions, budget, limits: LIMITS, deps });
}

describe('processShowFile', () => {
  it('returns 400 for invalid JSON', async () => {
    const deps = makeDeps();
    const budget = { inFlight: 0, reservedBytes: 0 };
    const res = await run({ body: '{not json', sessions: makeSessions(), budget, deps });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid JSON' });
    expect(deps.shareAgentMedia).not.toHaveBeenCalled();
    expect(budget).toEqual({ inFlight: 0, reservedBytes: 0 });
  });

  it('returns 400 when body validation fails, without a session lookup', async () => {
    const deps = makeDeps({
      validateShowFileBody: vi.fn(() => ({ error: 'token must be a non-empty string', reason: 'missing-token' })),
    });
    const res = await run({
      body: JSON.stringify({ path: '/work/chart.png' }),
      sessions: makeSessions(),
      deps,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'token must be a non-empty string', reason: 'missing-token' });
    expect(deps.auditShowFile).toHaveBeenCalledWith(expect.objectContaining({ result: 'missing-token' }));
    expect(deps.shareAgentMedia).not.toHaveBeenCalled();
  });

  it('rejects an unknown token with 403 and reserves nothing', async () => {
    const deps = makeDeps();
    const budget = { inFlight: 0, reservedBytes: 0 };
    const res = await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'wrong' }),
      sessions: makeSessions(),
      budget,
      deps,
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'invalid token', reason: 'invalid-token' });
    expect(deps.auditShowFile).toHaveBeenCalledWith(expect.objectContaining({ result: 'invalid-token' }));
    expect(deps.shareAgentMedia).not.toHaveBeenCalled();
    expect(budget).toEqual({ inFlight: 0, reservedBytes: 0 });
  });

  it('publishes on the happy path (200) and releases the budget + in-flight count', async () => {
    const deps = makeDeps();
    const sessions = makeSessions();
    const budget = { inFlight: 0, reservedBytes: 0 };
    const res = await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'good-token', caption: 'hi' }),
      sessions,
      budget,
      deps,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, media_id: 'media-123', kind: 'image', deduped: false });
    // shareAgentMedia got the session's pinned roots and a publish() closure.
    expect(deps.shareAgentMedia).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/work/chart.png',
      caption: 'hi',
      pinnedRoots: { pinned: true },
      maxBytes: LIMITS.maxBytes,
    }));
    // Budget + per-session counter fully released after completion.
    expect(budget).toEqual({ inFlight: 0, reservedBytes: 0 });
    expect(sessions.get('room-1')._showFileInFlight).toBe(0);
    expect(deps.auditShowFile).toHaveBeenCalledWith(expect.objectContaining({ result: 'ok' }));
  });

  it('publish() closure routes to journalPublish bound to the resolved session', async () => {
    let capturedPublish;
    const deps = makeDeps({
      shareAgentMedia: vi.fn(async ({ deps: inner }) => {
        capturedPublish = inner.publish;
        inner.publish('publishImage', { blob_ref: 'x' });
        return { ok: true, media_id: 'm', kind: 'image', realPath: '/p', size: 1, sha256: 's' };
      }),
    });
    const sessions = makeSessions();
    await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'good-token' }),
      sessions,
      deps,
    });
    expect(typeof capturedPublish).toBe('function');
    expect(deps.journalPublish).toHaveBeenCalledWith(
      sessions.get('room-1'), 'publishImage', { blob_ref: 'x' },
    );
  });

  it('returns 429 when the session already has one show_file in flight', async () => {
    const deps = makeDeps();
    const sessions = makeSessions([{ token: 'good-token', roomId: 'room-1', inFlight: 1 }]);
    const budget = { inFlight: 0, reservedBytes: 0 };
    const res = await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'good-token' }),
      sessions,
      budget,
      deps,
    });
    expect(res.status).toBe(429);
    expect(res.headers).toEqual({ 'Retry-After': '1' });
    expect(res.body).toEqual({ error: 'saturated' });
    expect(deps.shareAgentMedia).not.toHaveBeenCalled();
    // The saturated request reserved nothing.
    expect(budget).toEqual({ inFlight: 0, reservedBytes: 0 });
  });

  it('returns 429 when the global byte budget cannot fit another reservation', async () => {
    const deps = makeDeps();
    const budget = { inFlight: 1, reservedBytes: LIMITS.globalByteBudget };
    const res = await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'good-token' }),
      sessions: makeSessions(),
      budget,
      deps,
    });
    expect(res.status).toBe(429);
    expect(deps.shareAgentMedia).not.toHaveBeenCalled();
    // Existing reservation untouched by the rejected request.
    expect(budget).toEqual({ inFlight: 1, reservedBytes: LIMITS.globalByteBudget });
  });

  it('maps a denial to its status via denialToStatus and still releases the budget', async () => {
    const deps = makeDeps({
      shareAgentMedia: vi.fn().mockResolvedValue({ denied: 'sensitive' }),
      denialToStatus: vi.fn(() => 403),
    });
    const sessions = makeSessions();
    const budget = { inFlight: 0, reservedBytes: 0 };
    const res = await run({
      body: JSON.stringify({ path: '/work/secret.env', token: 'good-token' }),
      sessions,
      budget,
      deps,
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'sensitive' });
    expect(deps.denialToStatus).toHaveBeenCalledWith('sensitive');
    expect(budget).toEqual({ inFlight: 0, reservedBytes: 0 });
    expect(sessions.get('room-1')._showFileInFlight).toBe(0);
  });

  it('releases the budget + in-flight count when shareAgentMedia throws (502 path)', async () => {
    const deps = makeDeps({
      shareAgentMedia: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const sessions = makeSessions();
    const budget = { inFlight: 0, reservedBytes: 0 };
    const res = await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'good-token' }),
      sessions,
      budget,
      deps,
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'internal error' });
    expect(deps.auditShowFile).toHaveBeenCalledWith(expect.objectContaining({ result: 'internal-error' }));
    // Critically: the error path does not leak a reservation.
    expect(budget).toEqual({ inFlight: 0, reservedBytes: 0 });
    expect(sessions.get('room-1')._showFileInFlight).toBe(0);
  });

  it('reserves exactly one slot + maxBytes during the in-flight upload', async () => {
    let observed;
    const deps = makeDeps({
      shareAgentMedia: vi.fn(async () => {
        observed = { ...budget };
        return { ok: true, media_id: 'm', kind: 'image', realPath: '/p', size: 1, sha256: 's' };
      }),
    });
    const sessions = makeSessions();
    const budget = { inFlight: 0, reservedBytes: 0 };
    await run({
      body: JSON.stringify({ path: '/work/chart.png', token: 'good-token' }),
      sessions,
      budget,
      deps,
    });
    expect(observed).toEqual({ inFlight: 1, reservedBytes: LIMITS.maxBytes });
  });
});
