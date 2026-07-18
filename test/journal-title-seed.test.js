import { describe, it, expect, vi } from 'vitest';
import { seedJournalTitle, applyFallbackTitle } from '../lib/journal-title-seed.js';

describe('seedJournalTitle (workdir-sourced)', () => {
  it('titles the convo from the workdir basename when no hint is set', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, { workdir: '/home/dan/yearbook-app', upsertConvo, warn: () => {} });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('yearbook-app') });
  });

  it('does not overwrite an existing title hint', async () => {
    const session = { _journalTitleHint: 'kept' };
    const upsertConvo = vi.fn();
    await seedJournalTitle(session, { workdir: '/tmp/x', upsertConvo, warn: () => {} });
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  // Restart/resume: the good Gemini title lived on the OLD session object and
  // is handed in as incomingHint. The fresh session must adopt it BEFORE any
  // publish — otherwise the workdir seed publishes the bare repo name and the
  // journal's COALESCE upsert clobbers the good title on the server (the
  // title-revert bug). Adopting silently (no upsert) is the fix: the title
  // already exists server-side, so there is nothing to publish.
  it('adopts an incoming hint onto a fresh session without publishing', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      incomingHint: 'mac:a1b2 Fix the photo upload race',
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
    expect(session._journalTitleHint).toBe('mac:a1b2 Fix the photo upload race');
  });

  it('never seeds the workdir name when reattaching to an existing convo', async () => {
    // Reattach paths (/restart, /model, /mode, resume-after-bridge-restart)
    // pass journalConvoId. The convo already exists server-side with whatever
    // title it earned; even with no in-memory hint, seeding the repo basename
    // here would clobber that title via COALESCE. Only a brand-new convo seeds.
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      reattaching: true,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it('still seeds the workdir name for a brand-new convo (not reattaching)', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      reattaching: false,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('yearbook-app') });
  });

  it('an empty-string incoming hint is a real title and is still adopted silently', async () => {
    // undefined means "no prior title"; '' is a title the user/agent chose.
    // Only undefined should fall through to the workdir seed.
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      incomingHint: '',
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
    expect(session._journalTitleHint).toBe('');
  });
});

describe('applyFallbackTitle (no-Gemini first-user-message naming)', () => {
  const deps = () => ({ serverLabel: '2', updateRoomName: vi.fn() });

  it('titles the convo from the first user message, same format as the LLM rename', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa1234',
      chatHistory: [
        { role: 'user', text: 'fix the folder picker' },
        { role: 'assistant', text: 'sure' },
      ],
    };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 fix the folder picker');
  });

  it('does nothing until a user message exists, then still applies later', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'assistant', text: 'hello' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
    session.chatHistory.push({ role: 'user', text: 'now do the thing' });
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 now do the thing');
  });

  it('applies only once per session', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: 'first' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).toHaveBeenCalledTimes(1);
  });

  it('strips tags, collapses whitespace, and truncates to 60 chars with an ellipsis', () => {
    const long = 'refactor <ide-opened-file></ide-opened-file> the whole\n\n  session   store so that every folder ever used shows up in the picker';
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: long }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    const title = d.updateRoomName.mock.calls[0][1];
    expect(title.startsWith('2:f0 refactor the whole session store')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe('2:f0 '.length + 61);
  });

  it('falls back to the room id for the short prefix and survives a missing history', () => {
    const session = { roomId: '!room', chatHistory: undefined };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    session.chatHistory = [{ role: 'user', text: 'hi' }];
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!room', '2:ro hi');
  });

  it('never lets angle brackets or reassembled script fragments into the title', () => {
    const cases = ['<scr<x>ipt>alert time', 'look at <script src=x', 'a <b> c > d'];
    for (const text of cases) {
      const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text }] };
      const d = deps();
      expect(applyFallbackTitle(session, d)).toBe(true);
      const title = d.updateRoomName.mock.calls[0][1];
      expect(title).not.toMatch(/[<>]/);
    }
  });

  it('does not clobber a title that is no longer the workdir seed (e.g. a resume summary)', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      _journalTitleHint: '2: fix the folder picker…',
      chatHistory: [{ role: 'user', text: 'carry on' }],
    };
    const d = { ...deps(), workdir: '/home/dan/proj' };
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
  });

  it('does replace the workdir-basename seed title', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      _journalTitleHint: 'proj',
      chatHistory: [{ role: 'user', text: 'carry on' }],
    };
    const d = { ...deps(), workdir: '/home/dan/proj' };
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 carry on');
  });

  it('skips a tag-only first user message and titles from the next real one', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      chatHistory: [
        { role: 'user', text: '<ide-selection></ide-selection>' },
        { role: 'user', text: 'the real prompt' },
      ],
    };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 the real prompt');
  });
});
