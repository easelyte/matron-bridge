import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Regression guard for the 2026-08-12 fork-sync latch collision.
//
// index.js's turn-end gate (maybeSummarizeAtTurnEnd) and lib/pinned-summary.js's
// inner pass (updatePinnedSummary) each hold their own re-entrancy latch. The
// fork-sync merge briefly had BOTH use `_summaryInFlight`: the outer gate set it
// before calling the inner pass, the inner pass saw it already set and bailed on
// every run, so codex never fired and pinned titles/summaries stopped
// regenerating. The two latches MUST stay on distinct session fields.
//
// index.js starts a server at import time (main() + apiServer.listen at module
// top level), so it can't be imported for a behavioral composition test — hence
// this source-level invariant, which pins the exact field names the two layers
// use and asserts they differ. If either layer's latch field is renamed to
// collide again, this fails.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const INNER_LATCH = '_summaryInFlight'; // owned by updatePinnedSummary
const OUTER_LATCH = '_summaryTurnInFlight'; // owned by maybeSummarizeAtTurnEnd

function sliceFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${signature}`);
  // Anchor on the body-opening brace (after the param list — which may itself
  // be a destructured `{ ... }` object), then walk to its matching close.
  const bodyOpen = /\)\s*\{/.exec(source.slice(start));
  if (!bodyOpen) throw new Error(`could not find body of ${signature}`);
  const open = start + bodyOpen.index + bodyOpen[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describe('summary latch separation (fork-sync collision regression)', () => {
  const indexSrc = readFileSync(join(root, 'index.js'), 'utf8');
  const pinnedSrc = readFileSync(join(root, 'lib/pinned-summary.js'), 'utf8');

  it('the two latch fields are distinct', () => {
    expect(OUTER_LATCH).not.toBe(INNER_LATCH);
  });

  it('the inner pass guards on and sets the inner latch', () => {
    const fn = sliceFunction(pinnedSrc, 'export async function updatePinnedSummary');
    expect(fn).toContain(`session.${INNER_LATCH}`);
    expect(fn).toContain(`session.${INNER_LATCH} = true`);
  });

  it('the turn-end gate sets the OUTER latch and never touches the inner latch', () => {
    const fn = sliceFunction(indexSrc, 'function maybeSummarizeAtTurnEnd');
    expect(fn).toContain(`session.${OUTER_LATCH} = true`);
    // The exact collision: the outer gate must not assign the inner pass's field.
    expect(fn).not.toContain(`session.${INNER_LATCH} =`);
  });
});
