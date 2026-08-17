import { describe, it, expect, vi } from 'vitest';
import {
  seedJournalTitle,
  applyFallbackTitle,
  formatRoomTitle,
  repoLabel,
  extractRepoOverride,
} from '../lib/journal-title-seed.js';

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

describe('repoLabel', () => {
  const defaultWorkdir = '/home/dan/son-of-anton';

  it('uses son-of-anton for the default workdir', () => {
    expect(repoLabel(defaultWorkdir, { defaultWorkdir })).toBe('son-of-anton');
  });

  it('uses the workdir basename for another repo', () => {
    expect(repoLabel('/home/dan/yearbook-app', { defaultWorkdir })).toBe('yearbook-app');
  });

  it('truncates an overflowing repo label with an ellipsis', () => {
    expect(repoLabel(`/home/dan/${'r'.repeat(25)}`, { defaultWorkdir })).toBe(`${'r'.repeat(24)}…`);
  });
});

describe('formatRoomTitle', () => {
  const options = {
    serverLabel: 'VPS',
    workdir: '/home/dan/yearbook-app',
    defaultWorkdir: '/home/dan/son-of-anton',
  };

  it('formats the server and repo without text or a session id', () => {
    const title = formatRoomTitle(options);
    expect(title).toBe('VPS · yearbook-app');
    expect(title).not.toMatch(/:\w{2}/);
  });

  it('formats the server, repo, and text without a session id', () => {
    const title = formatRoomTitle({ ...options, text: 'Fix the photo upload race' });
    expect(title).toBe('VPS · yearbook-app · Fix the photo upload race');
    expect(title).not.toMatch(/:\w{2}/);
  });

  it('truncates overflowing text at 60 characters with an ellipsis', () => {
    expect(formatRoomTitle({ ...options, text: 'x'.repeat(61) })).toBe(
      `VPS · yearbook-app · ${'x'.repeat(60)}…`,
    );
  });

  it('truncates an overflowing repo label at 24 characters with an ellipsis', () => {
    expect(formatRoomTitle({ ...options, workdir: `/home/dan/${'r'.repeat(25)}` })).toBe(
      `VPS · ${'r'.repeat(24)}…`,
    );
  });

  it('uses an LLM-inferred repo override in place of the workdir basename', () => {
    // workdir is yearbook-app (the session cwd) but the real work targets
    // snafu-studio — the override wins.
    expect(formatRoomTitle({ ...options, text: 'fix RLS gate', repo: 'snafu-studio' })).toBe(
      'VPS · snafu-studio · fix RLS gate',
    );
  });

  it('caps an overflowing repo override at 24 chars with an ellipsis', () => {
    expect(formatRoomTitle({ ...options, repo: 'r'.repeat(25) })).toBe(`VPS · ${'r'.repeat(24)}…`);
  });

  it('falls back to the workdir basename when repo is absent, blank, or non-string', () => {
    // Byte-identical to the pre-change output — the additive param must not
    // regress existing callers (resume path, applyFallbackTitle) that pass none.
    expect(formatRoomTitle({ ...options })).toBe('VPS · yearbook-app');
    expect(formatRoomTitle({ ...options, repo: '   ' })).toBe('VPS · yearbook-app');
    expect(formatRoomTitle({ ...options, repo: null })).toBe('VPS · yearbook-app');
  });

  it('sanitizes an untrusted repo label at the sink (F3)', () => {
    // A filesystem-derived label could contain the `·` separator, bidi/control
    // chars, or angle brackets and forge/reorder title segments. formatRoomTitle
    // must clean every repo source, not trust the caller.
    expect(formatRoomTitle({ ...options, text: 'work', repo: 'a·b' })).toBe('VPS · a b · work');
    expect(formatRoomTitle({ ...options, text: 'work', repo: 'evil‮reh' }))
      .toBe('VPS · evil reh · work');
    expect(formatRoomTitle({ ...options, text: 'work', repo: 'x<script>y' })).toBe('VPS · x y · work');
    // Empty-after-cleaning falls back to the workdir basename.
    expect(formatRoomTitle({ ...options, text: 'work', repo: '···' })).toBe('VPS · yearbook-app · work');
  });
});

describe('extractRepoOverride', () => {
  it('extracts a clean repo label from a REPO: line', () => {
    expect(extractRepoOverride('TITLE: work\nREPO: snafu-studio\nSUMMARY: done')).toBe('snafu-studio');
  });

  it('returns a short label unchanged (under the 24-char cap)', () => {
    // 20 chars — must NOT be truncated.
    expect(extractRepoOverride('REPO: claude-matrix-bridge')).toBe('claude-matrix-bridge');
  });

  it('caps an over-length repo at 24 chars plus an ellipsis', () => {
    expect(extractRepoOverride('REPO: some-really-long-monorepo-name')).toBe(
      `${'some-really-long-monorepo-name'.slice(0, 24)}…`,
    );
  });

  it('treats each sentinel as no override (returns null)', () => {
    for (const s of ['unknown', 'UNKNOWN', 'none', 'n/a', 'na', '-']) {
      expect(extractRepoOverride(`REPO: ${s}`)).toBeNull();
    }
  });

  it('returns null when there is no REPO: line, or it is whitespace, or text is non-string', () => {
    expect(extractRepoOverride('TITLE: work\nSUMMARY: done')).toBeNull();
    expect(extractRepoOverride('REPO:    ')).toBeNull();
    expect(extractRepoOverride(null)).toBeNull();
    expect(extractRepoOverride(undefined)).toBeNull();
  });

  it('a blank REPO: line does not swallow the following SUMMARY:/NEW: field', () => {
    // Horizontal-ws + line-bounded capture: an empty repo must fall back to the
    // workdir, never capture the next structured line as the repo.
    expect(extractRepoOverride('TITLE: x\nREPO:\nSUMMARY: done')).toBeNull();
    expect(extractRepoOverride('TITLE: x\nREPO:   \nNEW: done')).toBeNull();
  });

  it('truncates astral characters at the boundary without leaving an unpaired surrogate', () => {
    // 23 ASCII + a 2-UTF-16-unit emoji = 24 code points but 25 UTF-16 units: a
    // naive slice(0,24) would split the surrogate pair; code-point truncation
    // keeps it whole. encodeURIComponent throws on a lone surrogate, so it is a
    // reliable well-formedness check.
    const under = extractRepoOverride(`REPO: ${'a'.repeat(23)}👍`);
    expect(under).toBe(`${'a'.repeat(23)}👍`);
    expect(() => encodeURIComponent(under)).not.toThrow();
    // 24 ASCII + emoji = 25 code points → truncated to 24 code points + `…`;
    // the emoji is dropped whole rather than split.
    const over = extractRepoOverride(`REPO: ${'a'.repeat(24)}👍`);
    expect(over).toBe(`${'a'.repeat(24)}…`);
    expect(() => encodeURIComponent(over)).not.toThrow();
  });

  it('strips tag delimiters and stray angle brackets but preserves content', () => {
    // Tags collapse to a space (parity with applyFallbackTitle), so content is
    // preserved and no angle bracket survives.
    const out = extractRepoOverride('REPO: <b>foo</b>bar');
    expect(out).toBe('foo bar');
    expect(out).not.toMatch(/[<>]/);
  });

  it('drops the middot separator so an injected repo cannot forge extra title segments', () => {
    expect(extractRepoOverride('REPO: a · b')).toBe('a b');
  });

  it('is line-anchored — a mid-line REPO: echo cannot hijack the canonical line', () => {
    expect(extractRepoOverride('TITLE: probe REPO: spoof\nREPO: real-repo\nSUMMARY: x')).toBe('real-repo');
  });

  it('rejects duplicate REPO: lines (ambiguous / spoofable) to the workdir fallback', () => {
    // A stray REPO: echoed from transcript content before the canonical one
    // must not be able to select the title — two REPO: lines → no override.
    expect(extractRepoOverride('REPO: attacker\nTITLE: legit\nREPO: real-repo\nSUMMARY: y')).toBeNull();
    expect(extractRepoOverride('REPO: a\nREPO: b')).toBeNull();
  });

  it('strips control, format, and bidi characters before they reach the title', () => {
    // Bidi override (U+202E) can visually reorder a title; C0 controls (BEL)
    // are non-printing. Both must be neutralized (-> space, collapsed). The
    // .toBe assertions prove the chars are gone; the bidi range check is
    // belt-and-braces.
    const bidi = extractRepoOverride('REPO: safe\u202Eabc');
    expect(bidi).toBe('safe abc');
    expect(bidi).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(extractRepoOverride('REPO: a\u0007b')).toBe('a b');
  });
});

describe('applyFallbackTitle (repo-aware first-user-message naming)', () => {
  const deps = () => ({
    serverLabel: 'VPS',
    workdir: '/home/dan/proj',
    defaultWorkdir: '/home/dan/son-of-anton',
    updateRoomName: vi.fn(),
  });

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
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', 'VPS · proj · fix the folder picker');
  });

  it('does nothing until a user message exists, then still applies later', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'assistant', text: 'hello' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
    session.chatHistory.push({ role: 'user', text: 'now do the thing' });
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', 'VPS · proj · now do the thing');
  });

  it('applies only once per session', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: 'first' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).toHaveBeenCalledTimes(1);
  });

  // updateRoomName → journalUpsertConvo sets _journalTitleHint in production;
  // mirror that here so the upgrade guard (title-still-ours) is exercised.
  const hintTrackingDeps = (session) => ({
    serverLabel: 'VPS',
    workdir: '/home/dan/proj',
    defaultWorkdir: '/home/dan/son-of-anton',
    updateRoomName: vi.fn((_roomId, name) => { session._journalTitleHint = name; }),
  });

  it('upgrades a repo-less fallback once a repo signal arrives (F1r2)', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: 'fix it' }] };
    const d = hintTrackingDeps(session);
    // First application: no repo yet → titled from the workdir basename.
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenLastCalledWith('!abc', 'VPS · proj · fix it');
    // A tool result commits goodfellow activity → the fallback upgrades.
    expect(applyFallbackTitle(session, { ...d, repo: 'goodfellow' })).toBe(true);
    expect(d.updateRoomName).toHaveBeenLastCalledWith('!abc', 'VPS · goodfellow · fix it');
    // No further upgrade — the repo is now locked in.
    expect(applyFallbackTitle(session, { ...d, repo: 'snafu-studio' })).toBe(false);
    expect(d.updateRoomName).toHaveBeenCalledTimes(2);
  });

  it('does not upgrade if a later title (e.g. a codex pass) replaced ours', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: 'fix it' }] };
    const d = hintTrackingDeps(session);
    expect(applyFallbackTitle(session, d)).toBe(true);
    // Simulate a codex summary pass winning the title in between.
    session._journalTitleHint = 'VPS · goodfellow · Codex-authored title';
    expect(applyFallbackTitle(session, { ...d, repo: 'goodfellow' })).toBe(false);
    expect(d.updateRoomName).toHaveBeenCalledTimes(1); // only the initial fallback
  });

  it('applies with the repo directly when the fallback first fires post-commit', () => {
    // A tool-only first turn (no assistant text → no earlier flush) reaches the
    // commit path before any fallback; it should title WITH the repo immediately.
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: 'fix it' }] };
    const d = hintTrackingDeps(session);
    expect(applyFallbackTitle(session, { ...d, repo: 'goodfellow' })).toBe(true);
    expect(d.updateRoomName).toHaveBeenLastCalledWith('!abc', 'VPS · goodfellow · fix it');
    expect(session._fallbackRepoInferred).toBe(true);
  });

  it('strips tags, collapses whitespace, and truncates to 60 chars with an ellipsis', () => {
    const long = 'refactor <ide-opened-file></ide-opened-file> the whole\n\n  session   store so that every folder ever used shows up in the picker';
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: long }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    const title = d.updateRoomName.mock.calls[0][1];
    expect(title.startsWith('VPS · proj · refactor the whole session store')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe('VPS · proj · '.length + 61);
  });

  it('falls back to the room id for the short prefix and survives a missing history', () => {
    const session = { roomId: '!room', chatHistory: undefined };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    session.chatHistory = [{ role: 'user', text: 'hi' }];
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!room', 'VPS · proj · hi');
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
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', 'VPS · proj · carry on');
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
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', 'VPS · proj · the real prompt');
  });
});
