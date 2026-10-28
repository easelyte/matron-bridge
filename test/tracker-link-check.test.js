import { describe, expect, it, vi } from 'vitest';
import {
  findTrackerLinks,
  titleMatches,
  createTrackerLinkChecker,
  withTrackerLinkCheck,
  LINK_CHECK_FIELDS,
} from '../lib/tracker-link-check.js';

const BASE = 'https://chat.example/u/alice';
const link = (num, text = `#${num}`, base = BASE) => `[${text}](${base}/${num})`;

describe('findTrackerLinks', () => {
  it('finds https tracker links and splits the number and title out of the link text', () => {
    const text = `See ${link(41, '#41 Merge: release notes…')} and ${link(7, 'item #7 — Office move')}.`;
    expect(findTrackerLinks(text, { base: BASE })).toEqual([
      { raw: '[#41 Merge: release notes…](https://chat.example/u/alice/41)', user: 'alice', num: 41, textNum: 41, title: 'Merge: release notes…' },
      { raw: '[item #7 — Office move](https://chat.example/u/alice/7)', user: 'alice', num: 7, textNum: 7, title: 'Office move' },
    ]);
  });

  it('reads another user\'s link against that user', () => {
    const [l] = findTrackerLinks('[#3 Their task](https://chat.example/u/bob/3)', { base: BASE });
    expect(l).toMatchObject({ user: 'bob', num: 3, textNum: 3, title: 'Their task' });
  });

  it('reads the old matron://item, mission and project forms against the session\'s own user', () => {
    const found = findTrackerLinks('[#12 Fix it](matron://item/12) [#13 Plan](matron://mission/13) [#14 Launch](matron://project/14)', { base: BASE });
    expect(found.map(({ user, num, title }) => ({ user, num, title }))).toEqual([
      { user: 'alice', num: 12, title: 'Fix it' },
      { user: 'alice', num: 13, title: 'Plan' },
      { user: 'alice', num: 14, title: 'Launch' },
    ]);
  });

  it('keeps a bare #N link and a link with no number in its text', () => {
    const found = findTrackerLinks(`${link(4)} and [the merge question](${BASE}/5)`, { base: BASE });
    expect(found.map(({ num, textNum, title }) => ({ num, textNum, title }))).toEqual([
      { num: 4, textNum: 4, title: '' },
      { num: 5, textNum: null, title: 'the merge question' },
    ]);
  });

  it('reads link text that is the URL itself as a bare link', () => {
    const [l] = findTrackerLinks(`[${BASE}/7](${BASE}/7)`, { base: BASE });
    expect(l).toMatchObject({ num: 7, textNum: null, title: '' });
  });

  it('strips emphasis and quotes around the written title', () => {
    const [l] = findTrackerLinks(`[**#9** "Ship the thing"](${BASE}/9)`, { base: BASE });
    expect(l.title).toBe('Ship the thing');
  });

  it('ignores links to other hosts, conversations, images and non-numeric paths', () => {
    const text = [
      '[#1 x](https://github.com/acme/repo/pull/1)',
      '![#2 pic](https://chat.example/u/alice/2)',
      '[#3 x](https://chat.example/u/alice/3/extra)',
      '[#4 x](https://evil.example/u/alice/4)',
    ].join(' ');
    expect(findTrackerLinks(text, { base: BASE })).toEqual([]);
  });

  it('skips links written as code: an example of the link form is not a link', () => {
    const text = [
      'Write it as `[#12](https://chat.example/u/alice/12)` with a title.',
      '```',
      '[#13](https://chat.example/u/alice/13)',
      '```',
      '~~~md',
      '[#14](https://chat.example/u/alice/14)',
      '~~~',
      `But this one counts: ${link(15)}`,
    ].join('\n');
    expect(findTrackerLinks(text, { base: BASE }).map((l) => l.num)).toEqual([15]);
  });

  it('finds nothing in an empty or non-string text', () => {
    expect(findTrackerLinks('', { base: BASE })).toEqual([]);
    expect(findTrackerLinks(undefined, { base: BASE })).toEqual([]);
  });
});

describe('titleMatches', () => {
  it('accepts the title, a prefix of it, or an abbreviation with an ellipsis', () => {
    expect(titleMatches('Merge: release notes export', 'Merge: release notes export')).toBe(true);
    expect(titleMatches('Merge: release notes…', 'Merge: release notes export for the launch')).toBe(true);
    expect(titleMatches('merge release notes exp...', 'Merge: release notes export')).toBe(true);
  });

  it('accepts a paraphrase that keeps most of the title\'s words', () => {
    expect(titleMatches('office-move item', 'Office move to the new building: options')).toBe(true);
    expect(titleMatches('catch wrong #N item links', 'Matron: catch wrong #N item links — the bridge checks titles')).toBe(true);
  });

  it('ignores case, accents and punctuation', () => {
    expect(titleMatches('CAFÉ menu', 'Cafe menu update')).toBe(true);
  });

  it('refuses a title that belongs to something else', () => {
    expect(titleMatches('the new merge question', 'Office move to the new building: options')).toBe(false);
    expect(titleMatches('Release notes', 'Holiday rota for December')).toBe(false);
  });

  it('refuses link text that names no title at all', () => {
    expect(titleMatches('here', 'Merge: release notes export')).toBe(false);
    expect(titleMatches('', 'Merge: release notes export')).toBe(false);
  });
});

function fakeJournal(rows, { searchResults = [] } = {}) {
  const lookup = vi.fn(async (user, num) => {
    const row = rows[`${user}/${num}`];
    if (row === 'down') return { status: 0, data: { error: 'journal unreachable' } };
    if (!row) return { status: 404, data: { error: 'not_found' } };
    return { status: 200, data: { kind: row.kind, id: `id-${num}`, num, title: row.title, owner: { name: user } } };
  });
  const search = vi.fn(async () => ({ status: 200, data: { results: searchResults } }));
  return { lookup, search };
}

describe('createTrackerLinkChecker', () => {
  const rows = {
    'alice/41': { kind: 'item', title: 'Merge: release notes export' },
    'alice/42': { kind: 'item', title: 'Office move to the new building' },
    'alice/43': { kind: 'mission', title: 'Holiday rota' },
  };

  it('passes text whose links carry their targets\' titles', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    expect(await check([`Done: ${link(41, '#41 Merge: release notes…')}`, `on ${link(43, '#43 Holiday rota')}`])).toEqual({ ok: true });
  });

  it('passes text with no tracker links without asking the journal', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    expect(await check(['nothing to see', undefined, '[a PR](https://github.com/acme/x/pull/1)'])).toEqual({ ok: true });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a real number with the wrong title, naming both and the number the title belongs to', async () => {
    const { lookup, search } = fakeJournal(rows, {
      searchResults: [{ kind: 'item', num: 41, title: 'Merge: release notes export' }],
    });
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const r = await check([`The new one is ${link(42, '#42 Merge: release notes…')}`]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Nothing was posted');
    expect(r.error).toContain('#42 is the item "Office move to the new building"');
    expect(r.error).toContain('"Merge: release notes…" is #41 (item "Merge: release notes export")');
    expect(search).toHaveBeenCalledWith('Merge: release notes…');
  });

  it('refuses without a suggestion when the title matches nothing', async () => {
    const { lookup, search } = fakeJournal(rows, { searchResults: [{ kind: 'item', num: 43, title: 'Holiday rota' }] });
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const r = await check([link(42, '#42 Release notes')]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('#42 is the item "Office move to the new building"');
    expect(r.error).not.toContain('#43');
  });

  it('refuses a number that does not exist', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const r = await check([link(999, '#999 Something')]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('#999 does not exist');
  });

  it('refuses link text whose number differs from the link\'s', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const r = await check([`[#41 Merge: release notes](${BASE}/42)`]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('the text says #41 but the link goes to #42');
  });

  it('refuses a bare #N link without giving away its title', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const r = await check([`see ${link(42)}`]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('has no title');
    expect(r.error).toContain('[#42 <title>]');
    // Echoing the target's title would let a wrong number through by copying it.
    expect(r.error).not.toContain('Office move');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts unnumbered link text that matches the title, and refuses text that does not', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    expect(await check([`[the holiday rota](${BASE}/43)`])).toEqual({ ok: true });
    const r = await check([`[here](${BASE}/43)`]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('#43 is the mission "Holiday rota"');
  });

  it('lets the write through when the journal cannot be asked, or answers without a title', async () => {
    const { lookup, search } = fakeJournal({ 'alice/1': 'down', 'alice/2': { kind: 'item' } });
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    expect(await check([link(1, '#1 Anything'), link(2, '#2 Anything')])).toEqual({ ok: true });
  });

  it('skips matron://item links when the session\'s user is unknown', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => null });
    expect(await check(['[#29 Wrong title](matron://item/29)'])).toEqual({ ok: true });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('asks the journal once per distinct link, and caches answers', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    await check([`${link(41, '#41 Merge')} ${link(41, '#41 Merge release')}`]);
    await check([link(41, '#41 Merge')]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('asks again about a number it could not find: the record may have just been made', async () => {
    const rows2 = {};
    const { lookup, search } = fakeJournal(rows2);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    expect((await check([link(50, '#50 Fresh item')])).ok).toBe(false);
    rows2['alice/50'] = { kind: 'item', title: 'Fresh item' };
    expect(await check([link(50, '#50 Fresh item')])).toEqual({ ok: true });
  });

  it('checks every link, however many the text has', async () => {
    const many = {};
    for (let n = 1; n <= 60; n++) many[`alice/${n}`] = { kind: 'item', title: `Task number ${n}` };
    const { lookup, search } = fakeJournal(many);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const text = Array.from({ length: 60 }, (_, i) => link(i + 1, i === 59 ? '#60 Holiday rota' : `#${i + 1} Task number ${i + 1}`)).join(' ');
    const r = await check([text]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('#60 is the item "Task number 60"');
  });

  it('lists every bad link in one refusal', async () => {
    const { lookup, search } = fakeJournal(rows);
    const check = createTrackerLinkChecker({ lookup, search, base: () => BASE });
    const r = await check([`${link(42, '#42 Holiday rota')} ${link(43)}`]);
    expect(r.error).toContain('#42 is the item');
    expect(r.error).toContain('[#43 <title>]');
  });
});

describe('withTrackerLinkCheck', () => {
  it('refuses with 422 before the handler runs when a link is wrong', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const check = vi.fn(async () => ({ ok: false, error: 'bad link' }));
    const wrapped = withTrackerLinkCheck(check, handler, (d) => [d.title, d.body]);
    expect(await wrapped({ title: 't', body: 'b' })).toEqual({ status: 422, body: { error: 'bad link', code: 'tracker_link_mismatch' } });
    expect(check).toHaveBeenCalledWith(['t', 'b']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls the handler when the links are right', async () => {
    const handler = vi.fn(async () => ({ status: 201, body: { item: {} } }));
    const wrapped = withTrackerLinkCheck(async () => ({ ok: true }), handler, (d) => [d.body]);
    expect(await wrapped({ body: 'b' })).toEqual({ status: 201, body: { item: {} } });
  });

  it('lets the write through if the check itself throws', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const wrapped = withTrackerLinkCheck(async () => { throw new Error('boom'); }, handler, (d) => [d.body]);
    expect((await wrapped({ body: 'b' })).status).toBe(200);
  });
});

describe('LINK_CHECK_FIELDS', () => {
  it('covers every write an agent makes for the user to read', () => {
    expect(Object.keys(LINK_CHECK_FIELDS).sort()).toEqual([
      'agent-chat-send', 'agent-chat-start', 'briefing/publish',
      'items/close', 'items/comment', 'items/create', 'items/handover', 'items/reopen',
      'missions/close', 'missions/create', 'missions/post', 'missions/start', 'missions/status', 'missions/update',
      'sharing/shared_item_close', 'sharing/shared_item_comment', 'sharing/shared_item_create', 'sharing/shared_item_reopen',
      'sharing/shared_post', 'sharing/shared_status',
    ].sort());
    expect(LINK_CHECK_FIELDS['items/create']({ title: 'a', body: 'b', x: 'c' })).toEqual(['a', 'b']);
    expect(LINK_CHECK_FIELDS['agent-chat-send']({ message: 'm' })).toEqual(['m']);
  });
});
