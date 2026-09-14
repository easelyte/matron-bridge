import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import { selectEpochRepairs } from '../lib/session-state-repair.js';
import { createRunStateOutbox } from '../lib/run-state-outbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const silent = { warn() {}, log() {} };

describe('selectEpochRepairs', () => {
  it('re-offers the recorded state for a convo a live session owns', () => {
    const out = selectEpochRepairs([{ convoId: 'c1', state: 'running' }], new Set(['c1']));
    expect(out).toEqual({ reoffer: [{ convoId: 'c1', state: 'running' }], retire: [] });
  });

  it('RETIRES a stranded running convo with no live session — the permanent-Thinking case', () => {
    // Nothing owns the convo, so the process that was running it is gone and the row can never be
    // flipped by the session itself. Every client shows a "Thinking" that can never clear.
    const out = selectEpochRepairs([{ convoId: 'ghost', state: 'running' }], new Set());
    expect(out).toEqual({ reoffer: [], retire: ['ghost'] });
  });

  it('re-offers a TERMINAL state whose session is gone rather than retiring it', () => {
    // The session ended and its `done`/`waiting` frame never landed. Re-sending it is the repair;
    // retiring would be a no-op at best and could overwrite `waiting` with `done` at worst.
    const out = selectEpochRepairs(
      [{ convoId: 'a', state: 'done' }, { convoId: 'b', state: 'waiting' }],
      new Set(),
    );
    expect(out).toEqual({
      reoffer: [{ convoId: 'a', state: 'done' }, { convoId: 'b', state: 'waiting' }],
      retire: [],
    });
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
    expect(out.reoffer).toEqual([
      { convoId: 'live', state: 'running' },
      { convoId: 'ended', state: 'done' },
    ]);
    expect(out.retire).toEqual(['ghost']);
  });

  it('accepts a plain array of live ids and tolerates junk entries', () => {
    const out = selectEpochRepairs(
      [null, { convoId: '' }, { convoId: 'x' }, { convoId: 'y', state: 'running' }],
      ['y'],
    );
    expect(out).toEqual({ reoffer: [{ convoId: 'y', state: 'running' }], retire: [] });
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
    expect(afterRestart.list()).toEqual([{ convoId: 'c1', state: 'running' }]);
  });

  it('keeps only the LATEST state per convo', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');
    outbox.note('c1', 'done');
    expect(outbox.list()).toEqual([{ convoId: 'c1', state: 'done' }]);
  });

  it('settles only the state that was confirmed, so a newer transition survives', () => {
    // The in-flight 'running' frame confirms AFTER 'done' superseded it. Clearing on convo id
    // alone would erase the 'done' record and re-strand the row.
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');
    outbox.note('c1', 'done');

    expect(outbox.settle('c1', 'running')).toBe(false);
    expect(outbox.list()).toEqual([{ convoId: 'c1', state: 'done' }]);

    expect(outbox.settle('c1', 'done')).toBe(true);
    expect(outbox.list()).toEqual([]);
  });

  it('a settled entry stays gone across a restart', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'done');
    outbox.settle('c1', 'done');
    expect(createRunStateOutbox({ file, log: silent }).list()).toEqual([]);
  });

  it('ignores a missing convo id or state, and settling an unknown convo', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    expect(outbox.note('', 'done')).toBe(false);
    expect(outbox.note('c1', '')).toBe(false);
    expect(outbox.settle('nope', 'done')).toBe(false);
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
    expect(createRunStateOutbox({ file, log: silent }).list()).toEqual([{ convoId: 'c1', state: 'done' }]);
  });

  it('writes atomically, leaving no tmp files behind', () => {
    const outbox = createRunStateOutbox({ file, log: silent });
    outbox.note('c1', 'running');
    outbox.settle('c1', 'running');
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
    const offer = (convoId, recorded, publish = recorded) => {
      sent.push([convoId, publish]);
      outbox.settle(convoId, recorded); // stands in for the publisher's onDelivered
    };
    for (const { convoId, state } of reoffer) offer(convoId, state);
    for (const convoId of retire) offer(convoId, 'running', 'done');
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

describe('durable-write failures do not falsely commit', () => {
  let dir;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-state-fail-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('note() reports failure and does NOT cache a record disk never received', () => {
    // An unwritable directory stands in for ENOSPC/EIO. If the cache committed anyway, the
    // session latch and the cache's own idempotency check would both suppress the retry, and a
    // restart would find nothing to repair from.
    const outbox = createRunStateOutbox({ file: join(dir, 'missing-dir', 'outbox.json'), log: silent });

    expect(outbox.note('c1', 'running')).toBe(false);
    expect(outbox.size()).toBe(0);
    // Not suppressed as a duplicate on the next attempt.
    expect(outbox.note('c1', 'running')).toBe(false);
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

describe('a failed write-ahead leaves the transition retryable', () => {
  it('rolls the session latch back so an identical retry is not suppressed', () => {
    const source = readFileSync(join(root, 'index.js'), 'utf-8');
    const start = source.indexOf('function journalSessionState(');
    const body = source.slice(start, source.indexOf('\n}', start));
    // Without the rollback, a failed note() leaves _journalState advanced on an unprotected
    // transition: no durable record, and the change-gate swallows every retry, so the row stays
    // stale forever.
    expect(body).toContain('const previous = session._journalState;');
    expect(body).toContain('!runStateOutbox.note(convoId, state)');
    expect(body).toContain('session._journalState = previous;');
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

  it('records to the DURABLE outbox and settles on delivery, not on enqueue', () => {
    const body = sliceFunction('function journalSessionState(');
    expect(body).toContain('runStateOutbox.note(');
    expect(body).toContain('onDelivered');
    expect(body).toContain('runStateOutbox.settle(');
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
    expect(body).toContain("offer(convoId, 'running', 'done')");
    expect(body).toContain('onDelivered: () => runStateOutbox.settle(convoId, recorded)');
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
