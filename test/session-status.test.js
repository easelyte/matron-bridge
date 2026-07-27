import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  contextWindowFor,
  reconcileModelForWindow,
  contextTokensFromUsage,
  contextTokensFromAssistantEvent,
  postCompactContextTokens,
  compactTriggerFrom,
  contextGaugeText,
  buildSessionStatus,
  emailFromClaudeConfig,
  hostVitalLimits,
  sampleCpuOnce,
  cpuPercent,
  cpuSampledAtMs,
  ramPercent,
  startCpuSampler,
  stopCpuSampler,
} from '../lib/session-status.js';

describe('contextWindowFor', () => {
  it('gives 1m-default session models their full window', () => {
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-mythos-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-5[1m]')).toBe(1_000_000);
    // Current Opus + Sonnet 5 default their SESSIONS to 1m (measured via
    // `claude -p /context`), even with no [1m] marker on the bare API id.
    expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-7')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000);
  });

  it('defaults older / smaller models to 200k unless [1m] is appended', () => {
    expect(contextWindowFor('claude-opus-4-6')).toBe(200_000);
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(contextWindowFor('<synthetic>')).toBe(200_000);
  });

  it('handles a missing model', () => {
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });
});

describe('reconcileModelForWindow', () => {
  it('keeps the [1m] launch model when the bare stream id would narrow it', () => {
    // A session launched as e.g. opus-4-6[1m], whose first assistant event
    // reports the bare 200k-default id, must NOT drop to a 200k window.
    expect(reconcileModelForWindow('claude-opus-4-6[1m]', 'claude-opus-4-6')).toBe('claude-opus-4-6[1m]');
    expect(reconcileModelForWindow('claude-sonnet-4-5[1m]', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5[1m]');
    // Widen-only also refuses a genuine downgrade in the event path (a real
    // /model switch flows through its own path, not this reconcile).
    expect(reconcileModelForWindow('claude-opus-4-8', 'claude-haiku-4-5')).toBe('claude-opus-4-8');
  });

  it('adopts the new model when it widens or matches the window', () => {
    expect(reconcileModelForWindow('claude-opus-4-8', 'claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
    expect(reconcileModelForWindow('claude-opus-4-6', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(reconcileModelForWindow('claude-fable-5', 'claude-mythos-5')).toBe('claude-mythos-5');
  });

  it('handles missing sides without narrowing', () => {
    expect(reconcileModelForWindow(null, 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(reconcileModelForWindow('opus[1m]', null)).toBe('opus[1m]');
    expect(reconcileModelForWindow(null, null)).toBe(null);
    expect(reconcileModelForWindow(undefined, undefined)).toBe(null);
  });
});

describe('contextTokensFromUsage', () => {
  it('sums input + cache read + cache creation (the context footprint of the last request)', () => {
    expect(contextTokensFromUsage({
      input_tokens: 12,
      cache_read_input_tokens: 250_000,
      cache_creation_input_tokens: 3_400,
      output_tokens: 999, // excluded: output is not part of the next request's context
    })).toBe(253_412);
  });

  it('treats missing fields as zero', () => {
    expect(contextTokensFromUsage({ input_tokens: 100 })).toBe(100);
  });

  it('returns null when there is no usable usage', () => {
    expect(contextTokensFromUsage(null)).toBeNull();
    expect(contextTokensFromUsage(undefined)).toBeNull();
    expect(contextTokensFromUsage({})).toBeNull();
  });
});

describe('contextTokensFromAssistantEvent', () => {
  const usage = { input_tokens: 2, cache_read_input_tokens: 28_793, cache_creation_input_tokens: 1_315 };

  it("returns the last request's context footprint from a parent-stream assistant event", () => {
    expect(contextTokensFromAssistantEvent({ type: 'assistant', parent_tool_use_id: null, message: { usage } }))
      .toBe(30_110);
  });

  it('ignores subagent events — their usage is the subagent\'s own context, not the parent\'s', () => {
    expect(contextTokensFromAssistantEvent({ type: 'assistant', parent_tool_use_id: 'toolu_01x', message: { usage } }))
      .toBeNull();
    expect(contextTokensFromAssistantEvent({ type: 'assistant', isSidechain: true, message: { usage } }))
      .toBeNull();
  });

  it('ignores non-assistant events and events without usage', () => {
    expect(contextTokensFromAssistantEvent({ type: 'result', usage })).toBeNull();
    expect(contextTokensFromAssistantEvent({ type: 'assistant', message: {} })).toBeNull();
    expect(contextTokensFromAssistantEvent(null)).toBeNull();
  });
});

describe('postCompactContextTokens', () => {
  it('reads camelCase compactMetadata (transcript files, iv-mode)', () => {
    expect(postCompactContextTokens({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual', preTokens: 30_115, postTokens: 2_399 },
    })).toBe(2_399);
  });

  it('reads snake_case compact_metadata (stream-json stdout, print mode)', () => {
    expect(postCompactContextTokens({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 30_115, post_tokens: 2_399 },
    })).toBe(2_399);
  });

  it('returns null when metadata or post tokens are absent or zero', () => {
    expect(postCompactContextTokens({ type: 'system', subtype: 'compact_boundary' })).toBeNull();
    expect(postCompactContextTokens({ compactMetadata: { postTokens: 0 } })).toBeNull();
    expect(postCompactContextTokens(null)).toBeNull();
  });
});

describe('compactTriggerFrom', () => {
  it('reads camelCase compactMetadata (transcript files, iv-mode)', () => {
    expect(compactTriggerFrom({ compactMetadata: { trigger: 'manual', postTokens: 2_399 } })).toBe('manual');
  });

  it('reads snake_case compact_metadata (stream-json stdout, print mode)', () => {
    expect(compactTriggerFrom({ compact_metadata: { trigger: 'auto', post_tokens: 2_399 } })).toBe('auto');
  });

  it('returns null when the trigger is absent or malformed', () => {
    expect(compactTriggerFrom({ compactMetadata: {} })).toBeNull();
    expect(compactTriggerFrom({ compact_metadata: { trigger: '' } })).toBeNull();
    expect(compactTriggerFrom({})).toBeNull();
    expect(compactTriggerFrom(null)).toBeNull();
  });
});

describe('contextGaugeText', () => {
  it('formats tokens over the model window ("24k/200k")', () => {
    expect(contextGaugeText(24_313, 'claude-opus-4-6')).toBe('24k/200k');
    expect(contextGaugeText(24_313, 'claude-opus-4-8')).toBe('24k/1m');
  });

  it('keeps one decimal under 10k and formats 1m-class windows', () => {
    expect(contextGaugeText(2_399, 'claude-fable-5')).toBe('2.4k/1m');
  });

  it('passes sub-1k counts through raw', () => {
    expect(contextGaugeText(950, 'claude-opus-4-8')).toBe('950/1m');
  });

  it('returns null without a usable token count so callers fall back to non-numeric wording', () => {
    expect(contextGaugeText(null, 'claude-opus-4-8')).toBeNull();
    expect(contextGaugeText(0, 'claude-opus-4-8')).toBeNull();
    expect(contextGaugeText(undefined, 'claude-fable-5')).toBeNull();
  });
});

describe('buildSessionStatus', () => {
  it('assembles model, context gauge, and limits into one frame payload', () => {
    const status = buildSessionStatus({
      model: 'claude-fable-5',
      contextTokens: 253_412,
      limits: [{ label: 'Session', percent: 39, resets: 'Jul 14, 5:59pm (UTC)' }],
    });
    expect(status).toEqual({
      model: 'claude-fable-5',
      context: { tokens: 253_412, window: 1_000_000, pct: 25 },
      limits: [{ label: 'Session', percent: 39, resets: 'Jul 14, 5:59pm (UTC)' }],
    });
  });

  it('omits the context gauge when tokens are unknown, and limits when absent', () => {
    const status = buildSessionStatus({ model: 'claude-opus-4-8', contextTokens: null, limits: null });
    expect(status).toEqual({ model: 'claude-opus-4-8' });
  });

  it('omits the model when unknown but still reports context', () => {
    const status = buildSessionStatus({ model: null, contextTokens: 50_000, limits: [] });
    expect(status).toEqual({ context: { tokens: 50_000, window: 200_000, pct: 25 } });
  });

  it('rounds pct and clamps it to 100', () => {
    // 200k-window model so the clamp path is exercised at realistic token counts.
    expect(buildSessionStatus({ model: 'claude-opus-4-6', contextTokens: 1_000 }).context.pct).toBe(1);
    expect(buildSessionStatus({ model: 'claude-opus-4-6', contextTokens: 300_000 }).context.pct).toBe(100);
  });

  it('includes the session workdir when known, omits it otherwise (#521)', () => {
    expect(buildSessionStatus({ model: 'claude-fable-5', workdir: '/opt/matron/web-journal' })).toEqual({
      model: 'claude-fable-5',
      workdir: '/opt/matron/web-journal',
    });
    expect(buildSessionStatus({ model: 'claude-fable-5', workdir: null })).toEqual({ model: 'claude-fable-5' });
    expect(buildSessionStatus({ model: 'claude-fable-5', workdir: '' })).toEqual({ model: 'claude-fable-5' });
    expect(buildSessionStatus({ model: 'claude-fable-5' })).toEqual({ model: 'claude-fable-5' });
  });

  it('includes the logged-in account email when known, omits it otherwise', () => {
    expect(buildSessionStatus({ model: 'claude-fable-5', email: 'gene@yearbook.com' })).toEqual({
      model: 'claude-fable-5',
      email: 'gene@yearbook.com',
    });
    expect(buildSessionStatus({ model: 'claude-fable-5', email: null })).toEqual({ model: 'claude-fable-5' });
    expect(buildSessionStatus({ model: 'claude-fable-5', email: '' })).toEqual({ model: 'claude-fable-5' });
  });
});

describe('emailFromClaudeConfig', () => {
  it("extracts the logged-in account's email from a parsed ~/.claude.json", () => {
    expect(emailFromClaudeConfig({ oauthAccount: { emailAddress: 'gene@yearbook.com', displayName: 'Gene' } }))
      .toBe('gene@yearbook.com');
  });

  it('returns null when logged out, malformed, or missing', () => {
    expect(emailFromClaudeConfig({})).toBeNull();
    expect(emailFromClaudeConfig({ oauthAccount: {} })).toBeNull();
    expect(emailFromClaudeConfig({ oauthAccount: { emailAddress: 42 } })).toBeNull();
    expect(emailFromClaudeConfig(null)).toBeNull();
    expect(emailFromClaudeConfig(undefined)).toBeNull();
  });
});

describe('host vitals (#526)', () => {
  // Burn real CPU so two sampleCpuOnce() calls bracket a non-zero tick window
  // (jiffy resolution is ~10ms, so ~40ms guarantees accumulated ticks).
  const busyWait = (ms) => {
    const end = Date.now() + ms;
    // eslint-disable-next-line no-empty
    while (Date.now() < end) {}
  };

  it('ramPercent returns an integer 0-100', () => {
    const p = ramPercent();
    expect(typeof p).toBe('number');
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(100);
  });

  it('cpuPercent stays null until a scheduled sample produces a valid diff', () => {
    stopCpuSampler(); // reset module state (clears baseline + cache)
    expect(cpuPercent()).toBeNull();
    sampleCpuOnce(); // establishes the baseline only — no cached value yet
    expect(cpuPercent()).toBeNull();
    busyWait(40);
    sampleCpuOnce(); // now a real diff populates the cache
    const v = cpuPercent();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });

  it('hostVitalLimits always includes host_ram with an integer percent', () => {
    const entries = hostVitalLimits();
    const ram = entries.find((e) => e.id === 'host_ram');
    expect(ram).toBeDefined();
    expect(ram.label).toBe('RAM');
    expect(Number.isInteger(ram.percent)).toBe(true);
    // Age metadata: host_ram stamps sampled_at_ms inline at read time.
    expect(typeof ram.sampled_at_ms).toBe('number');
    expect(ram.sampled_at_ms).toBeGreaterThan(0);
    // Host vitals never reset — no resets_at/resets fields.
    expect('resets_at' in ram).toBe(false);
    expect('resets' in ram).toBe(false);
  });

  it('host_cpu + host_ram carry a numeric sampled_at_ms age stamp', () => {
    stopCpuSampler();
    expect(cpuSampledAtMs()).toBeNull(); // reset clears the stamp
    sampleCpuOnce();        // baseline only — no valid sample, no stamp
    expect(cpuSampledAtMs()).toBeNull();
    busyWait(40);
    const before = Date.now();
    sampleCpuOnce();        // valid diff → stamps sampled_at_ms
    const after = Date.now();
    const stamp = cpuSampledAtMs();
    expect(typeof stamp).toBe('number');
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);

    const entries = hostVitalLimits();
    const cpu = entries.find((e) => e.id === 'host_cpu');
    const ram = entries.find((e) => e.id === 'host_ram');
    expect(cpu).toBeDefined();
    expect(cpu.sampled_at_ms).toBe(stamp); // host_cpu uses the sampler's stamp
    expect(ram).toBeDefined();
    expect(typeof ram.sampled_at_ms).toBe('number');
    expect(ram.sampled_at_ms).toBeGreaterThan(0);
  });

  it('host_cpu is STABLE across two reads in the same tick (no 0/100 collapse)', () => {
    // Reproduces the re-entrancy blocker: journalStatus fires >1x per tick.
    // The reader must not mutate the baseline, so a 2nd read in the same tick
    // returns the same cached value rather than collapsing to a 0-interval
    // reading of 0 or 100.
    stopCpuSampler();
    sampleCpuOnce();        // baseline
    busyWait(40);
    sampleCpuOnce();        // cache a real value
    const cached = cpuPercent();
    expect(Number.isInteger(cached)).toBe(true);

    // Two reads with NO intervening scheduled sample — the many-per-tick case.
    const a = hostVitalLimits().find((e) => e.id === 'host_cpu');
    const b = hostVitalLimits().find((e) => e.id === 'host_cpu');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.label).toBe('CPU');
    expect(a.percent).toBe(cached);
    expect(b.percent).toBe(cached); // stable, not recomputed to 0/100
  });

  it('a degenerate (zero-tick) sample preserves the prior cached value', () => {
    stopCpuSampler();
    sampleCpuOnce();
    busyWait(40);
    sampleCpuOnce();
    const good = cpuPercent();
    expect(Number.isInteger(good)).toBe(true);
    // Back-to-back call in the same tick: ~0 elapsed ticks → must NOT overwrite.
    sampleCpuOnce();
    expect(cpuPercent()).toBe(good);
  });

  it('startCpuSampler is idempotent and .unref()s its interval', () => {
    stopCpuSampler();
    startCpuSampler(60000);
    startCpuSampler(60000); // second call is a no-op (no duplicate interval)
    // The interval is unref'd, so it does not keep the test process alive; the
    // suite exiting cleanly is the observable proof. Just confirm teardown.
    stopCpuSampler();
    expect(cpuPercent()).toBeNull();
  });
});

// index.js can't be imported in-process (it starts the bridge), so pin the
// wiring by source inspection — same pattern as the context-command and
// journal-input-router wiring tests.
describe('index.js wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');

  it('imports the status helpers from lib/session-status.js', () => {
    expect(src).toMatch(/import \{[^}]*buildSessionStatus[^}]*\} from '\.\/lib\/session-status\.js'/);
    expect(src).toMatch(/import \{[^}]*contextTokensFromAssistantEvent[^}]*\} from '\.\/lib\/session-status\.js'/);
    expect(src).toMatch(/import \{[^}]*postCompactContextTokens[^}]*\} from '\.\/lib\/session-status\.js'/);
  });

  it('starts the CPU sampler at boot and stops it on shutdown (#526)', () => {
    // main() owns the fixed-cadence sampler so journalStatus only ever reads it.
    const main = src.slice(src.indexOf('async function main('));
    expect(main).toContain('startCpuSampler(');
    // Both signal handlers tear it down so the interval doesn't leak.
    const sigint = src.slice(src.indexOf("process.on('SIGINT'"));
    expect(sigint).toContain('stopCpuSampler()');
    const sigterm = src.slice(src.indexOf("process.on('SIGTERM'"));
    expect(sigterm).toContain('stopCpuSampler()');
  });

  it('defines a journalStatus helper that publishes via publishStatus', () => {
    const start = src.indexOf('function journalStatus(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('buildSessionStatus(');
    expect(body).toContain('publishStatus(');
  });

  it('journalStatus threads the session workdir into the frame (#521)', () => {
    const start = src.indexOf('function journalStatus(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('workdir: session.workdir');
  });

  it("the print-mode result handler publishes status WITHOUT deriving context from result usage (it's cumulative across the turn's API calls, not a context footprint)", () => {
    const start = src.indexOf("case 'result': {");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("case 'system': {", start);
    const body = src.slice(start, end);
    expect(body).not.toContain('contextTokensFromUsage(');
    expect(body).toContain('journalStatus(session)');
    expect(body).toContain('refreshUsageLimits(');
  });

  it("the assistant handler tracks the last request's context footprint for the gauge", () => {
    const start = src.indexOf("case 'assistant': {");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("case 'result': {", start);
    const body = src.slice(start, end);
    expect(body).toContain('contextTokensFromAssistantEvent(');
    expect(body).toContain('_lastContextTokens');
  });

  it('the compact_boundary handler repaints the gauge from post-compact tokens', () => {
    const start = src.indexOf("subtype === 'compact_boundary'");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("case 'stream_event'", start);
    const body = src.slice(start, end);
    expect(body).toContain('postCompactContextTokens(');
    expect(body).toContain('_lastContextTokens');
    expect(body).toContain('journalStatus(session)');
  });

  it('the compact_boundary handler confirms a manual compact in chat with the fresh gauge, in both modes', () => {
    const start = src.indexOf("subtype === 'compact_boundary'");
    const end = src.indexOf("case 'stream_event'", start);
    const body = src.slice(start, end);
    // Both metadata spellings: a camelCase-only trigger read goes dark in
    // print mode (compact_metadata), which is exactly how the confirmation
    // used to get lost there.
    expect(body).toContain('compactTriggerFrom(');
    expect(body).not.toContain('event.compactMetadata?.trigger');
    expect(body).toContain('contextGaugeText(');
    expect(body).toContain('✅ Compacted — context now');
    // The non-pending manual branch (print mode) sends the confirmation too.
    expect(body).toContain("else if (trigger === 'manual')");
    // The confirm is deduped on its own dedicated field — gating it on the
    // legacy notice's shared lastCompactCompleteNotify cooldown silently
    // swallowed manual confirms that followed any recent compaction notice
    // (bugbot, PR #125). The shared field is only ever written here.
    expect(body).toContain('_lastManualCompactConfirm');
    expect(body).not.toMatch(/if \([^)]*lastCompactCompleteNotify/);
  });

  it('limits refresh is throttled through a shared cache with an inflight guard', () => {
    const start = src.indexOf('function refreshUsageLimits(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('inflight');
    expect(body).toContain('fetchUsageLimitsText(');
    expect(body).toContain('parseUsageLimits(');
    expect(src).toContain('LIMITS_REFRESH_MS');
  });

  it('limits refresh is a no-op when the journal is disabled (nothing consumes the cache)', () => {
    const start = src.indexOf('function refreshUsageLimits(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('if (!JOURNAL_ENABLED) return null;');
  });

  it('journalStatus threads the TTL-cached account email into the frame', () => {
    const gStart = src.indexOf('function getAccountEmail(');
    expect(gStart).toBeGreaterThan(-1);
    const gEnd = src.indexOf('\nfunction ', gStart + 1);
    const gBody = src.slice(gStart, gEnd);
    expect(gBody).toContain('emailFromClaudeConfig(');
    expect(gBody).toContain('.claude.json');

    const jStart = src.indexOf('function journalStatus(');
    const jEnd = src.indexOf('\nfunction ', jStart + 1);
    const jBody = src.slice(jStart, jEnd);
    expect(jBody).toContain('email: getAccountEmail()');
  });
});
