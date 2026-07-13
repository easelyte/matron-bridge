import { describe, it, expect, vi } from 'vitest';
import { makeMembershipGate } from '../lib/limits.js';

describe('membershipGate', () => {
  const allowed = ['@op:s'];
  const bot = '@bot:s';

  const encryptedState = async (_roomId, type) => {
    if (type === 'm.room.encryption') return { algorithm: 'm.megolm.v1.aes-sha2' };
    throw new Error('not found');
  };

  const historyState = (history_visibility) => async (_roomId, type) => {
    if (type === 'm.room.encryption') throw new Error('not found');
    if (type === 'm.room.history_visibility') return { history_visibility };
    throw new Error('not found');
  };

  it('passes a DM of only allowed + bot when encrypted', async () => {
    const client = {
      getJoinedRoomMembers: async () => ['@op:s', '@bot:s'],
      getRoomStateEvent: encryptedState,
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(true);
  });

  it('passes when history visibility is joined', async () => {
    const client = {
      getJoinedRoomMembers: async () => ['@op:s', '@bot:s'],
      getRoomStateEvent: historyState('joined'),
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(true);
  });

  it.each(['invited', 'shared', 'world_readable'])('rejects when history visibility is %s', async (visibility) => {
    const client = {
      getJoinedRoomMembers: async () => ['@op:s', '@bot:s'],
      getRoomStateEvent: historyState(visibility),
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
  });

  it('fails closed when room state lookups do not confirm a safe room', async () => {
    const client = {
      getJoinedRoomMembers: async () => ['@op:s', '@bot:s'],
      getRoomStateEvent: async () => { throw new Error('boom'); },
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
  });

  it('rejects a room with an unauthorized member', async () => {
    const client = {
      getJoinedRoomMembers: async () => ['@op:s', '@x:s', '@bot:s'],
      getRoomStateEvent: vi.fn(encryptedState),
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
    expect(client.getRoomStateEvent).not.toHaveBeenCalled();
  });

  it('fails closed on lookup error', async () => {
    const client = {
      getJoinedRoomMembers: async () => { throw new Error('boom'); },
      getRoomStateEvent: vi.fn(encryptedState),
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
    expect(client.getRoomStateEvent).not.toHaveBeenCalled();
  });

  it('empty allow-list fails CLOSED by default (no opt-in)', async () => {
    const client = { getJoinedRoomMembers: vi.fn() };
    const gate = makeMembershipGate({ client, allowedIds: [], botUserId: bot });
    expect(await gate('!r:s')).toBe(false);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it('empty allow-list + allowAny opt-in still rejects an unsafe room', async () => {
    const client = {
      getJoinedRoomMembers: vi.fn(),
      getRoomStateEvent: historyState('world_readable'),
    };
    const gate = makeMembershipGate({ client, allowedIds: [], botUserId: bot, allowAny: true });
    expect(await gate('!r:s')).toBe(false);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it('empty allow-list + allowAny opt-in passes a safe room', async () => {
    const client = {
      getJoinedRoomMembers: vi.fn(),
      getRoomStateEvent: historyState('joined'),
    };
    const gate = makeMembershipGate({ client, allowedIds: [], botUserId: bot, allowAny: true });
    expect(await gate('!r:s')).toBe(true);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it('re-validates fresh every call (no stale cache)', async () => {
    let members = ['@op:s', '@bot:s'];
    const client = {
      getJoinedRoomMembers: async () => members,
      getRoomStateEvent: historyState('joined'),
    };
    const gate = makeMembershipGate({ client, allowedIds: allowed, botUserId: bot });
    expect(await gate('!r:s')).toBe(true);
    members = ['@op:s', '@x:s', '@bot:s'];
    expect(await gate('!r:s')).toBe(false);
  });
});
