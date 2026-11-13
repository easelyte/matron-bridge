import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js, same idiom as test/inflight-wiring.test.js.
// index.js has no unit-test harness. The queued-release F1 timing fix (defer the
// boot reconcile behind a quiet-period timer re-armed by inbound frames, so the
// replay's ack lands before reconcile) lives in reconnect wiring that sits
// OUTSIDE the source slice test/queued-release-index.test.js evals — so those
// behavioural tests prove scheduleReleaseReconcile's logic in isolation, not that
// it is actually wired at the reconnect call site or that an inbound frame
// re-arms it. Both regress SILENTLY: reverting either edge to the pre-fix form
// leaves the full suite green while restoring the exact F1 race. These pin the
// wiring itself.
describe('queued-release reconnect wiring (F1)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  function bodyOf(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    expect(start, `could not find ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    const end = src.indexOf(endNeedle, start + 1);
    expect(end, `could not find the end of ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  it('wires the journal consumer onReconnect to handleJournalReconnect', () => {
    expect(
      src,
      'onReconnect must be handleJournalReconnect — the union handler that runs BOTH #207 stranded-subagent '
      + 'reconcile and #536 release retry + deferred reconcile',
    ).toMatch(/onReconnect:\s*handleJournalReconnect\b/);
  });

  it('handleJournalReconnect runs both reconnect wirings — #207 reconcile AND #536 via journalOnReconnect', () => {
    const body = bodyOf('function handleJournalReconnect(', '\nfunction ');
    expect(
      body,
      'handleJournalReconnect must reconcile stranded subagents (#207) — dropping it silently loses ghost-child cleanup',
    ).toMatch(/reconcileStrandedSubagents\(/);
    expect(
      body,
      'handleJournalReconnect must invoke journalOnReconnect (#536): the union conflict with #207 presents onReconnect '
      + 'as either/or, and taking one side silently kills the queued-release reconnect path (republish + deferred reconcile) '
      + 'while shipping green',
    ).toMatch(/journalOnReconnect\(/);
  });

  it('journalOnReconnect DEFERS the boot reconcile and never runs it synchronously (F1 call-site)', () => {
    const body = bodyOf('function journalOnReconnect(', '\nfunction ');
    expect(
      body,
      'journalOnReconnect must arm the deferred reconcile (scheduleReleaseReconcile), not run it inline',
    ).toMatch(/scheduleReleaseReconcile\(/);
    // The F1 bug is reverting this call site to a synchronous reconcileReleaseOutbox(),
    // which races the ack-bearing replay and stamps a committed release `expired`.
    // The behavioural tests don't catch the revert (the helper still works); this does.
    expect(
      body,
      'journalOnReconnect must NOT call reconcileReleaseOutbox() synchronously at the reconnect path — that IS the F1 race',
    ).not.toMatch(/reconcileReleaseOutbox\(/);
  });

  it('an inbound journal frame re-arms the deferred reconcile (F1 re-arm hook)', () => {
    const body = bodyOf('function journalHandleInboundEvent(', '\nfunction ');
    expect(
      body,
      'journalHandleInboundEvent must re-arm scheduleReleaseReconcile while a reconcile is pending, so it fires only '
      + 'after the reconnect replay burst goes quiet — deleting the re-arm restores the F1 race with CI fully green',
    ).toMatch(/_releaseReconcileTimer\) scheduleReleaseReconcile\(/);
  });
});
