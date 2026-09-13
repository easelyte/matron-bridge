import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConcurrency,
  summaryBlocks,
  summaryJournalPublishEnabled,
  JOURNAL_SUMMARY_MAX_CHARS,
  makeJournalSummaryPublisher,
  parseMaxConcurrent,
  summaryForJournal,
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
    publishSummary: vi.fn(),
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
      '[se] VPS:/srv/project:Useful work',
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


// --- loop #554 phase 1: journal publish ---

describe('summaryForJournal', () => {
  const bullets = (count, size = 100) =>
    Array.from({ length: count }, (_, i) => `• bullet ${i} ${'x'.repeat(size)}`).join('\n');

  it.each([['empty string', ''], ['null', null], ['undefined', undefined], ['whitespace', '   \n  ']])(
    'returns an empty string for %s',
    (_label, value) => {
      expect(summaryForJournal(value)).toBe('');
    },
  );

  it('exposes the journal cap as 1000 chars, matching matron-journal SUMMARY_MAX_CHARS', () => {
    expect(JOURNAL_SUMMARY_MAX_CHARS).toBe(1000);
  });

  it('is the identity (modulo trim) for text under the cap', () => {
    const text = '• one\n• two\n• three';
    expect(summaryForJournal(text)).toBe(text);
    expect(summaryForJournal(`\n${text}\n  `)).toBe(text);
  });

  it('passes a summary exactly at the cap through untouched', () => {
    const exact = `• ${'x'.repeat(998)}`;
    expect(exact).toHaveLength(1000);
    expect(summaryForJournal(exact)).toBe(exact);
  });

  // The measured live worst case: 2082 chars / 13 bullets. Publishing this raw
  // would bad_request the whole convo_upsert frame and silently drop the title.
  it('clamps a >2000-char live-shaped digest to the cap, keeping the newest bullets', () => {
    const raw = bullets(13, 150);
    expect(raw.length).toBeGreaterThan(2000);

    const out = summaryForJournal(raw);

    expect(out.length).toBeLessThanOrEqual(JOURNAL_SUMMARY_MAX_CHARS);
    expect(out).toContain('bullet 12');
    expect(out).not.toContain('bullet 0 ');
    // Oldest dropped first: the retained set is a contiguous suffix.
    const kept = out.split('\n').map(l => Number(l.match(/bullet (\d+)/)[1]));
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 13 - kept.length + i));
  });

  it('keeps at least the newest bullet rather than returning nothing', () => {
    const out = summaryForJournal(bullets(6, 400));
    expect(out.length).toBeLessThanOrEqual(JOURNAL_SUMMARY_MAX_CHARS);
    expect(out).toContain('bullet 5');
  });

  it('hard-cuts a single oversize bullet with an ellipsis instead of rejecting', () => {
    const out = summaryForJournal(`• ${'y'.repeat(3000)}`);
    expect(out).toHaveLength(JOURNAL_SUMMARY_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('• yyy')).toBe(true);
  });

  it('respects a caller-supplied budget', () => {
    expect(summaryForJournal('• one\n• two\n• three', 12)).toBe('• three');
  });

  it('keeps a wrapped bullet with its continuation lines rather than orphaning one', () => {
    const raw = `• old ${'a'.repeat(1200)}\n• new first line\ncontinued second line`;
    const out = summaryForJournal(raw);
    expect(out).toBe('• new first line\ncontinued second line');
  });

  it('clamps non-bullet prose as a single block', () => {
    const out = summaryForJournal('z'.repeat(1500));
    expect(out).toHaveLength(JOURNAL_SUMMARY_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('summaryBlocks', () => {
  it('keeps a bullet and its continuation lines together', () => {
    expect(summaryBlocks('• one\ncontinued\n• two')).toEqual(['• one\ncontinued', '• two']);
  });

  it('treats leading non-bullet lines as their own block', () => {
    expect(summaryBlocks('preamble\n• one')).toEqual(['preamble', '• one']);
  });

  it('drops blank lines and trims', () => {
    expect(summaryBlocks('  • one  \n\n   \n • two ')).toEqual(['• one', '• two']);
  });

  it.each([['empty', ''], ['null', null], ['undefined', undefined]])(
    'returns an empty list for %s', (_label, value) => {
      expect(summaryBlocks(value)).toEqual([]);
    },
  );
});

describe('makeJournalSummaryPublisher', () => {
  it('upserts the summary and records the hint', () => {
    const upsertConvo = vi.fn();
    const publish = makeJournalSummaryPublisher({ upsertConvo, env: {} });
    const s = session();

    expect(publish(s, '• work')).toBe('sent');

    expect(upsertConvo).toHaveBeenCalledWith(s, { summary: '• work' });
    expect(s._journalSummaryHint).toBe('• work');
  });

  it('skips an unchanged summary', () => {
    const upsertConvo = vi.fn();
    const publish = makeJournalSummaryPublisher({ upsertConvo, env: {} });
    const s = session();

    publish(s, '• work');
    expect(publish(s, '• work')).toBe('skipped');
    expect(upsertConvo).toHaveBeenCalledTimes(1);

    expect(publish(s, '• work\n• more')).toBe('sent');
    expect(upsertConvo).toHaveBeenCalledTimes(2);
  });

  it.each([['empty', ''], ['null', null], ['undefined', undefined]])(
    'skips a %s summary without clobbering the recorded hint',
    (_label, value) => {
      const upsertConvo = vi.fn();
      const publish = makeJournalSummaryPublisher({ upsertConvo, env: {} });
      const s = session({ _journalSummaryHint: '• prior' });

      expect(publish(s, value)).toBe('skipped');
      expect(upsertConvo).not.toHaveBeenCalled();
      expect(s._journalSummaryHint).toBe('• prior');
    },
  );

  // loop #554 R3/R4: a refused frame was neither sent nor retained. Recording
  // the hint there would suppress the retry meant to recover it — and the
  // caller needs 'refused' distinguishable from 'skipped' to know to come back.
  it('reports a refusal, leaves the hint unset, and retries the same digest', () => {
    const upsertConvo = vi.fn(() => false);
    const publish = makeJournalSummaryPublisher({ upsertConvo, env: {} });
    const s = session();

    expect(publish(s, '• work')).toBe('refused');
    expect(s._journalSummaryHint).toBeUndefined();

    upsertConvo.mockReturnValue(true);
    expect(publish(s, '• work')).toBe('sent');
    expect(s._journalSummaryHint).toBe('• work');
  });

  it('treats a transport that returns nothing as sent', () => {
    const publish = makeJournalSummaryPublisher({ upsertConvo: vi.fn(), env: {} });
    const s = session();

    expect(publish(s, '• work')).toBe('sent');
    expect(s._journalSummaryHint).toBe('• work');
  });

  it('publishes by default and stops when SUMMARY_JOURNAL_PUBLISH=0', () => {
    const upsertConvo = vi.fn();
    const env = {};
    const publish = makeJournalSummaryPublisher({ upsertConvo, env });

    publish(session(), '• work');
    expect(upsertConvo).toHaveBeenCalledTimes(1);

    // Read per call, not captured: a restart with a changed unit env flips it.
    env.SUMMARY_JOURNAL_PUBLISH = '0';
    const s = session();
    expect(publish(s, '• other')).toBe('skipped');
    expect(upsertConvo).toHaveBeenCalledTimes(1);
    expect(s._journalSummaryHint).toBeUndefined();
  });
});

describe('summaryJournalPublishEnabled', () => {
  it('defaults ON and is disabled only by an explicit 0', () => {
    expect(summaryJournalPublishEnabled({})).toBe(true);
    expect(summaryJournalPublishEnabled({ SUMMARY_JOURNAL_PUBLISH: '1' })).toBe(true);
    expect(summaryJournalPublishEnabled({ SUMMARY_JOURNAL_PUBLISH: '0' })).toBe(false);
  });
});

describe('updatePinnedSummary journal publish seam', () => {
  const longSummary = Array.from({ length: 16 }, (_, index) => `• item ${index}`).join('\n');

  it('publishes the accreted summary on the first pass', async () => {
    const d = deps();
    const s = session();

    await updatePinnedSummary(s, d);

    expect(d.publishSummary).toHaveBeenCalledTimes(1);
    expect(d.publishSummary).toHaveBeenCalledWith(s, '• Work is complete.');
    expect(s.pinnedSummaryText).toBe('• Work is complete.');
  });

  it('publishes the clamped digest, never the raw accumulator', async () => {
    const priorBullets = Array.from({ length: 12 }, (_, i) => `• prior ${i} ${'x'.repeat(150)}`).join('\n');
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(success('TITLE: Ongoing\nNEW: Newest milestone.')),
    });
    // _compactionFailures latches compaction off, so the accumulator accretes
    // past the cap — the steady state the live 2082-char record came from.
    const s = session({ pinnedSummaryText: priorBullets, _compactionFailures: 2 });

    await updatePinnedSummary(s, d);

    expect(s.pinnedSummaryText.length).toBeGreaterThan(JOURNAL_SUMMARY_MAX_CHARS);
    const published = d.publishSummary.mock.calls.at(-1)[1];
    expect(published.length).toBeLessThanOrEqual(JOURNAL_SUMMARY_MAX_CHARS);
    expect(published).not.toBe(s.pinnedSummaryText);
    expect(published).toContain('Newest milestone.');
  });

  it('publishes on the compaction write as well as the accretion write', async () => {
    const d = deps({
      codexOneShot: vi.fn()
        .mockResolvedValueOnce(success('• compacted one\n• compacted two\n• compacted three'))
        .mockResolvedValueOnce(success('TITLE: Compact result\nNEW: Another milestone.')),
    });
    const s = session({ pinnedSummaryText: longSummary, _compactionFailures: 1 });

    await updatePinnedSummary(s, d);

    expect(d.publishSummary).toHaveBeenCalledTimes(2);
    expect(d.publishSummary.mock.calls[0][1]).toBe('• compacted one\n• compacted two\n• compacted three');
    expect(d.publishSummary.mock.calls[1][1]).toContain('Another milestone.');
  });

  it('does not publish when the kill switch disables the generator', async () => {
    const d = deps({ env: { SUMMARY_CODEX_ENABLED: '0' } });

    await updatePinnedSummary(session(), d);

    expect(d.publishSummary).not.toHaveBeenCalled();
    expect(d.codexOneShot).not.toHaveBeenCalled();
  });

  it('does not publish when codex fails and no summary was produced', async () => {
    const d = deps({ codexOneShot: vi.fn().mockResolvedValue(failure()) });

    await updatePinnedSummary(session(), d);

    expect(d.publishSummary).not.toHaveBeenCalled();
  });

  it('keeps titling and persistence working when the publisher throws', async () => {
    const d = deps({
      publishSummary: vi.fn(() => { throw new Error('journal down'); }),
    });
    const s = session();

    await updatePinnedSummary(s, d);

    expect(d.updateRoomName).toHaveBeenCalledTimes(1);
    expect(d.persistSession).toHaveBeenCalledTimes(1);
    expect(s.pinnedSummaryText).toBe('• Work is complete.');
    expect(d.warn).toHaveBeenCalledWith('[summary] journal publish failed',
      expect.objectContaining({ error: 'journal down' }));
  });

  it('runs unchanged when no publishSummary dep is wired', async () => {
    const d = deps();
    delete d.publishSummary;
    const s = session();

    await updatePinnedSummary(s, d);

    expect(s.pinnedSummaryText).toBe('• Work is complete.');
    expect(d.updateRoomName).toHaveBeenCalledTimes(1);
  });

  // loop #554 F2: persistSession is fail-OPEN (index.js savePersistedSessions
  // logs and returns rather than throwing), so a publish that ran first could
  // leave the journal holding text the session store never recorded — and the
  // next resume would back-fill the older persisted digest over it.
  it('persists before it publishes', async () => {
    const order = [];
    const d = deps({
      persistSession: vi.fn(() => { order.push('persist'); return true; }),
      publishSummary: vi.fn(() => order.push('publish')),
    });

    await updatePinnedSummary(session(), d);

    expect(order).toEqual(['persist', 'publish']);
  });

  it('persists before it publishes on the compaction write too', async () => {
    const order = [];
    const d = deps({
      codexOneShot: vi.fn()
        .mockResolvedValueOnce(success('• compacted one\n• compacted two'))
        .mockResolvedValueOnce(success('TITLE: Compact result\nNEW: Another milestone.')),
      persistSession: vi.fn(() => { order.push('persist'); return true; }),
      publishSummary: vi.fn(() => order.push('publish')),
    });

    await updatePinnedSummary(session({ pinnedSummaryText: longSummary, _compactionFailures: 1 }), d);

    expect(order).toEqual(['persist', 'publish', 'persist', 'publish']);
  });

  it('does not publish a summary the session store failed to record', async () => {
    const d = deps({ persistSession: vi.fn(() => false) });
    const s = session();

    await updatePinnedSummary(s, d);

    expect(d.publishSummary).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledWith('[summary] journal publish skipped: summary not persisted',
      expect.objectContaining({ roomId: s.roomId }));
    // The pass still completes: the title lands and the in-memory digest stands.
    expect(d.updateRoomName).toHaveBeenCalledTimes(1);
    expect(s.pinnedSummaryText).toBe('• Work is complete.');
  });

  it('still publishes when persistSession reports nothing (legacy/unwired callers)', async () => {
    const d = deps({ persistSession: vi.fn(() => undefined) });

    await updatePinnedSummary(session(), d);

    expect(d.publishSummary).toHaveBeenCalledTimes(1);
  });

  it('publishes for a session with no id to persist', async () => {
    const d = deps();

    await updatePinnedSummary(session({ claudeSessionId: null }), d);

    expect(d.persistSession).not.toHaveBeenCalled();
    expect(d.publishSummary).toHaveBeenCalledWith(expect.anything(), '• Work is complete.');
  });

  it('leaves the bridge-local accumulator uncapped', async () => {
    const priorBullets = Array.from({ length: 12 }, (_, i) => `• prior ${i} ${'x'.repeat(150)}`).join('\n');
    const d = deps({
      codexOneShot: vi.fn().mockResolvedValue(success('TITLE: Ongoing\nNEW: Newest milestone.')),
    });
    const s = session({ pinnedSummaryText: priorBullets, _compactionFailures: 2 });

    await updatePinnedSummary(s, d);

    expect(s.pinnedSummaryText.startsWith('• prior 0 ')).toBe(true);
    expect(d.persistSession.mock.calls[0][4].pinnedSummaryText).toBe(s.pinnedSummaryText);
  });
});
