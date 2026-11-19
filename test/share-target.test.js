import { describe, it, expect } from 'vitest';
import { resolveShareTarget } from '../lib/share-target.js';

// /share-sensitive posts its courtesy notification into whatever roomId the
// caller passes. A stale or mistyped roomId used to be accepted silently and
// the notification landed in another chat (or nowhere). The share target must
// resolve to a live session, and the resolution must describe that session so
// the caller can see which chat was notified.
describe('resolveShareTarget', () => {
  const session = (over = {}) => ({
    alive: true,
    _journalTitleHint: 'ABC:3a Template cleanup',
    claudeSessionId: '3a000000-1111-4222-8333-444444444444',
    workdir: '/Users/developer/Dev/acme-infra',
    sendCallback: () => {},
    ...over,
  });

  it('rejects a roomId with no session at all', () => {
    const out = resolveShareTarget(new Map(), 'deadbeef-0000-0000-0000-000000000000');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no live session/i);
    expect(out.error).toContain('deadbeef');
  });

  it('rejects a roomId whose session is dead', () => {
    const sessions = new Map([['room-1', session({ alive: false })]]);
    const out = resolveShareTarget(sessions, 'room-1');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no live session/i);
  });

  it('lists live sessions in the rejection so the caller can self-correct', () => {
    const sessions = new Map([
      ['aaaa1111-0000-0000-0000-000000000000', session()],
      ['bbbb2222-0000-0000-0000-000000000000', session({ _journalTitleHint: 'store-1 onboarding' })],
    ]);
    const out = resolveShareTarget(sessions, 'cccc3333-0000-0000-0000-000000000000');
    expect(out.ok).toBe(false);
    expect(out.error).toContain('aaaa1111');
    expect(out.error).toContain('store-1 onboarding');
  });

  it('accepts a live session and describes it by title and room', () => {
    const sessions = new Map([['7a000000-2222-4333-8444-555555555555', session()]]);
    const out = resolveShareTarget(sessions, '7a000000-2222-4333-8444-555555555555');
    expect(out.ok).toBe(true);
    expect(out.description).toContain('ABC:3a Template cleanup');
    expect(out.description).toContain('7a000000');
  });

  it('falls back to the workdir when the session has no title yet', () => {
    const sessions = new Map([['room-1', session({ _journalTitleHint: undefined })]]);
    const out = resolveShareTarget(sessions, 'room-1');
    expect(out.ok).toBe(true);
    expect(out.description).toContain('acme-infra');
  });

  // Sessions are constructed with sendCallback null and get it
  // attached afterwards, so "alive" alone did not mean "can be told". The
  // caller reported `notified: <that room>` regardless, and the MCP tool
  // passed that on to the agent — which then believed the user had the link.
  it('rejects a live session that has no send channel attached yet', () => {
    const sessions = new Map([['room-1', session({ sendCallback: null })]]);
    const out = resolveShareTarget(sessions, 'room-1');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no send channel/i);
  });

  it('omits unreachable sessions from the list of alternatives it suggests', () => {
    const sessions = new Map([
      ['aaaa1111-0000-0000-0000-000000000000', session()],
      ['bbbb2222-0000-0000-0000-000000000000', session({ _journalTitleHint: 'not wired up', sendCallback: null })],
    ]);
    const out = resolveShareTarget(sessions, 'cccc3333-0000-0000-0000-000000000000');
    expect(out.ok).toBe(false);
    expect(out.error).toContain('aaaa1111');
    expect(out.error).not.toContain('not wired up');
  });

  // The caller sends through this object rather than re-reading the map, so
  // what was vetted and what gets messaged cannot drift apart.
  it('returns the vetted session itself so the caller need not look it up again', () => {
    const live = session();
    const sessions = new Map([['room-1', live]]);
    expect(resolveShareTarget(sessions, 'room-1').session).toBe(live);
  });
});
