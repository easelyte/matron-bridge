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
    expect(body).toContain("offer(convoId, 'done')");
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
