import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js, same idiom as test/inflight-wiring.test.js.
// index.js has no unit-test harness (importing it boots a bridge), so the
// loop-#701 wiring — "consume the interrupt's control_response ack" and the
// [wedge] tripwire — has no behavioural coverage there. The decision logic
// itself IS behaviourally covered in test/print-interrupt.test.js; these pin the
// couplings that only exist at the call site and that regress silently:
//
//   - drop the control_response case  -> the ack is dropped on the floor again
//                                        and the 10s overlap window is back;
//   - match on anything but the PENDING interrupt's own request_id
//                                     -> an unrelated control_response disarms
//                                        a live wedge;
//   - lose the [wedge] console.warn   -> "has this ever fired?" needs a journal
//                                        DB query again (it did, for 52 days).
describe('interrupt-ack backstop wiring (loop #701)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  function bodyOf(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    expect(start, `could not find ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    const end = src.indexOf(endNeedle, start + 1);
    expect(end, `could not find the end of ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  it('imports the ack helpers from lib/print-interrupt.js', () => {
    const importLine = src.match(/import \{[^}]*\} from '\.\/lib\/print-interrupt\.js';/);
    expect(importLine, 'index.js must import from lib/print-interrupt.js').not.toBeNull();
    expect(importLine[0]).toContain('isInterruptAck');
    expect(importLine[0]).toContain('applyInterruptAck');
    expect(importLine[0]).toContain('INTERRUPT_ACK_BACKSTOP_MS');
    expect(importLine[0]).toContain('INTERRUPT_FALLBACK_MS');
  });

  it('handles control_response in handleClaudeEvent and routes it through applyInterruptAck', () => {
    const body = bodyOf('function handleClaudeEvent(', '\n// --- Text Helpers ---');

    expect(
      body,
      'handleClaudeEvent must have a `case \'control_response\':`. Every stdout JSON line lands '
      + 'here; before #701 control_response fell through to `default: break` and the CLI\'s ~17ms '
      + 'interrupt acknowledgement was discarded. That ack is the only signal that distinguishes '
      + '"the CLI is wedged" (what the 10s unstick is for) from "the CLI heard us and is stopping" '
      + '(where clearing busy opens the turn-overlap window that can silently eat the operator\'s '
      + 'next message).',
    ).toContain("case 'control_response':");

    expect(
      body,
      'the control_response case must delegate to applyInterruptAck(session.pendingInterrupt, event). '
      + 'applyInterruptAck matches the PENDING interrupt\'s own request_id and is the single place '
      + 'the already-fired / already-cancelled / already-acked guards live. Inlining a looser match '
      + 'here (e.g. any control_response, or a top-level id compare) would let an unrelated control '
      + 'response disarm a live wedge.',
    ).toContain('applyInterruptAck(pending, event)');
    expect(body).toContain('const pending = session.pendingInterrupt;');
  });

  // Codex R1 F2. The whole value of the tripwire is that `[wedge]` means one
  // thing: the unstick actually fired and the turn-overlap window is open. A
  // routine interrupt ack is the OPPOSITE outcome and happens on every single
  // interrupt (~1/day), so tagging it `[wedge]` too would make the grep — and
  // any future alert rule on it — report normal operation as an incident.
  it('reserves the [wedge] prefix for real firings; the ack logs under [interrupt]', () => {
    const ackCase = bodyOf("case 'control_response': {", '\n    default:');

    expect(
      ackCase,
      'the control_response case must NOT log under the [wedge] prefix — that prefix is the '
      + 'alertable "the overlap window opened" signal, and an ack is proof it did not. '
      + '(Asserted on the console.* call form so the explanatory comment naming the prefix does '
      + 'not trip it.)',
    ).not.toMatch(/console\.(log|warn|error|info)\(\s*'\[wedge\]/);
    expect(ackCase).toContain("'[interrupt] acked by claude");

    // Drift detector for the external contract this case depends on: a
    // control_response that arrives while our interrupt is pending but does not
    // carry our request_id means the CLI changed the envelope, and the ack
    // silently stops matching (the 10s path quietly returns).
    expect(ackCase).toContain('isInterruptAck(event, pending.requestId)');
    expect(ackCase).toMatch(/console\.warn\(\s*'\[interrupt\] control_response did not match/);
  });

  it('arms the ack backstop on the interrupt it sends', () => {
    const body = bodyOf('async function printModeInterrupt(', '\nfunction bumpTurnGeneration(');

    expect(
      body,
      'printModeInterrupt must pass backstopMs: INTERRUPT_ACK_BACKSTOP_MS to sendPrintInterrupt. '
      + 'The ack REPLACES the 10s wedge with this longer backstop rather than cancelling it — a CLI '
      + 'version could acknowledge the interrupt and then never deliver a result, and the session '
      + 'must still recover instead of queueing messages behind a busy flag forever.',
    ).toContain('backstopMs: INTERRUPT_ACK_BACKSTOP_MS');
  });

  it('keeps the wedge purely additive: the no-ack path still clears busy', () => {
    const body = bodyOf('async function printModeInterrupt(', '\nfunction bumpTurnGeneration(');

    // #701 is a timing change only. If the busy-clear ever disappears from
    // onWedge, a wedged CLI queues the operator's messages behind a flag
    // nothing will clear — strictly worse than the bug #701 fixes. And the
    // shouldFireWedge generation gate from #688/#44 must survive untouched.
    expect(body).toContain('session.busy = false;');
    expect(body).toContain('shouldFireWedge: () => session.turnGeneration === armedGeneration');
    // The "Deliberately NO noteTurnEnd" stance is load-bearing and is stated in
    // a comment inside onWedge; assert on the CALL form so the comment itself
    // doesn't satisfy the check.
    expect(
      body,
      'onWedge must NOT call inflightMarker.noteTurnEnd — see the comment in printModeInterrupt. '
      + 'The wedge is a defensive unstick after an unacknowledged interrupt, not a turn end; '
      + 'clearing the marker here would drop the carry-on card for a turn that really was '
      + 'interrupted. #701 does not change that.',
    ).not.toContain('inflightMarker.noteTurnEnd(');
  });

  it('logs a greppable [wedge] tripwire when the wedge actually fires', () => {
    const body = bodyOf('async function printModeInterrupt(', '\nfunction bumpTurnGeneration(');

    // Option A of the #701 scoping analysis. There was no console.* anywhere in
    // the wedge path, which is why answering "has this ever fired?" required a
    // journal DB query over 52 days of events. The prefix must stay stable and
    // greppable: `journalctl -u matron-bridge-journal | grep '\[wedge\]'`.
    expect(body).toMatch(/console\.warn\(\s*'\[wedge\] interrupt %s after %dms/);
    expect(
      body,
      'the tripwire must carry the room id and the armed generation — without them a firing is '
      + 'unattributable to a session or a turn.',
    ).toContain('armedGeneration');
    expect(body).toContain('session.roomId');
  });

  // Codex R1 F2, second half. The wedge now has two deadlines. Telling the
  // operator "No response after 10s" when the CLI DID respond and we then
  // waited 60s is misleading recovery evidence — it points them at the wrong
  // failure. Both the log line and the chat notice must be derived from the
  // acknowledged state.
  it('derives the operator notice from the deadline that actually elapsed', () => {
    const body = bodyOf('async function printModeInterrupt(', '\nfunction bumpTurnGeneration(');

    expect(body).toContain('const acked = interruptHandle?.acknowledged === true;');
    expect(
      body,
      'the wedge notice must not hardcode "10s" — the acked firing waits INTERRUPT_ACK_BACKSTOP_MS.',
    ).not.toContain('after 10s');
    expect(body).toContain('claude acknowledged the interrupt but the turn has not ended after');
    expect(body).toContain('No response to the interrupt after');
  });
});
