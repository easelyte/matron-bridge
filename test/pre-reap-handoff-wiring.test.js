import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the power-hold-wiring idiom): the
// pre-reap handoff (lib/pre-reap-handoff.js) is wired into the
// idle reaper, the shared free gate and the user-input seams. The decisions
// themselves are unit-tested in test/pre-reap-handoff.test.js.
describe('pre-reap handoff wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  function fnBody(name) {
    const start = index.indexOf(`function ${name}(`);
    expect(start, `function ${name} is missing from index.js`).toBeGreaterThan(-1);
    const next = index.indexOf('\nfunction ', start + 1);
    const nextAsync = index.indexOf('\nasync function ', start + 1);
    const ends = [next, nextAsync].filter((i) => i > -1);
    return index.slice(start, ends.length ? Math.min(...ends) : undefined);
  }

  it('is configured once from the environment against the reap timeout', () => {
    expect(index).toContain("import { handoffConfig, handoffIdleSince, handoffDue, planHandoff, handoffTurnText, handoffNotice, preReapCompactCommand, noteTurnStart as notePreReapTurnStart } from './lib/pre-reap-handoff.js';");
    expect(index).toContain('const PRE_REAP_HANDOFF = handoffConfig(process.env, { reapTimeoutMs: SESSION_IDLE_TIMEOUT_MS });');
  });

  it('the reaper reads the frozen idle anchor and fires the handoff only in the not-yet-reaped branch', () => {
    const body = fnBody('startIdleReaper');
    expect(body).toContain('const last = handoffIdleSince(session);');
    expect(body).not.toContain('const last = session.lastActivityAt || session.startedAt || 0;');
    // The handoff is considered only when the session is NOT being reaped
    // this tick, and the work-hold / reap logic still keys off `last`.
    const branch = body.slice(body.indexOf('if (now - last < SESSION_IDLE_TIMEOUT_MS) {'), body.indexOf('const hold = sessionWorkHold('));
    expect(branch).toContain('handoffDue({ session, now, config: PRE_REAP_HANDOFF, occupied: controlOccupied })');
    // Fire-and-forget, but never an unhandled rejection out of the reaper tick.
    expect(branch).toMatch(/runPreReapHandoff\(session, now, last\)\.catch\(/);
    expect(branch).toMatch(/\n\s+continue;\n\s+}\n/);
    expect(body).toContain('const hold = sessionWorkHold(session, last, now, processTable());');
  });

  it('runPreReapHandoff marks first, reads the mission through the shared resolver, re-checks the session, then acts', () => {
    const body = fnBody('runPreReapHandoff');
    const mark = body.indexOf('session._preReapHandoff = { idleSince, at: now, compactPending: false };');
    const resolve = body.indexOf('await missionsHandlers.resolveMission(session, convoId)');
    expect(mark).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(mark);
    expect(body).toContain('await missionsClient.get(m.id)');
    expect(body).toContain('status_updated_at');
    // Re-checks after the awaits: still the live session, mark still ours.
    const recheck = body.indexOf('if (shuttingDown || sessions.get(roomId) !== session || !session.alive || session._autoStopped || !session._preReapHandoff) return;');
    expect(recheck).toBeGreaterThan(resolve);
    // A failed lookup or a session that turned busy drops the mark, so the
    // next tick retries and nothing stays frozen for work that never ran.
    const failed = body.indexOf('if (lookupFailed) {');
    const busy = body.indexOf('if (controlOccupied(session)) {');
    expect(failed).toBeGreaterThan(recheck);
    expect(busy).toBeGreaterThan(failed);
    expect(body.slice(failed, busy)).toContain('session._preReapHandoff = null;');
    expect(body.slice(busy, body.indexOf('const coordinator ='))).toContain('session._preReapHandoff = null;');
    // An outage is not "no mission": both a failed resolve and a thrown one
    // are recorded as a failure, never read as hasMission false.
    expect(body.match(/lookupFailed = `mission lookup (failed|threw)/g)).toHaveLength(2);
    // The Coordinator test is the same as the projects tools'.
    expect(body).toContain('const coordinator = session.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId);');
    expect(body).toMatch(/planHandoff\(\{\s*session, hasMission, missionStatusAt, coordinator,\s*contextTokens: session\._lastContextTokens, contextWindow: contextWindowForSession\(session\),\s*config: PRE_REAP_HANDOFF,\s*\}\)/);
    // One line in the chat, nothing when there is nothing to do.
    expect(body).toContain('const line = handoffNotice(plan, { idleMinutes });');
    expect(body).toMatch(/if \(!line\) \{[\s\S]*?return;\s*\}/);
    // The status turn is bridge-framed and not mirrored into the chat; the
    // compaction waits for it at the free gate. The notice is posted only
    // once the work was dispatched: after the turn was accepted, or after
    // the compaction started.
    expect(body).toContain('if (plan.compact) session._preReapHandoff.compactPending = true;');
    expect(body).toMatch(/if \(!sendTextToSession\(session, handoffTurnText\(\{ idleMinutes \}\), \{ skipJournalMirror: true \}\)\) \{[\s\S]*?return;\s*\}\n\s+postControlNotice\(session, line, 'handoff'\);/);
    expect(body).toMatch(/\n\s+if \(drainPreReapCompact\(session\)\) postControlNotice\(session, line, 'handoff'\);\n\s*\} finally \{ finishInput\?\.\(\); \}\n\}/);
    expect(body.match(/postControlNotice\(session, line, 'handoff'\);/g)).toHaveLength(2);
  });

  it('the compaction drains at the shared free gate, after parked controls and before the room inbox', () => {
    const gate = fnBody('maybeFlushRoomDelivery');
    const controls = gate.indexOf('if (drainDeferredControls(session)) return;');
    const compact = gate.indexOf('if (drainPreReapCompact(session)) return;');
    const inbox = gate.indexOf('flushRoomInbox(session);');
    expect(controls).toBeGreaterThan(-1);
    expect(compact).toBeGreaterThan(controls);
    expect(inbox).toBeGreaterThan(compact);
    const drain = fnBody('drainPreReapCompact');
    expect(drain).toContain('if (!mark || !mark.compactPending) return false;');
    expect(drain).toContain('if (!session.alive || session._autoStopped || controlOccupied(session)) return false;');
    expect(drain).toContain('mark.compactPending = false;');
    expect(drain).toContain("journalRouteTextToSession(session, preReapCompactCommand())");
  });

  it('a real user turn re-arms it: text, media, item replies and prompt answers from the journal', () => {
    for (const fn of ['journalOnText', 'journalOnMedia', 'journalOnItem', 'journalOnPromptReply']) {
      expect(fnBody(fn), `${fn} does not re-arm the handoff`).toContain('rearmPreReapHandoff(session);');
    }
    expect(fnBody('rearmPreReapHandoff')).toContain('session._preReapHandoff = null;');
    // Every other turn the bridge starts (a room message, a reminder, a
    // Coordinator carry-on) ends it where turns start, with the text so
    // the handoff's own status turn and compaction are left alone.
    const send = fnBody('sendToSession');
    expect(send).toContain('notePreReapTurnStart(session, journalText);');
    expect(send.indexOf('notePreReapTurnStart(session, journalText);')).toBeLessThan(send.indexOf('if (session._awaitingInputReady) {'));
    expect(send).not.toContain('rearmPreReapHandoff');
    expect(fnBody('journalRouteTextToSession')).not.toContain('rearmPreReapHandoff');
  });

  it('an idle iv /compact arms the compact_boundary stand-in turn-end at the shared dispatch', () => {
    // Without the marker an interactive session stays busy after a manual
    // compaction (no Stop hook fires); the handoff makes that routine, and
    // the Coordinator compact and auto-resume share the path.
    const arm = fnBody('armOperatorCompact');
    expect(arm).toContain('if (!session?.iv || session.busy || !isCompactCommand(text)) return false;');
    expect(arm).toContain('session._operatorCompactPending = true;');
    expect(arm).toContain('session._operatorCompactPendingTurn = session.turnCount;');
    expect(arm).toMatch(/session\._operatorCompactTimer = setTimeout\(\(\) => \{\s*session\._operatorCompactTimer = null;\s*session\._operatorCompactPending = false;\s*\}, OPERATOR_COMPACT_ARM_MS\);/);
    const route = fnBody('journalRouteTextToSession');
    expect(route).toMatch(/armOperatorCompact\(session, trimmed\);\n\s+return sendTextToSession\(session, trimmed, \{ skipJournalMirror: true \}\);\n\s*\} finally \{ finishInput\?\.\(\); \}/);
    // The boundary handler honours exactly that marker and turn stamp.
    expect(index).toMatch(/if \(session\._operatorCompactPending && trigger === 'manual'\s*&& session\.turnCount === session\._operatorCompactPendingTurn\)/);
  });

  it('says at boot whether it is on, and why not', () => {
    const main = fnBody('main');
    expect(main).toContain('Pre-reap handoff: at ${PRE_REAP_HANDOFF.idleMs}ms idle');
    expect(main).toContain('Pre-reap handoff: OFF (${PRE_REAP_HANDOFF.reason})');
  });

  it('is documented and syntax-checked', () => {
    for (const v of ['MATRON_PRE_REAP_HANDOFF', 'MATRON_PRE_REAP_HANDOFF_IDLE_MS', 'MATRON_PRE_REAP_COMPACT_PCT']) {
      expect(readme, `${v} missing from README`).toContain(`| \`${v}\` |`);
      expect(envExample, `${v} missing from .env.example`).toMatch(new RegExp(`^${v}=`, 'm'));
    }
    expect(claudeMd).toContain('[pre-reap handoff from the bridge]');
    expect(pkg.scripts.check).toContain('node --check lib/pre-reap-handoff.js');
  });
});
