import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveInteractive,
  resolveModel,
  normalizeModeArg,
  modeLabel,
  modeButtons,
  planModeSwitch,
} from '../lib/session-mode.js';
import * as sessionMode from '../lib/session-mode.js';

describe('resolveInteractive', () => {
  it('prefers an explicit boolean option over everything', () => {
    expect(resolveInteractive({ option: true, persisted: false, fallback: false })).toBe(true);
    expect(resolveInteractive({ option: false, persisted: true, fallback: true })).toBe(false);
  });
  it('falls back to the persisted value when no option', () => {
    expect(resolveInteractive({ option: undefined, persisted: true, fallback: false })).toBe(true);
    expect(resolveInteractive({ option: undefined, persisted: false, fallback: true })).toBe(false);
  });
  it('falls back to the global default when neither is set', () => {
    expect(resolveInteractive({ option: undefined, persisted: undefined, fallback: true })).toBe(true);
    expect(resolveInteractive({ option: undefined, persisted: undefined, fallback: false })).toBe(false);
  });
});

describe('resolveModel', () => {
  it('prefers the explicit option, then persisted, then undefined', () => {
    expect(resolveModel({ option: 'sonnet', persisted: 'opus' })).toBe('sonnet');
    expect(resolveModel({ option: undefined, persisted: 'opus' })).toBe('opus');
    expect(resolveModel({ option: undefined, persisted: undefined })).toBeUndefined();
  });
});

describe('normalizeModeArg', () => {
  it('maps interactive aliases', () => {
    for (const a of ['interactive', 'iv', 'tui', 'INTERACTIVE', ' iv ']) {
      expect(normalizeModeArg(a)).toBe('interactive');
    }
  });
  it('maps print aliases', () => {
    for (const a of ['print', 'noniv', 'non-interactive', 'p']) {
      expect(normalizeModeArg(a)).toBe('print');
    }
  });
  it('returns null for anything else', () => {
    expect(normalizeModeArg('banana')).toBeNull();
    expect(normalizeModeArg('')).toBeNull();
    expect(normalizeModeArg(undefined)).toBeNull();
  });
});

describe('modeLabel', () => {
  it('labels both modes', () => {
    expect(modeLabel(true)).toBe('interactive');
    expect(modeLabel(false)).toBe('non-interactive');
  });
});

describe('modeButtons', () => {
  it('offers a single button that flips to the other mode', () => {
    expect(modeButtons(false)).toEqual([
      { id: 'mode-interactive', label: 'Switch to interactive', value: 'mode:interactive' },
    ]);
    expect(modeButtons(true)).toEqual([
      { id: 'mode-print', label: 'Switch to non-interactive', value: 'mode:print' },
    ]);
  });
});

describe('planModeSwitch', () => {
  it('no-ops when already in the requested mode', () => {
    const d = planModeSwitch({ iv: { alive: true } }, true);
    expect(d.ok).toBe(false);
    expect(d.noop).toBe(true);
    expect(d.message).toMatch(/already/i);
  });
  it('refuses while the session is busy', () => {
    const d = planModeSwitch({ iv: null, busy: true }, true);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/turn/i);
  });
  it('refuses interactive->print while a TUI prompt is pending', () => {
    const d = planModeSwitch({ iv: { alive: true }, claudeSessionId: 'abc', pendingInteractivePrompt: {} }, false);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/question/i);
  });
  it('refuses while the session is still in the post-resume input hold', () => {
    const d = planModeSwitch({ iv: { alive: true }, busy: false, _awaitingInputReady: true }, false);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/resuming/i);
  });
  it('refuses while the session has no id yet (fresh print session)', () => {
    const d = planModeSwitch({ iv: null, busy: false, claudeSessionId: null }, true);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/starting up/i);
  });
  it('approves a clean switch', () => {
    const d = planModeSwitch({ iv: null, busy: false, claudeSessionId: 'abc', _sessionConfirmed: true }, true);
    expect(d.ok).toBe(true);
    expect(d.message).toMatch(/interactive/i);
  });
  it('refuses switching a provisional (unconfirmed) print session to interactive', () => {
    const d = planModeSwitch({ iv: null, busy: false, claudeSessionId: 'abc', _sessionConfirmed: false }, true);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/starting up/i);
  });
  it('does NOT gate an iv session on _sessionConfirmed (iv confirms via a different path)', () => {
    // iv->print: current is interactive, so the print-provisional gate is skipped
    // even though iv never sets _sessionConfirmed.
    const d = planModeSwitch({ iv: { alive: true }, busy: false, claudeSessionId: 'abc' }, false);
    expect(d.ok).toBe(true);
  });
});

describe('planSessionIdentity', () => {
  it('mints an id and plans --session-id for a fresh session', () => {
    const plan = sessionMode.planSessionIdentity({ resumeSessionId: undefined, mintId: () => 'uuid-1' });
    expect(plan.sessionId).toBe('uuid-1');
    expect(plan.cliArgs).toEqual(['--session-id', 'uuid-1']);
  });
  it('reuses the resume id and plans --resume without minting', () => {
    let minted = 0;
    const plan = sessionMode.planSessionIdentity({ resumeSessionId: 'old-id', mintId: () => { minted++; return 'never'; } });
    expect(plan.sessionId).toBe('old-id');
    expect(plan.cliArgs).toEqual(['--resume', 'old-id']);
    expect(minted).toBe(0);
  });
  // #136 / loop #459: a fresh print session that crashes BEFORE Claude
  // persisted a resumable session must respawn with the SAME id via
  // --session-id (not --resume, which would fail on a never-written session).
  // presetId reuses the given id without minting and keeps --session-id.
  it('reuses a presetId via --session-id (no --resume) without minting, when not resuming', () => {
    let minted = 0;
    const plan = sessionMode.planSessionIdentity({
      resumeSessionId: undefined, presetId: 'provisional-id', mintId: () => { minted++; return 'never'; },
    });
    expect(plan.sessionId).toBe('provisional-id');
    expect(plan.cliArgs).toEqual(['--session-id', 'provisional-id']);
    expect(minted).toBe(0);
  });
  it('resumeSessionId wins over presetId (a confirmed session resumes)', () => {
    const plan = sessionMode.planSessionIdentity({
      resumeSessionId: 'confirmed-id', presetId: 'provisional-id', mintId: () => 'never',
    });
    expect(plan.sessionId).toBe('confirmed-id');
    expect(plan.cliArgs).toEqual(['--resume', 'confirmed-id']);
  });
});

// Wiring guard: index.js can't be imported in-process (it starts the bridge),
// so assert by source inspection — the same pattern command-dispatch.test.js
// uses. Both spawn paths must route their id args through planSessionIdentity
// so a fresh PRINT session knows its claudeSessionId synchronously (RPC start
// needs it to answer convo_id) and the --session-id/--resume exclusivity rule
// lives in exactly one place.
describe('createSession id pre-assignment (source inspection)', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
  it('both spawn paths use planSessionIdentity', () => {
    const calls = src.match(/planSessionIdentity\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
  it('no hand-rolled --session-id/--resume args outside the helper', () => {
    expect(src).not.toMatch(/push\('--session-id'/);
    expect(src).not.toMatch(/push\('--resume'/);
  });

  // #136 / loop #459: the auto-restart must not --resume a session that
  // crashed before Claude persisted it. Scoped to PRINT mode only — iv-mode
  // confirms from camel-case `sessionId` transcript records that the snake-case
  // capture never sees, so gating iv would break its resume-after-persist
  // (PR review round 2 Blocker 2). Print-mode assertions are therefore singular.
  it('marks _sessionConfirmed the first time a session_id event arrives', () => {
    expect(src).toMatch(/if \(event\.session_id\) session\._sessionConfirmed = true;/);
  });
  it('the print spawn helper threads presetSessionId into planSessionIdentity (once, print-only)', () => {
    const calls = src.match(/planSessionIdentity\(\{ resumeSessionId, presetId: options\.presetSessionId/g) || [];
    expect(calls.length).toBe(1);
  });
  it('the print auto-restart uses claudeSessionId only when confirmed, presetSessionId otherwise', () => {
    const resumeGates = src.match(/session\._sessionConfirmed \? session\.claudeSessionId : null/g) || [];
    expect(resumeGates.length).toBe(1);
    const presetGates = src.match(/presetSessionId: session\._sessionConfirmed \? undefined : session\.claudeSessionId/g) || [];
    expect(presetGates.length).toBe(1);
  });
  it('the print constructor inits _sessionConfirmed from resumeSessionId (iv is unconditional --resume)', () => {
    const inits = src.match(/_sessionConfirmed: !!resumeSessionId/g) || [];
    expect(inits.length).toBe(1);
  });
});
