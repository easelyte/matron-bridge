import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { workHold, liveWorkChildren } from '../lib/work-hold.js';
import { createInflightMarker } from '../lib/inflight-marker.js';

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
      'index.js should have exactly 2 `session.busy = true;` turn-start sites (sendToSession and '
      + 'the plan-approval tool_result). If this changed, a '
      + 'turn start was added or removed — pair it with an inflightMarker.noteTurnStart call, or a '
      + 'restart during that turn produces NO carry-on card.',
    ).toBe(2);

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
    ).toContain('if (session.busy) inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId, inflightTurnOrigin(session));');

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

describe('background work markers in the bridge', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  // Run one top-level function of index.js against injected collaborators.
  function load(names, context) {
    const body = names.map((name) => {
      const start = src.indexOf(`function ${name}(`);
      expect(start, `could not find ${name} in index.js`).toBeGreaterThan(-1);
      const end = src.indexOf('\n}\n', start);
      return src.slice(start, end + 3);
    }).join('\n');
    return runInNewContext(`${body}\n({ ${names.join(', ')} });`, context);
  }

  const MCP = [];
  const hasWorkFns = (extra = {}) => load(['sessionWorkHold', 'sessionHasBackgroundWork'], {
    workHold, liveWorkChildren, MCP_SERVER_SIGNATURES: MCP, Date,
    sessionChildPid: (s) => s.pid ?? null,
    readProcessTable: () => [],
    ...extra,
  });
  const live = (table) => Object.assign([], table);

  it('a turn that ends with a live work child, a running subagent or nothing', () => {
    const { sessionHasBackgroundWork } = hasWorkFns();
    const child = live([{ pid: 11, ppid: 10, args: 'sleep 3600' }]);
    const bare = live([]);
    // `busy` is still set on some turn-end paths; it must not count as work.
    expect(sessionHasBackgroundWork({ pid: 10, busy: true }, child)).toBe(true);
    expect(sessionHasBackgroundWork({ pid: 10, busy: true, subagentConvos: { runningCount: () => 2 } }, bare)).toBe(true);
    expect(sessionHasBackgroundWork({ pid: 10, busy: true }, bare)).toBe(false);
  });

  it('on an unreadable process table only running subagents count', () => {
    const { sessionHasBackgroundWork } = hasWorkFns();
    const unreadable = Object.assign([], { unreadable: true });
    expect(sessionHasBackgroundWork({ pid: 10 }, unreadable)).toBe(false);
    expect(sessionHasBackgroundWork({ pid: 10, subagentConvos: { runningCount: () => 1 } }, unreadable)).toBe(true);
  });

  it('keeps the evidence when the check itself throws', () => {
    const { sessionHasBackgroundWork } = hasWorkFns({ sessionChildPid: () => { throw new Error('boom'); } });
    expect(sessionHasBackgroundWork({}, live([{ pid: 1, ppid: 0, args: 'x' }]))).toBe(true);
  });

  it('the card appears after a restart only when work outlived the turn', () => {
    const { sessionHasBackgroundWork } = hasWorkFns();
    const cases = {
      child: [{ pid: 10 }, live([{ pid: 11, ppid: 10, args: 'sleep 3600' }])],
      subagent: [{ pid: 10, subagentConvos: { runningCount: () => 1 } }, live([])],
      nothing: [{ pid: 10 }, live([])],
    };
    let data = {};
    const save = (d) => { data = JSON.parse(JSON.stringify(d)); };
    const first = createInflightMarker({ load: () => data, save, now: () => 1_000_000, bootId: 'boot-1' });
    for (const [convoId, [session, table]] of Object.entries(cases)) {
      first.noteTurnStart(convoId, `room-${convoId}`);
      first.noteTurnEnd(convoId, { hasWork: sessionHasBackgroundWork(session, table) });
    }
    const next = createInflightMarker({ load: () => data, save, now: () => 1_060_000, bootId: 'boot-2' });
    const stale = next.takeStale(6 * 3600 * 1000);
    expect(stale.map(r => [r.convoId, r.kind])).toEqual([['child', 'background'], ['subagent', 'background']]);
  });

  it('every turn-end seam goes through the non-blocking work check', () => {
    const ends = src.match(/inflightMarker\.noteTurnEnd\(journalConvoIdFor\(session\)[^;]*;/g) || [];
    expect(src.match(/dropBackgroundMarkerWhenNoWork\(session\);/g)).toHaveLength(5);
    expect(ends.filter(e => e.includes('{ hasWork: true }'))).toHaveLength(5);
    // The others are teardown or unstick paths that deliberately clear the marker.
    expect(ends.length).toBeGreaterThan(5);
  });

  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('a turn end keeps the marker, then drops it when the non-blocking check finds no work', async () => {
    let data = {};
    const marker = createInflightMarker({ load: () => data, save: (d) => { data = JSON.parse(JSON.stringify(d)); }, now: () => 1000, bootId: 'b1' });
    marker.noteTurnStart('alice', 'room-a');
    marker.noteTurnStart('bob', 'room-b');
    const tables = { alice: Object.assign([], { unreadable: false }), bob: [{ pid: 11, ppid: 10, args: 'sleep 3600' }] };
    const fns = hasWorkFns({ inflightMarker: marker, shuttingDown: false, journalConvoIdFor: (s) => s.id, readProcessTableAsync: async () => tables.current });
    const drop = load(['dropBackgroundMarkerWhenNoWork'], { ...fns, inflightMarker: marker, shuttingDown: false, journalConvoIdFor: (s) => s.id, readProcessTableAsync: async () => tables.current }).dropBackgroundMarkerWhenNoWork;
    const end = (session) => { marker.noteTurnEnd(session.id, { hasWork: true }); drop(session); };
    tables.current = tables.alice;
    end({ id: 'alice', pid: 10 });
    expect(data.alice.kind).toBe('background');
    await flush();
    expect(data.alice).toBeUndefined();
    tables.current = tables.bob;
    end({ id: 'bob', pid: 10 });
    await flush();
    expect(data.bob.kind).toBe('background');
  });

  it('a turn end does not read the process table synchronously', () => {
    const body = src.slice(src.indexOf('function dropBackgroundMarkerWhenNoWork'), src.indexOf('function startBackgroundMarkerMaintenance'));
    expect(body).toMatch(/readProcessTableAsync\(\)/);
    expect(body).not.toMatch(/readProcessTable\(\)/);
    const sweep = src.slice(src.indexOf('function startBackgroundMarkerMaintenance'), src.indexOf('// --- Pre-reap handoff'));
    expect(sweep).not.toMatch(/readProcessTable\(\)/);
    expect(src.slice(src.indexOf('function sessionHasBackgroundWork'), src.indexOf('function dropBackgroundMarkerWhenNoWork'))).not.toMatch(/execFileSync|readProcessTable\(/);
  });

  function sweepHarness({ ids, sessions, hasWork = () => true, shuttingDown = false }) {
    let tick;
    const refreshBackground = vi.fn();
    const clearBackground = vi.fn();
    const readProcessTableAsync = vi.fn(async () => []);
    const { startBackgroundMarkerMaintenance } = load(['startBackgroundMarkerMaintenance'], {
      setInterval: (fn) => { tick = fn; return { unref() {} }; },
      sessions: new Map(sessions.map((s, i) => [`r${i}`, s])), SESSION_IDLE_CHECK_MS: 1000, readProcessTableAsync,
      journalConvoIdFor: (s) => s.id, handoffIdleSince: () => 0, shuttingDown,
      sessionHasBackgroundWork: (s) => hasWork(s),
      inflightMarker: { backgroundIds: () => ids, refreshBackground, clearBackground },
    });
    startBackgroundMarkerMaintenance();
    return { tick: async () => { await tick(); }, refreshBackground, clearBackground, readProcessTableAsync };
  }

  it('sweeps background markers: refresh while work runs, drop when it is gone', async () => {
    const h = sweepHarness({
      ids: ['busy-one', 'gone', 'mid-turn'],
      sessions: [{ alive: true, id: 'busy-one' }, { alive: true, id: 'gone' }, { alive: true, busy: true, id: 'mid-turn' }],
      hasWork: (s) => s.id === 'busy-one',
    });
    await h.tick();
    expect(h.refreshBackground.mock.calls).toEqual([['busy-one']]);
    expect(h.clearBackground.mock.calls).toEqual([['gone']]);
    expect(h.readProcessTableAsync).toHaveBeenCalledTimes(1);
  });

  it('drops the marker of a conversation with no live session: reaped, killed, archived or exited', async () => {
    const h = sweepHarness({
      ids: ['reaped', 'dead', 'archived', 'live'],
      sessions: [{ alive: true, _autoStopped: true, id: 'reaped' }, { alive: false, id: 'dead' }, { alive: true, id: 'live' }],
      hasWork: () => true,
    });
    await h.tick();
    expect(h.clearBackground.mock.calls.map(c => c[0]).sort()).toEqual(['archived', 'dead', 'reaped']);
    expect(h.refreshBackground.mock.calls).toEqual([['live']]);
  });

  it('does nothing, and reads no process table, when there is no background marker', async () => {
    const h = sweepHarness({ ids: [], sessions: [{ alive: true, id: 'a' }] });
    await h.tick();
    expect(h.readProcessTableAsync).not.toHaveBeenCalled();
    expect(h.clearBackground).not.toHaveBeenCalled();
  });

  it('leaves the markers alone while the bridge is shutting down: the killed sessions are the ones whose cards a restart keeps', async () => {
    const h = sweepHarness({ ids: ['a'], sessions: [], shuttingDown: true });
    await h.tick();
    expect(h.clearBackground).not.toHaveBeenCalled();
    expect(h.readProcessTableAsync).not.toHaveBeenCalled();
  });

  it('judges the sweep by the session\'s real idle time, so the eight-hour cap applies', () => {
    const body = src.slice(src.indexOf('function startBackgroundMarkerMaintenance'), src.indexOf('// --- Pre-reap handoff'));
    expect(body).toMatch(/sessionHasBackgroundWork\(session, table, handoffIdleSince\(session\)\)/);
    const { sessionHasBackgroundWork } = hasWorkFns();
    const child = Object.assign([], [{ pid: 11, ppid: 10, args: 'sleep 3600' }]);
    const now = Date.now();
    expect(sessionHasBackgroundWork({ pid: 10 }, child, now - 60_000)).toBe(true);
    expect(sessionHasBackgroundWork({ pid: 10 }, child, now - 9 * 3600_000)).toBe(false);
  });

  it('reaping an idle session drops its background marker before the kill', () => {
    const body = src.slice(src.indexOf('session._autoStopped = true;'), src.indexOf('session._autoStopped = true;') + 400);
    expect(body.indexOf('inflightMarker.clearBackground(journalConvoIdFor(session))')).toBeGreaterThan(-1);
    expect(body.indexOf('inflightMarker.clearBackground')).toBeLessThan(body.indexOf('killSession(session'));
  });

  it('starts the sweep at boot whether or not the idle reaper is on', () => {
    const main = src.slice(src.indexOf('async function main()'));
    expect(main.indexOf('startBackgroundMarkerMaintenance();')).toBeGreaterThan(-1);
    expect(main.indexOf('startBackgroundMarkerMaintenance();')).toBeLessThan(main.indexOf('if (SESSION_IDLE_TIMEOUT_MS > 0)'));
  });

  it('shows the note a background chat had on its card', () => {
    expect(src).toMatch(/Your note for this chat: "/);
  });

  it('gives background work its own card and never carries it on by itself', () => {
    expect(src).toMatch(/\.filter\(rec => rec\.kind !== 'background'\)/);
    expect(src).toMatch(/rec\.kind === 'background'\s*\? `⚠️ The bridge restarted while this chat had background work running/);
  });
});
