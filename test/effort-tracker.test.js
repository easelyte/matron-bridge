import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  isEffortConfirmationPrompt,
  noteEffortWrite,
  noteEffortConfirmationPrompt,
  noteEffortConfirmationAnswer,
  noteEffortIdle,
  resetEffortTracking,
  trackedEffort,
} from '../lib/effort-tracker.js';
import { buildSessionStatus } from '../lib/session-status.js';

// The "Change effort level?" menu exactly as the PromptDetector classifies it
// (see the fixture in test/prompt-detector.test.js).
function confirmPrompt(level = 'ultracode') {
  return {
    kind: 'numbered',
    question: 'Change effort level? This conversation is cached. Switching to ' +
      `${level} re-reads history.`,
    options: [
      { key: '1', label: `Yes, switch to ${level}` },
      { key: '2', label: 'No, go back' },
    ],
  };
}

describe('isEffortConfirmationPrompt', () => {
  it('recognises the TUI effort confirmation and nothing else', () => {
    expect(isEffortConfirmationPrompt(confirmPrompt())).toBe(true);
    expect(isEffortConfirmationPrompt({ kind: 'numbered', question: 'Change model?', options: [] })).toBe(false);
    expect(isEffortConfirmationPrompt(null)).toBe(false);
  });
});

describe('effort tracking', () => {
  it('starts UNKNOWN — never a guess', () => {
    const session = {};
    expect(trackedEffort(session)).toBeNull();
  });

  it('writing /effort does NOT itself set the tracked value', () => {
    const session = {};
    noteEffortWrite(session, 'high');
    expect(trackedEffort(session)).toBeNull();
  });

  it('a CONFIRMED change sets the tracked value', () => {
    const session = {};
    noteEffortWrite(session, 'high');
    const prompt = confirmPrompt('high');
    noteEffortConfirmationPrompt(session, prompt);
    expect(trackedEffort(session)).toBeNull(); // still unconfirmed
    noteEffortConfirmationAnswer(session, prompt, 'Yes, switch to high');
    expect(trackedEffort(session)).toBe('high');
  });

  it('when NO confirmation appears before the session goes idle again, the write stands', () => {
    const session = {};
    noteEffortWrite(session, 'max');
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBe('max');
  });

  it('an armed confirmation blocks the idle path — only the answer settles it', () => {
    const session = {};
    noteEffortWrite(session, 'max');
    noteEffortConfirmationPrompt(session, confirmPrompt('max'));
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBeNull();
  });

  it('a DECLINED confirmation leaves the previous value — including unknown', () => {
    const session = {};
    noteEffortWrite(session, 'low');
    const first = confirmPrompt('low');
    noteEffortConfirmationPrompt(session, first);
    noteEffortConfirmationAnswer(session, first, 'No, go back');
    expect(trackedEffort(session)).toBeNull();

    // And with a value already tracked, a decline leaves THAT value standing.
    noteEffortWrite(session, 'high');
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBe('high');
    noteEffortWrite(session, 'low');
    const second = confirmPrompt('low');
    noteEffortConfirmationPrompt(session, second);
    noteEffortConfirmationAnswer(session, second, 'No, go back');
    expect(trackedEffort(session)).toBe('high');
  });

  it('resets to unknown at the session start/restart/resume seam', () => {
    const session = {};
    noteEffortWrite(session, 'xhigh');
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBe('xhigh');
    resetEffortTracking(session);
    expect(trackedEffort(session)).toBeNull();
    // The reset also drops a write that was still in flight.
    noteEffortWrite(session, 'low');
    resetEffortTracking(session);
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBeNull();
  });

  // The reset rule only does its job if the reset is OBSERVABLE. Clients merge
  // status fields stickily, so an omitted effort reads as "unchanged" and the
  // app would keep rendering the pre-restart level — exactly the false
  // confidence the reset exists to prevent. Guard the tracker→frame round trip.
  it('publishes an explicit null after a restart/resume reset, not an absent field', () => {
    const session = {};
    noteEffortWrite(session, 'ultracode');
    noteEffortIdle(session);
    expect(buildSessionStatus({ effort: trackedEffort(session) }).effort).toBe('ultracode');

    resetEffortTracking(session);
    const frame = buildSessionStatus({ effort: trackedEffort(session) });
    expect('effort' in frame).toBe(true);
    expect(frame.effort).toBeNull();
  });

  it('ignores a confirmation with no pending write (the host-terminal /effort gap)', () => {
    const session = {};
    const prompt = confirmPrompt('ultracode');
    noteEffortConfirmationPrompt(session, prompt);
    noteEffortConfirmationAnswer(session, prompt, 'Yes, switch to ultracode');
    expect(trackedEffort(session)).toBeNull();
  });

  it('ignores an unrelated prompt — it neither arms nor settles a pending write', () => {
    const session = {};
    noteEffortWrite(session, 'medium');
    const other = { kind: 'numbered', question: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes' }] };
    noteEffortConfirmationPrompt(session, other);
    noteEffortConfirmationAnswer(session, other, 'Yes');
    expect(trackedEffort(session)).toBeNull();
    // Still pending, so the idle seam settles it as normal.
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBe('medium');
  });

  it('normalizes the written level so the published value matches the alias list', () => {
    const session = {};
    noteEffortWrite(session, '  High ');
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBe('high');
  });

  it('refuses to track a level that is not a known effort level', () => {
    const session = {};
    noteEffortWrite(session, 'turbo');
    noteEffortIdle(session);
    expect(trackedEffort(session)).toBeNull();
  });
});

// index.js can't be imported in-process (it starts the bridge), so pin the
// wiring by source inspection — same pattern as the session-status tests.
describe('index.js effort-tracking wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');

  it('arms the confirmation BEFORE the prompt handler publishes idle activity', () => {
    const start = src.indexOf("iv.on('prompt', prompt => {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("iv.on('parseError'", start));
    const armed = body.indexOf('noteEffortConfirmationPrompt(session, prompt)');
    const idle = body.indexOf("journalActivity(session, 'idle')");
    expect(armed).toBeGreaterThan(-1);
    expect(idle).toBeGreaterThan(-1);
    // Ordering is load-bearing: an idle transition published first would
    // settle the pending write the confirmation is about to question.
    expect(armed).toBeLessThan(idle);
  });

  it('settles a pending write on the idle transition, after the dedup guard', () => {
    const start = src.indexOf('function journalActivity(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    const guard = body.indexOf('activityStateChanged(');
    const settle = body.indexOf("if (state === 'idle' && noteEffortIdle(session)) persistEffortLevel(session)");
    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(guard);
  });

  it('records the write from the /effort command path', () => {
    expect(src).toMatch(/import \{[^}]*noteEffortWrite[^}]*\} from '\.\/lib\/effort-tracker\.js'/);
    expect(src).toContain('noteEffortWrite(');
  });

  it('settles the confirmation from both answer paths (typed reply and journal tap)', () => {
    const typed = src.slice(
      src.indexOf('function maybeResolveInteractivePrompt('),
      src.indexOf('function handleInteractiveScreenUpdate('),
    );
    expect(typed).toContain('noteEffortConfirmationAnswer(session, p,');
    const tapStart = src.indexOf('function journalRoutePromptReply(');
    expect(tapStart).toBeGreaterThan(-1);
    const tap = src.slice(tapStart, src.indexOf('\nfunction ', tapStart + 1));
    expect(tap).toContain('noteEffortConfirmationAnswer(session, p,');
  });

  it('hands the live level to a recreate as its --effort, never the tracker state', () => {
    const start = src.indexOf('function recreateSession(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    // A copied pending write or armed confirmation belongs to the old
    // process; the replacement is seeded from the flag it was given.
    expect(body).not.toContain('_effort');
    expect(body).toContain('{ effort: trackedEffort(existing) }');
  });

  it('seeds both Claude spawns from the --effort they pass', () => {
    expect(src).toContain("if (printEffort) args.push('--effort', printEffort);");
    expect(src).toContain('_effort: { level: printEffort || null, pending: null, awaitingConfirm: false },');
    expect(src).toContain("if (ivEffort) claudeArgs.push('--effort', ivEffort);");
    expect(src).toContain('_effort: { level: ivEffort || null, pending: null, awaitingConfirm: false },');
  });

  it('persists the level with the room and every commit saves it', () => {
    expect(src).toContain('if (live && live.agent === AGENT_CLAUDE) derived.claudeEffort = trackedEffort(live);');
    expect(src.match(/if \(noteEffortConfirmationAnswer\([^)]*\)\) persistEffortLevel\(session\);/g)?.length).toBe(4);
  });

  it('settles a silent write on an idle session that never transitions to idle again', () => {
    const start = src.indexOf('function scheduleEffortSettle(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    // Only while still idle with no confirmation open: a busy session is
    // settled by its turn's end, an armed menu only by its answer.
    expect(body).toContain('if (session.busy || session.pendingInteractivePrompt) return;');
    expect(body).toContain('if (noteEffortIdle(session)) {');
    // One window per write: the previous timer goes, and a timer only
    // settles the level it was armed for.
    expect(body).toContain('if (session._effortSettleTimer) clearTimeout(session._effortSettleTimer);');
    expect(body).toContain("if (!level || session._effort?.pending !== level) return;");
    const sw = src.slice(src.indexOf('function switchEffortAndTrack('), start);
    expect(sw).toContain('noteEffortWrite(session, arg);\n    guardEffortDefault(session);\n    scheduleEffortSettle(session);');
  });

  it('accepts an armed confirmation before the prompt is surfaced', () => {
    const start = src.indexOf("iv.on('prompt', prompt => {");
    const body = src.slice(start, src.indexOf("iv.on('parseError'", start));
    const auto = body.indexOf('effortAutoConfirmResponse(session, prompt)');
    expect(auto).toBeGreaterThan(body.indexOf('noteEffortConfirmationPrompt(session, prompt)'));
    expect(auto).toBeLessThan(body.indexOf('handleInteractivePrompt(session, prompt)'));
  });
});
