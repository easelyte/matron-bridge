import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { restartNoteTurnText } from '../lib/restart-notes.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = index.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const from = index.lastIndexOf('\n', start) + 1;
  const decl = index.slice(from, start).startsWith('async ') ? from : start;
  return index.slice(decl, index.indexOf('\n}\n', start) + 3);
};

describe('resume note delivery wiring', () => {
  it('the boot cards queue the notes through the delivery, and fall back to cards when they cannot be queued', () => {
    const boot = fn('publishRestartCarryOnCards');
    expect(boot).toContain('restartNoteDelivery.start(noteResult.deliveries)');
    expect(boot).toMatch(/catch \(e\) \{[\s\S]*?publishRecoveryCard\(note\.convoId\)/);
    // Taken before the auto/card split, as upstream does.
    expect(boot.indexOf('takeNoteDeliveries(')).toBeLessThan(boot.indexOf('restartNoteDelivery.start('));
    expect(boot.indexOf('restartNoteDelivery.start(')).toBeLessThan(boot.indexOf('selectAutoCarryOn('));
    expect(boot).not.toContain('carryOnConvo(note.convoId');
  });

  it('main() resumes what an earlier process left after the cards, and settles the record even when that fails', () => {
    const main = index.slice(index.indexOf('async function main()'), index.indexOf('main().catch'));
    const cards = main.indexOf('publishRestartCarryOnCards();');
    const resume = main.indexOf('restartNoteDelivery.resume()');
    expect(cards).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(cards);
    expect(main.indexOf('startCodeUpdateWatcher();')).toBeGreaterThan(resume);
    expect(main).toMatch(/catch \(e\) \{[\s\S]*?restartRequests\.settleNotes\(\{\}\)/);
  });

  it('the delivery is built once, with its outcomes closing the restart record and its failures producing the card', () => {
    expect(index.match(/createNoteDelivery\(\{/g)).toHaveLength(1);
    const block = index.slice(index.indexOf('const restartNoteDelivery = createNoteDelivery({'), index.indexOf('// While a restart is requested, keep the journal'));
    expect(block).toContain('deliver: entry => deliverRestartNote(entry),');
    expect(block).toContain('recover: entry => { publishRecoveryCard(entry.convoId); },');
    expect(block).toContain('onSettled: outcomes => restartRequests.settleNotes(outcomes),');
  });
});

describe('deliverRestartNote', () => {
  function load(over = {}) {
    const sendToSession = vi.fn(() => true);
    const context = {
      restartInputs: { begin: () => () => {} }, sessionOccupied: s => !!s.busy, effortFlowHoldsInput: () => false, signInDialogHoldsInput: () => false,
      findSessionByClaudeSessionId: () => ({ alive: true }), journalResumeConvo: vi.fn(() => null), sendToSession,
      restartNoteTurnText, frameSafeBody: s => s, carryOnCause: () => ({ kind: 'carry_on' }), Date: { now: () => 10_000 },
      ...over,
    };
    return { run: runInNewContext(`${fn('deliverRestartNote')}\ndeliverRestartNote`, context), context, sendToSession };
  }
  const entry = { convoId: 'c1', text: 'check the build', writtenAt: 10_000 - 3 * 60_000, interrupted: true };

  it('hands the note to an idle session as a plain carry-on turn, with its age', async () => {
    const { run, sendToSession } = load();
    expect(await run(entry)).toBe(true);
    const [, blocks, options] = sendToSession.mock.calls[0];
    expect(blocks[0].text).toBe(restartNoteTurnText('check the build', 3 * 60_000, s => s, true));
    expect(options).toEqual({ plainTurn: true, causes: [{ kind: 'carry_on' }] });
  });

  it.each([
    ['a busy turn', { findSessionByClaudeSessionId: () => ({ alive: true, busy: true }) }],
    ['a PTY that is not ready', { findSessionByClaudeSessionId: () => ({ alive: true, _awaitingInputReady: true }) }],
    ['an open sign-in dialog', { signInDialogHoldsInput: () => true }],
    ['an effort picker', { effortFlowHoldsInput: () => true }],
  ])('defers on %s, without sending', async (_name, over) => {
    const { run, sendToSession } = load(over);
    expect(await run(entry)).toEqual({ deferred: true });
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it('resumes a sleeping chat first, and fails when it cannot be found or resumed', async () => {
    const resumed = load({ findSessionByClaudeSessionId: () => null, journalResumeConvo: vi.fn(() => ({ alive: true })) });
    expect(await resumed.run(entry)).toBe(true);
    expect(resumed.context.journalResumeConvo).toHaveBeenCalledWith('c1', expect.stringMatching(/resuming this chat with the note/));
    expect(await load({ findSessionByClaudeSessionId: () => null }).run(entry)).toBe(false);
  });

  it('is false when the session refuses the turn', async () => {
    const { run } = load({ sendToSession: () => false });
    expect(await run(entry)).toBe(false);
  });
});

describe('publishRecoveryCard', () => {
  function load(over = {}) {
    const cards = [];
    const run = runInNewContext(`${fn('publishRecoveryCard')}\npublishRecoveryCard`, {
      JOURNAL_ENABLED: true, loadPersistedSessions: () => ({ r1: { journalConvoId: 'c1' }, r2: { sessionId: 'c2' } }),
      isResumeConvoId: () => true, journalPublishCardForConvo: (id, card) => { cards.push([id, card]); return true; }, ...over,
    });
    return { run, cards };
  }

  it('offers a tap to carry on, for a chat a tap can resume', () => {
    const { run, cards } = load();
    expect(run('c1')).toBe(true);
    expect(cards[0][1].options[0]).toMatchObject({ value: 'resume:c1' });
    expect(cards[0][1].question).toMatch(/could not resume this chat by itself/);
    expect(run('c2')).toBe(true);
  });

  it('publishes nothing for a chat with no persisted session, an id a resume cannot address, or without a journal', () => {
    const a = load();
    expect(a.run('nobody')).toBe(false);
    expect(load({ isResumeConvoId: () => false }).run('c1')).toBe(false);
    expect(load({ JOURNAL_ENABLED: false }).run('c1')).toBe(false);
    expect(a.cards).toEqual([]);
  });
});
