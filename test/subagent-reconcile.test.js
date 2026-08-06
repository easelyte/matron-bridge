import { describe, it, expect } from 'vitest';
import { selectStrandedChildren } from '../lib/subagent-reconcile.js';

// Records mirror what subagent-running-store writes: childConvoId is the
// canonical `${parentConvoId}:sub:${agentId}` (see childConvoId in
// lib/subagent-convos.js), so provenance is self-consistent.
describe('selectStrandedChildren', () => {
  it('returns empty stranded/malformed for no entries', () => {
    expect(selectStrandedChildren([], new Set())).toEqual({ stranded: [], malformed: [] });
    expect(selectStrandedChildren(undefined, new Set())).toEqual({ stranded: [], malformed: [] });
  });

  it('marks a running child whose parent is NOT live as stranded (terminal parent)', () => {
    const entries = [{ childConvoId: 'pDead:sub:a1', parentConvoId: 'pDead', agentId: 'a1' }];
    // No live parents (bridge startup: sessions map empty) → child is a ghost.
    expect(selectStrandedChildren(entries, new Set())).toEqual({ stranded: ['pDead:sub:a1'], malformed: [] });
  });

  it('LEAVES a running child whose parent IS live (coordinator still running)', () => {
    const entries = [{ childConvoId: 'pLive:sub:a1', parentConvoId: 'pLive', agentId: 'a1' }];
    expect(selectStrandedChildren(entries, new Set(['pLive']))).toEqual({ stranded: [], malformed: [] });
  });

  it('reconciles only the orphaned children in a mixed set', () => {
    const entries = [
      { childConvoId: 'pLive:sub:a1', parentConvoId: 'pLive', agentId: 'a1' },   // parent live → keep
      { childConvoId: 'pDead:sub:b2', parentConvoId: 'pDead', agentId: 'b2' },   // parent gone → strand
      { childConvoId: 'pLive:sub:c3', parentConvoId: 'pLive', agentId: 'c3' },   // parent live → keep
      { childConvoId: 'pGone:sub:d4', parentConvoId: 'pGone', agentId: 'd4' },   // parent gone → strand
    ];
    const { stranded, malformed } = selectStrandedChildren(entries, new Set(['pLive']));
    expect(stranded.sort()).toEqual(['pDead:sub:b2', 'pGone:sub:d4']);
    expect(malformed).toEqual([]);
  });

  it('accepts an array of live parent ids as well as a Set', () => {
    const entries = [{ childConvoId: 'pLive:sub:a1', parentConvoId: 'pLive', agentId: 'a1' }];
    expect(selectStrandedChildren(entries, ['pLive'])).toEqual({ stranded: [], malformed: [] });
  });

  it('FAIL-CLOSED: a record with no parentConvoId is malformed, NOT stranded (never mark done)', () => {
    const entries = [{ childConvoId: 'x:sub:a1', parentConvoId: null, agentId: 'a1' }];
    const { stranded, malformed } = selectStrandedChildren(entries, new Set(['pLive']));
    expect(stranded).toEqual([]);              // must NOT be terminally mutated
    expect(malformed).toEqual(['x:sub:a1']);   // surfaced for the caller to log/quarantine
  });

  it('FAIL-CLOSED: a record with no agentId is malformed (can\'t validate provenance)', () => {
    const entries = [{ childConvoId: 'p1:sub:a1', parentConvoId: 'p1' }];
    expect(selectStrandedChildren(entries, new Set())).toEqual({ stranded: [], malformed: ['p1:sub:a1'] });
  });

  it('FAIL-CLOSED: childConvoId that does NOT match derive(parentConvoId, agentId) is malformed (F3)', () => {
    // childConvoId encodes parent "pLive" but the parentConvoId field says
    // "pDead". With pDead absent, a naive check would strand (and kill) the
    // actually-live pLive child. Self-consistency validation catches it.
    const entries = [{ childConvoId: 'pLive:sub:a1', parentConvoId: 'pDead', agentId: 'a1' }];
    const { stranded, malformed } = selectStrandedChildren(entries, new Set(['pLive']));
    expect(stranded).toEqual([]);
    expect(malformed).toEqual(['pLive:sub:a1']);
  });

  it('treats an empty-string parentConvoId as malformed too', () => {
    const entries = [{ childConvoId: 'x:sub:a1', parentConvoId: '', agentId: 'a1' }];
    expect(selectStrandedChildren(entries, new Set())).toEqual({ stranded: [], malformed: ['x:sub:a1'] });
  });

  it('skips entries without a childConvoId entirely, keeps consistent ones', () => {
    const entries = [
      { parentConvoId: 'pDead' },
      { childConvoId: '', parentConvoId: 'pDead' },
      null,
      { childConvoId: 'ok:sub:a1', parentConvoId: 'ok', agentId: 'a1' },
    ];
    expect(selectStrandedChildren(entries, new Set())).toEqual({ stranded: ['ok:sub:a1'], malformed: [] });
  });
});
