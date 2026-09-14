import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { repairSessionStates } from '../lib/session-state-repair.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

describe('repairSessionStates', () => {
  it('clears the latch BEFORE re-offering, so the change-gate cannot swallow the repair', () => {
    // The production publisher is journalSessionState, whose first line is
    // `if (session._journalState === state) return;`. Model it exactly: if the repair left the
    // latch in place, this stand-in would return early and publish nothing.
    const published = [];
    const journalSessionState = (session, state) => {
      if (session._journalState === state) return;
      session._journalState = state;
      published.push([session.id, state]);
    };

    const sessions = [{ id: 'a', _journalState: 'running' }];
    expect(repairSessionStates(sessions, journalSessionState)).toBe(1);
    expect(published).toEqual([['a', 'running']]);
    // The latch is re-armed by the publish, so the state is still deduped afterwards.
    expect(sessions[0]._journalState).toBe('running');
  });

  it('re-offers every live session, not just the first', () => {
    const published = [];
    const sessions = [
      { id: 'a', _journalState: 'running' },
      { id: 'b', _journalState: 'waiting' },
      { id: 'c', _journalState: 'done' },
    ];

    expect(repairSessionStates(sessions, (s, state) => published.push([s.id, state]))).toBe(3);
    expect(published).toEqual([
      ['a', 'running'],
      ['b', 'waiting'],
      ['c', 'done'],
    ]);
  });

  it('skips sessions that never latched a state — an eviction could not have swallowed one', () => {
    const published = [];
    const sessions = [{ id: 'a' }, { id: 'b', _journalState: undefined }, { id: 'c', _journalState: null }];

    expect(repairSessionStates(sessions, (s, state) => published.push([s.id, state]))).toBe(0);
    expect(published).toEqual([]);
  });

  it('tolerates a null entry and an absent iterable', () => {
    expect(repairSessionStates([null, undefined], () => { throw new Error('must not publish'); })).toBe(0);
    expect(repairSessionStates(undefined, () => { throw new Error('must not publish'); })).toBe(0);
  });

  it('re-offers `running` — the state whose loss is the user-visible stuck-Thinking bug', () => {
    // Regression anchor for #575. The evicted frame is the terminal transition, so after the
    // eviction the bridge believes it published a state the journal never recorded. The repair
    // must re-offer whatever the CURRENT state is, including a still-running one, because the
    // durable row may be stale in either direction.
    const published = [];
    repairSessionStates([{ id: 'live', _journalState: 'running' }], (s, state) => published.push(state));
    expect(published).toEqual(['running']);
  });
});

describe('handleJournalReconnect wiring', () => {
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

  it('runs the run-state repair on every accepted reconnect', () => {
    expect(sliceFunction('function handleJournalReconnect(')).toContain('republishSessionStates()');
  });

  it('routes the repair through the pure module rather than re-implementing the loop', () => {
    expect(sliceFunction('function republishSessionStates(')).toContain('repairSessionStates(');
  });

  it('still repairs summaries alongside it — the two latches are independent', () => {
    const body = sliceFunction('function handleJournalReconnect(');
    expect(body).toContain('republishSessionSummaries(');
    expect(body).toContain('reconcileStrandedSubagents(');
  });
});
