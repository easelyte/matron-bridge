import { describe, it, expect, vi } from 'vitest';
import {
  createSlowToolNotices,
  resolveSlowToolNoticeMs,
  resolveSlowToolReminderMs,
  isNoticeEligible,
  formatElapsed,
  renderSlowToolNotice,
  DEFAULT_SLOW_TOOL_NOTICE_MS,
  DEFAULT_SLOW_TOOL_REMINDER_MS,
  MAX_SLOW_TOOL_NOTICE_MS,
} from '../lib/slow-tool-notice.js';

// Deterministic timer harness: timers fire manually via advance(), matching
// the createPermissionRegistry test style (no fake global clocks).
function makeHarness({ thresholdMs = 1000, reminderMs = 3000, notify } = {}) {
  let nowMs = 0;
  let nextId = 1;
  const pending = new Map();
  const fired = [];
  const tracker = createSlowToolNotices({
    thresholdMs,
    reminderMs,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, at: nowMs + ms });
      return id;
    },
    clearTimeout: id => { pending.delete(id); },
    now: () => nowMs,
    notify: notify ?? (event => { fired.push(event); }),
  });
  function advance(ms) {
    nowMs += ms;
    for (const [id, timer] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= nowMs) {
        pending.delete(id);
        timer.fn();
      }
    }
  }
  return { tracker, advance, fired, pending };
}

describe('resolveSlowToolNoticeMs', () => {
  it('defaults to 3 minutes, reminder to 10', () => {
    expect(DEFAULT_SLOW_TOOL_NOTICE_MS).toBe(300_000);
    expect(DEFAULT_SLOW_TOOL_REMINDER_MS).toBe(600_000);
    expect(resolveSlowToolReminderMs(undefined)).toBe(DEFAULT_SLOW_TOOL_REMINDER_MS);
    expect(resolveSlowToolReminderMs('0')).toBe(0);
    expect(resolveSlowToolReminderMs('900000')).toBe(900_000);
  });
  it('defaults when unset or invalid', () => {
    expect(resolveSlowToolNoticeMs(undefined)).toBe(DEFAULT_SLOW_TOOL_NOTICE_MS);
    expect(resolveSlowToolNoticeMs('')).toBe(DEFAULT_SLOW_TOOL_NOTICE_MS);
    expect(resolveSlowToolNoticeMs('nope')).toBe(DEFAULT_SLOW_TOOL_NOTICE_MS);
  });
  it('zero and negatives disable', () => {
    expect(resolveSlowToolNoticeMs('0')).toBe(0);
    expect(resolveSlowToolNoticeMs('-5')).toBe(0);
  });
  it('in-range values pass, oversized values fall back', () => {
    expect(resolveSlowToolNoticeMs('30000')).toBe(30000);
    expect(resolveSlowToolNoticeMs(String(MAX_SLOW_TOOL_NOTICE_MS + 1))).toBe(DEFAULT_SLOW_TOOL_NOTICE_MS);
  });
});

describe('isNoticeEligible', () => {
  it('excludes user-blocking tools and ask-user MCP tools', () => {
    expect(isNoticeEligible('AskUserQuestion')).toBe(false);
    expect(isNoticeEligible('ExitPlanMode')).toBe(false);
    expect(isNoticeEligible('mcp__ask-user__request_secret')).toBe(false);
  });
  it('excludes subagents, whose activity already streams into chat', () => {
    expect(isNoticeEligible('Task')).toBe(false);
    expect(isNoticeEligible('Agent')).toBe(false);
  });
  it('includes ordinary and MCP tools', () => {
    expect(isNoticeEligible('Bash')).toBe(true);
    expect(isNoticeEligible('mcp__Roblox_Studio__run_script_in_play_mode')).toBe(true);
    expect(isNoticeEligible('mcp__chrome-devtools__get_network_request')).toBe(true);
  });
  it('rejects junk', () => {
    expect(isNoticeEligible('')).toBe(false);
    expect(isNoticeEligible(undefined)).toBe(false);
  });
});

describe('formatElapsed / renderSlowToolNotice', () => {
  it('formats seconds, minutes, hours', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(3_720_000)).toBe('1h 2m');
  });
  it('renders first notice and reminder distinctly', () => {
    const first = renderSlowToolNotice({ toolName: 'Bash', elapsedMs: 60_000, reminder: false });
    const again = renderSlowToolNotice({ toolName: 'Bash', elapsedMs: 300_000, reminder: true });
    expect(first).toContain('1m');
    expect(first).toContain('`Bash`');
    expect(again).toContain('STILL running');
    expect(again).toContain('5m');
    expect(first).not.toBe(again);
  });
});

describe('createSlowToolNotices', () => {
  it('fires a notice at the threshold and a reminder at the reminder mark, then stops', () => {
    const { tracker, advance, fired } = makeHarness();
    tracker.toolStarted('t1', 'mcp__Roblox_Studio__run_code');
    advance(999);
    expect(fired).toHaveLength(0);
    advance(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ toolUseId: 't1', reminder: false, elapsedMs: 1000 });
    advance(1999);
    expect(fired).toHaveLength(1); // reminder is measured from tool start (3000), not from the notice
    advance(1);
    expect(fired).toHaveLength(2);
    expect(fired[1]).toMatchObject({ reminder: true, elapsedMs: 3000 });
    advance(100_000);
    expect(fired).toHaveLength(2);
  });

  it('a reminder at or before the notice, or disabled, arms only the notice', () => {
    for (const reminderMs of [0, 500, 1000]) {
      const { tracker, advance, fired, pending } = makeHarness({ reminderMs });
      tracker.toolStarted('t1', 'Bash');
      expect(pending.size).toBe(1);
      advance(100_000);
      expect(fired).toHaveLength(1);
      expect(fired[0].reminder).toBe(false);
    }
  });

  it('a completed tool fires nothing', () => {
    const { tracker, advance, fired, pending } = makeHarness();
    tracker.toolStarted('t1', 'Bash');
    tracker.toolEnded('t1');
    advance(10_000);
    expect(fired).toHaveLength(0);
    expect(pending.size).toBe(0);
  });

  it('replayed tool_use blocks do not double-arm', () => {
    const { tracker, advance, fired } = makeHarness();
    tracker.toolStarted('t1', 'Bash');
    tracker.toolStarted('t1', 'Bash'); // partial + final event replay
    advance(1000);
    expect(fired).toHaveLength(1);
  });

  it('a tool_use replayed after its tool_result stays silent (tombstone)', () => {
    const { tracker, advance, fired } = makeHarness();
    tracker.toolEnded('t1'); // result seen first / already handled
    tracker.toolStarted('t1', 'Bash');
    advance(10_000);
    expect(fired).toHaveLength(0);
  });

  it('excluded tools and disabled threshold arm nothing', () => {
    const { tracker, advance, fired, pending } = makeHarness();
    tracker.toolStarted('q1', 'AskUserQuestion');
    tracker.toolStarted('s1', 'mcp__ask-user__request_secret');
    expect(pending.size).toBe(0);
    const disabled = makeHarness({ thresholdMs: 0 });
    disabled.tracker.toolStarted('t1', 'Bash');
    disabled.advance(100_000);
    advance(100_000);
    expect(fired).toHaveLength(0);
    expect(disabled.fired).toHaveLength(0);
  });

  it('reset clears timers and tombstones', () => {
    const { tracker, advance, fired, pending } = makeHarness();
    tracker.toolStarted('t1', 'Bash');
    tracker.toolEnded('t2');
    expect(tracker.size()).toBe(2);
    tracker.reset();
    expect(tracker.size()).toBe(0);
    expect(pending.size).toBe(0);
    advance(100_000);
    expect(fired).toHaveLength(0);
  });

  it('tracks concurrent tools independently', () => {
    const { tracker, advance, fired } = makeHarness();
    tracker.toolStarted('a', 'Bash');
    advance(500);
    tracker.toolStarted('b', 'Grep');
    advance(500); // a crosses threshold, b at 500ms
    expect(fired).toHaveLength(1);
    expect(fired[0].toolUseId).toBe('a');
    tracker.toolEnded('b'); // b finishes before its threshold
    advance(500);
    expect(fired).toHaveLength(1);
  });

  it('a throwing notify is contained and logged', () => {
    const log = vi.fn();
    let nowMs = 0;
    const pending = [];
    const tracker = createSlowToolNotices({
      thresholdMs: 1000,
      setTimeout: fn => { pending.push(fn); return pending.length; },
      clearTimeout: () => {},
      now: () => nowMs,
      notify: () => { throw new Error('transport down'); },
      log,
    });
    tracker.toolStarted('t1', 'Bash');
    nowMs = 1000;
    expect(() => pending.forEach(fn => fn())).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('transport down'));
  });
});
