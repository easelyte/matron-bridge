import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  bashTimeoutEnv,
  DEFAULT_BASH_DEFAULT_TIMEOUT_MS,
  DEFAULT_BASH_MAX_TIMEOUT_MS,
  ABSOLUTE_MAX_TIMEOUT_MS,
} from '../lib/bash-timeout-env.js';

const noop = () => {};

describe('bashTimeoutEnv', () => {
  it('injects both Claude Code Bash-timeout keys with defaults when the source env has neither', () => {
    const out = bashTimeoutEnv({}, { warn: noop });
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe(String(DEFAULT_BASH_DEFAULT_TIMEOUT_MS));
    expect(out.BASH_MAX_TIMEOUT_MS).toBe(String(DEFAULT_BASH_MAX_TIMEOUT_MS));
  });

  it('lifts the default well above the 120000ms (2 min) built-in cap', () => {
    const out = bashTimeoutEnv({}, { warn: noop });
    expect(Number(out.BASH_DEFAULT_TIMEOUT_MS)).toBeGreaterThan(120000);
    // max must be >= default so a per-call timeout can reach the default ceiling
    expect(Number(out.BASH_MAX_TIMEOUT_MS)).toBeGreaterThanOrEqual(
      Number(out.BASH_DEFAULT_TIMEOUT_MS),
    );
  });

  // The default must cover the longest unattended command a bridge session runs
  // without its own explicit timeout — a foreground Codex adversarial review,
  // whose workflow budget is ~15 min (900000ms). If the default were below that,
  // such a review would still be SIGTERM'd mid-run (the original bug).
  it('default covers the ~15-min (900000ms) foreground review budget with margin', () => {
    const out = bashTimeoutEnv({}, { warn: noop });
    expect(Number(out.BASH_DEFAULT_TIMEOUT_MS)).toBeGreaterThanOrEqual(900000);
  });

  it('lets a valid explicit operator env override the default (override wins)', () => {
    const out = bashTimeoutEnv(
      { BASH_DEFAULT_TIMEOUT_MS: '90000', BASH_MAX_TIMEOUT_MS: '300000' },
      { warn: noop },
    );
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe('90000');
    expect(out.BASH_MAX_TIMEOUT_MS).toBe('300000');
  });

  it('overrides each key independently — a set default still lets max fall back', () => {
    const out = bashTimeoutEnv({ BASH_DEFAULT_TIMEOUT_MS: '90000' }, { warn: noop });
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe('90000');
    expect(out.BASH_MAX_TIMEOUT_MS).toBe(String(DEFAULT_BASH_MAX_TIMEOUT_MS));
  });

  it('returns only string values (env vars are strings)', () => {
    const out = bashTimeoutEnv({}, { warn: noop });
    expect(typeof out.BASH_DEFAULT_TIMEOUT_MS).toBe('string');
    expect(typeof out.BASH_MAX_TIMEOUT_MS).toBe('string');
  });

  // F2 — malformed overrides must NOT silently pass through (Claude Code would
  // revert them to its 120s built-in, recreating the bug). They fall back to the
  // raised default and emit a warning naming the variable.
  for (const bad of ['', '0', '-1', '600000ms', 'abc', '600000.5', ' ']) {
    it(`rejects malformed BASH_DEFAULT_TIMEOUT_MS=${JSON.stringify(bad)} and warns`, () => {
      const warnings = [];
      const out = bashTimeoutEnv(
        { BASH_DEFAULT_TIMEOUT_MS: bad },
        { warn: (m) => warnings.push(m) },
      );
      expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe(String(DEFAULT_BASH_DEFAULT_TIMEOUT_MS));
      expect(Number(out.BASH_DEFAULT_TIMEOUT_MS)).toBeGreaterThan(120000);
      expect(warnings.some((m) => m.includes('BASH_DEFAULT_TIMEOUT_MS'))).toBe(true);
    });
  }

  it('accepts a canonical positive-integer string with surrounding whitespace', () => {
    const out = bashTimeoutEnv({ BASH_DEFAULT_TIMEOUT_MS: '  450000 ' }, { warn: noop });
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe('450000');
  });

  // Acceptance is aligned with Claude Code's own numeric parsing: a value the
  // runtime honors (scientific notation, trailing-zero decimal) must NOT be
  // rejected and downgraded to the default — it's re-emitted in canonical form.
  it.each([
    ['9e5', '900000'],
    ['6e5', '600000'],
    ['600000.0', '600000'],
  ])('accepts Claude-parseable override %s -> %s (no downgrade)', (input, expected) => {
    const warnings = [];
    const out = bashTimeoutEnv(
      { BASH_DEFAULT_TIMEOUT_MS: input },
      { warn: (m) => warnings.push(m) },
    );
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe(expected);
    expect(warnings).toEqual([]);
  });

  // A fat-finger typo (extra zero) must not let a hung command hold a session
  // for hours: anything above the 1h absolute ceiling is clamped, with a warning.
  it('clamps an over-ceiling override (extra-zero typo) to the absolute max and warns', () => {
    const warnings = [];
    const out = bashTimeoutEnv(
      { BASH_DEFAULT_TIMEOUT_MS: '18000000' }, // 5h typo
      { warn: (m) => warnings.push(m) },
    );
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe(String(ABSOLUTE_MAX_TIMEOUT_MS));
    expect(warnings.some((m) => m.includes('ceiling') || m.includes('clamp'))).toBe(true);
  });

  it('clamps an over-ceiling max override too', () => {
    const out = bashTimeoutEnv({ BASH_MAX_TIMEOUT_MS: '99999999' }, { warn: noop });
    expect(out.BASH_MAX_TIMEOUT_MS).toBe(String(ABSOLUTE_MAX_TIMEOUT_MS));
  });

  it('accepts an override at exactly the absolute ceiling without warning', () => {
    const warnings = [];
    const out = bashTimeoutEnv(
      {
        BASH_DEFAULT_TIMEOUT_MS: String(ABSOLUTE_MAX_TIMEOUT_MS),
        BASH_MAX_TIMEOUT_MS: String(ABSOLUTE_MAX_TIMEOUT_MS),
      },
      { warn: (m) => warnings.push(m) },
    );
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe(String(ABSOLUTE_MAX_TIMEOUT_MS));
    expect(warnings).toEqual([]);
  });

  it('keeps the ceiling above both shipped defaults (defaults never self-clamp)', () => {
    expect(ABSOLUTE_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_BASH_MAX_TIMEOUT_MS);
    expect(ABSOLUTE_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_BASH_DEFAULT_TIMEOUT_MS);
  });

  it('raises a too-small max override up to the resolved default and warns', () => {
    const warnings = [];
    const out = bashTimeoutEnv(
      { BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '300000' },
      { warn: (m) => warnings.push(m) },
    );
    expect(out.BASH_MAX_TIMEOUT_MS).toBe('600000');
    expect(warnings.some((m) => m.includes('raising max'))).toBe(true);
  });
});

// F1 — both Claude spawn environments (print-mode + interactive PTY) must merge
// the timeout helper. index.js is a large ESM entrypoint with no exports, so the
// wiring is pinned with a source-text assertion (P71: non-testable entry point
// needs a source-text wiring test). If a future refactor drops the spread from
// either spawn env, Bash calls in that path silently revert to the 2-min cap.
describe('index.js spawn-env wiring', () => {
  const indexSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'),
    'utf8',
  );

  it('imports the bashTimeoutEnv helper', () => {
    expect(indexSrc).toMatch(
      /import\s*\{\s*bashTimeoutEnv\s*\}\s*from\s*'\.\/lib\/bash-timeout-env\.js'/,
    );
  });

  it('merges bashTimeoutEnv() into both the print-mode and interactive spawn envs', () => {
    const spreads = indexSrc.match(/\.\.\.bashTimeoutEnv\(\)/g) || [];
    expect(spreads.length).toBe(2);
  });

  it('spreads the helper into the print-mode spawnEnv object', () => {
    const spawnEnvBlock = indexSrc.match(/const spawnEnv = \{[\s\S]*?\n {2}\};/);
    expect(spawnEnvBlock, 'spawnEnv object literal not found').not.toBeNull();
    expect(spawnEnvBlock[0]).toContain('...bashTimeoutEnv()');
  });

  it('spreads the helper into the interactive interactiveEnv object', () => {
    const interactiveEnvBlock = indexSrc.match(/const interactiveEnv = \{[\s\S]*?\n {2}\};/);
    expect(interactiveEnvBlock, 'interactiveEnv object literal not found').not.toBeNull();
    expect(interactiveEnvBlock[0]).toContain('...bashTimeoutEnv()');
  });
});
