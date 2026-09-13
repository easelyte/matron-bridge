import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js, same idiom as test/inflight-wiring.test.js.
// index.js has no unit-test harness, and /sleep is the bridge's only command
// that runs a host command capable of killing this process — so the couplings
// below are exactly the ones that must not regress silently:
//
//   - a hand-rolled button set would drift from lib/sleep-command.js's ids and
//     values, and a picker tap that matches neither is a SILENT no-op: the user
//     presses "Sleep now" and nothing at all happens;
//   - performSleep's publish -> flush -> exec ordering is only worth anything
//     if the REAL journal flush is wired in. A no-op flush still passes every
//     unit test in test/sleep-command.test.js while losing the goodbye message
//     on every real sleep;
//   - the executed string must come from configuration, never from chat text.
describe('/sleep wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  function bodyOf(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    expect(start, `could not find ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    const end = src.indexOf(endNeedle, start + 1);
    expect(end, `could not find the end of ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  it('imports the card and action from lib/sleep-command.js rather than inlining them', () => {
    expect(src).toMatch(/import \{[^}]*sleepButtons[^}]*\} from '\.\/lib\/sleep-command\.js'/s);
    expect(src).toMatch(/import \{[^}]*performSleep[^}]*\} from '\.\/lib\/sleep-command\.js'/s);
  });

  it('builds the confirmation card from sleepButtons()', () => {
    const body = bodyOf("case '!sleep'", "\n    case '!tools'");
    expect(
      body,
      'the /sleep card must use sleepButtons() — hand-rolled ids/values drift from '
      + 'lib/picker-dispatch.js and lib/journal-input-router.js, and a tap that matches '
      + 'neither silently does nothing',
    ).toContain('sleepButtons()');
  });

  it('refuses before publishing a card when no sleep command is configured', () => {
    const body = bodyOf("case '!sleep'", "\n    case '!tools'");
    expect(
      body,
      'an unconfigured box must say so, not offer a button that cannot work',
    ).toContain('SLEEP_NOT_CONFIGURED');
  });

  it('passes the real journal flush into performSleep', () => {
    const body = bodyOf('async function confirmSleepFromButton(', '\nasync function ');
    expect(
      body,
      'performSleep must receive the REAL journalPublisher.flush: its whole purpose is '
      + 'settling the goodbye before the host command kills this process',
    ).toMatch(/flush:.*journalPublisher\.flush/s);
  });

  it('exempts sleep: taps from the session-alive gate', () => {
    // /sleep is box-scoped: whether an AGENT session is alive has nothing to
    // do with whether the machine can power off. Without the exemption a tap
    // on a dead-but-present session (mid-teardown, idle-reaped, or a Codex
    // logical session between turns) burns the single-use card and answers a
    // sleep request with a message about model/effort/mode switching.
    const body = bodyOf('const skipsAliveGate', 'if (!session.alive');
    expect(body).toContain("startsWith('sleep:')");
  });

  it('does not kill sessions before the host command has succeeded', () => {
    // A failed command (passworded sudo) would otherwise leave a live bridge
    // with every session destroyed. On a command that DOES work, systemd
    // SIGTERMs the bridge into gracefulShutdown, which kills sessions and
    // flushes already — so doing it here is both redundant and destructive.
    const body = bodyOf('async function confirmSleepFromButton(', '\n// A tap on the same card');
    expect(body).not.toMatch(/killSession/);
  });

  it('executes the configured command, never chat text', () => {
    const body = bodyOf('async function confirmSleepFromButton(', '\nasync function ');
    expect(
      body,
      'the executed string must come from sleepConfig() — the environment, not chat text',
    ).toMatch(/sleepConfig\(\)/);
    expect(
      body,
      "the shell must run performSleep's `cmd` argument verbatim, via the tested "
      + 'runSleepCommand seam; interpolating anything else into the command line is how '
      + 'chat text would reach a shell',
    ).toMatch(/runSleepCommand\(cmd, \{ spawn \}\)/);
  });

  it('wires confirmSleep and cancelSleep into the picker dispatcher', () => {
    // Without these seams a sleep:confirm tap parses fine and then dispatches
    // to undefined — a crash or a silent no-op depending on the call path.
    expect(src).toMatch(/confirmSleep:\s*\w+/);
    expect(src).toMatch(/cancelSleep:\s*\w+/);
  });

  it('lists /sleep in the command reference', () => {
    expect(src).toMatch(/'\/sleep'/);
  });

  it('routes a verified sleep: tap whose session was reaped through the sessionless seam', () => {
    // The idle reaper removes the session long before a walk-away user taps;
    // the router hands such taps to routeSessionlessPickerTap, which must
    // reach the same confirm/cancel handlers the live path uses.
    const body = bodyOf('routeSessionlessPickerTap: (convoId', '\n  noticeUnknownConvo:');
    expect(body).toContain('confirmSleepFromButton(null, sendReply)');
    expect(body).toContain('cancelSleepFromButton(null, sendReply)');
    expect(body, 'a confirm stops the machine: it needs the same replay guard as journalOnPromptReply')
      .toContain('journalPublisher.flushCursor()');
  });
});
