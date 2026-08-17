import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConcurrency,
  parseMaxConcurrent,
  updatePinnedSummary,
} from '../lib/pinned-summary.js';

function messages(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index + 1}`,
  }));
}

function session(overrides = {}) {
  return {
    roomId: '!room:example.test',
    claudeSessionId: 'session-1',
    workdir: '/srv/project',
    originRoomId: '!origin:example.test',
    chatHistory: messages(),
    ...overrides,
  };
}

function success(text = 'TITLE: Useful work\nSUMMARY: Work is complete.') {
  return { text, reason: null, exitCode: 0, signal: null, durationMs: 12 };
}

function failure(reason = 'timeout') {
  return {
    text: null,
    reason,
    exitCode: null,
    signal: 'SIGKILL',
    durationMs: 60_000,
    stderrTail: 'codex diagnostic',
  };
}

function deps(overrides = {}) {
  return {
    codexOneShot: vi.fn().mockResolvedValue(success()),
    formatRoomTitle: vi.fn(({ serverLabel, workdir, text }) => `${serverLabel}:${workdir}:${text}`),
    applyFallbackTitle: vi.fn(),
    persistSession: vi.fn(),
    updateRoomName: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    serverLabel: 'VPS',
    defaultWorkdir: '/srv/default',
    env: {},
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  __resetConcurrency();
});

describe('parseMaxConcurrent', () => {
  it.each(['-1', 'Infinity', '1.5', '0', 'abc', '', '99'])(
    'uses the default for invalid value %j',
    value => {
      expect(parseMaxConcurrent(value)).toBe(2);
    },
  );

  it.each([
    ['minimum', '1', 1],
    ['middle', '12', 12],
    ['maximum', '32', 32],
  ])('accepts a valid %s integer', (_label, value, expected) => {
    expect(parseMaxConcurrent(value)).toBe(expected);
  });
});

describe('updatePinnedSummary guards and concurrency', () => {
  it('skips a concurrent entry for the same session without warning', async () => {
    const pending = deferred();
    const d = deps({ codexOneShot: vi.fn(() => pending.promise) });
    const s = session();

    const first = updatePinnedSummary(s, d);
    await Promise.resolve();
    await updatePinnedSummary(s, d);

    expect(d.codexOneShot).toHaveBeenCalledTimes(1);
    expect(d.debug).toHaveBeenCalledWith('[summary] in-flight', {});
    expect(d.warn).not.toHaveBeenCalled();

    pending.resolve(success());
    await first;
  });

  it('skips at global capacity without calling codex or warning', async () => {
    const pending = deferred();
    const codexOneShot = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(success());
    const d = deps({ codexOneShot, env: { SUMMARY_CODEX_MAX_CONCURRENT: '1' } });

    const first = updatePinnedSummary(session({ roomId: '!one' }), d);
    await Promise.resolve();
    await updatePinnedSummary(session({ roomId: '!two' }), d);

    expect(codexOneShot).toHaveBeenCalledTimes(1);
    expect(d.debug).toHaveBeenCalledWith('[summary] at-capacity', { activeCount: 1 });
    expect(d.warn).not.toHaveBeenCalled();

    pending.resolve(success());
    await first;
  });

  it('keeps the counter symmetric across capacity skips and completed runs', async () => {
    const d = deps({ env: { SUMMARY_CODEX_MAX_CONCURRENT: '1' } });

    for (let cycle = 0; cycle < 3; cycle++) {
      const pending = deferred();
      d.codexOneShot.mockImplementationOnce(() => pending.promise);
      const running = updatePinnedSummary(session({ roomId: `!running-${cycle}` }), d);
      await Promise.resolve();

      await Promise.all(Array.from({ length: 4 }, (_, skip) =>
        updatePinnedSummary(session({ roomId: `!skip-${cycle}-${skip}` }), d)));
      pending.resolve(success());
      await running;

      await updatePinnedSummary(session({ roomId: `!completed-${cycle}` }), d);
    }

    expect(d.codexOneShot).toHaveBeenCalledTimes(6);

    const pending = deferred();
    d.codexOneShot.mockImplementationOnce(() => pending.promise);
    const finalRun = updatePinnedSummary(session({ roomId: '!final' }), d);
    await Promise.resolve();
    await updatePinnedSummary(session({ roomId: '!final-skip' }), d);
    expect(d.codexOneShot).toHaveBeenCalledTimes(7);
    expect(d.debug).toHaveBeenLastCalledWith('[summary] at-capacity', { activeCount: 1 });
    pending.resolve(success());
    await finalRun;
  });
});

describe('updatePinnedSummary compaction', () => {
  const longSummary = Array.from({ length: 16 }, (_, index) => `• item ${index}`).join('\n');

  it('caps and persists compaction before requesting or applying the title', async () => {
    const order = [];
    const compacted = `  • ${'x'.repeat(450)}  `;
    const codexOneShot = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('compact');
        return success(compacted);
      })
      .mockImplementationOnce(async () => {
        order.push('title');
        return success('TITLE: Compact result\nNEW: Another milestone.');
      });
    const d = deps({
      codexOneShot,
      persistSession: vi.fn(() => order.push('persist')),
      updateRoomName: vi.fn(() => order.push('rename')),
    });
    const s = session({ pinnedSummaryText: longSummary, _compactionFailures: 1 });

    await updatePinnedSummary(s, d);

    expect(s.pinnedSummaryText.split('\n')[0]).toHaveLength(400);
    expect(d.persistSession.mock.calls[0][4].pinnedSummaryText).toHaveLength(400);
    expect(s._compactionFailures).toBe(0);
    expect(order.slice(0, 3)).toEqual(['compact', 'persist', 'title']);
    expect(order).toContain('rename');
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('rejects a prose-only compaction response and retains the prior summary', async () => {
    const d = deps({
      codexOneShot: vi.fn()
        .mockResolvedValueOnce(success('x'.repeat(450)))
        .mockResolvedValueOnce(success('TITLE: Still useful')),
    });
    const s = session({ pinnedSummaryText: longSummary });

    await updatePinnedSummary(s, d);

    expect(s.pinnedSummaryText).toBe(longSummary);
    expect(s._compactionFailures).toBe(1);
    expect(d.persistSession).toHaveBeenCalledTimes(1);
    expect(d.persistSession.mock.calls[0][4].pinnedSummaryText).toBe(longSummary);
    expect(d.warn).toHaveBeenCalledWith('[summary] compaction failed',
      expect.objectContaining({ reason: 'invalid-output' }));
  });

  it('rejects a whitespace-only compaction response and retains the prior summary', async () => {
    const d = deps({
      codexOneShot: vi.fn()
        .mockResolvedValueOnce(success('   '))
        .mockResolvedValueOnce(success('TITLE: Still useful')),
    });
    const s = session({ pinnedSummaryText: longSummary, _compactionFailures: 1 });

    await updatePinnedSummary(s, d);

    expect(s.pinnedSummaryText).toBe(longSummary);
    expect(s._compactionFailures).toBe(2);
    expect(d.persistSession).toHaveBeenCalledTimes(1);
    expect(d.persistSession.mock.calls[0][4].pinnedSummaryText).toBe(longSummary);
    expect(d.warn).toHaveBeenCalledWith('[summary] compaction failed',
      expect.objectContaining({ reason: 'invalid-output' }));
  });

  it('warns for compaction failure and only once when crossing the retry threshold', async () => {
    const d = deps({
      codexOneShot: vi.fn()
        .mockResolvedValueOnce(failure('nonzero-exit'))
        .mockResolvedValue(success('TITLE: Still useful\nNEW: Continued work.')),
      env: { SUMMARY_CODEX_MODEL: 'summary-model' },
    });
    const s = session({ pinnedSummaryText: longSummary, _compactionFailures: 1 });

    await updatePinnedSummary(s, d);

    expect(s._compactionFailures).toBe(2);
    expect(d.warn).toHaveBeenCalledWith('[summary] compaction failed', {
      reason: 'nonzero-exit',
      exitCode: null,
      signal: 'SIGKILL',
      durationMs: 60_000,
      model: 'summary-model',
    });
    expect(d.warn).toHaveBeenCalledWith('[summary] compaction skipped', { failures: 2 });
    expect(d.warn).toHaveBeenCalledTimes(2);

    d.warn.mockClear();
    d.codexOneShot.mockClear();
    await updatePinnedSummary(s, d);

    expect(d.codexOneShot).toHaveBeenCalledTimes(1);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('logs a compaction failure at warn level without warning for title success', async () => {
    const d = deps({
      codexOneShot: vi.fn()
        .mockResolvedValueOnce(failure())
        .mockResolvedValueOnce(success('TITLE: Recovered title\nNEW: Kept going.')),
    });

    await updatePinnedSummary(session({ pinnedSummaryText: longSummary }), d);

    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith('[summary] compaction failed', expect.any(Object));
    expect(d.debug).toHaveBeenCalledWith('[summary] ok', { durationMs: 12 });
  });

  it('keeps only the most recent bullets after appending past the hard ceiling', async () => {
    const existingSummary = Array.from(
      { length: 20 },
      (_, index) => `• item ${index + 1}`,
    ).join('\n');
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(
        success('TITLE: Bounded summary\nNEW: newest item'),
      ),
    });
    const s = session({
      pinnedSummaryText: existingSummary,
      _compactionFailures: 2,
    });

    await updatePinnedSummary(s, d);

    const bullets = s.pinnedSummaryText.split('\n');
    expect(bullets).toHaveLength(15);
    expect(bullets[0]).toBe('• item 7');
    expect(bullets.at(-1)).toBe('• newest item');
    expect(d.codexOneShot).toHaveBeenCalledTimes(1);
  });
});

describe('updatePinnedSummary title flow and log levels', () => {
  it('uses fallback with the session-first signature when the kill-switch is off', async () => {
    const d = deps({ env: { SUMMARY_CODEX_ENABLED: '0' } });
    const s = session();

    await updatePinnedSummary(s, d);

    expect(d.codexOneShot).not.toHaveBeenCalled();
    expect(d.applyFallbackTitle).toHaveBeenCalledWith(s, {
      serverLabel: 'VPS',
      updateRoomName: d.updateRoomName,
      workdir: '/srv/project',
      defaultWorkdir: '/srv/default',
      repo: null,
    });
    expect(d.debug).toHaveBeenCalledWith('[summary] kill-switch', { killSwitch: true });
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('routes a successful title through formatRoomTitle without warning', async () => {
    const d = deps();
    const s = session();

    await updatePinnedSummary(s, d);

    expect(d.formatRoomTitle).toHaveBeenCalledWith({
      serverLabel: 'VPS',
      workdir: '/srv/project',
      text: 'Useful work',
      defaultWorkdir: '/srv/default',
      repo: null,
    });
    expect(d.updateRoomName).toHaveBeenCalledWith(
      '!room:example.test',
      'VPS:/srv/project:Useful work',
    );
    expect(d.warn).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith('[summary] ok', { durationMs: 12 });
  });

  it('threads an LLM-inferred REPO override into formatRoomTitle', async () => {
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(
        success('TITLE: harden RLS gate\nREPO: snafu-studio\nSUMMARY: done'),
      ),
    });

    await updatePinnedSummary(session(), d);

    expect(d.formatRoomTitle).toHaveBeenCalledWith({
      serverLabel: 'VPS',
      workdir: '/srv/project',
      text: 'harden RLS gate',
      defaultWorkdir: '/srv/default',
      repo: 'snafu-studio',
    });
  });

  it('falls back to the activity-inferred repo when the model omits REPO', async () => {
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(success('TITLE: some work\nSUMMARY: done')),
      inferRepo: () => 'goodfellow',
    });

    await updatePinnedSummary(session(), d);

    expect(d.formatRoomTitle).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'some work', repo: 'goodfellow' }),
    );
  });

  it('lets the model REPO override win over the activity-inferred repo', async () => {
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(
        success('TITLE: some work\nREPO: easelyte/goodfellow\nSUMMARY: done'),
      ),
      inferRepo: () => 'goodfellow',
    });

    await updatePinnedSummary(session(), d);

    expect(d.formatRoomTitle).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'some work', repo: 'easelyte/goodfellow' }),
    );
  });

  it('passes repo:null when the model reports REPO: unknown (workdir fallback)', async () => {
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(
        success('TITLE: some work\nREPO: unknown\nSUMMARY: done'),
      ),
    });

    await updatePinnedSummary(session(), d);

    expect(d.formatRoomTitle).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'some work', repo: null }),
    );
  });

  it('keeps the existing room name for malformed non-null output', async () => {
    const d = deps({ codexOneShot: vi.fn().mockResolvedValue(success('SUMMARY: Still useful.')) });

    await expect(updatePinnedSummary(session(), d)).resolves.toBeUndefined();

    expect(d.updateRoomName).not.toHaveBeenCalled();
    expect(d.applyFallbackTitle).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith('[summary] no title match', {});
    expect(d.debug).not.toHaveBeenCalledWith('[summary] ok', expect.anything());
  });

  it('uses fallback and warns with failure details for null output', async () => {
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(failure('spawn-error')),
      env: { SUMMARY_CODEX_MODEL: 'summary-model' },
    });
    const s = session();

    await updatePinnedSummary(s, d);

    expect(d.applyFallbackTitle).toHaveBeenCalledWith(s, {
      serverLabel: 'VPS',
      updateRoomName: d.updateRoomName,
      workdir: '/srv/project',
      defaultWorkdir: '/srv/default',
      repo: null,
    });
    expect(d.warn).toHaveBeenCalledWith('[summary] failed', {
      reason: 'spawn-error',
      exitCode: null,
      signal: 'SIGKILL',
      durationMs: 60_000,
      stderrTail: 'codex diagnostic',
      model: 'summary-model',
    });
  });
});

describe('production dependency-wiring contract', () => {
  it('persists compaction before title work and falls back on a null title result', async () => {
    const order = [];
    const codexOneShot = vi.fn()
      .mockResolvedValueOnce(success('• one\n• two\n• three'))
      .mockResolvedValueOnce(failure('no-output'));
    const d = deps({
      codexOneShot,
      persistSession: vi.fn(() => order.push('persist')),
      updateRoomName: vi.fn(() => order.push('rename')),
      applyFallbackTitle: vi.fn(() => order.push('fallback')),
    });
    const s = session({
      pinnedSummaryText: Array.from({ length: 16 }, (_, index) => `• old ${index}`).join('\n'),
    });

    await updatePinnedSummary(s, d);

    expect(codexOneShot).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['persist', 'fallback']);
    expect(d.applyFallbackTitle).toHaveBeenCalledWith(s, expect.objectContaining({
      serverLabel: 'VPS',
      updateRoomName: d.updateRoomName,
      workdir: '/srv/project',
      defaultWorkdir: '/srv/default',
    }));
    expect(d.warn).toHaveBeenCalledWith('[summary] failed', expect.objectContaining({
      reason: 'no-output',
    }));
  });
});
