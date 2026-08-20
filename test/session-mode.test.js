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
  // Used to be refused ("the session is still starting up"), which is what
  // made /login impossible as the first thing you say to a new chat — and a
  // box whose Claude is not logged in can never complete the turn that would
  // confirm the session, so the refusal was unescapable. Safe to allow:
  // recreateSession's preInitPrint branch respawns on the same id with
  // --session-id instead of --resume.
  it('approves switching a provisional (unconfirmed) print session to interactive', () => {
    const d = planModeSwitch({ iv: null, busy: false, claudeSessionId: 'abc', _sessionConfirmed: false }, true);
    expect(d.ok).toBe(true);
    expect(d.provisional).toBe(true);
  });
  it('does not promise preserved history for a provisional switch (there is none)', () => {
    const d = planModeSwitch({ iv: null, busy: false, claudeSessionId: 'abc', _sessionConfirmed: false }, true);
    expect(d.message).not.toMatch(/history preserved/i);
    const confirmed = planModeSwitch({ iv: null, busy: false, claudeSessionId: 'abc', _sessionConfirmed: true }, true);
    expect(confirmed.message).toMatch(/history preserved/i);
    expect(confirmed.provisional).toBe(false);
  });
  // The gates that must still bite — an unconfirmed session is allowed
  // through, but only once it actually has an id and is not mid-turn.
  it('still refuses a provisional switch while busy or before an id exists', () => {
    expect(planModeSwitch({ iv: null, busy: true, claudeSessionId: 'abc', _sessionConfirmed: false }, true).ok).toBe(false);
    expect(planModeSwitch({ iv: null, busy: false, claudeSessionId: null, _sessionConfirmed: false }, true).ok).toBe(false);
  });
  it('does NOT gate an iv session on _sessionConfirmed (iv confirms via a different path)', () => {
    // iv->print: current is interactive, so the print-provisional gate is skipped
    // even though iv never sets _sessionConfirmed.
    const d = planModeSwitch({ iv: { alive: true }, busy: false, claudeSessionId: 'abc' }, false);
    expect(d.ok).toBe(true);
  });
  it('refuses an otherwise-clean switch while media is in flight (drain gate)', () => {
    // A /mode switch recreates the session; doing it mid-media-prep makes the
    // media router drop the in-flight attachment at its canonicality guard, the
    // same hazard /switch and /restart now gate on. Checked last, so it only
    // blocks a switch that would otherwise succeed.
    const clean = { iv: null, busy: false, claudeSessionId: 'abc', _sessionConfirmed: true };
    const d = planModeSwitch(clean, true, { hasInflightMedia: true });
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/attachment/i);
    // No regression when nothing is in flight.
    expect(planModeSwitch(clean, true, { hasInflightMedia: false }).ok).toBe(true);
    expect(planModeSwitch(clean, true).ok).toBe(true);
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
  // #136 / PR #151: a fresh print session that crashes BEFORE Claude
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

  // /logout-crash-loop bug: a room can persist a session id Claude never
  // wrote a transcript for (a zero-turn chat — init events fire at spawn,
  // before the transcript exists). --resume on such an id exits 1 ("No
  // conversation found"), and the auto-restart/auto-resume paths retried it
  // forever. When the caller supplies a transcriptExists predicate, a
  // resume whose transcript is missing is demoted to a fresh spawn on the
  // SAME id (--session-id), preserving convo/journal identity.
  it('demotes a resume whose transcript is missing to --session-id on the same id', () => {
    const checked = [];
    const plan = sessionMode.planSessionIdentity({
      resumeSessionId: 'ghost-id', mintId: () => 'never',
      transcriptExists: (id) => { checked.push(id); return false; },
    });
    expect(checked).toEqual(['ghost-id']);
    expect(plan.sessionId).toBe('ghost-id');
    expect(plan.cliArgs).toEqual(['--session-id', 'ghost-id']);
    expect(plan.resumed).toBe(false);
  });
  it('a demoted resume id wins over presetId (identity is the resume id)', () => {
    const plan = sessionMode.planSessionIdentity({
      resumeSessionId: 'ghost-id', presetId: 'provisional-id', mintId: () => 'never',
      transcriptExists: () => false,
    });
    expect(plan.sessionId).toBe('ghost-id');
    expect(plan.cliArgs).toEqual(['--session-id', 'ghost-id']);
  });
  it('honors a resume whose transcript exists', () => {
    const plan = sessionMode.planSessionIdentity({
      resumeSessionId: 'real-id', mintId: () => 'never',
      transcriptExists: () => true,
    });
    expect(plan.cliArgs).toEqual(['--resume', 'real-id']);
    expect(plan.resumed).toBe(true);
  });
  it('keeps legacy resume behavior when no predicate is supplied', () => {
    const plan = sessionMode.planSessionIdentity({ resumeSessionId: 'old-id', mintId: () => 'never' });
    expect(plan.cliArgs).toEqual(['--resume', 'old-id']);
    expect(plan.resumed).toBe(true);
  });
  it('fresh and preset plans report resumed:false', () => {
    expect(sessionMode.planSessionIdentity({ mintId: () => 'uuid-1' }).resumed).toBe(false);
    expect(sessionMode.planSessionIdentity({ presetId: 'p-1', mintId: () => 'never' }).resumed).toBe(false);
  });
});

// /logout-crash-loop bug, root cause: _sessionConfirmed was set by ANY event
// carrying session_id — but claude emits `system` events (init, hook_started/
// hook_response) at spawn, BEFORE any transcript exists. A zero-turn session
// was therefore marked resumable, and /logout's print→interactive switch
// spawned `claude --resume <id>` into "No conversation found" (exit 1) on a
// loop. Only turn-bearing events prove the transcript is on disk.
describe('eventConfirmsSession', () => {
  it('rejects system events (init and hooks fire pre-transcript at spawn)', () => {
    expect(sessionMode.eventConfirmsSession({ type: 'system', subtype: 'init', session_id: 'x' })).toBe(false);
    expect(sessionMode.eventConfirmsSession({ type: 'system', subtype: 'hook_started', session_id: 'x' })).toBe(false);
  });
  it('accepts turn-bearing events carrying a session_id', () => {
    for (const type of ['assistant', 'user', 'result', 'stream_event']) {
      expect(sessionMode.eventConfirmsSession({ type, session_id: 'x' })).toBe(true);
    }
  });
  it('rejects events without a session_id, and non-objects', () => {
    expect(sessionMode.eventConfirmsSession({ type: 'assistant' })).toBe(false);
    expect(sessionMode.eventConfirmsSession(null)).toBe(false);
    expect(sessionMode.eventConfirmsSession(undefined)).toBe(false);
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

  // #136 / PR #151: the auto-restart must not --resume a session that
  // crashed before Claude persisted it. Scoped to PRINT mode only — iv-mode
  // confirms from camel-case `sessionId` transcript records that the snake-case
  // capture never sees, so gating iv would break its resume-after-persist
  // (PR review round 2 Blocker 2). Print-mode assertions are therefore singular.
  it('marks _sessionConfirmed only on turn-bearing events (eventConfirmsSession, not raw session_id)', () => {
    expect(src).toMatch(/if \(eventConfirmsSession\(event\)\) session\._sessionConfirmed = true;/);
    expect(src).not.toMatch(/if \(event\.session_id\) session\._sessionConfirmed = true;/);
  });
  it('both spawn paths guard --resume with a transcriptExists predicate', () => {
    const guards = src.match(/transcriptExists: \(id\) => fs\.existsSync\(transcriptPathFor\(cwd, id\)\)/g) || [];
    expect(guards.length).toBe(2);
  });
  // Both spawn paths, not just print: a print->interactive switch on an
  // unconfirmed session reaches the iv spawn with no resume id, so without
  // presetId there it would mint a new uuid and change the room's claude
  // session id mid-switch — exactly what recreateSession says it preserves.
  it('both spawn helpers thread presetSessionId into planSessionIdentity', () => {
    const calls = src.match(/planSessionIdentity\(\{\s*resumeSessionId,\s*presetId: options\.presetSessionId/g) || [];
    expect(calls.length).toBe(2);
  });
  it('the print auto-restart uses claudeSessionId only when confirmed, presetSessionId otherwise', () => {
    const resumeGates = src.match(/session\._sessionConfirmed \? session\.claudeSessionId : null/g) || [];
    expect(resumeGates.length).toBe(1);
    const presetGates = src.match(/presetSessionId: session\._sessionConfirmed \? undefined : session\.claudeSessionId/g) || [];
    expect(presetGates.length).toBe(1);
  });
  it('the print constructor inits _sessionConfirmed from the identity plan (a demoted resume is NOT confirmed)', () => {
    const inits = src.match(/_sessionConfirmed: identity\.resumed/g) || [];
    expect(inits.length).toBe(1);
    expect(src).not.toMatch(/_sessionConfirmed: !!resumeSessionId/);
  });
  it('/login no longer demands a first message before it will run', () => {
    // The "send any message first" guard is gone: planModeSwitch now approves
    // the provisional switch, so a zero-turn chat reaches the mode switch on
    // its own. It has to stay gone — an unauthenticated box cannot complete
    // the turn the old message asked for, which made /login unreachable
    // precisely when it was the only thing that would help (jack, dev-j).
    expect(src).not.toMatch(/needs a conversation that has started/);
    // Busy is still handled, now by planModeSwitch's own refusal rather than
    // by an exclusion in a guard that no longer exists (Bugbot, PR #173).
    expect(src).not.toMatch(/!session\._sessionConfirmed && !session\.busy/);
  });

  // PR #151 follow-up: !restart goes through recreateSession, which passed
  // existing.claudeSessionId as the resume id UNCONDITIONALLY — a !restart
  // during the pre-init window hit the exact never-written-id --resume
  // failure the auto-restart path guards. This gate now carries /mode and
  // /login as well: since planModeSwitch stopped refusing unconfirmed print
  // sessions, the demotion below is the only thing keeping those two off a
  // --resume that cannot work.
  it('recreateSession gates the pre-init respawn on _sessionConfirmed, print-mode Claude only', () => {
    // Unconfirmed print → no resume id, same id threaded as presetSessionId
    // (--session-id). Confirmed (or iv / Codex, which never set the flag) →
    // resume exactly as before.
    expect(src).toMatch(/const preInitPrint = existing\.agent === AGENT_CLAUDE && !existing\.iv && !existing\._sessionConfirmed;/);
    const resumeGates = src.match(/createSession\(roomId, workdir, preInitPrint \? null : sessionId, \{/g) || [];
    expect(resumeGates.length).toBe(1);
    const presetGates = src.match(/presetSessionId: preInitPrint \? sessionId : undefined,/g) || [];
    expect(presetGates.length).toBe(1);
  });
});

describe('shouldRunAccountFlowReturn', () => {
  const owed = { alive: true, iv: {}, _accountFlowReturnToPrint: true };

  it('runs for an alive interactive session that owes a return to print', () => {
    expect(sessionMode.shouldRunAccountFlowReturn(owed)).toBe(true);
  });

  it('runs for a REPLACEMENT session carrying the copied flag (no identity requirement)', () => {
    // The iv auto-restart path copies _accountFlowReturnToPrint onto the new
    // session object; the timer must honor it even though it is not the
    // object that scheduled the timer.
    const replacement = { ...owed };
    expect(sessionMode.shouldRunAccountFlowReturn(replacement)).toBe(true);
  });

  it('is a no-op when the room has no session', () => {
    expect(sessionMode.shouldRunAccountFlowReturn(undefined)).toBe(false);
    expect(sessionMode.shouldRunAccountFlowReturn(null)).toBe(false);
  });

  it('is a no-op for a dead session', () => {
    expect(sessionMode.shouldRunAccountFlowReturn({ ...owed, alive: false })).toBe(false);
  });

  it('is a no-op once the session is back in print mode', () => {
    expect(sessionMode.shouldRunAccountFlowReturn({ ...owed, iv: null })).toBe(false);
  });

  it('is a no-op when the flow was already consumed or abandoned', () => {
    expect(sessionMode.shouldRunAccountFlowReturn({ ...owed, _accountFlowReturnToPrint: false })).toBe(false);
  });
});

describe('account-flow flag hygiene (source inspection)', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');

  it('the iv crash-restart enters the resume hold so parked commands run', () => {
    expect(src).toMatch(/enterResumeHold\(restarted\);/);
  });

  it('the readiness watcher clears a stale logout mark unless it is about to type /logout', () => {
    expect(src).toMatch(/if \(parkedSlash !== '\/logout'\) session\._accountLogoutPending = false;/);
  });

  it('iv account branches assign (not conditionally set) the logout mark, and never arm the return-to-print flag', () => {
    const assigns = src.match(/session\._accountLogoutPending = cmdWord === 'logout';/g) || [];
    expect(assigns.length).toBe(2);
    // _accountFlowReturnToPrint means "the bridge borrowed iv mode from a
    // print session" — only the print branch may arm it (on the replacement
    // session), never the already-interactive branches.
    const arms = src.match(/session\._accountFlowReturnToPrint = true;/g) || [];
    expect(arms.length).toBe(0);
    const nextArms = src.match(/next\._accountFlowReturnToPrint = true;/g) || [];
    expect(nextArms.length).toBe(1);
  });
});
