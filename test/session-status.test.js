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
