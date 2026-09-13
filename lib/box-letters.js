// One display letter per box, derived from the box NAMES alone.
//
// A direct port of MatronShared SessionTag.boxLetters (matron-apple): the
// apps derive the letter they render — and colour — beside every chat title
// from the same box-name registry, and the bridge now bakes the same letter
// into agent-chat room titles (`D:cd ↔️ P:ef — topic`). Two
// implementations of one rule, so this file mirrors the Swift one case for
// case; test/box-letters.test.js has a twin for every assertion in
// MatronShared/Tests/ChatTests/SessionTagTests.swift. If the rule changes,
// it changes in both places or the baked letter contradicts the coloured tag
// beside it.
//
// The rule: strip the prefix common to ALL names, then take the first
// letter/digit of what remains, uppercased. `dev-y` / `dev-z` therefore come
// out as `Y` and `Z`, not both `D` (the colleague-with-two-DEV-boxes
// problem), while unrelated names keep their initials (`mac-mini` / `dev-3`
// → `M` / `D`). A name that IS the common prefix (`dev` next to `dev-2`)
// falls back to its own initial. Deterministic — same names, same letters,
// on every platform. Collisions are tolerated: the letter is an aid, and the
// session short beside it still disambiguates.

// The first letter or digit, uppercased. Uppercasing can EXPAND some letters
// (ß → SS); the tag is one character by contract, so keep the original when
// it does. Iterated by code point, not UTF-16 unit, so an astral character
// is never split in half.
function firstAlphanumeric(s) {
  for (const ch of s) {
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    const upper = ch.toUpperCase();
    return [...upper].length === 1 ? upper : ch;
  }
  return null;
}

// Length of the case-insensitive longest common prefix of every name.
// Case-insensitive so `Dev-y` / `dev-z` still strip to `Y` / `Z`. Measured
// in UTF-16 units because that is what slice() below consumes; the two are
// derived from the same string, so they cannot disagree.
function commonPrefixLength(names) {
  if (names.length < 2) return 0;
  const shortest = names.reduce((a, b) => (b.length < a.length ? b : a));
  for (let len = shortest.length; len > 0; len--) {
    const candidate = shortest.slice(0, len).toLowerCase();
    if (names.every((n) => n.toLowerCase().startsWith(candidate))) return len;
  }
  return 0;
}

// Letters for a list of box names, returned in the SAME order (index i is
// names[i]'s letter). A name that yields nothing usable — no name at all, or
// no letter or digit anywhere in it — comes back as '?' rather than an empty
// string a caller might silently render as half a tag.
//
// Deviation from the Swift original, which cannot be handed a nil name: a
// nameless roster row is left out of the common-prefix strip entirely. Were
// it counted, its empty name would make the common prefix empty and collapse
// dev-y / dev-z back to D / D — one unnamed box must not restyle the others.
export function boxLetters(names = []) {
  const named = names.filter((n) => typeof n === 'string' && n.length > 0);
  const prefixLength = commonPrefixLength(named);
  return names.map((name) => {
    if (typeof name !== 'string' || !name) return '?';
    return firstAlphanumeric(name.slice(prefixLength)) || firstAlphanumeric(name) || '?';
  });
}

// One name's letter, derived against the whole roster it belongs to — the
// strip is only meaningful across the full set, so the set has to come with
// it. A name the roster omits is added before deriving: the journal's agent
// list excludes self on some paths, and our own letter must still be struck
// against the same prefix as everyone else's.
//
// `override` is the box's `tag_char` (the app's Settings → Devices → Tag
// Character, which the journal may one day carry on the roster row). Applied
// AFTER derivation, so one box opting out never shifts what its neighbours
// get from the strip. Taken verbatim once trimmed — the app already
// constrains it to a single rendered character, and re-cutting it here would
// split a multi-code-point emoji.
export function boxLetterFor(name, names = [], override = null) {
  if (typeof override === 'string' && override.trim()) return override.trim();
  const set = names.includes(name) ? names : [...names, name];
  return boxLetters(set)[set.indexOf(name)];
}
