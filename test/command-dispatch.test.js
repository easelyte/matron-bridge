import { describe, it, expect, vi } from 'vitest';
import {
  BRIDGE_COMMAND_NAMES,
  classifyBridgeCommand,
  classifyPrintRescue,
  classifyRescueKeystroke,
  classifyBusyMagicWord,
  isPlanBuildText,
  dispatchPlanBuild,
  isIvSlashPassthrough,
  dispatchJournalBridgeCommand,
  dispatchJournalRescueKeystroke,
  normalizeJournalControlCommand,
  classifyJournalControlCommand,
  JOURNAL_CONTROL_ALIASES,
  JOURNAL_CONTROL_HELP,
  JOURNAL_CONTROL_HELP_NOTE,
  JOURNAL_UNAVAILABLE_COMMANDS,
} from '../lib/command-dispatch.js';

// Journal command-classifier pins (Deliverable 4; formerly "Matrix
// regression pins" — Matrix's room.message handler was retired in Task 4,
// so the journal input consumer is now the sole caller of these
// classifiers). These lock in the classification behavior the journal path
// depends on (index.js's bridgeCommandNames gate, the !enter/!esc rescue
// block, and the isClaudeSlashCommand predicate). If a future edit changes
// what these return, the journal transport silently breaks — that's exactly
// the failure mode this file exists to catch.
describe('classifyBridgeCommand (journal command classification pin)', () => {
  it('classifies /stop', () => {
    expect(classifyBridgeCommand('/stop')).toBe('!stop');
  });

  it('classifies /status', () => {
    expect(classifyBridgeCommand('/status')).toBe('!status');
  });

  it('classifies the ! spelling identically to the / spelling', () => {
    expect(classifyBridgeCommand('!stop')).toBe('!stop');
    expect(classifyBridgeCommand('!status')).toBe('!status');
  });

  it('is case-insensitive on the command word', () => {
    expect(classifyBridgeCommand('/STOP')).toBe('!STOP');
    expect(classifyBridgeCommand('/Status')).toBe('!Status');
  });

  it('preserves arguments verbatim after the bang-normalized command', () => {
    expect(classifyBridgeCommand('/start /tmp/some dir --browser')).toBe('!start /tmp/some dir --browser');
    expect(classifyBridgeCommand('/model sonnet')).toBe('!model sonnet');
    expect(classifyBridgeCommand('/switch codex')).toBe('!switch codex');
  });

  it('classifies /sleep', () => {
    // Registered here rather than only in index.js's switch so BOTH
    // transports intercept it — a /sleep that reached the agent as ordinary
    // text would be a prompt, not a shutdown.
    expect(classifyBridgeCommand('/sleep')).toBe('!sleep');
    expect(BRIDGE_COMMAND_NAMES.has('sleep')).toBe(true);
  });

  it('classifies every bridge command name', () => {
    for (const name of BRIDGE_COMMAND_NAMES) {
      expect(classifyBridgeCommand('/' + name)).toBe('!' + name);
      expect(classifyBridgeCommand('!' + name)).toBe('!' + name);
    }
  });

  it('returns null for unknown-slash commands (TUI passthrough territory)', () => {
    expect(classifyBridgeCommand('/mcp-login')).toBeNull();
    expect(classifyBridgeCommand('/compact')).toBeNull();
    expect(classifyBridgeCommand('/commit')).toBeNull();
  });

  it('intercepts /login and /logout (print mode needs the interactive auto-switch)', () => {
    // Previously TUI-passthrough-only; the bridge now owns them so a print
    // session can switch itself to interactive and run the account flow
    // (handleCommand '!login'/'!logout', Dan 2026-07-15).
    expect(classifyBridgeCommand('/login')).toBe('!login');
    expect(classifyBridgeCommand('/logout')).toBe('!logout');
    expect(classifyBridgeCommand('!login')).toBe('!login');
    expect(classifyBridgeCommand('!logout')).toBe('!logout');
  });

  it('returns null for the show_bash family — never wired into the gate, even in Matrix', () => {
    // handleCommand's switch has cases for these, but bridgeCommandNames
    // never included them, so they've never been reachable from typed chat
    // text. Pinned here so the journal side can't accidentally "fix" this
    // and diverge from Matrix's actual (if surprising) behavior.
    expect(classifyBridgeCommand('/show_bash')).toBeNull();
    expect(classifyBridgeCommand('/show_bash_output')).toBeNull();
    expect(classifyBridgeCommand('/bash_output')).toBeNull();
  });

  it('returns null for text with no ! or / prefix', () => {
    expect(classifyBridgeCommand('stop')).toBeNull();
    expect(classifyBridgeCommand('hello claude')).toBeNull();
  });

  it('returns null for empty string and non-string input', () => {
    expect(classifyBridgeCommand('')).toBeNull();
    expect(classifyBridgeCommand(null)).toBeNull();
    expect(classifyBridgeCommand(undefined)).toBeNull();
    expect(classifyBridgeCommand(42)).toBeNull();
  });

  it('returns null for a bare ! or / with no command word', () => {
    expect(classifyBridgeCommand('!')).toBeNull();
    expect(classifyBridgeCommand('/')).toBeNull();
  });
});

describe('classifyRescueKeystroke (journal command classification pin: !esc)', () => {
  it('classifies !esc', () => {
    expect(classifyRescueKeystroke('!esc')).toBe('esc');
  });

  it('classifies !enter', () => {
    expect(classifyRescueKeystroke('!enter')).toBe('enter');
  });

  it('classifies the !escape and !stop aliases to esc, matching the literal Matrix comparison', () => {
    expect(classifyRescueKeystroke('!escape')).toBe('esc');
    expect(classifyRescueKeystroke('!stop')).toBe('esc');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(classifyRescueKeystroke('  !ESC  ')).toBe('esc');
    expect(classifyRescueKeystroke('!Enter')).toBe('enter');
  });

  it('returns null for the / spelling — rescue keystrokes are ! only', () => {
    expect(classifyRescueKeystroke('/esc')).toBeNull();
    expect(classifyRescueKeystroke('/enter')).toBeNull();
  });

  it('returns null for unrelated text', () => {
    expect(classifyRescueKeystroke('esc')).toBeNull();
    expect(classifyRescueKeystroke('hello')).toBeNull();
    expect(classifyRescueKeystroke('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(classifyRescueKeystroke(null)).toBeNull();
    expect(classifyRescueKeystroke(undefined)).toBeNull();
  });
});

// Busy-queue magic words (PR #101 follow-up). While a session is busy, bare
// send/interrupt/!interrupt flush the queue and bare cancel pops the last
// queued message — originally Matrix behavior, now the journal session-text
// route's own behavior (lib/busy-queue.js) since Matrix was retired in Task
// 4. Classification only: the busy gating lives at the call sites (and in
// dispatchBusyQueueMagicWord).
describe('classifyBusyMagicWord (journal command classification pin)', () => {
  it("classifies the flush words exactly as the Matrix busy branch compared them", () => {
    expect(classifyBusyMagicWord('send')).toBe('send');
    expect(classifyBusyMagicWord('interrupt')).toBe('send');
    expect(classifyBusyMagicWord('!interrupt')).toBe('send');
  });

  it('classifies cancel', () => {
    expect(classifyBusyMagicWord('cancel')).toBe('cancel');
  });

  it('is case-insensitive and trims whitespace, like the Matrix lowerText comparison', () => {
    expect(classifyBusyMagicWord('  SEND ')).toBe('send');
    expect(classifyBusyMagicWord('Cancel')).toBe('cancel');
    expect(classifyBusyMagicWord(' !Interrupt ')).toBe('send');
  });

  it('returns null for anything else — including near-misses that must queue as ordinary text', () => {
    expect(classifyBusyMagicWord('send it')).toBeNull();
    expect(classifyBusyMagicWord('/interrupt')).toBeNull();
    expect(classifyBusyMagicWord('!send')).toBeNull();
    expect(classifyBusyMagicWord('cancel:0')).toBeNull();
    expect(classifyBusyMagicWord('')).toBeNull();
  });

  it('returns null for non-string input rather than throwing', () => {
    expect(classifyBusyMagicWord(null)).toBeNull();
    expect(classifyBusyMagicWord(undefined)).toBeNull();
    expect(classifyBusyMagicWord(7)).toBeNull();
  });
});

describe('isIvSlashPassthrough (journal command classification pin: unknown-slash passthrough + // escape)', () => {
  it('is true for an unknown slash command', () => {
    expect(isIvSlashPassthrough('/compact')).toBe(true);
    expect(isIvSlashPassthrough('/login')).toBe(true);
  });

  it('is false for a // -escaped message (queues like ordinary text instead of hitting the PTY)', () => {
    expect(isIvSlashPassthrough('//not a command, just text')).toBe(false);
    expect(isIvSlashPassthrough('//')).toBe(false);
  });

  it('is false for plain text with no leading slash', () => {
    expect(isIvSlashPassthrough('hello')).toBe(false);
    expect(isIvSlashPassthrough('')).toBe(false);
  });

  it('is true for a single leading slash with nothing after it', () => {
    expect(isIvSlashPassthrough('/')).toBe(true);
  });

  it('returns false for non-string input rather than throwing', () => {
    expect(isIvSlashPassthrough(null)).toBe(false);
    expect(isIvSlashPassthrough(undefined)).toBe(false);
  });
});

// Plan-mode `build` keyword (PR #101 follow-up). The journal path approves a
// pending plan when the text is exactly "build" (case-insensitive, trimmed)
// and the session has plan state (pendingPlan || pendingPlanDenialId ||
// ivPendingPlanToolUseId) — originally Matrix's comparison, pinned here
// unchanged since Matrix's retirement in Task 4. The approval implementation
// (approvePlanBuild, index.js) is reused AS-IS.
describe('isPlanBuildText (journal command classification pin)', () => {
  it("matches exactly the Matrix comparison: text.toLowerCase().trim() === 'build'", () => {
    expect(isPlanBuildText('build')).toBe(true);
    expect(isPlanBuildText('Build')).toBe(true);
    expect(isPlanBuildText('  BUILD  ')).toBe(true);
  });

  it('does not match longer phrases or prefixed spellings — those are plan feedback, not approval', () => {
    expect(isPlanBuildText('build it')).toBe(false);
    expect(isPlanBuildText('please build')).toBe(false);
    expect(isPlanBuildText('!build')).toBe(false);
    expect(isPlanBuildText('/build')).toBe(false);
    expect(isPlanBuildText('')).toBe(false);
  });

  it('returns false for non-string input rather than throwing', () => {
    expect(isPlanBuildText(null)).toBe(false);
    expect(isPlanBuildText(undefined)).toBe(false);
    expect(isPlanBuildText(9)).toBe(false);
  });
});

describe('dispatchPlanBuild', () => {
  it('approves via the injected approvePlan when the text is build and a plan is pending', async () => {
    const approvePlan = vi.fn(async () => {});
    expect(await dispatchPlanBuild('build', true, { approvePlan })).toBe(true);
    expect(approvePlan).toHaveBeenCalledTimes(1);
  });

  it('with no pending plan, build is NOT intercepted — it routes as ordinary text', async () => {
    const approvePlan = vi.fn();
    expect(await dispatchPlanBuild('build', false, { approvePlan })).toBe(false);
    expect(approvePlan).not.toHaveBeenCalled();
  });

  it('with a pending plan, non-build text is NOT intercepted (plan feedback flows through)', async () => {
    const approvePlan = vi.fn();
    expect(await dispatchPlanBuild('actually, use vitest instead', true, { approvePlan })).toBe(false);
    expect(approvePlan).not.toHaveBeenCalled();
  });

  it('propagates a thrown error from approvePlan (caller catches — see journalOnText)', async () => {
    const approvePlan = vi.fn(async () => { throw new Error('kaboom'); });
    await expect(dispatchPlanBuild('build', true, { approvePlan })).rejects.toThrow('kaboom');
  });
});

describe('dispatchJournalBridgeCommand', () => {
  it('classifies, flushes the cursor BEFORE dispatch, then runs the bridge command with the normalized text', async () => {
    const order = [];
    const flushCursor = vi.fn(() => order.push('flush'));
    const runBridgeCommand = vi.fn(async (normalized) => {
      order.push(`run:${normalized}`);
    });

    const handled = await dispatchJournalBridgeCommand('/stop', { flushCursor, runBridgeCommand });

    expect(handled).toBe(true);
    expect(runBridgeCommand).toHaveBeenCalledWith('!stop');
    expect(order).toEqual(['flush', 'run:!stop']);
  });

  it('does not flush or dispatch for non-command text — never falls through to a command handler', async () => {
    const flushCursor = vi.fn();
    const runBridgeCommand = vi.fn();

    const handled = await dispatchJournalBridgeCommand('just chatting with claude', { flushCursor, runBridgeCommand });

    expect(handled).toBe(false);
    expect(flushCursor).not.toHaveBeenCalled();
    expect(runBridgeCommand).not.toHaveBeenCalled();
  });

  it('does not dispatch an unknown slash command (passthrough territory, not a bridge command)', async () => {
    const flushCursor = vi.fn();
    const runBridgeCommand = vi.fn();

    const handled = await dispatchJournalBridgeCommand('/compact', { flushCursor, runBridgeCommand });

    expect(handled).toBe(false);
    expect(flushCursor).not.toHaveBeenCalled();
    expect(runBridgeCommand).not.toHaveBeenCalled();
  });

  it('propagates a thrown error from runBridgeCommand (caller is responsible for catching — see journalOnText)', async () => {
    const flushCursor = vi.fn();
    const runBridgeCommand = vi.fn(async () => { throw new Error('boom'); });

    await expect(dispatchJournalBridgeCommand('/status', { flushCursor, runBridgeCommand }))
      .rejects.toThrow('boom');
    // The replay guard still ran before the failing dispatch.
    expect(flushCursor).toHaveBeenCalledOnce();
  });

  // Journal-transport command safety net (Deliverable 2), for commands whose
  // implementation needs context the journal transport doesn't have. Was
  // framed as a "Matrix-only" concern before Matrix's retirement in Task 4;
  // mapping handleCommand's actual switch found NO command that needs this
  // today (see JOURNAL_UNAVAILABLE_COMMANDS's comment in
  // lib/command-dispatch.js) — the real, shipped denylist is empty. These
  // tests exercise the MECHANISM itself via the `unavailableCommands`
  // override, so a future command added to the denylist is guaranteed to
  // get a safe "not available" reply instead of silently falling through to
  // Claude as text or crashing, without needing a live example to test
  // against today.
  describe('the not-available denylist mechanism (JOURNAL_UNAVAILABLE_COMMANDS is empty today — see that constant\'s comment for the mapping)', () => {
    it('the real, shipped denylist has no entries', () => {
      expect(JOURNAL_UNAVAILABLE_COMMANDS.size).toBe(0);
    });

    it('a denied command replies via notAvailable instead of dispatching, and is still reported as handled', async () => {
      const flushCursor = vi.fn();
      const runBridgeCommand = vi.fn();
      const notAvailable = vi.fn();

      const handled = await dispatchJournalBridgeCommand('/status', {
        flushCursor, runBridgeCommand, notAvailable,
        unavailableCommands: new Set(['status']),
      });

      expect(handled).toBe(true);
      expect(notAvailable).toHaveBeenCalledWith('status');
      // Never falls through to Claude as text: runBridgeCommand (the only
      // path that could do that) is never called.
      expect(runBridgeCommand).not.toHaveBeenCalled();
      // Nothing destructive happened, so there's nothing to replay-guard.
      expect(flushCursor).not.toHaveBeenCalled();
    });

    it('a command not on the denylist still dispatches normally even with a non-empty denylist in play', async () => {
      const flushCursor = vi.fn();
      const runBridgeCommand = vi.fn();
      const notAvailable = vi.fn();

      const handled = await dispatchJournalBridgeCommand('/stop', {
        flushCursor, runBridgeCommand, notAvailable,
        unavailableCommands: new Set(['status']),
      });

      expect(handled).toBe(true);
      expect(runBridgeCommand).toHaveBeenCalledWith('!stop');
      expect(notAvailable).not.toHaveBeenCalled();
    });

    it('never crashes when notAvailable is omitted', async () => {
      const flushCursor = vi.fn();
      const runBridgeCommand = vi.fn();

      await expect(dispatchJournalBridgeCommand('/status', {
        flushCursor, runBridgeCommand, unavailableCommands: new Set(['status']),
      })).resolves.toBe(true);
      expect(runBridgeCommand).not.toHaveBeenCalled();
    });
  });
});

describe('dispatchJournalRescueKeystroke', () => {
  it('flushes the cursor BEFORE sending the keystroke, when iv is active', async () => {
    const order = [];
    const flushCursor = vi.fn(() => order.push('flush'));
    const sendRescueKeystroke = vi.fn(async (kind) => order.push(`send:${kind}`));

    const handled = await dispatchJournalRescueKeystroke('!esc', true, { flushCursor, sendRescueKeystroke });

    expect(handled).toBe(true);
    expect(sendRescueKeystroke).toHaveBeenCalledWith('esc');
    expect(order).toEqual(['flush', 'send:esc']);
  });

  it('does nothing when iv is not active — a print-mode session has no PTY to receive the keystroke', async () => {
    const flushCursor = vi.fn();
    const sendRescueKeystroke = vi.fn();

    const handled = await dispatchJournalRescueKeystroke('!esc', false, { flushCursor, sendRescueKeystroke });

    expect(handled).toBe(false);
    expect(flushCursor).not.toHaveBeenCalled();
    expect(sendRescueKeystroke).not.toHaveBeenCalled();
  });

  it('does nothing for non-rescue text even when iv is active', async () => {
    const flushCursor = vi.fn();
    const sendRescueKeystroke = vi.fn();

    const handled = await dispatchJournalRescueKeystroke('hello', true, { flushCursor, sendRescueKeystroke });

    expect(handled).toBe(false);
    expect(flushCursor).not.toHaveBeenCalled();
    expect(sendRescueKeystroke).not.toHaveBeenCalled();
  });
});

// Control-convo parity (Deliverable 3): /start is the canonical spelling,
// "new" stays as an alias; /sessions canonical, "list" alias; /help
// canonical (bare "help" already worked before and still does, since it has
// no alias entry — it normalizes to itself).
describe('normalizeJournalControlCommand', () => {
  it('resolves the canonical /start spelling with no directory arg', () => {
    expect(normalizeJournalControlCommand('/start')).toEqual({ cmd: 'start', rest: [] });
  });

  it('resolves /start with a directory arg', () => {
    expect(normalizeJournalControlCommand('/start /tmp/some-project')).toEqual({
      cmd: 'start', rest: ['/tmp/some-project'],
    });
  });

  it('resolves the "new" alias to start, with and without a directory', () => {
    expect(normalizeJournalControlCommand('new')).toEqual({ cmd: 'start', rest: [] });
    expect(normalizeJournalControlCommand('new /tmp/some-project')).toEqual({
      cmd: 'start', rest: ['/tmp/some-project'],
    });
  });

  it('resolves the "list" alias to sessions', () => {
    expect(normalizeJournalControlCommand('list')).toEqual({ cmd: 'sessions', rest: [] });
    expect(normalizeJournalControlCommand('/sessions')).toEqual({ cmd: 'sessions', rest: [] });
  });

  it('resolves bare "help" and canonical /help identically', () => {
    expect(normalizeJournalControlCommand('help')).toEqual({ cmd: 'help', rest: [] });
    expect(normalizeJournalControlCommand('/help')).toEqual({ cmd: 'help', rest: [] });
  });

  it('strips an optional leading ! the same way / is stripped', () => {
    expect(normalizeJournalControlCommand('!start')).toEqual({ cmd: 'start', rest: [] });
  });

  it('is case-insensitive on the command word but preserves argument casing', () => {
    expect(normalizeJournalControlCommand('/START /Tmp/Project')).toEqual({
      cmd: 'start', rest: ['/Tmp/Project'],
    });
  });

  it('passes through --browser and other flags as rest tokens for /start', () => {
    expect(normalizeJournalControlCommand('/start --browser /tmp/proj')).toEqual({
      cmd: 'start', rest: ['--browser', '/tmp/proj'],
    });
  });

  it('returns an empty cmd for empty/whitespace-only input', () => {
    expect(normalizeJournalControlCommand('')).toEqual({ cmd: '', rest: [] });
    expect(normalizeJournalControlCommand('   ')).toEqual({ cmd: '', rest: [] });
  });

  it('passes an unrecognized word through unresolved (caller gates on BRIDGE_COMMAND_NAMES)', () => {
    expect(normalizeJournalControlCommand('gibberish')).toEqual({ cmd: 'gibberish', rest: [] });
    expect(normalizeJournalControlCommand('gibberish').cmd).not.toBe('');
    expect(BRIDGE_COMMAND_NAMES.has('gibberish')).toBe(false);
  });

  it('every alias target is itself a real bridge command name', () => {
    for (const target of Object.values(JOURNAL_CONTROL_ALIASES)) {
      expect(BRIDGE_COMMAND_NAMES.has(target)).toBe(true);
    }
  });
});

describe('control-convo help text sanity', () => {
  it('the short fallback nudge documents both canonical spellings and both aliases', () => {
    expect(JOURNAL_CONTROL_HELP).toMatch(/\/start/);
    expect(JOURNAL_CONTROL_HELP).toMatch(/new/);
    expect(JOURNAL_CONTROL_HELP).toMatch(/\/sessions/);
    expect(JOURNAL_CONTROL_HELP).toMatch(/list/);
    expect(JOURNAL_CONTROL_HELP).toMatch(/\/help/);
  });

  it('the /help addendum documents the alias table', () => {
    expect(JOURNAL_CONTROL_HELP_NOTE).toMatch(/"new" = \/start/);
    expect(JOURNAL_CONTROL_HELP_NOTE).toMatch(/"list" = \/sessions/);
  });

  it('the /help addendum calls out that session-scoped commands need an actual session convo', () => {
    expect(JOURNAL_CONTROL_HELP_NOTE.toLowerCase()).toMatch(/session-scoped/);
  });
});

describe('classifyJournalControlCommand', () => {
  it('applies the JOURNAL_UNAVAILABLE_COMMANDS denylist to the control-convo path too (review fast-follow)', () => {
    // With the (test-injected) denylist populated, a denied command routes
    // to a refusal — never to dispatch — from the control convo, exactly as
    // dispatchJournalBridgeCommand enforces for session convos. Alias
    // resolution happens BEFORE the check, so an alias can't sidestep it.
    const unavailableCommands = new Set(['sessions']);
    expect(classifyJournalControlCommand('/sessions', { unavailableCommands }))
      .toEqual({ kind: 'unavailable', cmd: 'sessions' });
    expect(classifyJournalControlCommand('list', { unavailableCommands }))
      .toEqual({ kind: 'unavailable', cmd: 'sessions' });
    // Non-denied commands still dispatch; unknown words still route to help.
    expect(classifyJournalControlCommand('/start /tmp/proj', { unavailableCommands }))
      .toEqual({ kind: 'dispatch', cmd: 'start', normalizedText: '!start /tmp/proj' });
    expect(classifyJournalControlCommand('gibberish', { unavailableCommands })).toEqual({ kind: 'help' });
    // And with the real (empty) default denylist, nothing is denied today.
    expect(classifyJournalControlCommand('/sessions')).toEqual({ kind: 'dispatch', cmd: 'sessions', normalizedText: '!sessions' });
  });
});

describe('classifyPrintRescue', () => {
  it('maps !esc and !escape to interrupt', () => {
    expect(classifyPrintRescue('!esc')).toBe('interrupt');
    expect(classifyPrintRescue('!escape')).toBe('interrupt');
    expect(classifyPrintRescue('  !ESC  ')).toBe('interrupt');
  });

  it('excludes !stop (print mode keeps its stop-session meaning) and !enter', () => {
    expect(classifyPrintRescue('!stop')).toBeNull();
    expect(classifyPrintRescue('!enter')).toBeNull();
  });

  it('ignores bare words, other text, and non-strings', () => {
    expect(classifyPrintRescue('esc')).toBeNull();
    expect(classifyPrintRescue('please !esc')).toBeNull();
    expect(classifyPrintRescue(null)).toBeNull();
    expect(classifyPrintRescue(42)).toBeNull();
  });
});

describe('dispatchJournalRescueKeystroke print path', () => {
  const mk = () => ({
    flushCursor: vi.fn(),
    sendRescueKeystroke: vi.fn(),
    sendPrintInterrupt: vi.fn(),
  });

  it('dispatches !esc to sendPrintInterrupt when print-active and not iv-active', async () => {
    const cb = mk();
    const handled = await dispatchJournalRescueKeystroke('!esc', false, { ...cb, printActive: true });
    expect(handled).toBe(true);
    expect(cb.flushCursor).toHaveBeenCalledTimes(1);
    expect(cb.sendPrintInterrupt).toHaveBeenCalledTimes(1);
    expect(cb.sendRescueKeystroke).not.toHaveBeenCalled();
  });

  it('does NOT treat !stop or !enter as a print interrupt', async () => {
    const cb = mk();
    expect(await dispatchJournalRescueKeystroke('!stop', false, { ...cb, printActive: true })).toBe(false);
    expect(await dispatchJournalRescueKeystroke('!enter', false, { ...cb, printActive: true })).toBe(false);
    expect(cb.sendPrintInterrupt).not.toHaveBeenCalled();
    expect(cb.flushCursor).not.toHaveBeenCalled();
  });

  it('iv-active takes precedence over the print path', async () => {
    const cb = mk();
    const handled = await dispatchJournalRescueKeystroke('!esc', true, { ...cb, printActive: true });
    expect(handled).toBe(true);
    expect(cb.sendRescueKeystroke).toHaveBeenCalledWith('esc');
    expect(cb.sendPrintInterrupt).not.toHaveBeenCalled();
  });

  it('returns false without printActive or without sendPrintInterrupt', async () => {
    const cb = mk();
    expect(await dispatchJournalRescueKeystroke('!esc', false, { ...cb })).toBe(false);
    expect(await dispatchJournalRescueKeystroke('!esc', false, { flushCursor: cb.flushCursor, sendRescueKeystroke: cb.sendRescueKeystroke, printActive: true })).toBe(false);
    expect(cb.flushCursor).not.toHaveBeenCalled();
  });
});

// Matron is the only client now — nobody can follow a matrix.to room link, so
// command replies (/start, /resume, /workdir confirmations) must not contain
// one. Source inspection because index.js can't be imported in-process (it
// starts the bridge) — same pattern as session-status's wiring tests.
describe('command replies carry no matrix.to links', () => {
  it('index.js builds no matrix.to URLs', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    expect(src).not.toContain('matrix.to/#/');
  });
});
