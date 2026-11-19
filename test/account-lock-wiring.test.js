import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level side effects), so the
// account lock's wiring is pinned by source inspection, as the other
// *-wiring tests do. The lock itself and each path's refusal are unit-tested
// in test/account-lock.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('account lock wiring', () => {
  it('the journal feeds it: hello_ok and live panic frames, and nothing else clears it', () => {
    expect(index).toMatch(/onPanic: \(panic, \{ hello \}\) => \(hello \? accountLock\.onHello\(panic\) : accountLock\.onFrame\(panic\)\)/);
    const feeds = index.match(/accountLock\.(onHello|onFrame)\(/g) || [];
    expect(feeds).toHaveLength(2);
  });

  it('locking interrupts every running turn and tells each affected conversation once', () => {
    const stop = body('function stopTurnsForAccountLock()', '\n}\n');
    expect(stop).toMatch(/for \(const session of sessions\.values\(\)\)/);
    expect(stop).toMatch(/printModeInterrupt\(session/);
    expect(stop).toMatch(/sendKeystroke\('esc'\)/);
    expect(stop).toMatch(/noticeAccountLocked\(/);
    const notice = body('function noticeAccountLocked(', '\n}\n');
    expect(notice).toMatch(/accountLock\.shouldNotify\(/);
    expect(notice).toMatch(/ACCOUNT_LOCKED_LINE/);
  });

  it('no turn starts while locked, whatever its source: the one function every turn goes through refuses first', () => {
    const send = body('function sendToSession(session, contentBlocks', 'const historyText');
    const guard = send.indexOf('accountLock.isLocked()');
    expect(guard).toBeGreaterThan(-1);
    expect(send.slice(guard, guard + 200)).toMatch(/return false/);
    // Ahead of everything that could dispatch or change state.
    expect(guard).toBeLessThan(send.indexOf('foreignSessions.end'));
  });

  it('queued messages are not flushed while locked', () => {
    const flush = body('function flushPendingSessionQueue(session) {', 'const queue = session.queuedMessages');
    expect(flush).toMatch(/if \(accountLock\.isLocked\(\)\) return false;/);
  });

  it('a reminder that falls due while locked is held, and fired after the clear', () => {
    const fire = body('async function fireTimer(record) {', 'let session = findSessionByClaudeSessionId');
    expect(fire).toMatch(/if \(accountLock\.hold\(\{ kind: 'timer', record \}\)\) return;/);
    const release = body('function releaseAfterAccountLock(held)', '\n}\n');
    expect(release).toMatch(/kind === 'timer'/);
    expect(release).toMatch(/fireTimer\(/);
  });

  it('every inbound path is told about the lock', () => {
    expect(body('const journalRpcHandler = createRpcRequestHandler({', '\n});')).toMatch(/accountLocked: \(\) => accountLock\.isLocked\(\)/);
    expect(body('agentInvites = createAgentInvites({', '\n});')).toMatch(/accountLocked: \(\) => accountLock\.isLocked\(\)/);
    expect(body('transferReceiver = createTransferReceiver({', '\n});')).toMatch(/accountLocked: \(\) => accountLock\.isLocked\(\)/);
    const router = body('const journalInputConsumer = createJournalInputConsumer({', '\n});');
    expect(router).toMatch(/inputLock: \{ verdict: \(kind, keyId\) => \(accountLock\.isLocked\(\) \? accountLock\.verdict\(\)/);
    // A same-bridge invite never passes the invites manager's frame handler.
    const local = body('function journalInjectInviteRequest(frame) {', 'const isJoin');
    expect(local).toMatch(/accountLock\.isLocked\(\)/);
  });

  it('room messages waiting for a session are not flushed (and so not lost) while locked, and idle sessions are flushed after the clear', () => {
    const flush = body('function maybeFlushRoomDelivery(session) {', 'foreignSessions.drainParked');
    expect(flush).toMatch(/if \(accountLock\.isLocked\(\)\) return;/);
    const release = body('function releaseAfterAccountLock(held)', '\n}\n');
    expect(release).toMatch(/flushPendingSessionQueue\(session\)/);
    expect(release).toMatch(/maybeFlushRoomDelivery\(session\)/);
  });

  it('it does not depend on the approval gate', () => {
    const make = body('const accountLock = createAccountLock({', '\n});');
    expect(make).not.toMatch(/approvalGate|boxLock/);
  });
});

describe('locked mode and gate wiring beyond the event router', () => {
  it('a locked box delivers a signed tap only on a check that spends the statement', () => {
    const router = body('const journalInputConsumer = createJournalInputConsumer({', '\n});');
    expect(router).toMatch(/verifySignedTap: tapVerifier \? \(payload\) => tapVerifier\.forDelivery\(payload\) : null/);
  });

  it('session control asks the lock whether another session may start work', () => {
    expect(index).toMatch(/peersAllowed: \(\) => !boxLock \|\| boxLock\.allowsPeer\(\)/);
  });

  it('journal nudges and invite answers that would start a turn are dropped while outside work is refused', () => {
    expect(body('function outsideWorkRefused()', '\n}\n')).toMatch(/accountLock\.isLocked\(\) \|\| \(!!boxLock && !boxLock\.allowsPeer\(\)\)/);
    expect(index).toMatch(/function journalHandleConsentFrame\(frame\) \{\n[^\n]*\n {2}if \(outsideWorkRefused\(\)\) return;/);
    expect(index).toMatch(/function journalHandleUnseenFrame\(frame\) \{\n[^\n]*\n {2}if \(outsideWorkRefused\(\)\) return;/);
    expect(index).toMatch(/notifyRoom: \(\.\.\.args\) => \{ if \(!outsideWorkRefused\(\)\) journalNotifyRoomEvent\(\.\.\.args\); \}/);
  });

  it('room messages queued behind a turn stay queued while the box is locked, and go when it is unlocked', () => {
    const make = body('const roomDelivery = createRoomDelivery({', '\n});');
    expect(make).toMatch(/isHeld: \(\) => outsideWorkRefused\(\)/);
    // An arrival behind waiting messages asks the gated drain; it never flushes by itself.
    expect(make).toMatch(/requestDrain: \(session\) => maybeFlushRoomDelivery\(session\)/);
    // Every drain goes through the one flush, which asks the hold first.
    expect(index.match(/roomDelivery\.flush\(/g) || []).toHaveLength(1);
    const drain = body('function drainHeldRoomDeliveries()', '\n}\n');
    expect(drain).toMatch(/if \(outsideWorkRefused\(\)\) return;/);
    expect(drain).toMatch(/roomDelivery\.pendingKeys\(\)/);
    expect(drain).toMatch(/maybeFlushRoomDelivery\(session\)/);
    const lock = body('const boxLock = approvalGate.enabled ? createBoxLock({', '\n}) : null;');
    expect(lock).toMatch(/onChange: \(\) => \{[\s\S]*drainHeldRoomDeliveries\(\)/);
  });

  it('a session control action parked while the session was busy is not applied once the unlock window has closed', () => {
    expect(index).toMatch(/function drainDeferredControls\(session\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(outsideWorkRefused\(\)\) return false;/);
  });

  it('a box with approval keys does not start a session from a typed command', () => {
    const head = body('async function handleCommand(roomId, text, sendReply) {', 'switch (cmd) {');
    expect(head).toMatch(/approvalGate\.enabled && \(cmd === '!start' \|\| cmd === '!workdir'\)/);
    expect(head).toMatch(/return;/);
  });
});
