import { describe, it, expect } from 'vitest';
import { parseUsageLimits, parseResetsAt, resetsAtMs, deriveLimitId, formatLimits } from '../lib/usage-limits.js';

// Real `claude -p "/usage" --output-format text` output (subscription account).
// Note the middot separator (·) is the literal character Claude Code emits.
const SUBSCRIPTION_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Jul 9, 12:59am (UTC)
Current week (all models): 66% used · resets Jul 12, 6:59pm (UTC)
Current week (Fable): 100% used · resets Jul 12, 6:59pm (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1732 requests · 3 sessions
  74% of your usage was at >150k context
`;

// Real output from the same command after claude switched the reset text to
// "at" + the machine's IANA zone (captured 2026-07-14 on a Europe/London
// machine, during BST = UTC+1).
const LOCAL_ZONE_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 23% used · resets Jul 15 at 12:19am (Europe/London)
Current week (all models): 13% used · resets Jul 20 at 9:59pm (Europe/London)
Current week (Fable): 21% used · resets Jul 20 at 9:59pm (Europe/London)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.
`;

const GREEN = '#3fb950';
const ORANGE = '#f0883e';
const RED = '#f85149';

describe('parseUsageLimits', () => {
  it('extracts the Current session / week headline lines', () => {
    const { ok, lines } = parseUsageLimits(SUBSCRIPTION_SAMPLE, new Date('2026-07-08T00:00:00Z'));
    expect(ok).toBe(true);
    expect(lines).toEqual([
      { id: 'session_5h', label: 'Session', percent: 39, resets: 'Jul 9, 12:59am (UTC)', resets_at: '2026-07-09T00:59:00.000Z', resets_at_ms: Date.parse('2026-07-09T00:59:00.000Z') },
      { id: 'week_all', label: 'Week (all models)', percent: 66, resets: 'Jul 12, 6:59pm (UTC)', resets_at: '2026-07-12T18:59:00.000Z', resets_at_ms: Date.parse('2026-07-12T18:59:00.000Z') },
      { id: 'week_fable', label: 'Week (Fable)', percent: 100, resets: 'Jul 12, 6:59pm (UTC)', resets_at: '2026-07-12T18:59:00.000Z', resets_at_ms: Date.parse('2026-07-12T18:59:00.000Z') },
    ]);
    // resets_at keeps its original ISO-string wire type; resets_at_ms is the
    // additive epoch-ms number sibling.
    for (const l of lines) {
      expect(typeof l.resets_at).toBe('string');
      expect(typeof l.resets_at_ms).toBe('number');
    }
  });

  it('does not include the intro line or the "what\'s contributing" breakdown', () => {
    const { lines } = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l.label).not.toMatch(/contributing|requests|subscription/i);
    }
  });

  it('reports ok:false with no lines when nothing matches', () => {
    const { ok, lines } = parseUsageLimits('Some unrelated output about an API key.\nNo limits here.');
    expect(ok).toBe(false);
    expect(lines).toEqual([]);
  });

  it('handles empty / nullish input without throwing', () => {
    expect(parseUsageLimits('')).toEqual({ ok: false, lines: [] });
    expect(parseUsageLimits(null)).toEqual({ ok: false, lines: [] });
    expect(parseUsageLimits(undefined)).toEqual({ ok: false, lines: [] });
  });

  it('adds resets_at (ISO) and resets_at_ms (epoch) to lines when the reset text parses', () => {
    const { lines } = parseUsageLimits(SUBSCRIPTION_SAMPLE, new Date('2026-07-08T00:00:00Z'));
    expect(lines.map((l) => l.resets_at)).toEqual([
      '2026-07-09T00:59:00.000Z',
      '2026-07-12T18:59:00.000Z',
      '2026-07-12T18:59:00.000Z',
    ]);
    expect(lines.map((l) => l.resets_at_ms)).toEqual([
      Date.parse('2026-07-09T00:59:00.000Z'),
      Date.parse('2026-07-12T18:59:00.000Z'),
      Date.parse('2026-07-12T18:59:00.000Z'),
    ]);
  });

  it('omits both resets_at and resets_at_ms when the reset text does not parse', () => {
    const { lines } = parseUsageLimits('Current session: 39% used · resets soon\n');
    expect(lines).toHaveLength(1);
    expect('resets_at' in lines[0]).toBe(false);
    expect('resets_at_ms' in lines[0]).toBe(false);
  });

  it('parses the "at" + local IANA zone format to UTC timestamps', () => {
    const { ok, lines } = parseUsageLimits(LOCAL_ZONE_SAMPLE, new Date('2026-07-14T22:00:00Z'));
    expect(ok).toBe(true);
    expect(lines).toEqual([
      // BST is UTC+1: 12:19am Jul 15 London = 11:19pm Jul 14 UTC.
      { id: 'session_5h', label: 'Session', percent: 23, resets: 'Jul 15 at 12:19am (Europe/London)', resets_at: '2026-07-14T23:19:00.000Z', resets_at_ms: Date.parse('2026-07-14T23:19:00.000Z') },
      { id: 'week_all', label: 'Week (all models)', percent: 13, resets: 'Jul 20 at 9:59pm (Europe/London)', resets_at: '2026-07-20T20:59:00.000Z', resets_at_ms: Date.parse('2026-07-20T20:59:00.000Z') },
      { id: 'week_fable', label: 'Week (Fable)', percent: 21, resets: 'Jul 20 at 9:59pm (Europe/London)', resets_at: '2026-07-20T20:59:00.000Z', resets_at_ms: Date.parse('2026-07-20T20:59:00.000Z') },
    ]);
  });

  it('derives a stable machine id per limit line', () => {
    const { lines } = parseUsageLimits(SUBSCRIPTION_SAMPLE, new Date('2026-07-08T00:00:00Z'));
    expect(lines.map((l) => l.id)).toEqual(['session_5h', 'week_all', 'week_fable']);
  });

  // Real output when the Fable weekly bucket is at 0% — Claude prints that line
  // with NO "· resets …" tail. The parser must still keep it (id/label/percent)
  // and omit resets/resets_at/resets_at_ms, while the with-resets session and
  // week-all lines in the SAME parse are unchanged.
  it('parses a Fable 0%-used line that has no resets clause', () => {
    const ZERO_FABLE_SAMPLE = `Current session: 25% used · resets Jul 26, 8:59pm (America/New_York)
Current week (all models): 24% used · resets Aug 1, 4:59am (America/New_York)
Current week (Fable): 0% used
`;
    const { ok, lines } = parseUsageLimits(ZERO_FABLE_SAMPLE, new Date('2026-07-26T12:00:00Z'));
    expect(ok).toBe(true);
    expect(lines.map((l) => l.id)).toEqual(['session_5h', 'week_all', 'week_fable']);

    // week_fable: kept, percent 0, no resets fields at all.
    const fable = lines[2];
    expect(fable).toEqual({ id: 'week_fable', label: 'Week (Fable)', percent: 0 });
    expect('resets' in fable).toBe(false);
    expect('resets_at' in fable).toBe(false);
    expect('resets_at_ms' in fable).toBe(false);

    // Regression guard: the two with-resets lines parse identically to before —
    // same percent and same resets_at the optional group must not disturb.
    expect(lines[0]).toEqual({
      id: 'session_5h', label: 'Session', percent: 25,
      resets: 'Jul 26, 8:59pm (America/New_York)',
      resets_at: '2026-07-27T00:59:00.000Z',
      resets_at_ms: Date.parse('2026-07-27T00:59:00.000Z'),
    });
    expect(lines[1]).toEqual({
      id: 'week_all', label: 'Week (all models)', percent: 24,
      resets: 'Aug 1, 4:59am (America/New_York)',
      resets_at: '2026-08-01T08:59:00.000Z',
      resets_at_ms: Date.parse('2026-08-01T08:59:00.000Z'),
    });
  });
});

describe('resetsAtMs', () => {
  const now = new Date('2026-07-08T00:00:00Z');

  it('returns the epoch-ms number for a parseable reset', () => {
    expect(resetsAtMs('Jul 9, 12:59am (UTC)', now)).toBe(Date.parse('2026-07-09T00:59:00.000Z'));
  });

  it('returns null on unparseable input, matching parseResetsAt', () => {
    expect(resetsAtMs('soon', now)).toBeNull();
    expect(resetsAtMs('', now)).toBeNull();
    expect(resetsAtMs(null, now)).toBeNull();
  });

  it('parseResetsAt is the ISO wrapper over the same instant', () => {
    const ms = resetsAtMs('Jul 12, 6:59pm (UTC)', now);
    expect(parseResetsAt('Jul 12, 6:59pm (UTC)', now)).toBe(new Date(ms).toISOString());
  });
});

describe('deriveLimitId', () => {
  it('maps the session line to session_5h', () => {
    expect(deriveLimitId('session')).toBe('session_5h');
    expect(deriveLimitId('Session')).toBe('session_5h');
  });

  it('maps the all-models weekly line to week_all', () => {
    expect(deriveLimitId('week (all models)')).toBe('week_all');
  });

  it('maps a named weekly line to week_<slug>', () => {
    expect(deriveLimitId('week (Fable)')).toBe('week_fable');
    expect(deriveLimitId('week (Sonnet 5)')).toBe('week_sonnet_5');
    expect(deriveLimitId('week (Claude Opus 4.8)')).toBe('week_claude_opus_4_8');
  });

  it('slugs the whole suffix when a weekly line has no parentheses (wording drift)', () => {
    // Distinct future weekly wordings must NOT all collapse to week_other.
    expect(deriveLimitId('week all models')).toBe('week_all_models');
    expect(deriveLimitId('week fable')).toBe('week_fable');
    expect(deriveLimitId('week sonnet 5')).toBe('week_sonnet_5');
  });

  it('never crashes on unknown / empty / nullish labels', () => {
    expect(deriveLimitId('week ()')).toBe('week_other');
    expect(deriveLimitId('something odd')).toBe('something_odd');
    expect(deriveLimitId('')).toBe('week_other');
    expect(deriveLimitId(null)).toBe('week_other');
    expect(deriveLimitId(undefined)).toBe('week_other');
  });
});

describe('parseUsageLimits id dedup', () => {
  it('disambiguates two lines that derive the same id', () => {
    // Two unparseable-parenthetical weekly lines both derive week_other; the
    // dedup guard must give the second a distinct id so clients keyed by id
    // don't clobber one with the other.
    const raw = [
      'Current week (): 10% used · resets soon',
      'Current week (): 20% used · resets soon',
    ].join('\n');
    const { lines } = parseUsageLimits(raw);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.id)).toEqual(['week_other', 'week_other_2']);
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
  });
});

describe('parseResetsAt', () => {
  const now = new Date('2026-07-08T00:00:00Z');

  it('parses an am time to a UTC ISO timestamp', () => {
    expect(parseResetsAt('Jul 9, 12:59am (UTC)', now)).toBe('2026-07-09T00:59:00.000Z');
  });

  it('parses a pm time', () => {
    expect(parseResetsAt('Jul 12, 6:59pm (UTC)', now)).toBe('2026-07-12T18:59:00.000Z');
  });

  it('rolls to next year when the month/day is far in the past', () => {
    expect(parseResetsAt('Jan 2, 3:00am (UTC)', new Date('2026-12-30T00:00:00Z')))
      .toBe('2027-01-02T03:00:00.000Z');
  });

  it('keeps a reset less than 24h in the past in the current year', () => {
    expect(parseResetsAt('Jul 9, 12:59am (UTC)', new Date('2026-07-09T06:00:00Z')))
      .toBe('2026-07-09T00:59:00.000Z');
  });

  it('returns null on unparseable input', () => {
    expect(parseResetsAt('soon', now)).toBeNull();
    expect(parseResetsAt('', now)).toBeNull();
    expect(parseResetsAt(null, now)).toBeNull();
    expect(parseResetsAt('Julember 9, 12:59am (UTC)', now)).toBeNull();
    expect(parseResetsAt('Jul 9, 12:59am (PST)', now)).toBeNull();
  });

  it('fails open on stale mid-year text more than 24h in the past', () => {
    expect(parseResetsAt('Jul 9, 12:59am (UTC)', new Date('2026-08-15T00:00:00Z')))
      .toBeNull();
  });

  it('still rolls Dec->Jan when the reset is imminent', () => {
    expect(parseResetsAt('Jan 1, 12:59am (UTC)', new Date('2026-12-31T12:00:00Z')))
      .toBe('2027-01-01T00:59:00.000Z');
  });

  it('parses a previous-year date just past midnight within tolerance', () => {
    expect(parseResetsAt('Dec 31, 11:59pm (UTC)', new Date('2027-01-01T06:00:00Z')))
      .toBe('2026-12-31T23:59:00.000Z');
  });

  it('fails open when the date is beyond the 8-day future horizon', () => {
    expect(parseResetsAt('Jul 20, 12:00pm (UTC)', new Date('2026-07-01T00:00:00Z')))
      .toBeNull();
  });

  it('parses the "at" separator with a UTC zone', () => {
    expect(parseResetsAt('Jul 9 at 12:59am (UTC)', now)).toBe('2026-07-09T00:59:00.000Z');
  });

  it('converts a summer-time IANA zone to UTC (BST = UTC+1)', () => {
    expect(parseResetsAt('Jul 15 at 12:19am (Europe/London)', new Date('2026-07-14T22:00:00Z')))
      .toBe('2026-07-14T23:19:00.000Z');
  });

  it('converts the same zone in winter without the DST offset (GMT)', () => {
    expect(parseResetsAt('Jan 10 at 3:00pm (Europe/London)', new Date('2027-01-10T00:00:00Z')))
      .toBe('2027-01-10T15:00:00.000Z');
  });

  it('converts a US zone across the date line to the right UTC day', () => {
    // EDT is UTC-4: 12:19am Jul 15 New York = 4:19am Jul 15 UTC.
    expect(parseResetsAt('Jul 15 at 12:19am (America/New_York)', new Date('2026-07-14T22:00:00Z')))
      .toBe('2026-07-15T04:19:00.000Z');
  });

  it('rolls the year correctly for a zoned Dec->Jan reset', () => {
    // GMT in winter: 12:59am Jan 1 London = 12:59am Jan 1 UTC, next year.
    expect(parseResetsAt('Jan 1 at 12:59am (Europe/London)', new Date('2026-12-31T12:00:00Z')))
      .toBe('2027-01-01T00:59:00.000Z');
  });

  it('fails open on zone names Intl rejects or legacy abbreviations', () => {
    expect(parseResetsAt('Jul 9 at 12:59am (Not/AZone)', now)).toBeNull();
    expect(parseResetsAt('Jul 9 at 12:59am (BST)', now)).toBeNull();
  });
});

describe('formatLimits', () => {
  it('produces a plain-text headline block', () => {
    const parsed = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    const { plain } = formatLimits(parsed, SUBSCRIPTION_SAMPLE);
    expect(plain).toContain('Subscription Usage');
    expect(plain).toContain('Session: 39% · resets Jul 9, 12:59am (UTC)');
    expect(plain).toContain('Week (all models): 66% · resets Jul 12, 6:59pm (UTC)');
    expect(plain).toContain('Week (Fable): 100% · resets Jul 12, 6:59pm (UTC)');
    // The breakdown must not leak into the formatted output.
    expect(plain).not.toContain('requests');
  });

  it('color-codes percentages by threshold in HTML', () => {
    const parsed = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    const { html } = formatLimits(parsed, SUBSCRIPTION_SAMPLE);
    expect(html).toContain(`<font color="${GREEN}">39%</font>`);   // < 50
    expect(html).toContain(`<font color="${ORANGE}">66%</font>`);  // < 80
    expect(html).toContain(`<font color="${RED}">100%</font>`);    // >= 80
  });

  it('maps threshold boundaries to the right colors', () => {
    const mk = (percent) => formatLimits(
      { ok: true, lines: [{ label: 'Session', percent, resets: 'soon' }] },
      '',
    ).html;
    expect(mk(49)).toContain(`<font color="${GREEN}">49%</font>`);
    expect(mk(50)).toContain(`<font color="${ORANGE}">50%</font>`);
    expect(mk(79)).toContain(`<font color="${ORANGE}">79%</font>`);
    expect(mk(80)).toContain(`<font color="${RED}">80%</font>`);
  });

  it('falls back to the raw text when parsing found nothing', () => {
    const raw = 'Login required. Run `claude` to authenticate.';
    const parsed = parseUsageLimits(raw);
    const { plain, html } = formatLimits(parsed, raw);
    expect(plain).toContain('Login required');
    expect(html).toContain('Login required');
  });

  it('escapes HTML-special characters in the fallback', () => {
    const raw = 'error: <bad> & "stuff"';
    const { html } = formatLimits(parseUsageLimits(raw), raw);
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;stuff&quot;');
    expect(html).not.toContain('<bad>');
    expect(html).not.toContain('"stuff"');
  });

  it('escapes double quotes in parsed labels and reset times', () => {
    const { html } = formatLimits(
      { ok: true, lines: [{ label: 'week ("all" models)', percent: 10, resets: 'Jul 9, "noon"' }] },
      '',
    );
    expect(html).toContain('week (&quot;all&quot; models)');
    expect(html).toContain('Jul 9, &quot;noon&quot;');
  });
});
