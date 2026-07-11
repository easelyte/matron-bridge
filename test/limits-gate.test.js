import { describe, it, expect, vi } from 'vitest';
import { makeMembershipGate } from '../lib/limits.js';

describe('membershipGate', () => {
  const allowed = ['@op:s'];
  const bot = '@bot:s';

  it('passes a DM of only allowed + bot', async () => {
    const client = { getJoinedRoomMembers: async () => ['@op:s', '@bot:s'] };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(true);
  });

  it('rejects a room with an unauthorized member', async () => {
    const client = { getJoinedRoomMembers: async () => ['@op:s', '@x:s', '@bot:s'] };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
  });

  it('fails closed on lookup error', async () => {
    const client = { getJoinedRoomMembers: async () => { throw new Error('boom'); } };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
  });

  it('empty allow-list fails CLOSED by default (no opt-in)', async () => {
    const client = { getJoinedRoomMembers: vi.fn() };
    const gate = makeMembershipGate({ client, allowedIds: [], botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it('empty allow-list + allowAny opt-in => allow-any', async () => {
    const client = { getJoinedRoomMembers: vi.fn() };
    const gate = makeMembershipGate({ client, allowedIds: [], botUserId: bot, allowAny: true });
    expect(await gate('!r:s')).toBe(true);
  });

  it('re-validates fresh every call (no stale cache)', async () => {
    let members = ['@op:s', '@bot:s'];
    const client = { getJoinedRoomMembers: async () => members };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(true);
    members = ['@op:s', '@x:s', '@bot:s'];
    expect(await gate('!r:s')).toBe(false);
  });
});
