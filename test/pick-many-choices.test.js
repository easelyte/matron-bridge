import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolvePromptChoices } from '../lib/journal-input-router.js';

// Options in the exact shape sendAllQuestions journals for an AskUserQuestion
// card: id opt_<letter>, value = label.
const opts = (...labels) => labels.map((label, i) => ({
  id: `opt_${String.fromCharCode(97 + i)}`, label, value: label,
}));

describe('resolvePromptChoices (pick_many replies)', () => {
  const options = opts('Red', 'Green', 'Blue');

  it('resolves a single tick as one option', () => {
    expect(resolvePromptChoices(options, 'Green')).toEqual({ options: [options[1]], indices: [1] });
  });

  it('resolves two or more ticks joined by ", "', () => {
    expect(resolvePromptChoices(options, 'Red, Blue')).toEqual({ options: [options[0], options[2]], indices: [0, 2] });
    expect(resolvePromptChoices(options, 'Red, Green, Blue').indices).toEqual([0, 1, 2]);
  });

  it('matches labels case-insensitively and returns option order, de-duplicated', () => {
    expect(resolvePromptChoices(options, 'blue, RED, Blue').indices).toEqual([0, 2]);
  });

  it('handles labels that themselves contain ", "', () => {
    const tricky = opts('Red, green', 'Blue');
    expect(resolvePromptChoices(tricky, 'Red, green').indices).toEqual([0]);
    expect(resolvePromptChoices(tricky, 'Red, green, Blue').indices).toEqual([0, 1]);
    const withPrefix = opts('Red, green', 'Red', 'Blue');
    expect(resolvePromptChoices(withPrefix, 'Red, Blue').indices).toEqual([1, 2]);
    expect(resolvePromptChoices(withPrefix, 'Red, green, Red').indices).toEqual([0, 1]);
  });

  it('backtracks when an early match leaves an unparseable rest', () => {
    const tricky = opts('A, B', 'A', 'B, C');
    expect(resolvePromptChoices(tricky, 'A, B, C').indices).toEqual([1, 2]);
  });

  it('refuses an ambiguous joined string instead of guessing', () => {
    const tricky = opts('A, B', 'A', 'B, C', 'C');
    expect(resolvePromptChoices(tricky, 'A, B, C')).toBeNull();
    const split = opts('Red, green', 'Red', 'green');
    expect(resolvePromptChoices(split, 'Red, green')).toBeNull();
    expect(resolvePromptChoices(opts('Same', 'Same'), 'Same')).toBeNull();
  });

  it('matches an option value before treating digits as a position', () => {
    const numeric = opts('2', '3', '4');
    expect(resolvePromptChoices(numeric, '2').indices).toEqual([0]);
    expect(resolvePromptChoices(numeric, '2, 4').indices).toEqual([0, 2]);
  });

  it('still accepts a single option id or 1-based number', () => {
    expect(resolvePromptChoices(options, 'opt_c').indices).toEqual([2]);
    expect(resolvePromptChoices(options, '2').indices).toEqual([1]);
  });

  it('returns null when any part names no option (caller falls back to free text)', () => {
    expect(resolvePromptChoices(options, 'Red, Purple')).toBeNull();
    expect(resolvePromptChoices(options, 'Purple')).toBeNull();
    expect(resolvePromptChoices(options, 'Red,Blue')).toBeNull();
    expect(resolvePromptChoices(options, 'Red, ')).toBeNull();
  });

  it('tolerates empty or missing input', () => {
    expect(resolvePromptChoices(options, '')).toBeNull();
    expect(resolvePromptChoices(options, null)).toBeNull();
    expect(resolvePromptChoices([], 'Red')).toBeNull();
    expect(resolvePromptChoices(undefined, 'Red')).toBeNull();
  });

  it('stays fast on many similar labels', () => {
    const many = opts(...Array.from({ length: 40 }, (_, i) => 'x, '.repeat(i) + 'x'));
    const choice = Array.from({ length: 200 }, () => 'x').join(', ') + ', y';
    const t0 = Date.now();
    expect(resolvePromptChoices(many, choice)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('handles a very long choice without recursing per part', () => {
    const choice = Array.from({ length: 50000 }, () => 'Red').join(', ') + ', Blue';
    const t0 = Date.now();
    expect(resolvePromptChoices(opts('Red', 'Green', 'Blue'), choice)?.indices).toEqual([0, 2]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// index.js has no unit harness for journalRoutePromptReply; assert the
// print-mode AskUserQuestion branch wires multiSelect through the set
// resolver and answers with every selected label.
describe('print-mode pick_many reply wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = index.indexOf('function journalRoutePromptReply(');
  const fn = index.slice(start, index.indexOf('\n}\n', start));

  it('resolves a multiSelect question with resolvePromptChoices and joins labels', () => {
    expect(fn).toMatch(/q\.multiSelect\)/);
    expect(fn).toMatch(/resolvePromptChoices\(options, choice\)/);
    expect(fn).toMatch(/resolved\.options\.map\(o => o\.label\)\.join\(', '\)/);
  });

  it('falls back to free text or the raw choice instead of dropping it', () => {
    expect(fn).toMatch(/: \(freeText \|\| rawChoice\)/);
  });
});
