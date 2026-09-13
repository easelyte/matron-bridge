import { describe, it, expect } from 'vitest';
import { boxLetters, boxLetterFor } from '../lib/box-letters.js';

// The bridge half of the apps' box letter (MatronShared SessionTag.boxLetters,
// matron-apple). The rule has to match character for character: the app
// derives the letter it COLOURS from the same box names, and a room title
// whose baked-in letter disagreed with the tag beside it would be worse than
// no letter at all. Every case below has a twin in
// MatronShared/Tests/ChatTests/SessionTagTests.swift.
describe('boxLetters', () => {
  it('strips the prefix common to ALL names — the two-DEV-boxes problem', () => {
    // dev-y / dev-z must come out Y / Z, not both D.
    expect(boxLetters(['dev-y', 'dev-z'])).toEqual(['Y', 'Z']);
  });

  it('keeps plain initials for unrelated names', () => {
    expect(boxLetters(['mac-mini', 'dev-3'])).toEqual(['M', 'D']);
  });

  it('falls back to its own initial for a name that IS the common prefix', () => {
    // 'dev' next to 'dev-2': stripping leaves nothing, so 'dev' keeps D
    // while its longer sibling still earns the distinguishing 2.
    expect(boxLetters(['dev', 'dev-2'])).toEqual(['D', '2']);
  });

  it('strips the common prefix case-insensitively', () => {
    expect(boxLetters(['Dev-y', 'dev-z'])).toEqual(['Y', 'Z']);
  });

  it('keeps a single character when uppercasing would EXPAND the letter', () => {
    // 'ß'.toUpperCase() is 'SS'; the tag is one character by contract.
    expect(boxLetters(['box-ß', 'box-z'])).toEqual(['ß', 'Z']);
  });

  it('takes the first alphanumeric, not the first character', () => {
    expect(boxLetters(['-=dev', '~mac'])).toEqual(['D', 'M']);
  });

  it('leaves a single name its own initial (nothing to strip against)', () => {
    expect(boxLetters(['mac-mini'])).toEqual(['M']);
  });

  it('yields no letters for an empty registry', () => {
    expect(boxLetters([])).toEqual([]);
    expect(boxLetters()).toEqual([]);
  });

  it('marks a name with no alphanumerics at all rather than emitting nothing', () => {
    expect(boxLetters(['???', 'mac'])).toEqual(['?', 'M']);
  });

  it('a nameless box does not wipe every other box\'s prefix strip', () => {
    // A roster row with a null name would otherwise make the common prefix
    // empty and collapse dev-y / dev-z back to D / D.
    expect(boxLetters(['dev-y', 'dev-z', null])).toEqual(['Y', 'Z', '?']);
    expect(boxLetters(['dev-y', 'dev-z', ''])).toEqual(['Y', 'Z', '?']);
  });

  it('is stable under duplicate names', () => {
    expect(boxLetters(['dev-2', 'dev-2', 'dev-9'])).toEqual(['2', '2', '9']);
  });
});

describe('boxLetterFor', () => {
  it('derives one name\'s letter against the whole roster', () => {
    expect(boxLetterFor('dev-z', ['dev-y', 'dev-z'])).toBe('Z');
  });

  it('adds a name the roster omits to the set before deriving', () => {
    // The journal's agent list excludes self on some paths; own name still
    // has to be stripped against the same prefix as everyone else's.
    expect(boxLetterFor('dev-y', ['dev-z'])).toBe('Y');
  });

  it('does not double-count a name the roster already holds', () => {
    expect(boxLetterFor('dev', ['dev', 'dev-2'])).toBe('D');
  });

  it('prefers an explicit tag character (the app\'s per-device override)', () => {
    expect(boxLetterFor('dev-y', ['dev-y', 'dev-z'], '🐈')).toBe('🐈');
    expect(boxLetterFor('dev-y', ['dev-y', 'dev-z'], ' Q ')).toBe('Q');
  });

  it('ignores an override that carries no character', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      expect(boxLetterFor('dev-y', ['dev-y', 'dev-z'], bad)).toBe('Y');
    }
  });

  it('an override never shifts what the OTHER boxes derive', () => {
    // Derivation runs over the names; the override is applied after, so one
    // box opting out cannot change its neighbour's letter.
    expect(boxLetterFor('dev-z', ['dev-y', 'dev-z'], null)).toBe('Z');
    expect(boxLetterFor('dev-y', ['dev-y', 'dev-z'], 'Q')).toBe('Q');
    expect(boxLetterFor('dev-z', ['dev-y', 'dev-z'])).toBe('Z');
  });

  it('marks an unusable name rather than returning an empty tag half', () => {
    expect(boxLetterFor('', [])).toBe('?');
    expect(boxLetterFor(null, ['mac'])).toBe('?');
  });
});
