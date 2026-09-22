import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

import { planTransition, selectEpochRepairs } from '../lib/session-state-repair.js';
import { createRunStateOutbox } from '../lib/run-state-outbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const silent = { warn() {}, log() {} };

describe('selectEpochRepairs', () => {
  it('re-offers the recorded state for a convo a live session owns', () => {
    const out = selectEpochRepairs([{ convoId: 'c1', state: 'running', token: 'T' }], new Set(['c1']));
    expect(out).toEqual({ reoffer: [{ convoId: 'c1', state: 'running', token: 'T' }], retire: [] });
  });

  it('RETIRES a stranded running convo with no live session — the permanent-Thinking case', () => {
    // Nothing owns the convo, so the process that was running it is gone and the row can never be
    // flipped by the session itself. Every client shows a "Thinking" that can never clear.
    const out = selectEpochRepairs([{ convoId: 'ghost', state: 'running', token: 'T' }], new Set());
    expect(out).toEqual({ reoffer: [], retire: [{ convoId: 'ghost', token: 'T' }] });
  });

  it('re-offers a TERMINAL state whose session is gone rather than retiring it', () => {
    // The session ended and its `done`/`waiting` frame never landed. Re-sending it is the repair;
    // retiring would be a no-op at best and could overwrite `waiting` with `done` at worst.
    const out = selectEpochRepairs(
      [{ convoId: 'a', state: 'done' }, { convoId: 'b', state: 'waiting' }],
      new Set(),
    );
    expect(out.retire).toEqual([]);
    expect(out.reoffer.map((r) => [r.convoId, r.state])).toEqual([['a', 'done'], ['b', 'waiting']]);
  });

  it('separates a mixed epoch correctly', () => {
    const out = selectEpochRepairs(
      [
        { convoId: 'live', state: 'running' },
        { convoId: 'ghost', state: 'running' },
        { convoId: 'ended', state: 'done' },
      ],
      new Set(['live']),
    );
    expect(out.reoffer.map((r) => r.convoId)).toEqual(['live', 'ended']);
    expect(out.retire.map((r) => r.convoId)).toEqual(['ghost']);
  });

  it('accepts a plain array of live ids and tolerates junk entries', () => {
    const out = selectEpochRepairs(
      [null, { convoId: '' }, { convoId: 'x' }, { convoId: 'y', state: 'running' }],
      ['y'],
    );
    expect(out.retire).toEqual([]);
    expect(out.reoffer.map((r) => r.convoId)).toEqual(['y']);
  });

  it('is inert with no entries', () => {
    expect(selectEpochRepairs(undefined, undefined)).toEqual({ reoffer: [], retire: [] });
  });
});

describe('run-state outbox', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-state-outbox-'));
    file = join(dir, 'outbox.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('SURVIVES a process restart — the whole reason it is on disk', () => {
    const first = createRunStateOutbox({ file, log: silent });
    first.note('c1', 'running');

    // A fresh instance models the bridge coming back up: the pending transition is still there.
    const afterRestart = createRunStateOutbox({ file, log: silent });
    expect(afterRestart.list().map((r) => [r.convoId, r.state])).toEqual([['c1', 'running']]);
  });

  it('keeps only the LATEST state per convo', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');
    outbox.note('c1', 'done');
    expect(outbox.list().map((r) => [r.convoId, r.state])).toEqual([['c1', 'done']]);
  });

  it('settles only the state that was confirmed, so a newer transition survives', () => {
    // The in-flight 'running' frame confirms AFTER 'done' superseded it. Clearing on convo id
    // alone would erase the 'done' record and re-strand the row.
    const outbox = createRunStateOutbox({ file, log: silent });
    const stale = outbox.note('c1', 'running');
    const fresh = outbox.note('c1', 'done');

    expect(outbox.settle('c1', stale)).toBe(false);
    expect(outbox.list().map((r) => r.state)).toEqual(['done']);

    expect(outbox.settle('c1', fresh)).toBe(true);
    expect(outbox.list()).toEqual([]);
  });

  it('a settled entry stays gone across a restart', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.settle('c1', outbox.note('c1', 'done'));
    expect(createRunStateOutbox({ file, log: silent }).list()).toEqual([]);
  });

  it('ignores a missing convo id or state, and settling an unknown convo', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    expect(outbox.note('', 'done')).toBe(null);
    expect(outbox.note('c1', '')).toBe(null);
    expect(outbox.settle('nope', { rev: 1 })).toBe(false);
    expect(outbox.size()).toBe(0);
  });

  it('quarantines a corrupt file instead of silently starting empty over it', () => {
    writeFileSync(file, '{not json');
    const outbox = createRunStateOutbox({ file, log: silent });

    expect(outbox.list()).toEqual([]);
    // The evidence survives under a .corrupt-* name rather than being overwritten.
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(true);
    // And the store is usable again afterwards.
    outbox.note('c1', 'done');
    expect(createRunStateOutbox({ file, log: silent }).list().map((r) => r.state)).toEqual(['done']);
  });

  it('writes atomically, leaving no tmp files behind', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.settle('c1', outbox.note('c1', 'running'));
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

describe('retirement settles against the RECORDED state (no publish loop)', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-state-retire-'));
    file = join(dir, 'outbox.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Models index.js's epoch sweep end to end: classify -> publish -> delivery -> capacity retry.
  // The published state for a retirement ('done') differs from the recorded one ('running'), so
  // settling on the published value would never match. The record would survive, the capacity
  // hook would sweep it again, and every confirmed `done` would schedule another one forever.
  function sweep(outbox, liveConvoIds, sent) {
    const { reoffer, retire } = selectEpochRepairs(outbox.list(), liveConvoIds);
    const offer = (convoId, token, publish) => {
      sent.push([convoId, publish]);
      outbox.settle(convoId, token); // stands in for the publisher's onLocalSendComplete
    };
    for (const { convoId, state, token } of reoffer) offer(convoId, token, state);
    for (const { convoId, token } of retire) offer(convoId, token, 'done');
  }

  it('publishes done ONCE and clears the record', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('ghost', 'running');
    const sent = [];

    sweep(outbox, new Set(), sent);
    expect(sent).toEqual([['ghost', 'done']]);
    expect(outbox.size()).toBe(0);

    // The capacity hook fires on every confirmed send; with the record cleared it finds nothing.
    sweep(outbox, new Set(), sent);
    expect(sent).toEqual([['ghost', 'done']]);
  });

  it('stays cleared across a restart, so the loop cannot resume later', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('ghost', 'running');
    sweep(outbox, new Set(), []);

    expect(createRunStateOutbox({ file, log: silent }).list()).toEqual([]);
  });
});

describe('loop #754: the transition publish does NOT settle on local send — reconcile is the authority', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-state-754-'));
    file = join(dir, 'outbox.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Models the epoch sweep the same way the "retirement settles" block does: classify -> publish
  // -> settle on the sweep's own send. This is the reconcile authority.
  function sweep(outbox, liveConvoIds, sent) {
    const { reoffer, retire } = selectEpochRepairs(outbox.list(), liveConvoIds);
    const offer = (convoId, token, publish) => {
      sent.push([convoId, publish]);
      outbox.settle(convoId, token);
    };
    for (const { convoId, state, token } of reoffer) offer(convoId, token, state);
    for (const { convoId, token } of retire) offer(convoId, token, 'done');
  }

  it('a `done` whose local send completed but whose server commit was LOST survives and is redelivered', () => {
    const outbox = createRunStateOutbox({ file, log: silent });

    // journalSessionState write-aheads the terminal transition, then publishes `done`. Under the
    // #754 fix it deliberately does NOT settle on the publisher's onLocalSendComplete callback,
    // because that callback fires when the frame leaves the local socket buffer, NOT when the
    // server persists it. Model exactly that: note the transition, "publish" it, and do NOT settle.
    outbox.note('c1', 'done');
    // <-- the local send completed here (ws.send callback fired) but the connection dropped before
    //     the server committed. The OLD code called runStateOutbox.settle() right here and stranded
    //     the row forever. The new code does not, so the write-ahead record MUST survive.
    expect(outbox.size()).toBe(1);
    expect(outbox.list().map((r) => [r.convoId, r.state])).toEqual([['c1', 'done']]);

    // On the next accepted reconnect the session is gone (no live owner). The reconcile sweep
    // re-offers the surviving terminal record — a SECOND delivery attempt for the lost `done` —
    // and settles it against the recorded revision.
    const sent = [];
    sweep(outbox, new Set(), sent);
    expect(sent).toEqual([['c1', 'done']]);
    expect(outbox.size()).toBe(0);
  });

  it('a still-live convo whose transition send was lost is re-offered its current state on reconnect', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');
    // No eager settle on local send (the fix). The record survives.
    expect(outbox.size()).toBe(1);

    const sent = [];
    sweep(outbox, new Set(['c1']), sent); // c1 still owned by a live session
    expect(sent).toEqual([['c1', 'running']]); // re-offered, not retired
    expect(outbox.size()).toBe(0);
  });

  it('a cleanly reconciled transition settles exactly once and does not loop', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'done');

    const sent = [];
    sweep(outbox, new Set(), sent); // reconcile publishes + settles
    expect(outbox.size()).toBe(0);

    // The capacity hook fires again on the next confirmed send; with the record settled it is inert.
    sweep(outbox, new Set(), sent);
    expect(sent).toEqual([['c1', 'done']]);
  });
});

describe('a failed REPLACEMENT never leaves the superseded state eligible for repair', () => {
  let dir;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-state-super-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops the predecessor rather than re-offering a state it knows is stale', () => {
    const file = join(dir, 'outbox.json');
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');
    expect(outbox.list().map((r) => r.state)).toEqual(['running']);

    // Make the next write fail by replacing the file with a directory of the same name.
    rmSync(file, { force: true });
    mkdtempSync(join(dir, 'x-'));
    require('fs').mkdirSync(file);

    expect(outbox.note('c1', 'waiting')).toBe(null);

    // The stale `running` must be gone. Left in place, the sweep would re-offer it behind the
    // `waiting` frame that was already published, regressing the row to running for good.
    expect(outbox.list()).toEqual([]);
    expect(selectEpochRepairs(outbox.list(), new Set(['c1']))).toEqual({ reoffer: [], retire: [] });
  });
});

describe('ABA: a conversation that resumes mid-retirement keeps its record', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-state-aba-'));
    file = join(dir, 'outbox.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not let a stale retirement settle the resumed incarnation', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');

    // The epoch sweep reads the record and selects it for retirement...
    const [selected] = selectEpochRepairs(outbox.list(), new Set()).retire;
    expect(selected.convoId).toBe('c1');

    // ...but before the publish is confirmed, the conversation resumes and re-enters `running`.
    // Same STATE as before, which is exactly what makes this an ABA: only the revision differs.
    const resumed = outbox.note('c1', 'running');

    // The stale retirement callback must not clear the resumed incarnation's record. If it did,
    // and the resumed session's next frame were evicted, the row would sit at `done` with nothing
    // left to repair it.
    expect(outbox.settle('c1', selected.token)).toBe(false);
    expect(outbox.size()).toBe(1);

    // The resumed record is still settleable on its own token.
    expect(outbox.settle('c1', resumed)).toBe(true);
    expect(outbox.size()).toBe(0);
  });
});

describe('durable-write failures do not falsely commit', () => {
  let dir;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-state-fail-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('note() reports failure and does NOT cache a record disk never received', () => {
    // An unwritable directory stands in for ENOSPC/EIO. If the cache committed anyway, the
    // session latch and the cache's own idempotency check would both suppress the retry, and a
    // restart would find nothing to repair from.
    const outbox = createRunStateOutbox({ file: join(dir, 'missing-dir', 'outbox.json'), log: silent });

    expect(outbox.note('c1', 'running')).toBe(null);
    expect(outbox.size()).toBe(0);
    // Not suppressed as a duplicate on the next attempt.
    expect(outbox.note('c1', 'running')).toBe(null);
  });
});

describe('instance isolation', () => {
  it('REFUSES to construct without an explicit path rather than sharing a default', () => {
    // A shared default is the failure mode itself: a second bridge reading the first's records
    // would not have those conversations in its own sessions map, so its epoch sweep would
    // classify the first bridge's LIVE convos as stranded and publish `done` against them.
    // Missing config must error, not silently fall back.
    expect(() => createRunStateOutbox({ log: silent })).toThrow(/instance-scoped/);
    expect(() => createRunStateOutbox({ file: '', log: silent })).toThrow(/instance-scoped/);
  });

  it('derives the default from the bridge directory, not the home directory', () => {
    const source = readFileSync(join(root, 'index.js'), 'utf-8');
    // Same shape as JOURNAL_CURSOR_FILE: env override, else a file in the bridge's own dir.
    expect(source).toContain('MATRON_RUN_STATE_OUTBOX_FILE');
    expect(source).toMatch(/path\.join\(__dirname, 'run-state-outbox\.json'\)/);
    expect(source).toContain('createRunStateOutbox({ file: RUN_STATE_OUTBOX_FILE');
  });
});

describe('planTransition (change-gate + write-ahead)', () => {
  // Drives the real sequences rather than grepping index.js for them.
  function run(steps) {
    let latch;
    const published = [];
    for (const [state, note] of steps) {
      const out = planTransition(latch, state, note);
      latch = out.latch;
      if (out.publish) published.push(state);
    }
    return { latch, published };
  }

  const ok = (token = { rev: 1 }) => () => token;
  const failed = () => null;
  const nothingToProtect = () => undefined;

  it('suppresses a repeat of the same state', () => {
    const { published } = run([['running', ok()], ['running', ok()]]);
    expect(published).toEqual(['running']);
  });

  it('publishes each genuine flip', () => {
    const { published } = run([['running', ok()], ['waiting', ok()], ['running', ok()]]);
    expect(published).toEqual(['running', 'waiting', 'running']);
  });

  it('a FAILED write-ahead does not gate off the inverse transition', () => {
    // The sequence that a naive rollback breaks: waiting -> (note fails) running -> the running
    // frame lands anyway -> the turn ends and must still be able to publish waiting. Restoring the
    // previous latch would swallow that, leaving the row at running: permanent "Thinking".
    const { published } = run([
      ['waiting', ok()],
      ['running', failed],
      ['waiting', ok()],
    ]);
    expect(published).toEqual(['waiting', 'running', 'waiting']);
  });

  it('a FAILED write-ahead also leaves an identical retry publishable', () => {
    const { published } = run([['running', failed], ['running', ok()]]);
    expect(published).toEqual(['running', 'running']);
  });

  it('reports no token for an unprotected transition', () => {
    expect(planTransition(undefined, 'running', failed)).toEqual({
      publish: true,
      latch: undefined,
      token: null,
    });
  });

  it('treats "nothing to protect" as a normal transition, NOT a failure', () => {
    // A session with no convo id yet buffers its payload rather than publishing, so there is
    // nothing to protect and nothing has failed. Invalidating here would make every transition on
    // such a session republish.
    const out = planTransition(undefined, 'running', nothingToProtect);
    expect(out).toEqual({ publish: true, latch: 'running', token: null });
    // ...and the latch then dedups as usual.
    expect(planTransition('running', 'running', nothingToProtect).publish).toBe(false);
  });
});

describe('index.js wiring', () => {
  // index.js starts a server at import time (main() + apiServer.listen at module top level), so
  // it cannot be imported for a behavioral test — the repo's established fallback is a
  // source-level invariant (see summary-latch-separation.test.js).
  const source = readFileSync(join(root, 'index.js'), 'utf-8');

  function sliceFunction(signature) {
    const start = source.indexOf(signature);
    if (start === -1) throw new Error(`could not find ${signature}`);
    const bodyOpen = /\)\s*\{/.exec(source.slice(start));
    const open = start + bodyOpen.index + bodyOpen[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated ${signature}`);
  }

  it('write-ahead records to the DURABLE outbox but does NOT settle eagerly on local send (loop #754)', () => {
    const body = sliceFunction('function journalSessionState(');
    expect(body).toContain('runStateOutbox.note(');
    expect(body).toContain('planTransition(');
    // Loop #754: the transition publish must NOT clear the durable record on the publisher's
    // local-send callback — that callback fires when the frame leaves the local socket, not when
    // the server commits it, so settling there strands a lost-after-send `done` forever. The
    // reconnect reconciliation sweep (republishSessionStates) is the sole settle authority.
    // The load-bearing signal is the absence of the settle CALL (comment prose is ignored by
    // checking for the call form, not the bare identifier).
    expect(body).not.toContain('runStateOutbox.settle(');
    expect(body).not.toContain('onLocalSendComplete:');
  });

  it('runs the run-state repair on every accepted reconnect', () => {
    expect(sliceFunction('function handleJournalReconnect(')).toContain('republishSessionStates()');
  });

  it('repairs through the NON-EVICTING path so it cannot drop the outage backlog', () => {
    const body = sliceFunction('function republishSessionStates(');
    expect(body).toContain('upsertConvoBestEffort');
    expect(body).toContain('retain: false');
    expect(body).not.toContain('journalUpsertConvo(');
  });

  it('retires stranded running convos that no live session owns', () => {
    const body = sliceFunction('function republishSessionStates(');
    expect(body).toContain('selectEpochRepairs(');
    // Retirement publishes `done` but settles against the RECORDED `running` — settling on the
    // published value would never match and would loop forever.
    expect(body).toContain("offer(convoId, token, 'done')");
    expect(body).toContain('onLocalSendComplete: () => runStateOutbox.settle(convoId, token)');
    // The live set is built from sessions, the same signal the subagent reconcile uses.
    expect(body).toContain('journalConvoIdFor(session)');
  });

  it('retries on returned send capacity, not only on another reconnect', () => {
    expect(source).toContain('retryRunStateRepairs()');
    const retry = sliceFunction('function retryRunStateRepairs(');
    expect(retry).toContain('runStateOutbox.size()');
    expect(retry).toContain('republishSessionStates()');
  });

  it('guards the sweep against synchronous re-entry from its own send', () => {
    expect(sliceFunction('function republishSessionStates(')).toContain('_runStateRepairRunning');
  });

  it('still repairs summaries and stranded subagents alongside it', () => {
    const body = sliceFunction('function handleJournalReconnect(');
    expect(body).toContain('republishSessionSummaries(');
    expect(body).toContain('reconcileStrandedSubagents(');
  });
});
