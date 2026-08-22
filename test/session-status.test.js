import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
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
  statusRepaintDue,
  STATUS_REPAINT_MS,
  hostVitals,
  sampleCpuOnce,
  cpuPercent,
  cpuSampledAtMs,
  ramPercent,
  startCpuSampler,
  stopCpuSampler,
} from '../lib/session-status.js';

describe('contextWindowFor', () => {
  it('gives 1m-class models their full window', () => {
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-mythos-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-5[1m]')).toBe(1_000_000);
  });

  it('defaults everything else to 200k', () => {
    expect(contextWindowFor('claude-opus-4-8')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
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
    expect(reconcileModelForWindow('claude-opus-4-6[1m]', 'claude-haiku-4-5')).toBe('claude-opus-4-6[1m]');
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
    expect(contextGaugeText(24_313, 'claude-opus-4-8')).toBe('24k/200k');
  });

  it('keeps one decimal under 10k and formats 1m-class windows', () => {
    expect(contextGaugeText(2_399, 'claude-fable-5')).toBe('2.4k/1m');
  });

  it('passes sub-1k counts through raw', () => {
    expect(contextGaugeText(950, 'claude-opus-4-8')).toBe('950/200k');
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
    expect(buildSessionStatus({ model: 'claude-opus-4-8', contextTokens: 1_000 }).context.pct).toBe(1);
    expect(buildSessionStatus({ model: 'claude-opus-4-8', contextTokens: 300_000 }).context.pct).toBe(100);
  });

  it('includes the session workdir when known, omits it otherwise', () => {
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

  it('carries host vitals at top level (status.vitals), never inside limits', () => {
    const vitals = { cpu_pct: 12, ram_pct: 47, sampled_at_ms: 1_753_000_000_000 };
    const status = buildSessionStatus({
      model: 'claude-fable-5',
      limits: [{ id: 'session', label: 'Session', percent: 39 }],
      vitals,
    });
    expect(status.vitals).toEqual(vitals);
    // limits[] stays the account-meter list — vitals must not leak into it.
    expect(status.limits).toEqual([{ id: 'session', label: 'Session', percent: 39 }]);
  });

  it('omits status.vitals when vitals is null/absent', () => {
    expect('vitals' in buildSessionStatus({ model: 'claude-fable-5', vitals: null })).toBe(false);
    expect('vitals' in buildSessionStatus({ model: 'claude-fable-5' })).toBe(false);
  });

  it('carries the composer argument lists as model_options / effort_levels', () => {
    const status = buildSessionStatus({
      model: 'claude-fable-5',
      modelOptions: [{ value: 'opus', label: 'Opus' }],
      effortLevels: [{ value: 'high', label: 'High' }],
    });
    expect(status.model_options).toEqual([{ value: 'opus', label: 'Opus' }]);
    expect(status.effort_levels).toEqual([{ value: 'high', label: 'High' }]);
  });

  it('publishes EMPTY lists as empties — "this agent offers nothing", not "no opinion"', () => {
    // Codex says this. Under a sticky merge, omitting the lists after a
    // mid-session /switch claude→codex would leave Claude's seven effort
    // levels offered on a session whose /effort refuses them.
    const status = buildSessionStatus({ model: 'gpt-5.6-codex', modelOptions: [], effortLevels: [] });
    expect(status.model_options).toEqual([]);
    expect(status.effort_levels).toEqual([]);
  });

  it('omits the lists only when the caller has no opinion at all (old bridges, subagent frames)', () => {
    const status = buildSessionStatus({ model: 'claude-fable-5' });
    expect('model_options' in status).toBe(false);
    expect('effort_levels' in status).toBe(false);
    const explicit = buildSessionStatus({ model: 'claude-fable-5', modelOptions: undefined, effortLevels: undefined });
    expect('model_options' in explicit).toBe(false);
    expect('effort_levels' in explicit).toBe(false);
  });

  it('carries the current effort level as a string when tracked', () => {
    expect(buildSessionStatus({ model: 'claude-fable-5', effort: 'xhigh' })).toEqual({
      model: 'claude-fable-5',
      effort: 'xhigh',
    });
  });

  it('publishes an EXPLICIT null while effort is unknown — clients merge stickily, so absent means "unchanged"', () => {
    const status = buildSessionStatus({ model: 'claude-fable-5', effort: null });
    expect('effort' in status).toBe(true);
    expect(status.effort).toBeNull();
    // An empty string is unknown too, and must not publish as "".
    expect(buildSessionStatus({ model: 'claude-fable-5', effort: '' }).effort).toBeNull();
  });

  it('omits effort entirely when the caller passes no opinion (Codex sessions, subagent frames)', () => {
    expect('effort' in buildSessionStatus({ model: 'gpt-5.6-codex' })).toBe(false);
    expect('effort' in buildSessionStatus({ model: 'gpt-5.6-codex', effort: undefined })).toBe(false);
  });

  it('re-publishes null on EVERY frame while unknown, so a client that missed one clear still converges', () => {
    // Not a one-shot clear: three consecutive frames of an untracked session
    // all carry the null, so a dropped/throttled frame cannot strand a client
    // on a stale level.
    for (let i = 0; i < 3; i++) {
      expect(buildSessionStatus({ model: 'claude-fable-5', effort: null }).effort).toBeNull();
    }
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

describe('host vitals', () => {
  // Injected os.cpus()-style tick snapshots so the CPU-diff tests are fully
  // deterministic instead of racing real jiffy accumulation between two live
  // os.cpus() reads (the old busyWait approach flaked ~50% on the zero-tick
  // preservation check — expected 96, got 100). BASE→VALID is a 50%-busy
  // window: idleDelta 400 / totalDelta 800 → busy 0.5 → 50.
  const BASE = { idle: 1000, total: 4000 };
  const VALID = { idle: 1400, total: 4800 };

  // Burn real CPU so two live sampleCpuOnce() calls bracket a non-zero tick
  // window — used only by the real-path smoke test below.
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

  it('cpuPercent stays null until a scheduled sample produces a valid diff (deterministic)', () => {
    stopCpuSampler(); // reset module state (clears baseline + cache)
    expect(cpuPercent()).toBeNull();
    sampleCpuOnce(BASE); // establishes the baseline only — no cached value yet
    expect(cpuPercent()).toBeNull();
    sampleCpuOnce(VALID); // a real diff populates the cache
    expect(cpuPercent()).toBe(50);
  });

  it('cpuPercent populates over a real live sampling window (default snapshot path)', () => {
    stopCpuSampler();
    sampleCpuOnce(); // live baseline (default cpuTicks())
    busyWait(40);
    sampleCpuOnce(); // live diff
    const v = cpuPercent();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });

  it('hostVitals is a flat snapshot with an integer ram_pct and no limit/reset fields', () => {
    const v = hostVitals();
    expect(v).not.toBeNull();
    expect(Number.isInteger(v.ram_pct)).toBe(true);
    expect(v.ram_pct).toBeGreaterThanOrEqual(0);
    expect(v.ram_pct).toBeLessThanOrEqual(100);
    // It is a top-level object, NOT a limit entry: no id/label/percent/resets.
    expect('id' in v).toBe(false);
    expect('label' in v).toBe(false);
    expect('resets' in v).toBe(false);
    expect('resets_at' in v).toBe(false);
  });

  it('hostVitals carries a numeric sampled_at_ms so clients can expire stale replays', () => {
    // The publisher replays the last status frame to new viewers, so an idle
    // convo would show an arbitrarily old reading as current without an age
    // stamp. sampled_at_ms is the CPU cache-stamp once the sampler has warmed.
    stopCpuSampler();
    sampleCpuOnce(BASE);
    sampleCpuOnce(VALID); // cache a valid cpu reading + stamp its sample time
    const v = hostVitals();
    expect(v.cpu_pct).toBe(50);
    expect(typeof v.sampled_at_ms).toBe('number');
    expect(v.sampled_at_ms).toBeGreaterThan(0);
    expect(v.sampled_at_ms).toBe(cpuSampledAtMs());
  });

  it('hostVitals falls back to now for sampled_at_ms before the cpu sampler warms', () => {
    stopCpuSampler(); // cpu_pct + cpuSampledAtMs both null
    const before = Date.now();
    const v = hostVitals();
    expect(v.cpu_pct).toBeNull();
    expect(typeof v.ram_pct).toBe('number'); // still emits RAM
    expect(v.sampled_at_ms).toBeGreaterThanOrEqual(before);
  });

  it('cpu_pct is STABLE across two reads in the same tick (no 0/100 collapse)', () => {
    // journalStatus fires >1x per tick; the reader (hostVitals) must not mutate
    // the baseline, so back-to-back reads return the same cached value rather
    // than collapsing to a 0-interval reading of 0 or 100.
    stopCpuSampler();
    sampleCpuOnce(BASE);
    sampleCpuOnce(VALID);
    const cached = cpuPercent();
    expect(cached).toBe(50);
    // Two reads with NO intervening scheduled sample — the many-per-tick case.
    expect(hostVitals().cpu_pct).toBe(cached);
    expect(hostVitals().cpu_pct).toBe(cached); // stable, not recomputed to 0/100
  });

  it('a degenerate (zero-tick) sample preserves the prior cached value (deterministic)', () => {
    stopCpuSampler();
    sampleCpuOnce(BASE);
    sampleCpuOnce(VALID);
    const good = cpuPercent();
    expect(good).toBe(50);
    // Re-feed the SAME ticks as the last sample: idleDelta = totalDelta = 0 →
    // the sampler must preserve the cached value, not overwrite with 0/100.
    sampleCpuOnce(VALID);
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

  it('starts the CPU sampler at boot (gated on journal-enabled) and stops it on shutdown', () => {
    // main() owns the fixed-cadence sampler so journalStatus only ever reads it.
    const main = src.slice(src.indexOf('async function main('));
    expect(main).toContain('startCpuSampler(');
    // The sampler only feeds journal frames, so it's gated on JOURNAL_ENABLED —
    // no os.cpus() polling when nothing consumes it.
    expect(main).toMatch(/if \(JOURNAL_ENABLED\) startCpuSampler\(/);
    // Shutdown now runs through the async gracefulShutdown() settle path (#536);
    // it tears down the sampler so the interval doesn't leak, and both signal
    // handlers delegate to it.
    const shutdown = src.slice(src.indexOf('async function gracefulShutdown('));
    expect(shutdown).toContain('stopCpuSampler()');
    const sigint = src.slice(src.indexOf("process.on('SIGINT'"));
    expect(sigint).toContain("gracefulShutdown('SIGINT')");
    const sigterm = src.slice(src.indexOf("process.on('SIGTERM'"));
    expect(sigterm).toContain("gracefulShutdown('SIGTERM')");
  });

  it('journalStatus wires host vitals to top-level status.vitals, never into limits[]', () => {
    const start = src.indexOf('function journalStatus(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    // vitals ride at top level via the buildSessionStatus vitals param.
    expect(body).toContain('hostVitals()');
    expect(body).toMatch(/vitals[,\n]/);
    // The Codex path passes an empty limits array (no account rate limits) and
    // never spreads vitals into limits.
    expect(body).not.toContain('hostVitalLimits');
    expect(body).toMatch(/limits:\s*isCodex\s*\?\s*\[\]/);
  });

  it('every status publisher in the tree builds its frame with buildSessionStatus', () => {
    // Replace-not-merge replay means a partial frame is not merely incomplete
    // — it REPLACES a good one for any client that cold-starts after it. So
    // the invariant is per-publisher, not per-call-site: every module that
    // calls publishStatus must build the frame through buildSessionStatus.
    // If this fails, a new publisher appeared — route it through
    // buildSessionStatus rather than widening the list.
    const libDir = fileURLToPath(new URL('../lib', import.meta.url));
    const roots = [
      fileURLToPath(new URL('../index.js', import.meta.url)),
      ...readdirSync(libDir).filter(f => f.endsWith('.js')).map(f => join(libDir, f)),
    ];
    const publishers = [];
    for (const file of roots) {
      const body = readFileSync(file, 'utf-8');
      // The publisher module DEFINES publishStatus; it doesn't call one.
      if (file.endsWith('journal-publisher.js')) continue;
      if (/publishStatus\??\.?\(/.test(body)) publishers.push([basename(file), body]);
    }
    expect(publishers.map(([name]) => name).sort()).toEqual([
      'codex-event-format.js',
      'index.js',
      'subagent-convos.js',
    ]);
    for (const [name, body] of publishers) {
      expect(body, `${name} publishes status frames`).toContain('buildSessionStatus(');
    }
  });

  it('defines a journalStatus helper that publishes via publishStatus', () => {
    const start = src.indexOf('function journalStatus(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('buildSessionStatus(');
    expect(body).toContain('publishStatus(');
  });

  it('journalStatus scopes model_options / effort_levels / effort to Claude sessions', () => {
    const start = src.indexOf('function journalStatus(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    // Codex takes a free-text model id (`codex --model <id>`) the bridge never
    // validates, so it has nothing to offer; /effort isn't exposed for Codex at
    // all. It says so with EMPTY lists and a null effort rather than by staying
    // silent — under a sticky merge, silence would leave a Claude session's
    // offers (and a stale "· xhigh") standing after a mid-session switch.
    expect(body).toMatch(/modelOptions:\s*isCodex\s*\?\s*\[\]\s*:\s*modelOptions\(\)/);
    expect(body).toMatch(/effortLevels:\s*isCodex\s*\?\s*\[\]\s*:\s*effortOptions\(\)/);
    expect(body).toMatch(/effort:\s*isCodex\s*\?\s*null\s*:\s*trackedEffort\(session\)/);
  });

  it('journalStatus has exactly ONE frame-building path, so no branch can emit a partial repaint', () => {
    // The journal's replay cache is replace-not-merge (last frame wins
    // verbatim). A second, leaner buildSessionStatus call for some fast path
    // would therefore be able to strand a cold-starting client without the
    // composer's argument lists.
    const start = src.indexOf('function journalStatus(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    expect(body.match(/buildSessionStatus\(/g)).toHaveLength(1);
  });

  it('journalStatus threads the resolved session workdir into the frame', () => {
    const start = src.indexOf('function journalStatus(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    // Resolved to an absolute path (session.workdir can be relative) before it
    // ships on the status frame.
    expect(body).toContain('workdir: session.workdir ? path.resolve(session.workdir) : undefined');
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

// Header liveness (Dan, 2026-08-02): the status frame used to publish at turn
// end only, so a brand-new chat showed a bare header until its first turn
// completed — and a long tool-heavy turn left the gauge stale for its whole
// duration. Now the frame is seeded at spawn (whatever is known pre-turn) and
// repainted mid-turn from assistant-event usage, throttled by wall clock.
describe('statusRepaintDue', () => {
  it('is due when nothing was ever published', () => {
    expect(statusRepaintDue(undefined, 1000)).toBe(true);
    expect(statusRepaintDue(null, 1000)).toBe(true);
  });
  it('suppresses repaints inside the throttle window', () => {
    expect(statusRepaintDue(10_000, 10_000 + STATUS_REPAINT_MS - 1)).toBe(false);
  });
  it('is due once the window has elapsed', () => {
    expect(statusRepaintDue(10_000, 10_000 + STATUS_REPAINT_MS)).toBe(true);
  });
  it('honors a custom interval', () => {
    expect(statusRepaintDue(10_000, 10_500, 1000)).toBe(false);
    expect(statusRepaintDue(10_000, 11_000, 1000)).toBe(true);
  });
});

describe('index.js header-liveness wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');

  it('journalStatus stamps _statusPublishedAt only when a frame actually goes out', () => {
    const start = src.indexOf('function journalStatus(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    // The stamp must sit after every early return (no convo id / empty
    // status) AND be gated on publishStatus's return value, so throttled
    // callers aren't starved by frames that never went out — including
    // frames the socket layer dropped (journal down, unserializable).
    const stampAt = body.indexOf('session._statusPublishedAt');
    expect(stampAt).toBeGreaterThan(-1);
    expect(stampAt).toBeGreaterThan(body.lastIndexOf('return;'));
    expect(body).toMatch(/if \(journalPublisher\.publishStatus\(convoId, status\)\) \{\s*\n\s*session\._statusPublishedAt = Date\.now\(\);/);
  });

  it('publishStatus reports whether the frame actually went out', () => {
    // The throttle fix above only works if the publisher tells the truth:
    // every drop path (closed socket, unserializable payload, send throw,
    // noop publisher) must return an explicit false and the send path an
    // explicit true — a bare `return` on a new drop path would still be
    // falsy today, but the explicit contract keeps future edits honest.
    const pubSrc = readFileSync(fileURLToPath(new URL('../lib/journal-publisher.js', import.meta.url)), 'utf-8');
    expect(pubSrc).toContain('publishStatus() { return false; }'); // noop publisher
    const start = pubSrc.indexOf('publishStatus(convoId, status)');
    // Our fork inserts publishHostVitals between publishStatus and respondRpc,
    // so bound the slice at it to read publishStatus's body alone.
    const bodyEnd = pubSrc.indexOf('publishHostVitals(', start);
    const pubBody = pubSrc.slice(start, bodyEnd);
    expect(pubBody).toContain('return true;');
    expect(pubBody).toContain('return false;');
    expect(pubBody).not.toMatch(/^\s*return;\s*$/m);
  });

  it('all three spawn branches seed the header via journalSpawnStatus', () => {
    // Definition + print + iv + codex call sites.
    const calls = src.match(/journalSpawnStatus\(/g) || [];
    expect(calls.length).toBe(4);
    // The helper publishes now and repaints when the limits refresh lands.
    const start = src.indexOf('function journalSpawnStatus(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('journalStatus(session)');
    expect(body).toContain('refreshUsageLimits(');
  });

  it('the assistant-event context capture repaints the header, throttled', () => {
    expect(src).toMatch(/statusRepaintDue\(session\._statusPublishedAt, Date\.now\(\)\)/);
  });

  it('the print init capture repaints so the model lands before the first turn ends', () => {
    const at = src.indexOf('session.initData = event;');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toContain('journalStatus(session);');
  });
});
