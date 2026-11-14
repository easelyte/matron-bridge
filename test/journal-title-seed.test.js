import { readFileSync } from 'fs';
import { describe, it, expect, vi } from 'vitest';
import { seedJournalTitle, applyFallbackTitle, parseTitlePassResponse, withSessionShort, sessionShortFromTitle, titleMarkerFor, hintIsEarnedTitle, recordTitleEarned } from '../lib/journal-title-seed.js';

describe('seedJournalTitle (workdir-sourced)', () => {
  it('titles the convo from the workdir basename, with no server-label prefix', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, { workdir: '/home/alice/acme-app', serverLabel: '2', upsertConvo, warn: () => {} });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: 'acme-app' });
  });

  it('seeds the bare basename when no server label is given', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, { workdir: '/home/alice/acme-app', upsertConvo, warn: () => {} });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: 'acme-app' });
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
      workdir: '/home/alice/acme-app',
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
      workdir: '/home/alice/acme-app',
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
      workdir: '/home/alice/acme-app',
      reattaching: false,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('acme-app') });
  });

  // A full bridge restart loses the in-memory hint (nothing carries
  // incomingHint), so resumed sessions used to re-apply the first-user-message
  // fallback title over the earned Gemini title. The persisted hint (written
  // by journalUpsertConvo on every title change) is handed in as
  // persistedHint and must be adopted the same way: silently, no upsert —
  // the title already exists server-side.
  it('adopts the persisted hint when reattaching, so the fallback cannot clobber the earned title', async () => {
    const session = { _journalTitleHint: undefined, roomId: '!abc', claudeSessionId: 'b53e6542' };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/alice/acme-app',
      serverLabel: '3',
      persistedHint: '3:b5 css token migration',
      reattaching: true,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
    expect(session._journalTitleHint).toBe('3:b5 css token migration');

    session.chatHistory = [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'hello' }];
    const updateRoomName = vi.fn();
    const applied = applyFallbackTitle(session, { serverLabel: '3', updateRoomName, workdir: '/home/alice/acme-app' });
    expect(applied).toBe(false);
    expect(updateRoomName).not.toHaveBeenCalled();
  });

  it('ignores the persisted hint for a brand-new convo (not reattaching)', async () => {
    // A fresh convo reusing a room (new journalConvoId) has no server-side
    // title yet — a stale hint from the room's PRIOR convo must not suppress
    // the seed, or the new convo starts untitled.
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/alice/acme-app',
      persistedHint: 'stale title from a prior convo',
      reattaching: false,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('acme-app') });
    expect(session._journalTitleHint).not.toBe('stale title from a prior convo');
  });

  it('a live incoming hint wins over the persisted hint', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    await seedJournalTitle(session, {
      workdir: '/home/alice/acme-app',
      incomingHint: 'live carried title',
      persistedHint: 'older persisted title',
      reattaching: true,
      upsertConvo,
      warn: () => {},
    });
    expect(session._journalTitleHint).toBe('live carried title');
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it('an empty-string persisted hint is a real title and is still adopted', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/alice/acme-app',
      persistedHint: '',
      reattaching: true,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
    expect(session._journalTitleHint).toBe('');
  });

  it('an empty-string incoming hint is a real title and is still adopted silently', async () => {
    // undefined means "no prior title"; '' is a title the user/agent chose.
    // Only undefined should fall through to the workdir seed.
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/alice/acme-app',
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

  it('titles the convo from the first user message, prefixed with the session short like the LLM rename', () => {
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
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '[f0] fix the folder picker');
  });

  it('does nothing until a user message exists, then still applies later', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'assistant', text: 'hello' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
    session.chatHistory.push({ role: 'user', text: 'now do the thing' });
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '[f0] now do the thing');
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
    expect(title.startsWith('[f0] refactor the whole session store')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe(66); // '[f0] ' + 60 chars + ellipsis
  });

  it('survives a missing history and applies once one arrives, shorting the room id when the session id is unknown', () => {
    const session = { roomId: '7c0ffee0-aaaa-bbbb-cccc-000000000000', chatHistory: undefined };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    session.chatHistory = [{ role: 'user', text: 'hi' }];
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('7c0ffee0-aaaa-bbbb-cccc-000000000000', '[7c] hi');
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
    const d = { ...deps(), workdir: '/home/alice/proj' };
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
  });

  it('does replace the labeled workdir seed title', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      _journalTitleHint: '2: proj',
      chatHistory: [{ role: 'user', text: 'carry on' }],
    };
    const d = { ...deps(), workdir: '/home/alice/proj' };
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '[f0] carry on');
  });

  it('still replaces the legacy bare-basename seed from sessions persisted before labeling', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      _journalTitleHint: 'proj',
      chatHistory: [{ role: 'user', text: 'carry on' }],
    };
    const d = { ...deps(), workdir: '/home/alice/proj' };
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '[f0] carry on');
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
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '[f0] the real prompt');
  });
});

describe('withSessionShort (2-char session-id title prefix)', () => {
  it('prefixes the first two characters of the id in brackets', () => {
    expect(withSessionShort('b53e6542', 'css token migration')).toBe('[b5] css token migration');
  });

  it('leaves the title bare when there is no id to short', () => {
    expect(withSessionShort(undefined, 'untagged')).toBe('untagged');
    expect(withSessionShort('', 'untagged')).toBe('untagged');
    expect(withSessionShort('   ', 'untagged')).toBe('untagged');
  });

  it('puts a marker ahead of the short, and ahead of a bare title', () => {
    expect(withSessionShort('b53e6542', 'port the tests', '🐣')).toBe('🐣 [b5] port the tests');
    expect(withSessionShort(undefined, 'port the tests', '🐣')).toBe('🐣 port the tests');
  });
});

// withSessionShort's inverse: reading a short back OUT of a title another
// bridge published (agent-chat room titles name the peer by its session
// tag). The two must share one boundary rule, or a title this bridge minted
// would fail to parse on the box that reads it — hence the round trips.
describe('sessionShortFromTitle', () => {
  it('peels the short off a published title', () => {
    expect(sessionShortFromTitle('[2h] Remote work')).toBe('2h');
  });

  it('reads THROUGH every marker the bridge puts ahead of the short', () => {
    // ↔️ = agent-chat room (#225), 🔗 = its pre-#228 legacy twin, 🐣 = a
    // session another agent spawned (#227).
    expect(sessionShortFromTitle('↔️ [2h] mac ↔️ box-2 — ci triage')).toBe('2h');
    expect(sessionShortFromTitle('🔗 [2h] mac ↔ box-2')).toBe('2h');
    expect(sessionShortFromTitle('🐣 [2h] port the tests')).toBe('2h');
  });

  it('round-trips whatever withSessionShort wrote', () => {
    expect(sessionShortFromTitle(withSessionShort('b53e6542', 'css token migration'))).toBe('b5');
    expect(sessionShortFromTitle(withSessionShort('b53e6542', 'port the tests', '🐣'))).toBe('b5');
    // …and a title that never earned a short comes back empty, not '[u'.
    expect(sessionShortFromTitle(withSessionShort('', 'untagged'))).toBe('');
  });

  it('returns nothing for bracketed text that is not a short', () => {
    // Same closed set as the apps' splitTitle: exactly two alphanumerics,
    // a trailing space, and a non-empty title after it. Anything else is
    // ordinary title text that happens to start with a bracket.
    expect(sessionShortFromTitle('Remote work')).toBe('');
    expect(sessionShortFromTitle('[abc] three chars')).toBe('');
    expect(sessionShortFromTitle('[a] one char')).toBe('');
    expect(sessionShortFromTitle('[a ] space')).toBe('');
    expect(sessionShortFromTitle('[2h]no space')).toBe('');
    expect(sessionShortFromTitle('[2h] ')).toBe('');
    expect(sessionShortFromTitle('[2h]')).toBe('');
    expect(sessionShortFromTitle('🐣 no short here')).toBe('');
  });

  it('never throws on a missing or non-string title', () => {
    expect(sessionShortFromTitle(undefined)).toBe('');
    expect(sessionShortFromTitle(null)).toBe('');
    expect(sessionShortFromTitle(42)).toBe('');
  });
});

describe('spawned-session titles (🐣 marker + task-derived fallback)', () => {
  const deps = () => ({ serverLabel: '2', updateRoomName: vi.fn() });

  it('names a spawned session from the approved task, not the boilerplate opening turn', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa1234',
      spawnedByAgent: true,
      spawnTask: 'port the flaky auth tests to the new harness',
      chatHistory: [
        { role: 'user', text: '[spawned session] You were started by the user\'s agent session on "mac".' },
      ],
    };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '🐣 [f0] port the flaky auth tests to the new harness');
  });

  it('cleans and truncates the task exactly like a first-message title', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      spawnedByAgent: true,
      spawnTask: `<task>  ${'x'.repeat(80)}  </task>`,
      chatHistory: [],
    };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    const [, title] = d.updateRoomName.mock.calls[0];
    expect(title.startsWith('🐣 [f0] xxx')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('<');
  });

  it('titleMarkerFor keeps the marker for a live spawned session and infers it from a persisted title', () => {
    expect(titleMarkerFor({ spawnedByAgent: true })).toBe('🐣');
    // After a bridge restart the flag is gone; the current title carries it.
    expect(titleMarkerFor({ _journalTitleHint: '🐣 [f0] port the tests' })).toBe('🐣');
    expect(titleMarkerFor({ _journalTitleHint: '[f0] a chat about 🐣 emoji' })).toBe('');
    expect(titleMarkerFor({})).toBe('');
    expect(titleMarkerFor(undefined)).toBe('');
  });
});

describe('parseTitlePassResponse (Gemini title-pass parsing)', () => {
  it('parses all four fields from a well-formed response', () => {
    const parsed = parseTitlePassResponse(
      'TITLE: plan mode fix\nSUMMARY: Fixed the plan-mode toggle.\nNEW: Added a regression test.\nROSTER: Working on the plan-mode toggle in the bridge.');
    expect(parsed).toEqual({
      title: 'plan mode fix',
      summary: 'Fixed the plan-mode toggle.',
      added: 'Added a regression test.',
      roster: 'Working on the plan-mode toggle in the bridge.',
    });
  });

  it('captures a multi-line ROSTER through to end-of-text', () => {
    const parsed = parseTitlePassResponse(
      'TITLE: search backfill\nROSTER: Backfilling the FTS index.\nCurrently fixing ghost rows.\nNext up is trigger coverage.');
    expect(parsed.title).toBe('search backfill');
    expect(parsed.roster).toBe('Backfilling the FTS index.\nCurrently fixing ghost rows.\nNext up is trigger coverage.');
  });

  it('stops the ROSTER capture at the next KEY: line', () => {
    // The prompt keeps ROSTER as its last format line, but a model that
    // reorders fields must not have a later key swallowed into the roster.
    const parsed = parseTitlePassResponse(
      'ROSTER: First roster line.\nSecond roster line.\nTITLE: out of order\nNEW: something new');
    expect(parsed.roster).toBe('First roster line.\nSecond roster line.');
    expect(parsed.title).toBe('out of order');
    expect(parsed.added).toBe('something new');
  });

  it('keeps prose that merely looks like a key (API:, TODO:) inside the ROSTER body', () => {
    // The stop delimiter is this parser's own format keys, not any capitalised
    // word: an ordinary roster sentence opening `API:` used to truncate the
    // summary there and drop every sentence after it.
    const parsed = parseTitlePassResponse([
      'TITLE: bridge room work',
      'ROSTER: Working on the agent-chat delivery path.',
      'API: the tool surface is still in flux.',
      'TODO: sender escaping is next.',
      'Ready for questions about room delivery.',
    ].join('\n'));
    expect(parsed.roster).toBe([
      'Working on the agent-chat delivery path.',
      'API: the tool surface is still in flux.',
      'TODO: sender escaping is next.',
      'Ready for questions about room delivery.',
    ].join('\n'));
  });

  it('still stops the ROSTER capture at a real trailing format key', () => {
    const parsed = parseTitlePassResponse([
      'ROSTER: Working on the delivery path.',
      'TODO: not a key, stays in the body.',
      'TITLE: out of order',
    ].join('\n'));
    expect(parsed.roster).toBe('Working on the delivery path.\nTODO: not a key, stays in the body.');
    expect(parsed.title).toBe('out of order');
  });

  it('returns null for absent fields (pre-ROSTER responses keep working)', () => {
    const parsed = parseTitlePassResponse('TITLE: voice note support\nNEW: Wired the recorder.');
    expect(parsed.title).toBe('voice note support');
    expect(parsed.added).toBe('Wired the recorder.');
    expect(parsed.summary).toBeNull();
    expect(parsed.roster).toBeNull();
  });

  it('returns all nulls for garbage and non-string input', () => {
    expect(parseTitlePassResponse('the model rambled with no keys at all')).toEqual({
      title: null, summary: null, added: null, roster: null,
    });
    expect(parseTitlePassResponse(undefined)).toEqual({
      title: null, summary: null, added: null, roster: null,
    });
  });
});

describe('title-pass wiring in index.js and lib/title-summary.js (source inspection)', () => {
  const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const passSrc = readFileSync(new URL('../lib/title-summary.js', import.meta.url), 'utf-8');

  it('routes the Gemini response through parseTitlePassResponse, with the spoken lines already cut out', () => {
    // The spoken lines (voice mode) are taken out by splitSpoken first; the
    // parser must be given what is left. See test/spoken-summary-wiring.test.js.
    expect(passSrc).toMatch(/const parsed = parseTitlePassResponse\(voiced\.rest\);/);
  });

  it('builds the prompt via buildSummaryPrompt instead of hand-rolling it', () => {
    // Task B4: the two inline prompt variants (each ending its Format: block
    // with the ROSTER line) moved to lib/summary-pass.js's buildSummaryPrompt,
    // which keeps its own coverage of the ROSTER-must-be-last invariant
    // (test/summary-pass.test.js) — index.js's job is just to call it.
    expect(passSrc).toMatch(/const prompt = buildSummaryPrompt\(\{/);
  });

  it('upserts the roster to the journal, sliced to the protocol cap', () => {
    expect(passSrc).toMatch(/journalUpsertConvo\(session, \{ summary: parsed\.roster\.slice\(0, 1000\) \}\);/);
  });

  it('names the room from the session short + parsed title — no SERVER_LABEL prefix', () => {
    // Which box owns a conversation is data now (agent_device_id, rendered
    // as a chip by the apps). A label baked in here is frozen text that a
    // rename can never reach — and it is what made two boxes both read
    // "DEV" in the chat list. The 2-char session short is the part that
    // tells two sessions on the SAME box apart, so it stays.
    expect(passSrc).toMatch(/const name = withSessionShort\(session\.claudeSessionId \|\| session\.roomId, parsed\.title\.slice\(0, 60\), titleMarkerFor\(session\)\);/);
  });

  it('names a resumed session with the session short but no SERVER_LABEL prefix, inferring the 🐣 marker from the persisted title', () => {
    expect(indexSrc).toMatch(/withSessionShort\(resumeSessionId, summary/);
    expect(indexSrc).toMatch(/: `Resumed \$\{shortId\}`,/);
    expect(indexSrc).toMatch(/const resumedHint = resumePersisted\?\.journalTitleHint;/);
    expect(indexSrc).toMatch(/titleMarkerFor\(\{ _journalTitleHint: resumedHint \}\)\);/);
  });

  it('a /resume keeps an earned LLM title, and carries the flag onto the new room', () => {
    expect(indexSrc).toMatch(/const resumedTitleEarned = recordTitleEarned\(resumePersisted, \{ serverLabel: SERVER_LABEL \}\);/);
    expect(indexSrc).toMatch(/const roomName = resumedTitleEarned && typeof resumedHint === 'string' && resumedHint\.trim\(\)\n\s+\? resumedHint\n/);
    expect(indexSrc).toMatch(/session\._llmTitleEarned = resumedTitleEarned;[\s\S]*?await updateRoomName\(sessionRoomId, roomName\);[\s\S]*?llmTitleEarned: session\._llmTitleEarned,/);
  });

  it('every restart, handoff and provider swap carries the flag; persistSession writes it from the live session', () => {
    expect(indexSrc.match(/restarted\._llmTitleEarned = session\._llmTitleEarned;/g)).toHaveLength(2);
    expect(indexSrc.match(/next\._llmTitleEarned = existing\._llmTitleEarned;/g)).toHaveLength(2);
    expect(indexSrc).toContain("if (typeof prev.llmTitleEarned === 'boolean') newSession._llmTitleEarned = prev.llmTitleEarned;");
    expect(indexSrc).toContain("if (typeof live?._llmTitleEarned === 'boolean') derived.llmTitleEarned = live._llmTitleEarned;");
  });

  it('never rebuilds a `LABEL:` title prefix anywhere', () => {
    expect(indexSrc).not.toMatch(/\$\{SERVER_LABEL\}:/);
    expect(passSrc).not.toMatch(/\$\{SERVER_LABEL\}:/);
  });
});

describe('hintIsEarnedTitle (a record from before the llmTitleEarned flag)', () => {
  const opts = { serverLabel: 'bridge', workdir: '/home/alice/acme-app' };
  const base = (extra) => ({
    roomId: 'r', lastSummaryMsgCount: 4,
    chatHistory: [{ role: 'user', text: 'Fix the <b>export</b> please' }, { role: 'assistant', text: 'ok' }],
    ...extra,
  });

  it('an LLM title after a successful pass is earned, behind a marker or not', () => {
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '[ab] export pipeline repair' }), opts)).toBe(true);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '🐣 [ab] export pipeline repair' }), opts)).toBe(true);
  });

  it('depends on no process state: the same answer with the summary cursor at 0 (a restart, /resume or handoff)', () => {
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '[ab] export pipeline repair', lastSummaryMsgCount: 0 }), opts)).toBe(true);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '[ab] Fix the export please', lastSummaryMsgCount: 0 }), opts)).toBe(false);
  });

  it('never with no title', () => {
    expect(hintIsEarnedTitle(base({ _journalTitleHint: undefined }), opts)).toBe(false);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '' }), opts)).toBe(false);
  });

  it('a seed, the first-user-message fallback or a /resume placeholder is not earned', () => {
    expect(hintIsEarnedTitle(base({ _journalTitleHint: 'acme-app' }), opts)).toBe(false);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: 'bridge: acme-app' }), opts)).toBe(false);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '[ab] Fix the export please' }), opts)).toBe(false);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '🐣 [ab] Ship it', spawnTask: 'Ship it' }), opts)).toBe(false);
    expect(hintIsEarnedTitle(base({ _journalTitleHint: '[ab] Resumed ab12cd34' }), opts)).toBe(false);
  });
});

describe('recordTitleEarned (what a /resume carries over)', () => {
  const history = [{ role: 'user', text: 'Fix the export' }];
  it('the record flag wins, true or false', () => {
    expect(recordTitleEarned({ llmTitleEarned: true, journalTitleHint: 'acme-app', workdir: '/w/acme-app' })).toBe(true);
    expect(recordTitleEarned({ llmTitleEarned: false, journalTitleHint: '[ab] export pipeline repair', chatHistory: history })).toBe(false);
  });
  it('a record from before the flag is read from its last title', () => {
    expect(recordTitleEarned({ journalTitleHint: '[ab] export pipeline repair', chatHistory: history, workdir: '/w/app' })).toBe(true);
    expect(recordTitleEarned({ journalTitleHint: '[ab] Fix the export', chatHistory: history, workdir: '/w/app' })).toBe(false);
    expect(recordTitleEarned({ journalTitleHint: 'app', chatHistory: history, workdir: '/w/app' })).toBe(false);
    expect(recordTitleEarned(null)).toBe(false);
  });
});
