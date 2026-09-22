import { describe, expect, it } from 'vitest';
import { redactAndRoute } from '../lib/codex-event-format.js';
import { createPublishRedactor } from '../lib/redact.js';

// Loop #762 — guards-first, version-tolerant codex-viz rendering.
//
// These tests prove the env-dump / secret-reference guards in allowlistedEvent
// run UNCONDITIONALLY for command_execution across every envelope
// (item.started, item.completed, item.delta, and an unknown/newer type) and
// across every output-carrying field alias. They FAIL against a naive
// version-tolerant routing that leaves the guards gated on item.completed while
// extracting/forwarding under other envelopes (the hole reverted 3-4× before).

const RUN_ID = 'run-egress-1';
const CONVO_ID = `parent:codex:${RUN_ID}`;
// A live in-band version and two future versions above the old 0.156.0 ceiling
// — version-tolerance means all three render richly with no manual band bump.
const SUPPORTED = 'codex-cli 0.155.1';

// A secret VALUE the redactor deliberately does NOT scrub, so any egress is
// visible in the published frames. This proves the DROP guard — not redaction —
// is what prevents the leak (real leaks used innocuous env names the baseline
// redactor cannot catch).
const SECRET = 'innocuous-value-9f3a-do-not-leak';

// A raw env dump under innocuous names: >=3 assignment lines, >=60% assignments
// → matches looksLikeRawEnvDump.
const ENV_DUMP = [
  `ALPHA=${SECRET}`,
  `BRAVO=${SECRET}-2`,
  `CHARLIE=${SECRET}-3`,
  'HOME=/root',
].join('\n');

// Identity redactor: leaves SECRET intact so egress is detectable.
const noopRedact = value => value;

function makePublisher() {
  const calls = [];
  return {
    calls,
    publishToolOutput(convoId, payload) { calls.push({ method: 'publishToolOutput', convoId, payload }); return true; },
    publishText(convoId, payload, options) { calls.push({ method: 'publishText', convoId, payload, options }); return true; },
    publishActivity(convoId, state, detail) { calls.push({ method: 'publishActivity', convoId, state, detail }); },
    publishStatus(convoId, payload) { calls.push({ method: 'publishStatus', convoId, payload }); },
  };
}

function route(event, { redact = noopRedact, schemaVersion = SUPPORTED } = {}) {
  const publisher = makePublisher();
  const state = {};
  redactAndRoute(event, {
    publisher,
    convoId: CONVO_ID,
    runId: RUN_ID,
    meta: { schemaVersion },
    state,
    redact,
  });
  return { publisher, state };
}

const ENVELOPES = ['item.started', 'item.completed', 'item.delta', 'item.updated'];
// item.updated stands in for an unknown/newer envelope.
// Every alias in COMMAND_OUTPUT_FIELDS — the command guard must scan them all.
const OUTPUT_ALIASES = ['aggregated_output', 'output', 'message', 'text', 'delta', 'chunk', 'stdout', 'stderr'];

describe('codex-viz command_execution egress guard (unconditional across envelopes)', () => {
  for (const envelope of ENVELOPES) {
    for (const field of OUTPUT_ALIASES) {
      it(`drops a raw env dump in item.${field} under ${envelope} and never egresses the secret`, () => {
        const event = {
          type: envelope,
          item: {
            id: 'cmd-egress',
            type: 'command_execution',
            command: 'run something benign',
            [field]: ENV_DUMP,
          },
        };
        const { publisher, state } = route(event);
        const serialized = JSON.stringify(publisher.calls);
        expect(serialized, `${envelope} / ${field}`).not.toContain(SECRET);
        expect(state.redactionDropCount, `${envelope} / ${field}`).toBe(1);
        expect(publisher.calls, `${envelope} / ${field}`).toEqual([]);
      });
    }

    it(`drops a raw env-dump command (env) under ${envelope}`, () => {
      const { publisher, state } = route({
        type: envelope,
        item: { id: 'cmd-env', type: 'command_execution', command: 'env' },
      });
      expect(state.redactionDropCount, envelope).toBe(1);
      expect(publisher.calls, envelope).toEqual([]);
    });

    it(`drops a secret-env-referencing command under ${envelope}, dump in output`, () => {
      const { publisher, state } = route({
        type: envelope,
        item: {
          id: 'cmd-ref',
          type: 'command_execution',
          command: 'printenv DATABASE_PASSWORD',
          aggregated_output: ENV_DUMP,
        },
      });
      const serialized = JSON.stringify(publisher.calls);
      expect(serialized, envelope).not.toContain(SECRET);
      expect(state.redactionDropCount, envelope).toBe(1);
      expect(publisher.calls, envelope).toEqual([]);
    });
  }

  it('does not over-drop a legitimate command_execution under item.delta', () => {
    const { publisher, state } = route({
      type: 'item.delta',
      item: { id: 'cmd-ok', type: 'command_execution', command: 'npm test', aggregated_output: 'ok\n' },
    });
    expect(state.redactionDropCount ?? 0).toBe(0);
    // Renders (as text passthrough for the delta envelope) without leaking.
    expect(publisher.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(publisher.calls)).toContain('npm test');
  });
});

describe('codex-viz top-level error diagnostics (loop #762 follow-up)', () => {
  it('renders a top-level error message at 0.155.1 (regression) instead of dropping it', () => {
    const { publisher, state } = route({ type: 'error', message: 'fatal upstream failure' });
    const body = publisher.calls.find(call => call.method === 'publishText')?.payload.body;
    expect(body).toBeTypeOf('string');
    expect(body).toContain('fatal upstream failure');
    expect(state.redactionDropCount ?? 0).toBe(0);
  });

  it('redacts a secret inside a top-level error message', () => {
    const redact = value => value.replaceAll('SENTINEL_CRED', '[REDACTED]');
    const { publisher } = route(
      { type: 'error', message: 'fatal SENTINEL_CRED failure' },
      { redact },
    );
    const body = publisher.calls.find(call => call.method === 'publishText')?.payload.body;
    expect(body).toContain('[REDACTED]');
    expect(body).not.toContain('SENTINEL_CRED');
  });

  it('scrubs assignment values in a top-level error whose message is a raw env dump', () => {
    const { publisher } = route({ type: 'error', message: ENV_DUMP });
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[REDACTED-ENV]');
  });

  it('scrubs assignment values diluted by prose (ratio-dodge), preserving the prose', () => {
    // Codex r3 F1: two assignments mixed with two prose lines dodge any
    // dominance-ratio heuristic; scrubbing catches them regardless.
    const { publisher } = route({
      type: 'error',
      message: 'fatal\nalpha=prose-secret-1\nbravo=prose-secret-2\nat worker.js:1',
    });
    const body = publisher.calls.find(call => call.method === 'publishText')?.payload.body;
    expect(body).not.toContain('prose-secret-1');
    expect(body).not.toContain('prose-secret-2');
    expect(body).toContain('fatal');
    expect(body).toContain('at worker.js:1');
  });

  it('preserves an inline key=value mention inside prose (not a bare assignment line)', () => {
    const { publisher } = route({ type: 'error', message: 'connection failed: host=db.internal' });
    const body = publisher.calls.find(call => call.method === 'publishText')?.payload.body;
    expect(body).toContain('host=db.internal');
  });
});

describe('codex-viz unknown/future item type diagnostics', () => {
  it('renders a newer item type as a safe { type } stub without forwarding its fields', () => {
    const { publisher } = route({
      type: 'item.completed',
      item: { id: 'x', type: 'future_diag', message: 'informative detail', structural: { drop: 'me' } },
    });
    const serialized = JSON.stringify(publisher.calls);
    // The item type is visible, but arbitrary textual/structural fields are NOT
    // forwarded — a future codex that renames a command item and streams output
    // in a textual field the command guard never sees cannot egress here.
    expect(serialized).toContain('future_diag');
    expect(serialized).not.toContain('informative detail');
    expect(serialized).not.toContain('structural');
  });

  it('never egresses a raw env dump carried in an unknown item textual field', () => {
    const { publisher } = route({
      type: 'item.completed',
      item: { id: 'x', type: 'future_diag', message: ENV_DUMP },
    });
    expect(JSON.stringify(publisher.calls)).not.toContain(SECRET);
  });
});

describe('codex-viz version tolerance (no upper band, no manual bump)', () => {
  for (const schemaVersion of ['codex-cli 0.155.1', 'codex-cli 0.156.0', 'codex-cli 1.0.0']) {
    it(`renders a command_execution richly under ${schemaVersion}`, () => {
      const { publisher } = route({
        type: 'item.completed',
        item: {
          id: 'item_1', type: 'command_execution', command: 'printf ok',
          aggregated_output: 'ok', exit_code: 0, status: 'completed',
        },
      }, { schemaVersion });
      const tool = publisher.calls.find(call => call.method === 'publishToolOutput');
      expect(tool, schemaVersion).toBeDefined();
      expect(tool.payload).toEqual({
        tool_use_id: 'item_1', command: 'printf ok', output: 'ok', exit_code: 0, status: 'completed',
      });
    });
  }

  it('still fails safe to text passthrough below the schema floor', () => {
    const { publisher, state } = route({
      type: 'item.completed',
      item: {
        id: 'item_1', type: 'command_execution', command: 'printf ok',
        aggregated_output: 'ok', exit_code: 0, status: 'completed',
      },
    }, { schemaVersion: 'codex-cli 0.145.0' });
    // Below floor → generic text passthrough, never the rich tool-output route.
    expect(publisher.calls.some(call => call.method === 'publishToolOutput')).toBe(false);
    expect(publisher.calls.some(call => call.method === 'publishText')).toBe(true);
    expect(state.unparsed).toBe(1);
  });
});

// Codex adversarial review, round 1, blockers F1 + F2 — reproduced by the
// reviewer with the PRODUCTION baseline redactor (which cannot scrub secrets
// under innocuous env names). These lock in the fixes using that same redactor.
describe('codex-viz egress hardening (production baseline redactor)', () => {
  // Baseline-only redactor: no policy file, never reads disk. It redacts
  // secret-KEY-named assignments but leaves innocuous-named values intact — so
  // any value that reaches a frame here is a genuine leak, not a redaction gap.
  const baseline = createPublishRedactor({ env: {}, readFileSyncFn: () => '' });

  // A partial (below-threshold) env dump under INNOCUOUS uppercase names the
  // baseline redactor does not scrub.
  const PARTIAL = 'ALPHA=partial-secret-1\nBRAVO=partial-secret-2';
  // A full lowercase env dump — env names may be lowercase, and the pre-fix
  // classifier only matched uppercase.
  const LOWER_DUMP = 'alpha=lower-secret-1\nbravo=lower-secret-2\ncharlie=lower-secret-3';

  function routeBaseline(event) {
    return route(event, { redact: baseline });
  }

  it('F1: a partial env dump streamed in item.delta output never egresses (output not forwarded off item.completed)', () => {
    const { publisher } = routeBaseline({
      type: 'item.delta',
      item: { id: 'c', type: 'command_execution', command: 'load config', aggregated_output: PARTIAL },
    });
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('partial-secret-1');
    expect(serialized).not.toContain('partial-secret-2');
  });

  it('F1: a partial env dump under an unknown envelope never egresses', () => {
    const { publisher } = routeBaseline({
      type: 'item.updated',
      item: { id: 'c', type: 'command_execution', command: 'load config', output: PARTIAL },
    });
    expect(JSON.stringify(publisher.calls)).not.toContain('partial-secret');
  });

  it('F2: a lowercase env dump in a top-level error message has its values scrubbed', () => {
    const { publisher } = routeBaseline({ type: 'error', message: LOWER_DUMP });
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('lower-secret');
    expect(serialized).toContain('[REDACTED-ENV]');
  });

  it('F2: a lowercase env dump in an unknown item textual field never egresses (field not forwarded)', () => {
    const { publisher } = routeBaseline({
      type: 'item.completed',
      item: { id: 'x', type: 'future_diag', message: LOWER_DUMP },
    });
    expect(JSON.stringify(publisher.calls)).not.toContain('lower-secret');
  });

  it('F1(b): a two-line env dump in a top-level error message has its values scrubbed', () => {
    const TWO_LINE = 'alpha=lower-secret-1\nbravo=lower-secret-2';
    const { publisher } = routeBaseline({ type: 'error', message: TWO_LINE });
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('lower-secret');
    expect(serialized).toContain('[REDACTED-ENV]');
  });

  it('F1(b): a legitimate inline key=value diagnostic is preserved (prose, not a bare line)', () => {
    const { publisher } = routeBaseline({ type: 'error', message: 'connection failed: host=db.internal' });
    const body = publisher.calls.find(call => call.method === 'publishText')?.payload.body;
    expect(body).toContain('host=db.internal');
  });

  it('F2 (r3): an overflow schema version fails safe to text passthrough, not rich routing', () => {
    const overflowVersion = `codex-cli ${'9'.repeat(400)}.0.0`;
    const { publisher, state } = route({
      type: 'item.completed',
      item: {
        id: 'c', type: 'command_execution', command: 'printf ok',
        aggregated_output: 'ALPHA=overflow-canary', exit_code: 0, status: 'completed',
      },
    }, { redact: baseline, schemaVersion: overflowVersion });
    // Infinity-valued component must be rejected → generic text passthrough,
    // never the rich publishToolOutput route. The generic fallback also omits
    // aggregated_output entirely, so the canary never reaches the client.
    expect(publisher.calls.some(call => call.method === 'publishToolOutput')).toBe(false);
    expect(JSON.stringify(publisher.calls)).not.toContain('overflow-canary');
    expect(state.unparsed).toBe(1);
  });

  it('F2: a lowercase env dump in command_execution output is dropped', () => {
    const { publisher, state } = routeBaseline({
      type: 'item.completed',
      item: { id: 'c', type: 'command_execution', command: 'cat config', aggregated_output: LOWER_DUMP },
    });
    expect(JSON.stringify(publisher.calls)).not.toContain('lower-secret');
    expect(state.redactionDropCount).toBe(1);
    expect(publisher.calls).toEqual([]);
  });

  it('delta gate: an overflow-version top-level error diagnostic is still scrubbed via the generic fallback', () => {
    const overflowVersion = `codex-cli ${'9'.repeat(400)}.0.0`;
    const { publisher } = route(
      { type: 'error', message: 'alpha=fallback-secret-1' },
      { redact: baseline, schemaVersion: overflowVersion },
    );
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('fallback-secret-1');
    expect(serialized).toContain('[REDACTED-ENV]');
  });

  it('delta gate: a NUL-delimited env dump in a below-floor error diagnostic is scrubbed', () => {
    const NUL_DUMP = 'alpha=nul-secret-1\0bravo=nul-secret-2\0charlie=nul-secret-3';
    const { publisher } = route(
      { type: 'error', message: NUL_DUMP },
      { redact: baseline, schemaVersion: 'codex-cli 0.145.0' },
    );
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('nul-secret');
    expect(serialized).toContain('[REDACTED-ENV]');
  });

  it('delta gate 2: a NUL-framed env value that itself contains a newline is fully scrubbed', () => {
    // NUL is the authoritative delimiter; the continuation bytes of the first
    // entry's value must not survive as if they were a separate line.
    const MIXED = 'ALPHA=first-line\ncontinuation-secret\0BRAVO=second-secret';
    const { publisher } = route(
      { type: 'error', message: MIXED },
      { redact: baseline, schemaVersion: SUPPORTED },
    );
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('continuation-secret');
    expect(serialized).not.toContain('first-line');
    expect(serialized).not.toContain('second-secret');
    expect(serialized).toContain('[REDACTED-ENV]');
  });

  it('delta gate: an env dump in a below-floor item textual field is scrubbed via the generic fallback', () => {
    const { publisher } = route(
      { type: 'item.completed', item: { id: 'x', type: 'future_answer', answer: LOWER_DUMP } },
      { redact: baseline, schemaVersion: 'codex-cli 0.145.0' },
    );
    const serialized = JSON.stringify(publisher.calls);
    expect(serialized).not.toContain('lower-secret');
    expect(serialized).toContain('[REDACTED-ENV]');
  });
});
