import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { summaryWindow, buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor } from '../lib/summary-pass.js';
import { parseTitlePassResponse, withSessionShort, titleMarkerFor, hintIsEarnedTitle } from '../lib/journal-title-seed.js';

// "Generate the title once" as index.js wires it: the summary
// pass asks for and applies TITLE only until the conversation has earned its
// LLM title; roster, summary and spoken lines still update every pass.
// Importing index.js would start the bridge, so llmTitleEarned,
// markLlmTitleEarned and maybeUpdatePinnedSummary (contiguous in index.js)
// are lifted out and run in a vm — the idiom of spoken-summary-wiring.test.js.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function harness({ persisted = {}, answer = 'TITLE: export fix\nNEW: Fixed the export.\nROSTER: Fixing the nightly export.' } = {}) {
  const start = src.indexOf('function llmTitleEarned(');
  const passStart = src.indexOf('async function maybeUpdatePinnedSummary(');
  const end = src.indexOf('\n}\n', passStart) + 2;
  expect(start, 'could not find llmTitleEarned in index.js — this test needs updating').toBeGreaterThan(-1);
  expect(passStart, 'llmTitleEarned must sit just before maybeUpdatePinnedSummary').toBeGreaterThan(start);
  const calls = { prompts: [], renames: [], persisted: [], published: [], upserts: [] };
  const context = vm.createContext({
    applyFallbackTitle: () => {}, SERVER_LABEL: 'bridge',
    updateRoomName: (_roomId, name) => calls.renames.push(name),
    summaryModel: {
      model: 'test-model',
      generate: async (prompt) => { calls.prompts.push(prompt); return answer; },
      generateWithModel: async (prompt) => { calls.prompts.push(prompt); return { text: answer, model: 'test-model' }; },
    },
    summaryModelNag: { maybeFile: () => {} },
    journalConvoIdFor: () => 'convo', debug: () => {}, console,
    summaryWindow, buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor,
    parseTitlePassResponse, withSessionShort, titleMarkerFor, hintIsEarnedTitle,
    getPersistedSession: (roomId) => persisted[roomId] || null,
    journalUpsertConvo: (_s, opts) => calls.upserts.push(JSON.parse(JSON.stringify(opts))),
    persistSession: (_roomId, _sid, _wd, _origin, extra) => calls.persisted.push(JSON.parse(JSON.stringify(extra))),
    journalPublish: (_session, method, payload) => calls.published.push({ method, payload: JSON.parse(JSON.stringify(payload)) }),
  });
  vm.runInContext(src.slice(start, end), context);
  return { calls, pass: (session) => context.maybeUpdatePinnedSummary(session) };
}

function session(extra = {}) {
  return {
    roomId: 'room', claudeSessionId: 'ab12', workdir: '/tmp/w',
    chatHistory: [{ role: 'user', text: 'Fix the export.' }, { role: 'assistant', text: 'Fixed.' }],
    pinnedSummaryText: '', lastSummaryMsgCount: 0, lastRosterText: '',
    _journalTitleHint: '[ab] Fix the export.', // the first-user-message fallback
    ...extra,
  };
}

describe('title generated once (maybeUpdatePinnedSummary)', () => {
  it('the first pass asks for TITLE, applies it and persists that the title is earned', async () => {
    const { calls, pass } = harness();
    const s = session();
    await pass(s);
    expect(calls.prompts[0].system).toContain('TITLE: <title>');
    expect(calls.renames).toEqual(['[ab] export fix']);
    expect(s._llmTitleEarned).toBe(true);
    expect(calls.persisted).toContainEqual({ llmTitleEarned: true });
  });

  it('later passes leave TITLE out of the prompt and ignore one the model writes anyway; roster and summary still update', async () => {
    const { calls, pass } = harness({ answer: 'TITLE: something else\nNEW: Shipped it.\nROSTER: Shipping the export.' });
    const s = session({ _llmTitleEarned: true, pinnedSummaryText: '• Fixed.' });
    await pass(s);
    expect(calls.prompts[0].system).not.toContain('TITLE');
    expect(calls.renames).toEqual([]);
    expect(calls.upserts).toEqual([{ summary: 'Shipping the export.' }]);
    expect(calls.published[0].payload.toc).toBe('Shipped it.');
    expect(s.lastRosterText).toBe('Shipping the export.');
  });

  it('a bridge restart reads the persisted flag', async () => {
    const { calls, pass } = harness({ persisted: { room: { llmTitleEarned: true } } });
    // The title reads like the fallback, so only the persisted flag can say earned.
    const s = session({ lastSummaryMsgCount: 2 });
    s.chatHistory.push({ role: 'user', text: 'Now deploy.' });
    await pass(s);
    expect(calls.prompts[0].system).not.toContain('TITLE');
    expect(calls.renames).toEqual([]);
    expect(s._llmTitleEarned).toBe(true);
  });

  it('a restart with no summary cursor in memory still knows an earned title (persisted flag or not)', async () => {
    // The record from before the flag, restored with the cursor at 0.
    const legacy = harness();
    const s1 = session({ _journalTitleHint: '[ab] export pipeline repair', lastSummaryMsgCount: 0 });
    await legacy.pass(s1);
    expect(legacy.calls.prompts[0].system).not.toContain('TITLE');
    expect(legacy.calls.renames).toEqual([]);
    // ...and the derived yes is written into the record.
    expect(legacy.calls.persisted).toContainEqual({ llmTitleEarned: true });
    // A record that says false (a /resume gave it a non-LLM title) asks again.
    const resumed = harness({ persisted: { room: { llmTitleEarned: false } } });
    const s2 = session({ _journalTitleHint: '[ab] Fix export from the resume summary', lastSummaryMsgCount: 0 });
    await resumed.pass(s2);
    expect(resumed.calls.prompts[0].system).toContain('TITLE: <title>');
    expect(resumed.calls.renames).toEqual(['[ab] export fix']);
    expect(s2._llmTitleEarned).toBe(true);
  });

  it('a session from before the flag that already has an LLM title counts as earned', async () => {
    const { calls, pass } = harness();
    const s = session({ _journalTitleHint: '[ab] export pipeline repair', lastSummaryMsgCount: 2 });
    s.chatHistory.push({ role: 'user', text: 'Now deploy.' });
    await pass(s);
    expect(calls.prompts[0].system).not.toContain('TITLE');
    expect(calls.renames).toEqual([]);
  });

  it('a pass that returned no TITLE leaves the title unearned, so the next pass asks again', async () => {
    const { calls, pass } = harness({ answer: 'NEW: Fixed the export.\nROSTER: Fixing the nightly export.' });
    const s = session();
    await pass(s);
    expect(calls.renames).toEqual([]);
    expect(s._llmTitleEarned).toBe(false);
    expect(s.lastSummaryMsgCount).toBe(2);
    s.chatHistory.push({ role: 'user', text: 'Again.' });
    await pass(s);
    expect(calls.prompts[1].system).toContain('TITLE: <title>');
  });
});
