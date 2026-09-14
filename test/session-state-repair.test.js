import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { notePendingState, settlePendingState, repairPendingStates } from '../lib/session-state-repair.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

describe('pending run-state tracking', () => {
  it('keeps only the LATEST state per convo — re-offering a superseded one moves the row backwards', () => {
    const pending = new Map();
    notePendingState(pending, 'c1', 'running');
    notePendingState(pending, 'c1', 'done');
    expect([...pending.entries()]).toEqual([['c1', 'done']]);
  });

  it('ignores a missing convo id or an absent state', () => {
    const pending = new Map();
    expect(notePendingState(pending, '', 'done')).toBe(false);
    expect(notePendingState(pending, 'c1', undefined)).toBe(false);
    expect(notePendingState(pending, 'c1', null)).toBe(false);
    expect(pending.size).toBe(0);
  });

  it("settles only the state that was confirmed, so a newer pending transition survives", () => {
    // The in-flight 'running' frame confirms AFTER 'done' superseded it. Clearing on convo id
    // alone would erase the 'done' record and strand the row at running — the original bug.
    const pending = new Map();
    notePendingState(pending, 'c1', 'running');
    notePendingState(pending, 'c1', 'done');

    expect(settlePendingState(pending, 'c1', 'running')).toBe(false);
    expect(pending.get('c1')).toBe('done');

    expect(settlePendingState(pending, 'c1', 'done')).toBe(true);
    expect(pending.has('c1')).toBe(false);
  });

  it('settling an unknown convo is a no-op', () => {
    const pending = new Map();
    expect(settlePendingState(pending, 'nope', 'done')).toBe(false);
  });
});

describe('repairPendingStates', () => {
  it('re-offers every unconfirmed transition on a new epoch', () => {
    const pending = new Map([
      ['c1', 'done'],
      ['c2', 'running'],
    ]);
    const offers = [];

    expect(repairPendingStates(pending, (id, state) => offers.push([id, state]))).toEqual({
      offered: 2,
      refused: 0,
    });
    expect(offers).toEqual([
      ['c1', 'done'],
      ['c2', 'running'],
    ]);
  });

  it('RETAINS a refused offer for the next epoch instead of dropping it', () => {
    // A full queue refuses the non-evicting best-effort send. Dropping the record there would
    // reintroduce the very bug: an unconfirmed terminal state with nothing left to retry from.
    const pending = new Map([['c1', 'done']]);

    expect(repairPendingStates(pending, () => false)).toEqual({ offered: 0, refused: 1 });
    expect(pending.get('c1')).toBe('done');
  });

  it('survives a publisher that settles synchronously mid-iteration', () => {
    // An injected transport can confirm inside the publish call, mutating the map we are
    // iterating. Without the snapshot, the second entry would be skipped.
    const pending = new Map([
      ['c1', 'done'],
      ['c2', 'done'],
    ]);
    const offers = [];

    const result = repairPendingStates(pending, (id, state) => {
      offers.push(id);
      settlePendingState(pending, id, state);
    });

    expect(result).toEqual({ offered: 2, refused: 0 });
    expect(offers).toEqual(['c1', 'c2']);
    expect(pending.size).toBe(0);
  });

  it('is inert with nothing pending or no publisher', () => {
    expect(repairPendingStates(new Map(), () => true)).toEqual({ offered: 0, refused: 0 });
    expect(repairPendingStates(null, () => true)).toEqual({ offered: 0, refused: 0 });
    expect(repairPendingStates(new Map([['c', 'done']]), null)).toEqual({ offered: 0, refused: 0 });
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

  it('records the pending state and settles it on delivery, not on enqueue', () => {
    const body = sliceFunction('function journalSessionState(');
    expect(body).toContain('notePendingState(pendingRunStates');
    expect(body).toContain('onDelivered');
    expect(body).toContain('settlePendingState(pendingRunStates');
  });

  it('runs the run-state repair on every accepted reconnect', () => {
    expect(sliceFunction('function handleJournalReconnect(')).toContain('republishSessionStates()');
  });

  it('repairs through the NON-EVICTING path so it cannot drop the outage backlog', () => {
    const body = sliceFunction('function republishSessionStates(');
    expect(body).toContain('upsertConvoBestEffort');
    expect(body).toContain('retain: false');
    // The ordinary evicting enqueue must not be reachable from the repair.
    expect(body).not.toContain('journalUpsertConvo(');
  });

  it('retries on returned send capacity, not only on another reconnect', () => {
    // hello_ok fires onReconnect BEFORE the backlog pumps, so a connection that comes back with
    // a full queue refuses every re-offer. Without a capacity-triggered retry, a healthy socket
    // that never disconnects again would leave those rows stranded forever.
    expect(source).toContain('retryRunStateRepairs()');
    const retry = sliceFunction('function retryRunStateRepairs(');
    expect(retry).toContain('pendingRunStates.size');
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
