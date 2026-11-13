import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Prompts the bridge resolves by itself must not stay "unanswered" in the
// user's unseen list. Queued-message cards are released with a
// queued_release prompt_reply naming the card's prompt_id (any sender
// counts); timer and reminder cards, which nothing waits on, are published
// with `blocking: false` so they never count as unanswered at all. index.js cannot be imported in-process, so the wiring is
// pinned by source inspection (as in test/memory-wiring.test.js); the store
// side is unit-tested in test/timer-command.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('timer and reminder cards', () => {
  it('both Send-now / Cancel cards are published non-blocking, with the timer\'s prompt_id', () => {
    const payload = body('function timerCardPayload(', '\n}\n');
    expect(payload).toContain('prompt_id: timerPromptId(record),');
    expect(payload).toContain('blocking: false,');
    expect(payload).toContain("mode: 'pick_one',");
    const cards = index.match(/'pick_one', summary, escapeHtml\(summary\), timerCardPayload\(record, summary\)\);/g) || [];
    // The typed /timer confirmation and the agent's reminder_create card.
    expect(cards).toHaveLength(2);
    expect(index).not.toMatch(/\[timerSendNowButton\(record\.id\), timerCancelButton\(record\.id\)\],\s*'pick_one', summary, escapeHtml\(summary\)\);/);
  });

  // Today's apps render an unknown bridge prompt_reply as an "Answered"
  // bubble, so the card itself says it blocks nothing instead.
  it('no prompt_reply is published for a timer firing or being cancelled', () => {
    expect(index).not.toContain('timer_release');
    expect(index).not.toContain('publishTimerRelease');
  });
});

describe('queued-message cards', () => {
  it('the turn-end flush releases the batch\'s cards as sent (queued_release naming each prompt_id)', () => {
    const flush = body('function flushQueue(', '\nfunction ');
    expect(flush).toContain('finalizeSentQueue(snapshot.convoId, snapshot.entries);\n  return true;');
    const fin = body('function finalizeSentQueue(', '\nfunction ');
    expect(fin).toContain("action = 'send'");
    expect(fin).toMatch(/emitRelease\(convoId, \{\s*promptId: liveEntry\.promptId,\s*action,/);
    const emit = body('function emitRelease(', '\nfunction ');
    expect(emit).toMatch(/publishPromptReply\(convoId, \{\s*kind: 'queued_release',\s*prompt_id: promptId,/);
  });

  it('a batch dropped because the session ended releases its cards as expired', () => {
    const flush = body('function flushQueue(', '\nfunction ');
    const dropped = flush.indexOf('[QUEUE] dropped queued message(s)');
    const expire = flush.indexOf("finalizeSentQueue(snapshot.convoId, snapshot.entries, 'expired');");
    expect(dropped).toBeGreaterThan(-1);
    expect(expire).toBeGreaterThan(dropped);
  });
});
