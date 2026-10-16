import { describe, it, expect } from 'vitest';
import {
  handoffConfig, handoffIdleSince, handoffDue, planHandoff, handoffTurnText, handoffNotice, preReapCompactCommand, noteTurnStart,
  DEFAULT_HANDOFF_IDLE_MS, DEFAULT_COMPACT_PCT, STATUS_FRESH_GRACE_MS, HANDOFF_TURN_PREFIX,
} from '../lib/pre-reap-handoff.js';

import { isCompactCommand, hasQueuedCompact, compactBatchSize } from '../lib/compact-priority.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const T = Date.parse('2026-10-04T10:00:00.000Z');

describe('handoffConfig', () => {
  it('defaults to on, 50 minutes idle, 20% compaction, under a one-hour reap', () => {
    expect(handoffConfig({}, { reapTimeoutMs: HOUR })).toEqual({ enabled: true, idleMs: DEFAULT_HANDOFF_IDLE_MS, compactPct: DEFAULT_COMPACT_PCT, reason: null });
    expect(DEFAULT_HANDOFF_IDLE_MS).toBe(50 * MIN);
    expect(DEFAULT_COMPACT_PCT).toBe(20);
  });
  it('MATRON_PRE_REAP_HANDOFF=0/false/off switches it off', () => {
    for (const v of ['0', 'false', 'off', 'OFF', 'no']) {
      const c = handoffConfig({ MATRON_PRE_REAP_HANDOFF: v }, { reapTimeoutMs: HOUR });
      expect(c.enabled).toBe(false);
      expect(c.reason).toBe('MATRON_PRE_REAP_HANDOFF');
    }
    expect(handoffConfig({ MATRON_PRE_REAP_HANDOFF: '1' }, { reapTimeoutMs: HOUR }).enabled).toBe(true);
  });
  it('takes the idle delay and threshold from the environment, falling back on nonsense', () => {
    const c = handoffConfig({ MATRON_PRE_REAP_HANDOFF_IDLE_MS: '1200000', MATRON_PRE_REAP_COMPACT_PCT: '40' }, { reapTimeoutMs: HOUR });
    expect(c).toEqual({ enabled: true, idleMs: 20 * MIN, compactPct: 40, reason: null });
    expect(handoffConfig({ MATRON_PRE_REAP_HANDOFF_IDLE_MS: 'soon' }, { reapTimeoutMs: HOUR }).idleMs).toBe(DEFAULT_HANDOFF_IDLE_MS);
    expect(handoffConfig({ MATRON_PRE_REAP_COMPACT_PCT: '101' }, { reapTimeoutMs: HOUR }).compactPct).toBe(DEFAULT_COMPACT_PCT);
    expect(handoffConfig({ MATRON_PRE_REAP_COMPACT_PCT: '-3' }, { reapTimeoutMs: HOUR }).compactPct).toBe(DEFAULT_COMPACT_PCT);
    expect(handoffConfig({ MATRON_PRE_REAP_COMPACT_PCT: '100' }, { reapTimeoutMs: HOUR }).compactPct).toBe(100);
  });
  it('0 or off for the threshold keeps the status turn but never compacts', () => {
    expect(handoffConfig({ MATRON_PRE_REAP_COMPACT_PCT: '0' }, { reapTimeoutMs: HOUR }).compactPct).toBe(0);
    expect(handoffConfig({ MATRON_PRE_REAP_COMPACT_PCT: 'off' }, { reapTimeoutMs: HOUR }).compactPct).toBe(0);
  });
  it('is off when the reaper is off, or when the idle delay is not shorter than the reap', () => {
    expect(handoffConfig({}, { reapTimeoutMs: 0 })).toMatchObject({ enabled: false, reason: 'the idle reaper is off (SESSION_IDLE_TIMEOUT_MS=0)' });
    expect(handoffConfig({ MATRON_PRE_REAP_HANDOFF_IDLE_MS: String(HOUR) }, { reapTimeoutMs: HOUR })).toMatchObject({ enabled: false, reason: 'MATRON_PRE_REAP_HANDOFF_IDLE_MS is not shorter than SESSION_IDLE_TIMEOUT_MS' });
    expect(handoffConfig({ MATRON_PRE_REAP_HANDOFF_IDLE_MS: String(HOUR - 1) }, { reapTimeoutMs: HOUR }).enabled).toBe(true);
    // A short reap with the default delay: off, with the same reason.
    expect(handoffConfig({}, { reapTimeoutMs: 30 * MIN }).enabled).toBe(false);
  });
});

describe('handoffIdleSince', () => {
  it('is the last activity (or the start) until a handoff fires, then the anchor it froze', () => {
    expect(handoffIdleSince({ lastActivityAt: 5, startedAt: 1 })).toBe(5);
    expect(handoffIdleSince({ startedAt: 1 })).toBe(1);
    expect(handoffIdleSince({})).toBe(0);
    // The handoff turn's own output bumps lastActivityAt; the reaper must not see that.
    expect(handoffIdleSince({ lastActivityAt: 900, _preReapHandoff: { idleSince: 5, at: 800 } })).toBe(5);
    expect(handoffIdleSince({ lastActivityAt: 900, _preReapHandoff: null })).toBe(900);
  });
});

describe('noteTurnStart', () => {
  const marked = () => ({ lastActivityAt: 900, _preReapHandoff: { idleSince: 5, at: 800, compactPending: false } });
  it('any other turn ends the idle period: the mark goes and the clock is lastActivityAt again', () => {
    for (const text of ['finish the PR', '[from the Coordinator] carry on', '⏰ Reminder #3 — check the deploy', '//compact', '']) {
      const s = marked();
      noteTurnStart(s, text);
      expect(s._preReapHandoff, text).toBeNull();
      expect(handoffIdleSince(s)).toBe(900);
    }
  });
  it('the handoff\'s own status turn and a compaction leave the mark alone', () => {
    for (const text of [handoffTurnText({ idleMinutes: 50 }), '/compact', '  /compact  ', '/compact keep the file list']) {
      const s = marked();
      noteTurnStart(s, text);
      expect(s._preReapHandoff, text).toEqual({ idleSince: 5, at: 800, compactPending: false });
      expect(handoffIdleSince(s)).toBe(5);
    }
  });
  it('is a no-op on an unmarked session', () => {
    const s = { lastActivityAt: 900 };
    noteTurnStart(s, 'hello');
    expect(s).toEqual({ lastActivityAt: 900 });
    noteTurnStart(null, 'hello');
  });
});

describe('handoffDue', () => {
  const config = handoffConfig({}, { reapTimeoutMs: HOUR });
  const idle = (ms, extra = {}) => ({ alive: true, lastActivityAt: T - ms, ...extra });
  const never = () => false;
  it('is due once the idle delay has passed on a live, free session with no handoff this idle period', () => {
    expect(handoffDue({ session: idle(50 * MIN), now: T, config, occupied: never })).toBe(true);
    expect(handoffDue({ session: idle(50 * MIN - 1), now: T, config, occupied: never })).toBe(false);
    expect(handoffDue({ session: idle(59 * MIN), now: T, config, occupied: never })).toBe(true);
  });
  it('is never due when off, dead, auto-stopped, or already done this idle period', () => {
    expect(handoffDue({ session: idle(55 * MIN), now: T, config: { ...config, enabled: false }, occupied: never })).toBe(false);
    expect(handoffDue({ session: idle(55 * MIN, { alive: false }), now: T, config, occupied: never })).toBe(false);
    expect(handoffDue({ session: idle(55 * MIN, { _autoStopped: true }), now: T, config, occupied: never })).toBe(false);
    expect(handoffDue({ session: idle(55 * MIN, { _preReapHandoff: { idleSince: T - 55 * MIN, at: T - 5 * MIN } }), now: T, config, occupied: never })).toBe(false);
    expect(handoffDue({ session: null, now: T, config, occupied: never })).toBe(false);
  });
  it('never fires mid-turn or while a prompt waits — the caller\'s occupied test decides', () => {
    const s = idle(55 * MIN, { busy: true });
    expect(handoffDue({ session: s, now: T, config, occupied: (x) => !!x.busy })).toBe(false);
    expect(handoffDue({ session: idle(55 * MIN, { waitingForAnswer: 'perm' }), now: T, config, occupied: (x) => !!x.waitingForAnswer })).toBe(false);
  });
});

describe('planHandoff', () => {
  const config = handoffConfig({}, { reapTimeoutMs: HOUR });
  const base = { alive: true, agent: 'claude', lastActivityAt: T - 50 * MIN };
  const plan = (over = {}, cfg = config) => planHandoff({
    session: base, hasMission: true, missionStatusAt: null, coordinator: false,
    contextTokens: 400_000, contextWindow: 1_000_000, config: cfg, ...over,
  });
  it('asks for a status refresh and compacts a high gauge', () => {
    expect(plan()).toEqual({ statusTurn: true, compact: true, pct: 40, skipped: { status: null, compact: null } });
  });
  it('skips the status turn without a mission, for the Coordinator, and when the status is already newer', () => {
    expect(plan({ hasMission: false })).toMatchObject({ statusTurn: false, skipped: { status: 'no mission' } });
    expect(plan({ coordinator: true })).toMatchObject({ statusTurn: false, skipped: { status: 'coordinator' } });
    const after = new Date(T - 49 * MIN).toISOString();
    expect(plan({ missionStatusAt: after })).toMatchObject({ statusTurn: false, skipped: { status: 'status is current' } });
    // A status set in the closing minutes of the last turn counts as current too.
    const justBefore = new Date(T - 50 * MIN - STATUS_FRESH_GRACE_MS + 1).toISOString();
    expect(plan({ missionStatusAt: justBefore }).statusTurn).toBe(false);
    const wellBefore = new Date(T - 50 * MIN - STATUS_FRESH_GRACE_MS - 1).toISOString();
    expect(plan({ missionStatusAt: wellBefore }).statusTurn).toBe(true);
    // An unparseable timestamp is no reason to skip.
    expect(plan({ missionStatusAt: 'yesterday' }).statusTurn).toBe(true);
  });
  it('skips the compaction for Codex, below the threshold, without a gauge, and when compaction is off', () => {
    expect(plan({ session: { ...base, agent: 'codex' } })).toMatchObject({ compact: false, pct: 40, skipped: { compact: 'codex' } });
    expect(plan({ contextTokens: 199_999 })).toMatchObject({ compact: false, pct: 20, skipped: { compact: 'below threshold' } });
    expect(plan({ contextTokens: 200_000 }).compact).toBe(true);
    expect(plan({ contextTokens: undefined })).toMatchObject({ compact: false, pct: null, skipped: { compact: 'no gauge' } });
    expect(plan({ contextWindow: null })).toMatchObject({ compact: false, pct: null, skipped: { compact: 'no gauge' } });
    expect(plan({}, { ...config, compactPct: 0 })).toMatchObject({ compact: false, skipped: { compact: 'off' } });
  });
  it('rounds the gauge to a whole percent', () => {
    expect(plan({ contextTokens: 123_456 }).pct).toBe(12);
  });
});

describe('preReapCompactCommand', () => {
  it('passes one line of working-state instructions to the compact summarizer', () => {
    const command = preReapCompactCommand();
    expect(typeof command).toBe('string');
    expect(command.startsWith('/compact ')).toBe(true);
    expect(command).not.toMatch(/[\r\n]/);
    expect(isCompactCommand(command)).toBe(true);
    for (const topic of [
      'Preserve', 'session goal', "user's latest asks", 'mission', 'PR',
      'worktree', 'branch', 'names and paths', 'open tracker items',
      'unanswered questions', 'pending background jobs', 'reminders',
      'waits', 'promises made', 'exact next step',
    ]) expect(command).toContain(topic);
  });

  it('keeps compact queue priority and the frozen idle anchor', () => {
    const command = preReapCompactCommand();
    const queue = [command, 'continue working'].map(text => [{ type: 'text', text }]);
    expect(hasQueuedCompact(queue)).toBe(true);
    expect(compactBatchSize(queue)).toBe(1);
    const mark = { idleSince: T, at: T + MIN };
    const session = { _preReapHandoff: mark };
    noteTurnStart(session, command);
    expect(session._preReapHandoff).toBe(mark);
  });
});

describe('handoffTurnText', () => {
  it('is bridge-framed, names the idle time, and asks for status + milestone only on change, one line back', () => {
    const text = handoffTurnText({ idleMinutes: 50 });
    expect(text.startsWith(HANDOFF_TURN_PREFIX)).toBe(true);
    expect(HANDOFF_TURN_PREFIX).toBe('[pre-reap handoff from the bridge]');
    expect(text).toContain('idle for about 50 minutes');
    expect(text).toContain('mission_status');
    expect(text).toContain('milestone_post');
    expect(text).toMatch(/nothing has changed/i);
    expect(text).toContain("If this session's work is finished (its mission is done or it has completed the task it was given)");
    expect(text).toContain('and /close has not been run since its last real work');
    expect(text).toContain('run /close now (that is not new work); otherwise do nothing.');
    expect(text).toMatch(/do not start new work/i);
    expect(text).toMatch(/one line/i);
    expect(text).not.toContain('\n');
  });
});

describe('handoffNotice', () => {
  const skipped = { status: null, compact: null };
  it('is one line naming what the bridge did, or null when it did nothing', () => {
    expect(handoffNotice({ statusTurn: true, compact: true, pct: 42, skipped }, { idleMinutes: 50 }))
      .toBe('💤 Idle 50 min — asked this session to refresh its mission status; compacting its context (42%) once it answers.');
    expect(handoffNotice({ statusTurn: true, compact: false, pct: 10, skipped }, { idleMinutes: 55 }))
      .toBe('💤 Idle 55 min — asked this session to refresh its mission status before it sleeps.');
    expect(handoffNotice({ statusTurn: false, compact: true, pct: 42, skipped }, { idleMinutes: 50 }))
      .toBe('💤 Idle 50 min — compacting this session\'s context (42%) before it sleeps.');
    expect(handoffNotice({ statusTurn: false, compact: false, pct: 10, skipped }, { idleMinutes: 50 })).toBeNull();
  });
});
