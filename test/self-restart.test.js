import { describe, it, expect } from 'vitest';
import {
  SELF_RESTART_MAX,
  CONTINUE_MAX_CHARS,
  CONTINUATION_PREFIX,
  planSelfRestart, parseSelfRestartMax } from '../lib/self-restart.js';

// A session restarting ITSELF (the restart_session MCP tool): the agent asks
// the bridge to respawn its own claude process — typically to pick up browser
// tools — and hands over a message the bridge sends back into the replacement
// so the work carries on without the user having to retype anything.
//
// planSelfRestart is the whole decision: it either refuses with a message the
// agent reads, or returns the !restart command text to park plus the exact
// continuation text to queue. The endpoint in index.js is deliberately thin
// around it so every rule below is testable without a live session.

const ok = (over = {}) => ({
  continueWith: 'Take a screenshot of localhost:3000 and check the header.',
  browser: true,
  model: null,
  agent: 'claude',
  restartCount: 0,
  ...over,
});

describe('planSelfRestart — the command it parks', () => {
  it('always forces, so the parked restart cannot re-defer itself', () => {
    // Without --force the replayed command would hit the busy check again
    // and park a second time, forever.
    expect(planSelfRestart(ok()).command).toMatch(/^!restart --force\b/);
  });

  it('passes --browser when browser tools were asked for', () => {
    expect(planSelfRestart(ok()).command).toBe('!restart --force --browser');
  });

  it('omits --browser when not asked for, preserving the session extras', () => {
    expect(planSelfRestart(ok({ browser: false })).command).toBe('!restart --force');
  });

  it('passes --model with the requested alias', () => {
    expect(planSelfRestart(ok({ browser: false, model: 'opus' })).command)
      .toBe('!restart --force --model opus');
  });

  it('combines browser and model in one restart', () => {
    expect(planSelfRestart(ok({ model: 'sonnet[1m]' })).command)
      .toBe('!restart --force --browser --model sonnet[1m]');
  });
});

describe('planSelfRestart — the continuation it queues', () => {
  it('marks the text so it is never mistaken for something the user typed', () => {
    const { continuation } = planSelfRestart(ok({ continueWith: 'Carry on with the audit.' }));
    expect(continuation).toBe(`${CONTINUATION_PREFIX}Carry on with the audit.`);
  });

  it('trims surrounding whitespace before marking', () => {
    expect(planSelfRestart(ok({ continueWith: '  do the thing\n' })).continuation)
      .toBe(`${CONTINUATION_PREFIX}do the thing`);
  });

  it('refuses an empty or whitespace-only continuation', () => {
    // A restart with nothing to say afterwards strands the session silently:
    // the process respawns and then just sits there.
    expect(planSelfRestart(ok({ continueWith: '   ' })).error).toMatch(/continue_with/);
    expect(planSelfRestart(ok({ continueWith: '' })).command).toBeUndefined();
  });

  it('refuses a non-string continuation', () => {
    expect(planSelfRestart(ok({ continueWith: null })).error).toMatch(/continue_with/);
  });

  it(`refuses a continuation longer than ${CONTINUE_MAX_CHARS} characters`, () => {
    const res = planSelfRestart(ok({ continueWith: 'x'.repeat(CONTINUE_MAX_CHARS + 1) }));
    expect(res.error).toMatch(/characters/);
    expect(res.command).toBeUndefined();
  });

  it('accepts a continuation exactly at the limit', () => {
    expect(planSelfRestart(ok({ continueWith: 'x'.repeat(CONTINUE_MAX_CHARS) })).error).toBeUndefined();
  });
});

describe('planSelfRestart — loop budget', () => {
  it('allows restarts below the cap', () => {
    expect(planSelfRestart(ok({ restartCount: SELF_RESTART_MAX - 1 })).error).toBeUndefined();
  });

  it('refuses once the cap is reached', () => {
    // The runaway case: the continuation message tells the next turn to
    // restart again, and nobody is watching.
    const res = planSelfRestart(ok({ restartCount: SELF_RESTART_MAX }));
    expect(res.error).toMatch(/ask the user/i);
    expect(res.command).toBeUndefined();
  });

  it('reports the budget it spent so the caller can say so', () => {
    expect(planSelfRestart(ok({ restartCount: 1 })).restartCount).toBe(2);
  });

  it('refuses above the cap too, not just exactly at it', () => {
    expect(planSelfRestart(ok({ restartCount: SELF_RESTART_MAX + 5 })).error).toBeTruthy();
  });

  it('treats a missing count as a fresh budget', () => {
    expect(planSelfRestart(ok({ restartCount: undefined })).restartCount).toBe(1);
  });
});

describe('planSelfRestart — model validation', () => {
  it('refuses an unknown alias before the session is killed', () => {
    // Validating here matters: a bad alias discovered at turn-end replay
    // would have already torn the session down.
    const res = planSelfRestart(ok({ model: 'gpt-5' }));
    expect(res.error).toMatch(/model/i);
    expect(res.command).toBeUndefined();
  });

  it('accepts a full claude-* model name', () => {
    expect(planSelfRestart(ok({ browser: false, model: 'claude-opus-4-8' })).command)
      .toBe('!restart --force --model claude-opus-4-8');
  });

  it('ignores an empty model string rather than refusing it', () => {
    expect(planSelfRestart(ok({ browser: false, model: '' })).command).toBe('!restart --force');
  });
});

describe('planSelfRestart — Codex sessions', () => {
  it('refuses browser tools, which are a Claude-only session extra', () => {
    expect(planSelfRestart(ok({ agent: 'codex' })).error).toMatch(/Claude-only/);
  });

  it('refuses a model switch, which Codex takes from its own config', () => {
    expect(planSelfRestart(ok({ agent: 'codex', browser: false, model: 'opus' })).error)
      .toMatch(/Codex/);
  });

  it('allows a plain restart with a continuation', () => {
    const res = planSelfRestart(ok({ agent: 'codex', browser: false }));
    expect(res.error).toBeUndefined();
    expect(res.command).toBe('!restart --force');
  });
});

describe('parseSelfRestartMax (MATRON_SELF_RESTART_MAX)', () => {
  it('uses the default when unset or not a number, so the cap always binds', () => {
    expect(parseSelfRestartMax(undefined)).toBe(3);
    expect(parseSelfRestartMax('')).toBe(3);
    expect(parseSelfRestartMax('lots')).toBe(3);
    expect(parseSelfRestartMax('-1')).toBe(3);
  });
  it('accepts a non-negative integer, including 0 (self-restart off)', () => {
    expect(parseSelfRestartMax('5')).toBe(5);
    expect(parseSelfRestartMax('0')).toBe(0);
  });
});
