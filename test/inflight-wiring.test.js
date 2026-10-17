import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexExecSession } from '../lib/codex-session.js';
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { liveWorkChildren } from '../lib/work-hold.js';
import { currentBootSubagents, sessionBackgroundWork, evaluateQuiet } from '../lib/restart-quiet.js';
import { createInflightMarker } from '../lib/inflight-marker.js';
import { selectAutoCarryOn } from '../lib/code-update-restart.js';

// Source-text assertions on index.js, same idiom as test/codex-session.test.js's
// "Codex bridge wiring" block. index.js has no unit-test harness, so the
// restart-carry-on turn-boundary wiring (Task 4) has no behavioural coverage at
// all. These pin the two couplings that took two review rounds to discover by
// hand, both of which regress SILENTLY in either direction:
//
//   - too eager a clear  -> the marker is gone at the next boot, so a turn that
//                           really was interrupted gets no "Carry on" card and
//                           the feature is quietly dead for that path;
//   - too lazy a clear   -> a stale marker survives a finished turn and the next
//                           boot offers to carry on a conversation that is over,
//                           which is the exact failure the user rejected
//                           ("don't resurface all the old dead conversations").
//
// Nothing at runtime enforces either, hence these.
describe('restart carry-on turn-boundary wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  function bodyOf(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    expect(start, `could not find ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    const end = src.indexOf(endNeedle, start + 1);
    expect(end, `could not find the end of ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  it('gates the Codex marker clear on !discardOutput so a teardown keeps the card', () => {
    const body = bodyOf('function finishCodexTurn(', '\nfunction ');

    expect(
      body,
      'finishCodexTurn must clear the inflight marker ONLY when the turn genuinely ended, '
      + 'i.e. guarded by `if (!discardOutput)`. discardOutput is passed exclusively by the two '
      + 'teardown callers (killSession, and the turn-exit fallback for an already-dead session), '
      + 'where the turn was INTERRUPTED, not finished. An unguarded clear here is how a SIGTERM '
      + 'restart erased its own evidence: restart.sh kills with plain kill/pkill (SIGTERM), the '
      + 'handler calls killSession for every live session, and a mid-turn Codex session deleted '
      + 'the very record the next boot needs. CONSEQUENCE OF REMOVING THIS GUARD: Codex sessions '
      + 'get no carry-on card on a restart — the feature is silently dead for that backend on its '
      + 'primary trigger.',
    ).toContain('if (!discardOutput) inflightMarker.noteTurnEnd(');

    // The guard is worthless if a second, ungated call sits alongside it.
    expect(
      body.split('inflightMarker.noteTurnEnd(').length - 1,
      'finishCodexTurn must contain EXACTLY ONE inflightMarker.noteTurnEnd call, the guarded one. '
      + 'A second, ungated call would defeat the guard and re-break the SIGTERM restart path.',
    ).toBe(1);
  });

  it('keeps discardOutput a teardown-only signal, since the marker gate now rides on it', () => {
    // The gate above encodes a caller CLASSIFICATION (teardown vs genuine turn
    // end) in a parameter whose name is about output suppression. That coupling
    // is the fragility; this pins it. If you are adding a call site, decide
    // which kind it is before changing this number.
    expect(
      src.split('discardOutput: true').length - 1,
      'index.js must pass `discardOutput: true` at exactly TWO call sites, both teardown: '
      + "killSession's Codex branch, and the codex.on('turn-exit') fallback for an already-dead "
      + 'session. finishCodexTurn treats that flag as "this turn was torn down, not finished" and '
      + 'so LEAVES the inflight marker standing for the next boot to card. A new call site passing '
      + 'it merely to suppress output would leak a marker -> SPURIOUS "Carry on" card for a '
      + 'conversation that actually finished. A teardown call site that drops it would clear the '
      + 'marker -> NO card for a turn that really was interrupted. Either way the break is silent; '
      + 'update this count only once you have classified the new site.',
    ).toBe(2);
  });

  it('clears the marker in the !stop handler BEFORE killSession, not inside killSession', () => {
    const body = bodyOf("case '!stop': {", '\n    }');
    const clear = body.indexOf('inflightMarker.noteTurnEnd(journalConvoIdFor(session))');
    const kill = body.indexOf('killSession(session)');

    expect(
      clear,
      '!stop must clear the inflight marker. It is a DELIBERATE turn end, but the kill path never '
      + 'sets session.busy = false for print/iv sessions, so this site is invisible to a '
      + '`session.busy = false` grep and was missed once already. CONSEQUENCE: without it, '
      + '!stop on a mid-turn session leaves a marker behind and the next boot offers to carry on a '
      + 'turn the user killed on purpose — a SPURIOUS card.',
    ).toBeGreaterThan(-1);

    expect(
      kill,
      'expected the !stop handler to still call killSession(session) — this test needs updating',
    ).toBeGreaterThan(-1);

    expect(
      clear < kill,
      'the !stop marker clear must come BEFORE killSession(session). killSession tears the session '
      + 'down and, for Codex, re-enters finishCodexTurn — whose clear is deliberately gated off on '
      + 'that path. Clearing first means the marker is gone regardless of what teardown does, and '
      + 'removes any dependency on killSession leaving journalConvoIdFor(session) resolvable. '
      + 'CONSEQUENCE OF INVERTING: a deliberately killed turn can survive as a marker and produce a '
      + 'SPURIOUS "Carry on" card.',
    ).toBe(true);
  });

  it('does not clear the marker inside killSession, so /restart and /switch still get their card', () => {
    const body = bodyOf('function killSession(', '\nfunction ');

    expect(
      body,
      'killSession must NOT clear the inflight marker. It is reused by /restart and /switch, where '
      + 'the turn genuinely WAS interrupted and the carry-on card is the correct behaviour, and by '
      + 'the SIGINT/SIGTERM shutdown handlers, which are the feature\'s whole reason to exist. '
      + 'Clearing here would silently kill restart carry-on for every path at once. The one caller '
      + 'that should clear — !stop — does so explicitly at its own call site.',
    ).not.toContain('inflightMarker.');
  });

  it('records a turn start at every site that sets session.busy = true', () => {
    // A missed start site is the quieter failure (a silently missed card), but
    // it is still a hole, and the set is small enough to pin exactly.
    const starts = src.split('session.busy = true;').length - 1;
    const notes = src.split('inflightMarker.noteTurnStart(').length - 1;

    expect(
      starts,
      'index.js should have exactly 3 `session.busy = true;` turn-start sites (submitAnswer\'s '
      + 'tool_result write, sendToSession, and the plan-approval tool_result). If this changed, a '
      + 'turn start was added or removed — pair it with an inflightMarker.noteTurnStart call, or a '
      + 'restart during that turn produces NO carry-on card.',
    ).toBe(3);

    expect(
      notes,
      'every `session.busy = true;` site must be followed by inflightMarker.noteTurnStart(...), '
      + 'otherwise a turn interrupted by a restart leaves no marker and the user gets no card. '
      + 'The count is starts + 1, and the +1 is EXACTLY ONE deliberate exception: the first-turn '
      + "repair in handleCodexEvent's thread.started (pinned by the next test). It exists because a "
      + 'fresh Codex conversation has no convo id at the `session.busy = true` seam at all, so that '
      + 'site\'s call is a no-op and the marker has to be written later, once the id exists. If you '
      + 'are changing this number, you are either adding a turn-start site (pair it, and bump '
      + '`starts`) or adding a second such repair (justify it here first).',
    ).toBe(starts + 1);
  });

  it('repairs the first-turn marker for a fresh Codex convo, once, gated on the missing id', () => {
    // The +1 above. A fresh Codex session is created with claudeSessionId AND
    // journalConvoId both null (createCodexSessionForRoom), so sendToSession's
    // noteTurnStart runs with null and returns early — and touch() cannot fix
    // it later, because touch() no-ops when no record exists. The id is first
    // known at thread.started, which is also where persistSession makes the
    // convo genuinely resumable. Without this repair the FIRST Codex turn —
    // frequently the longest — silently gets no carry-on card.
    const body = bodyOf('function handleCodexEvent(', '\nfunction ');

    expect(
      body,
      'handleCodexEvent must record the turn start once the Codex thread id arrives, and must gate '
      + 'it on session.busy so a thread.started outside a turn cannot invent a marker. '
      + 'CONSEQUENCE OF REMOVING: no carry-on card for the first turn of every new Codex chat.',
    ).toContain('if (session.busy) inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId);');

    expect(
      body.split('inflightMarker.noteTurnStart(').length - 1,
      'handleCodexEvent must contain EXACTLY ONE noteTurnStart — the first-turn repair. A second '
      + 'one would re-mark a conversation whose turn is already marked.',
    ).toBe(1);

    const missingGate = body.indexOf('if (journalIdMissing) {');
    const repair = body.indexOf('if (session.busy) inflightMarker.noteTurnStart(');

    expect(
      missingGate,
      'expected the thread.started handler to still branch on `if (journalIdMissing) {` — this test '
      + 'needs updating',
    ).toBeGreaterThan(-1);

    expect(
      missingGate < repair,
      'the repair must sit inside the `journalIdMissing` branch, NOT the enclosing '
      + '`nativeIdChanged || journalIdMissing` block. journalConvoId is assigned once and never '
      + 'reassigned, so journalIdMissing is true at most once per conversation; nativeIdChanged can '
      + 'fire again later on a thread-id change, while journalConvoId — and therefore the marker '
      + 'key — stays put. CONSEQUENCE OF WIDENING THE GATE: a mid-flight turn already marked under '
      + "that id gets noteTurnStart called on it again, resetting startedAt/touchedAt and wrongly "
      + 'refreshing the age window that decides whether the interruption is recent enough to card.',
    ).toBe(true);
  });
});

describe('background marker behaviour in the bridge', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  function runFunction(name, context) {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end < 0 ? src.indexOf('\nasync function ', start + 1) : end);
    return runInNewContext(`${body}\n${name};`, {
      BRIDGE_BOOT_AT: 1000, currentBootSubagents, sessionBackgroundWork,
      journalConvoIdFor: session => session.journalConvoId || 'alice',
      subagentRunningStore: { listStrict: () => ({ ok: true, records: [] }) },
      ...context,
    });
  }

  it('retains evidence on probe failures and detects work without an age cap', () => {
    let observed = { ok: true, table: [{ pid: 11, ppid: 10, args: 'worker' }] };
    const hasWork = runFunction('sessionHasBackgroundWork', {
      readProcessTableStrict: () => observed, sessionChildPid: () => 10,
      liveWorkChildren, MCP_SERVER_SIGNATURES: [],
    });
    expect(hasWork({ proc: { pid: 10 } })).toBe(true);
    observed = { ok: true, table: [] };
    expect(hasWork({ proc: { pid: 10 } })).toBe(false);
    for (const value of [{ ok: false }, null, { ok: true }]) {
      observed = value;
      expect(hasWork({ proc: { pid: 10 } })).toBe(true);
    }
    const throws = runFunction('sessionHasBackgroundWork', {
      readProcessTableStrict: () => { throw new Error('timeout'); },
      sessionChildPid: () => 10, liveWorkChildren, MCP_SERVER_SIGNATURES: [],
    });
    expect(throws({})).toBe(true);
  });

  it('maintains background markers with idle reaping disabled', () => {
    let tick;
    let clock = 0;
    let saved;
    let work = true;
    const marker = createInflightMarker({ load: () => ({}), save: value => { saved = structuredClone(value); }, now: () => clock, bootId: 'boot-a' });
    marker.noteTurnStart('alice', 'room-a');
    marker.noteTurnEnd('alice', { hasWork: true });
    const session = { alive: true, busy: false };
    const unref = vi.fn();
    const start = runFunction('startBackgroundMarkerMaintenance', {
      setInterval: fn => { tick = fn; return { unref }; },
      sessions: new Map([['room-a', session]]),
      readProcessTableStrict: () => ({ ok: true, table: [] }),
      sessionHasBackgroundWork: () => work,
      journalConvoIdFor: () => 'alice', inflightMarker: marker,
      SESSION_IDLE_CHECK_MS: 60_000, Date: { now: () => clock },
    });
    const begin = src.indexOf('  startBackgroundMarkerMaintenance();', src.indexOf('async function main()'));
    const end = src.indexOf('  startAutoResumeSweep();', begin);
    // Execute the boot wiring, including the disabled-reaper branch.
    runInNewContext(src.slice(begin, end), {
      startBackgroundMarkerMaintenance: start, SESSION_IDLE_TIMEOUT_MS: 0,
      startIdleReaper: () => { throw new Error('reaping disabled'); }, console: { log() {} },
    });
    expect(unref).toHaveBeenCalledOnce();
    clock = 7 * 3600 * 1000;
    tick();
    expect(saved.alice.touchedAt).toBe(clock);
    session.busy = true;
    work = false;
    tick();
    expect(saved.alice.kind).toBe('background');
    expect(session._bgWorkObserved).toEqual({ at: clock, hasWork: false });
    session.busy = false;
    tick();
    expect(saved).toEqual({});
  });

  it('retains newly discovered descendants after their retained parent exits', () => {
    const session = { alive: true, journalConvoId: 'alice', codex: { child: { pid: 10 } } };
    let table = [{ pid: 11, ppid: 10, startTime: 'shell-start', args: 'shell' }];
    let saved;
    const marker = createInflightMarker({ load: () => ({}), save: value => { saved = structuredClone(value); }, now: () => 1000, bootId: 'boot-a' });
    marker.noteTurnStart('alice', 'room-a');
    marker.noteTurnEnd('alice', { hasWork: true });
    const context = { readProcessTableStrict: () => ({ ok: true, table }), MCP_SERVER_SIGNATURES: [] };
    const hasWork = runFunction('sessionHasBackgroundWork', context);
    let tick;
    runFunction('startBackgroundMarkerMaintenance', {
      ...context, sessionHasBackgroundWork: hasWork,
      sessions: new Map([['room-a', session]]), inflightMarker: marker,
      SESSION_IDLE_CHECK_MS: 60_000, Date: { now: () => 1000 },
      setInterval: fn => { tick = fn; return { unref() {} }; },
    })();
    expect(sessionBackgroundWork(session, table, []).children).toBe(true);
    session.codex.child = null;
    table = [{ ...table[0], ppid: 1 }, { pid: 12, ppid: 11, startTime: 'worker-start', args: 'worker' }];
    expect(sessionBackgroundWork(session, table, []).children).toBe(true);
    table = [{ ...table[1], ppid: 1 }];
    expect(sessionBackgroundWork(session, table, []).children).toBe(true);
    const result = evaluateQuiet({ sessions: [session], bootAt: 1000,
      readProcessTable: () => ({ ok: true, table }), listRunningSubagents: () => [], prev: { consecutiveQuiet: 2 } });
    expect(result.probe_error).toBeNull();
    expect(result.quiet).toBe(false);
    expect(result.holders).toContainEqual({ convoId: 'alice', why: 'children' });
    tick();
    expect(saved.alice.kind).toBe('background');
    table = [];
    tick();
    expect(saved).toEqual({});
  });

  function lifecycleContext(table) {
    let saved;
    const marker = createInflightMarker({ load: () => ({}), save: value => { saved = structuredClone(value); }, now: () => 1000, bootId: 'boot-a' });
    marker.noteTurnStart('alice', 'room-a');
    const session = { alive: true, busy: true, proc: { pid: 10 }, toolCalls: [], responseBuffer: '', turnCount: 0, workdir: 'box-a' };
    const noop = () => {};
    const context = {
      inflightMarker: marker, journalConvoIdFor: () => 'alice', shuttingDown: false,
      SESSION_IDLE_CHECK_MS: 60_000, Date: { now: () => 1000 },
      liveWorkChildren, MCP_SERVER_SIGNATURES: [], readProcessTableStrict: () => ({ ok: true, table }),
      debug: noop, flushResponse: noop, journalStreamClear: noop, journalSessionState: noop,
      journalActivity: noop, maybeSummarizeAtTurnEnd: noop, journalStatus: noop,
      dispatchDeferredCommand: () => false, flushPendingSessionQueue: () => false,
      maybeFlushRoomDelivery: noop, foreignSessions: { end: noop },
      clearPendingInterrupt: noop, refreshUsageLimits: () => null,
      extractTextContent: () => '', isLoginExpiredText: () => false,
      isSidechainEvent: () => false, modelFromEvent: () => null, eventConfirmsSession: () => false,
      postCompactContextTokens: () => null, contextGaugeText: () => null,
      compactTriggerFrom: event => event.compact_metadata?.trigger,
      routeWorkflowStreamEvent: noop, endRestartNoticeTurn: noop, clearTurnClassification: noop, bumpTurnGeneration: noop,
      holdTurnForSteer: () => false,
    };
    context.sessionChildPid = runFunction('sessionChildPid', {});
    context.sessionHasBackgroundWork = runFunction('sessionHasBackgroundWork', context);
    return { session, context, saved: () => saved };
  }

  for (const hasWork of [true, false]) {
    const table = hasWork ? [{ pid: 11, ppid: 10, pgid: 10, sid: 10, startTime: 'worker-start', args: 'worker' }] : [];
    it(`interactive turn end ${hasWork ? 'retains background work' : 'clears completed work'}`, () => {
      const state = lifecycleContext(table);
      const start = src.indexOf('  session.onTurnEnd = () => {');
      const end = src.indexOf('\n  };', start) + 5;
      runInNewContext(src.slice(start, end), { ...state.context, session: state.session });
      state.session.onTurnEnd();
      expect(state.saved()).toEqual(hasWork ? { alice: expect.objectContaining({ kind: 'background' }) } : {});
    });

    it(`print turn end ${hasWork ? 'retains background work' : 'clears completed work'}`, () => {
      const state = lifecycleContext(table);
      runFunction('handleClaudeEvent', state.context)(state.session, { type: 'result' });
      expect(state.saved()).toEqual(hasWork ? { alice: expect.objectContaining({ kind: 'background' }) } : {});
    });

    it(`exec adapter exit ${hasWork ? 'retains surviving work' : 'clears completed work'}`, () => {
      const state = lifecycleContext(table);
      const child = new EventEmitter();
      Object.assign(child, { pid: 10, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      const codex = new CodexExecSession({ env: {}, spawnImpl: () => child, readProcesses: () => ({ ok: true, table: [{ pid: 10, pgid: 10, sid: 10, startTime: 'parent-start' }] }) });
      state.session.codex = codex;
      const finish = runFunction('finishCodexTurn', state.context);
      const start = src.indexOf("  codex.on('turn-exit',");
      const end = src.indexOf('\n  });', start) + 6;
      runInNewContext(src.slice(start, end), {
        ...state.context, codex, session: state.session, finishCodexTurn: finish,
        clearInterval() {}, refreshCodexTelemetry() {}, refreshCodexMetadata() {}, CODEX_APP_SERVER: false,
      });
      expect(codex.send([{ type: 'text', text: 'hello' }])).toBe(true);
      let tick;
      const startMaintenance = runFunction('startBackgroundMarkerMaintenance', {
        ...state.context, sessions: new Map([['room-a', state.session]]),
        setInterval: fn => { tick = fn; return { unref() {} }; },
      });
      startMaintenance();
      tick();
      expect(state.session._bgWorkObserved).toEqual({ at: 1000, hasWork });
      for (const worker of table) worker.ppid = 1;
      child.stdout.write('{"type":"turn.completed"}\n');
      child.emit('close', 0, null);
      expect(codex.child).toBeNull();
      expect(state.session.proc).toBeNull();
      expect(state.saved()).toEqual(hasWork ? { alice: expect.objectContaining({ kind: 'background' }) } : {});
      tick();
      tick();
      expect(state.saved()).toEqual(hasWork ? { alice: expect.objectContaining({ kind: 'background' }) } : {});
      const gate = () => evaluateQuiet({ sessions: [state.session], bootAt: 1000,
        readProcessTable: () => ({ ok: true, table }), listRunningSubagents: () => [], prev: { consecutiveQuiet: 2 } });
      expect(gate().quiet).toBe(!hasWork);
      if (hasWork) {
        table[0].startTime = 'replacement-start';
        table[0].pgid = 20; table[0].sid = 20;
        tick();
        expect(state.saved()).toEqual({});
        expect(gate().quiet).toBe(true);
      }
      table.length = 0;
      tick();
      expect(state.saved()).toEqual({});
      expect(state.session._bgWorkObserved).toEqual({ at: 1000, hasWork: false });
    });

    it(`manual compact boundary ${hasWork ? 'retains background work' : 'clears completed work'}`, () => {
      const state = lifecycleContext(hasWork ? [{ pid: 11, ppid: 10, args: 'worker' }] : []);
      state.session._operatorCompactPending = true;
      state.session._operatorCompactPendingTurn = state.session.turnCount;
      runFunction('handleClaudeEvent', state.context)(state.session, {
        type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' },
      });
      expect(state.session.busy).toBe(false);
      expect(state.session._operatorCompactPending).toBe(false);
      expect(state.saved()).toEqual(hasWork ? { alice: expect.objectContaining({ kind: 'background' }) } : {});
    });
  }

  it.each(['pgid', 'sid'])('retains an orphaned exec worker by %s without a pre-exit inventory poll', groupColumn => {
    const table = [{ pid: 11, ppid: 1, pgid: 20, sid: 20, startTime: 'Thu Jan 1 00:00:01 2026', args: 'worker' }];
    table[0][groupColumn] = 10;
    const state = lifecycleContext(table);
    const child = new EventEmitter();
    Object.assign(child, { pid: 10, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const spawn = vi.fn(() => child);
    const codex = new CodexExecSession({ env: {}, spawnImpl: spawn,
      readProcesses: () => ({ ok: true, table: [{ pid: 10, pgid: 10, sid: 10, startTime: 'Thu Jan 1 00:00:00 2026' }] }) });
    state.session.codex = codex;
    const wireStart = src.indexOf("  codex.on('turn-exit',");
    const wireEnd = src.indexOf('\n  });', wireStart) + 6;
    runInNewContext(src.slice(wireStart, wireEnd), { ...state.context, session: state.session, codex, clearInterval() {}, refreshCodexTelemetry() {}, refreshCodexMetadata() {}, CODEX_APP_SERVER: false,
      finishCodexTurn: runFunction('finishCodexTurn', state.context) });
    codex.send([{ type: 'text', text: 'Continue' }]);
    expect(spawn.mock.calls[0][2].detached).toBe(process.platform !== 'win32');
    child.stdout.write('{"type":"turn.completed"}\n');
    child.emit('close', 0, null);
    expect(state.saved()).toMatchObject({ alice: { kind: 'background' } });
    const gate = () => evaluateQuiet({ sessions: [state.session], bootAt: 1000,
      readProcessTable: () => ({ ok: true, table }), listRunningSubagents: () => [], prev: { consecutiveQuiet: 2 } });
    expect(gate().quiet).toBe(false);
    table.length = 0;
    expect(gate().quiet).toBe(true);
  });

  it('excludes configured server subtrees from orphaned exec groups', () => {
    const session = { codex: { workGroups: [{ pid: 10, pgid: 10, sid: 10, startTime: 'parent-start' }] } };
    const table = [{ pid: 11, ppid: 1, pgid: 10, sid: 10, startTime: 'server-start', args: 'node server.js' },
      { pid: 12, ppid: 11, pgid: 10, sid: 10, startTime: 'worker-start', args: 'browser' }];
    expect(sessionBackgroundWork(session, table, [], [['server.js']]).children).toBe(false);
    table.push({ pid: 13, ppid: 1, pgid: 10, sid: 10, startTime: 'worker-start', args: 'worker' });
    expect(sessionBackgroundWork(session, table, [], [['server.js']]).children).toBe(true);
  });

  it('holds exec work with unknown group identity until an empty successful observation', () => {
    const session = { alive: true, codex: { child: null, workGroups: [{ pid: 10, pgid: 10, sid: 10 }] } };
    expect(sessionBackgroundWork(session, [{ pid: 11, ppid: 1, args: 'worker' }], []).children).toBe(true);
    expect(sessionBackgroundWork(session, [], []).children).toBe(false);
    session.codex.workGroups = [{ pid: 10, pgid: 10, sid: 10, startTime: 'original' }];
    expect(sessionBackgroundWork(session, [{ pid: 10, ppid: 1, pgid: 10, sid: 10, startTime: 'replacement', args: 'other' }], []).children).toBe(false);
  });

  it('retains a parent marker for current in-process work until completion', () => {
    const state = lifecycleContext([]);
    let records = [{ childConvoId: 'bob', parentConvoId: 'alice', addedAt: 1000 }];
    state.context.subagentRunningStore = { listStrict: () => ({ ok: true, records }) };
    state.context.sessionHasBackgroundWork = runFunction('sessionHasBackgroundWork', state.context);
    runFunction('handleClaudeEvent', state.context)(state.session, { type: 'result' });
    expect(state.saved()).toEqual({ alice: expect.objectContaining({ kind: 'background' }) });
    let tick;
    runFunction('startBackgroundMarkerMaintenance', { ...state.context,
      sessions: new Map([['room-a', state.session]]),
      setInterval: fn => { tick = fn; return { unref() {} }; },
    })();
    tick();
    expect(state.saved()).toMatchObject({ alice: { kind: 'background' } });
    records = [];
    tick();
    expect(state.saved()).toEqual({});
  });

  it('retains parent evidence when the running store is corrupt', () => {
    const state = lifecycleContext([]);
    state.context.subagentRunningStore = { listStrict: () => ({ ok: false }) };
    state.context.sessionHasBackgroundWork = runFunction('sessionHasBackgroundWork', state.context);
    runFunction('handleClaudeEvent', state.context)(state.session, { type: 'result' });
    expect(state.saved()).toEqual({ alice: expect.objectContaining({ kind: 'background' }) });
    let tick;
    runFunction('startBackgroundMarkerMaintenance', { ...state.context,
      sessions: new Map([['room-a', state.session]]),
      setInterval: fn => { tick = fn; return { unref() {} }; },
    })();
    tick();
    expect(state.saved()).toMatchObject({ alice: { kind: 'background' } });
  });

  for (const hasJob of [false, true]) {
    it(`completion hook ${hasJob ? 'preserves a real job' : 'does not count as background work'}`, () => {
      for (const name of ['stop-notify.sh', 'stop-notify.mjs']) {
        const table = [
          { pid: 11, ppid: 10, args: `sh -c hooks/${name}` },
          { pid: 12, ppid: 11, args: `node hooks/${name}` },
          { pid: 13, ppid: 12, args: 'curl --silent' },
          ...(hasJob ? [{ pid: 14, ppid: 10, args: 'worker' }] : []),
        ];
        const state = lifecycleContext(table);
        expect(state.context.sessionHasBackgroundWork(state.session)).toBe(hasJob);
      }
    });
  }

  it('publishes a distinct background card for recently touched long-running work', () => {
    const clock = 7 * 3600 * 1000;
    for (const stamp of [null, { bootId: 'boot-1', sha: 'abc' }]) {
      const marker = createInflightMarker({
        load: () => ({ alice: { bootId: 'boot-1', kind: 'background', startedAt: 0, touchedAt: clock - 1 } }),
        save() {}, now: () => clock, bootId: 'boot-2',
      });
      const publish = vi.fn(() => true);
      const boot = runFunction('publishRestartCarryOnCards', {
        JOURNAL_ENABLED: true, PLANNED_RESTART_ENABLED: false, inflightMarker: marker,
        RESTART_CARRY_ON_MAX_AGE_MS: 6 * 3600 * 1000,
        takeSelfRestartStamp: () => stamp, SELF_RESTART_STAMP_FILE: 'unused',
        loadPersistedSessions: () => ({ 'room-a': { journalConvoId: 'alice' } }),
        selectAutoCarryOn, CODE_UPDATE_AUTO_CARRY_ON: true,
        CODE_UPDATE_AUTO_CARRY_ON_DELAY_MS: 1000, setTimeout() {},
        isResumeConvoId: () => true, formatInterruptedAgo: () => 'recently',
        journalPublishCardForConvo: publish, console: { log() {}, warn() {} },
      });
      boot();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][1].question).toContain('background work');
      expect(publish.mock.calls[0][1].options[0].value).toBe('resume:alice');
      boot();
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });

  it('checks remaining work at each normal backend turn-end seam', () => {
    const ends = [
      src.slice(src.indexOf('function finishCodexTurn('), src.indexOf('\nfunction ', src.indexOf('function finishCodexTurn(') + 1)),
      src.slice(src.indexOf('// Authoritative iv-mode turn-end seam.'), src.indexOf('// Authoritative iv-mode turn-end seam.') + 220),
      src.slice(src.indexOf('// Authoritative print-mode turn-end seam.'), src.indexOf('// Authoritative print-mode turn-end seam.') + 220),
      src.slice(src.indexOf('// This branch IS the turn-end for a print-mode'), src.indexOf('// This branch IS the turn-end for a print-mode') + 500),
    ];
    for (const end of ends) expect(end).toContain('{ hasWork: sessionHasBackgroundWork(session) }');
  });
});
