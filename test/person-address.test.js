import { describe, it, expect, vi } from 'vitest';
import { personRef, isAddress, PERSON_MAX } from '../lib/person-ref.js';
import { createSharingHandlers } from '../lib/sharing-tools.js';
import { createSharingClient } from '../lib/sharing-client.js';
import { formatContactAddAck, formatSharingError, contactLine } from '../lib/sharing-format.js';
import { foreignTurnBanner, personLabel } from '../lib/foreign-turn.js';

// People on other Matron journals (journal federation): an address
// name@host wherever the tools take a person, and contact_add remote: true
// for the invite link the user makes.
const ok = (data) => ({ status: 200, data });

function fixture(client = {}) {
  const sessions = new Map([['!r:s', { roomId: '!r:s', journalConvoId: 'c-1' }]]);
  const c = {
    contactAdd: vi.fn(async () => ({ status: 202, data: { pending: 'owner' } })),
    inviteAsk: vi.fn(async () => ({ status: 202, data: { ask: { id: 'ia_1', state: 'awaiting_user' }, pending: 'user' } })),
    share: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'not_contact' } })),
    lookup: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })),
    mission: vi.fn(async () => ok({ mission: {} })),
    ...client,
  };
  const h = createSharingHandlers({ sessions, journalConvoIdFor: (s) => s.journalConvoId, client: c, resolveMission: async () => ({ id: 'ms_1' }) });
  return { h, client: c };
}

describe('personRef', () => {
  it('takes a name on this journal or an address on another, host lower-cased', () => {
    expect(personRef(' bob ')).toBe('bob');
    expect(personRef('bob@B.Example')).toBe('bob@b.example');
    expect(personRef('bob.s@b.example:8443')).toBe('bob.s@b.example:8443');
    for (const bad of ['', '-bob', 'bob@', '@b.example', 'bob@b_x.example', 'bob@b.example:', 'a@b@c.example', 'bob smith', `bob@${'a'.repeat(254)}`, null, 7]) {
      expect(personRef(bad), String(bad)).toBeNull();
    }
    const longest = `${'b'.repeat(64)}@${`${'a'.repeat(63)}.`.repeat(3)}${'a'.repeat(61)}:65535`;
    expect(personRef(longest)).toBe(longest);
    expect(longest.length).toBe(PERSON_MAX);
    expect(isAddress('bob@b.example')).toBe(true);
    expect(isAddress('bob')).toBe(false);
  });
});

describe('contact_add remote: true', () => {
  it('asks for an invite link from this conversation, and is told the link never comes back', async () => {
    const { h, client } = fixture();
    const r = await h.contact_add({ roomId: '!r:s', remote: true });
    expect(r.status).toBe(202);
    expect(client.inviteAsk).toHaveBeenCalledWith({ convo_id: 'c-1' });
    expect(client.contactAdd).not.toHaveBeenCalled();
    const text = formatContactAddAck(r.body);
    expect(text).toMatch(/make an invite link/);
    expect(text).toMatch(/never see it/);
  });

  it('refuses a name with it, an address without it, and a remote that is not true', async () => {
    const { h, client } = fixture();
    expect((await h.contact_add({ roomId: '!r:s', remote: true, user: 'bob' })).status).toBe(400);
    const byAddress = await h.contact_add({ roomId: '!r:s', user: 'bob@b.example' });
    expect(byAddress.status).toBe(400);
    expect(byAddress.body.error).toMatch(/remote: true/);
    expect((await h.contact_add({ roomId: '!r:s', remote: 'yes', user: 'bob' })).status).toBe(400);
    expect(client.inviteAsk).not.toHaveBeenCalled();
    expect(client.contactAdd).not.toHaveBeenCalled();
    expect((await h.contact_add({ roomId: '!r:s', remote: false, user: 'bob' })).status).toBe(202);
  });

  it('says an ask already waiting is the same ask, and a journal with federation off plainly', async () => {
    const waiting = fixture({ inviteAsk: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'pending' } })) });
    const r = await waiting.h.contact_add({ roomId: '!r:s', remote: true });
    expect(r.body.blocked_by).toBe('invite_pending');
    expect(formatSharingError('contact_add', r.body)).toMatch(/already waiting for your user's tap/);
    expect(formatSharingError('contact_add', { error: 'conflict', blocked_by: 'federation_off' })).toMatch(/federation is off/);
  });

  it('hits POST /contacts/invites', async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => { calls.push([init.method, url, init.body]); return new Response('{}', { status: 202 }); });
    await createSharingClient({ baseUrl: 'https://j.example', token: 't', fetchImpl: fetch }).inviteAsk({ convo_id: 'c-1' });
    expect(calls).toEqual([['POST', 'https://j.example/contacts/invites', JSON.stringify({ convo_id: 'c-1' })]]);
  });
});

describe('an address where a person goes', () => {
  it('mission_share passes the address, and a not_contact refusal says both things it can mean', async () => {
    const { h, client } = fixture();
    const r = await h.share({ roomId: '!r:s', contact: 'bob@b.example' });
    expect(client.share).toHaveBeenCalledWith('ms_1', expect.objectContaining({ contact: 'bob@b.example' }));
    expect(r.body.blocked_by).toBe('across_journals');
    expect(formatSharingError('share', r.body)).toMatch(/either they are not a contact .* or this journal does not share across journals yet/);
    // A contact on this journal still hears the usual answer.
    expect((await h.share({ roomId: '!r:s', contact: 'tim' })).body.blocked_by).toBe('not_contact');
    // A missing mission is still that, address or not.
    const gone = fixture({ share: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await gone.h.share({ roomId: '!r:s', contact: 'bob@b.example', mission: 9 })).body.error).toBe('not_found');
  });

  it('shared_by takes an address, its host lower-cased; nothing found says where a shared mission shows up', async () => {
    const { h, client } = fixture();
    const r = await h.shared_get({ roomId: '!r:s', shared_by: 'Bob@B.Example', num: 3 });
    expect(client.lookup).toHaveBeenCalledWith('Bob@b.example', 3);
    expect([r.status, r.body.error, r.body.across_journals]).toEqual([404, 'not_found', true]);
    expect(formatSharingError('shared_get', r.body)).toMatch(/shows there once their journal has sent it/);
    expect((await h.shared_get({ roomId: '!r:s', shared_by: 'bob@', num: 3 })).status).toBe(400);
    const post = await h.shared_post({ roomId: '!r:s', shared_by: 'bob@b.example', mission: 3, kind: 'progress', title: 'x' });
    expect(formatSharingError('shared_post', post.body)).toMatch(/no mission or item with that number/);
    // A journal that cannot read across journals rejects the address.
    const old = fixture({ lookup: vi.fn(async () => ({ status: 400, data: { error: 'bad_request' } })) });
    const o = await old.h.shared_get({ roomId: '!r:s', shared_by: 'bob@b.example', num: 3 });
    expect(o.body.blocked_by).toBe('reading_across');
    expect(formatSharingError('shared_get', o.body)).toMatch(/cannot read what people on other journals share yet/);
    expect((await h.shared_get({ roomId: '!r:s', shared_by: 'tim', num: 3 })).body.error).toBe('not_found');
  });

  it('the foreign-turn banner and room labels name the whole address', () => {
    const banner = foreignTurnBanner({ person: 'bob@b.example', roomId: '!room:s' });
    expect(banner).toMatch(/started by bob@b\.example, another person, on another Matron journal — not by your user/);
    expect(foreignTurnBanner({ person: 'bob', roomId: '!room:s' })).toMatch(/started by bob, another person — not by your user/);
    expect(personLabel('bob@b.example', 'agent')).toBe("bob@b.example's agent (another person)");
  });

  it('contact lines keep a long address whole, so it can be passed back', () => {
    const long = `${'b'.repeat(64)}@${'a'.repeat(60)}.example`;
    expect(contactLine({ id: 'ct_1', address: long, state: 'active' })).toContain(long);
  });
});
