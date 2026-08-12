import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractForceFlag } from '../lib/command-dispatch.js';

// /restart's wait-for-turn-end deferral: issued mid-turn WITHOUT --force,
// /restart must no longer kill the session (cancelling e.g. an in-flight
// /compact — the exact incident that motivated this: "/compact then
// /restart --browser cancels the compaction"). Instead it parks the restart
// and replays it, forced, at the turn-end seams. --force keeps the old
// immediate behavior.

describe('extractForceFlag', () => {
  it('finds --force and strips it from rest', () => {
    expect(extractForceFlag(['--force'])).toEqual({ force: true, rest: [] });
    expect(extractForceFlag(['--browser', '--force'])).toEqual({ force: true, rest: ['--browser'] });
  });

  it('recognises the mobile-autocorrected em/en dash spellings', () => {
    expect(extractForceFlag(['—force'])).toEqual({ force: true, rest: [] });
    expect(extractForceFlag(['–force'])).toEqual({ force: true, rest: [] });
  });

  it('is case-insensitive on the flag word', () => {
    expect(extractForceFlag(['--Force'])).toEqual({ force: true, rest: [] });
  });

  it('returns force=false with tokens untouched when absent', () => {
    expect(extractForceFlag(['--browser', 'now'])).toEqual({ force: false, rest: ['--browser', 'now'] });
  });

  it('preserves non-force tokens verbatim, unicode dashes included', () => {
    expect(extractForceFlag(['—browser', '--force']).rest).toEqual(['—browser']);
  });

  it('does not treat "force" without dashes as the flag', () => {
    expect(extractForceFlag(['force'])).toEqual({ force: false, rest: ['force'] });
  });

  it('defaults to an empty token list', () => {
    expect(extractForceFlag()).toEqual({ force: false, rest: [] });
  });
});

// The deferral itself lives in index.js and can't be imported, so it's
// pinned by source inspection — the same technique the index.js wiring pins
// in busy-queue.test.js use.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

describe("index.js !restart busy deferral (source inspection)", () => {
  const start = src.indexOf("case '!restart':");
  const body = src.slice(start, src.indexOf("case '!resume':", start));

  it('parses --force before the extras/agent flag parsers', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/extractForceFlag\(parts\.slice\(1\)\)/);
  });

  it('a busy, unforced /restart defers instead of restarting', () => {
    expect(body).toMatch(/existing\.busy && !restartForced/);
    expect(body).toMatch(/_deferredCommandText/);
  });

  it("replies with the 'waiting' message, --force escape hatch included", () => {
    expect(body).toContain('Waiting for turn to finish before restarting');
    expect(body).toContain('Send again with --force to restart immediately.');
  });

  it('the stashed replay is forced so it cannot re-defer at the seam', () => {
    expect(body).toMatch(/'!restart', '--force'/);
  });
});

describe('index.js dispatchDeferredCommand (source inspection)', () => {
  const start = src.indexOf('function dispatchDeferredCommand(session)');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  it('exists', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('clears the stash before the liveness check, so a dead session can never restart later', () => {
    const clear = body.indexOf('session._deferredCommandText = null');
    const aliveCheck = body.indexOf('!session.alive');
    expect(clear).toBeGreaterThan(-1);
    expect(aliveCheck).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(aliveCheck);
  });

  it('refuses to fire for a superseded session (would restart its replacement)', () => {
    expect(body).toMatch(/sessions\.get\(session\.roomId\) !== session/);
  });

  it('replays through handleCommand with the journal command ctx', () => {
    expect(body).toMatch(/journalSessionCommandCtx\(session\)/);
    expect(body).toMatch(/handleCommand\(session\.roomId, text, ctx\.sendReply, ctx\.sendHtml, ctx\.sender\)/);
  });
});

// Each turn-end seam must consume the stash INSTEAD of flushing the queue:
// flushing first would type queued messages into the process the restart is
// about to kill. recreateSession carries queuedMessages into the
// replacement, and the room-delivery inbox is keyed by roomId, so both
// reach the new session.
describe('index.js turn-end seams dispatch the deferred command (source inspection)', () => {
  const seamWindow = (anchor, end) => {
    const start = src.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf(end, start));
  };

  const expectDispatchBeforeFlush = (body) => {
    const dispatch = body.indexOf('dispatchDeferredCommand(session)');
    const flush = body.indexOf('flushPendingSessionQueue(session)');
    expect(dispatch).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(flush);
  };

  it('iv-mode onTurnEnd (also the manual-/compact boundary path)', () => {
    expectDispatchBeforeFlush(seamWindow('session.onTurnEnd = () => {', 'session.requestPlanDecision'));
  });

  it("print-mode 'result' event", () => {
    expectDispatchBeforeFlush(seamWindow("case 'result': {", "case 'system':"));
  });

  // The fatal "no conversation found" result path breaks out early, before
  // the normal seam — in print mode a parked restart must fire there too
  // (Bugbot, PR #187) or it sits dormant after the user was told it was
  // waiting. In iv mode it must NOT fire there: the path can run from the
  // Stop hook's /turn-end transcript drain, and onTurnEnd (which always
  // follows) needs the stash intact to skip the queue flush — otherwise
  // queued messages get typed into the session the restart is replacing
  // (Bugbot, second pass).
  it("fatal no-conversation-found result path dispatches, print mode only", () => {
    const body = seamWindow('const noSession = event.errors.some', "if (session.iv) {");
    const busyClear = body.indexOf('session.busy = false');
    const dispatch = body.indexOf('if (!session.iv) dispatchDeferredCommand(session)');
    expect(busyClear).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(busyClear).toBeLessThan(dispatch);
  });

  it('finishCodexTurn', () => {
    expectDispatchBeforeFlush(seamWindow('function finishCodexTurn(session', '\n}\n'));
  });
});

// A busy print-mode /model no longer refuses ("Finish or interrupt the
// current turn…") — it parks `!model <alias>` on the SAME deferred-command
// stash /restart uses, replayed at the turn-end seam BEFORE the queue
// flush. The replay recreates the session with the new model, and the
// carried queue then flushes on the replacement (compact still first), so
// the switch applies ahead of every queued message. One stash, one slot:
// parking /model over a parked /restart (or vice versa) replaces it with a
// notice, mirroring the /login//logout parked-slash precedent.
describe('index.js busy /model parks on the deferred-command stash (source inspection)', () => {
  const start = src.indexOf('function applyModelSwitch(');
  const body = src.slice(start, src.indexOf('function applyModeSwitch(', start));

  it('parks the normalized replay text when the planner defers', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/decision\.defer/);
    expect(body).toMatch(/_deferredCommandText = `!model \$\{decision\.normalized\}`/);
  });

  it('a repeat of the same parked /model just says it is already queued', () => {
    expect(body).toContain('already queued');
  });

  it('replacing a different parked command says so instead of silently dropping it', () => {
    expect(body).toMatch(/replacing the queued/);
  });

  it('the /restart park site names a replaced /model too', () => {
    const rs = src.indexOf("case '!restart':");
    const rbody = src.slice(rs, src.indexOf("case '!resume':", rs));
    expect(rbody).toMatch(/replacing the queued/);
  });
});

// The queue those seams deliberately did NOT flush has to be delivered by
// the REPLACEMENT session, or it strands in memory forever: the fresh
// session is idle, so no turn-end seam will ever fire on its own. This is
// the "/compact → /restart (parked) → message → restart → message lost"
// incident: the message queued behind the compacting turn, rode into the
// replacement via recreateSession, and nothing ever flushed it — the iv
// resume-ready watcher only flushed the hold-window outbox, and
// recreateSession's immediate flush was Codex-only.
describe('index.js carried queue flushes on the replacement session (source inspection)', () => {
  it('iv resume-ready flush covers carried queuedMessages, merged ahead of the hold outbox', () => {
    const start = src.indexOf('function startResumeReadyWatcher(session)');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('function dispatchMergedFlush', start));
    // The carried queue is flushed through the one true queue path (summary
    // tile + notification retire + compact priority)…
    expect(body).toMatch(/flushPendingSessionQueue\(session\)/);
    // …and hold-window messages merge onto its TAIL first, so both go out as
    // ONE send (queue entries were sent earlier, so they keep first place;
    // back-to-back sendText calls would cancel each other's pending Enter).
    expect(body).toMatch(/queuedMessages\.push\(\.\.\.outbox\)/);
  });

  it('a parked slash command yields to a carried queue, not just to held messages', () => {
    const start = src.indexOf('function startResumeReadyWatcher(session)');
    const body = src.slice(start, src.indexOf('function dispatchMergedFlush', start));
    expect(body).toMatch(/outbox\.length > 0 \|\| carriedQueue/);
  });

  it('recreateSession flushes immediately for every session that skips the resume hold', () => {
    const start = src.indexOf('function recreateSession(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('function printModeInterrupt', start));
    // Print-mode Claude has no resume hold and no turn running — the old
    // Codex-only gate stranded its carried queue exactly the same way.
    expect(body).toMatch(/!next\._awaitingInputReady && next\.queuedMessages\?\.length/);
    expect(body).not.toMatch(/next\.agent === AGENT_CODEX && next\.queuedMessages/);
  });
});
