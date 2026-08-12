import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js, same idiom as test/inflight-wiring.test.js
// (read the source, extract a region by needle, assert the substring is present).
// index.js has no unit-test harness, so this index.js WIRING invariant has no
// behavioural coverage at all.
//
// Critical #1 of PR #209 has two halves, and BOTH must hold for the codex-viz
// live view to activate:
//   (a) the producer shim is prepended to the SESSION's PATH — pinned by
//       test/codex-paths.test.js (prependShimToPath / configureCodexSinkEnv);
//   (b) the watcher's activation guard (detectProducer) is evaluated against
//       that SESSION env, not the bridge's process.env — the wiring pinned here.
//
// Half (b) is the silent one. Deleting the single line
//   watcherDependencies: { env: session.codexSpawnEnv || process.env }
// from setupSubagentWatcher leaves the ENTIRE suite green, yet detectProducer
// then evaluates the bridge's PATH (which has no shim), finds no producer, and
// leaves the live view disabled — the exact reported bug this PR fixes. Nothing
// at runtime catches that, hence these source-text pins.
describe('codex-viz session-env watcher wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  function bodyOf(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    expect(start, `could not find ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    const end = src.indexOf(endNeedle, start + 1);
    expect(end, `could not find the end of ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  it('constructs the codex watcher against session.codexSpawnEnv, not the bridge env', () => {
    const body = bodyOf('function setupSubagentWatcher(', '\nfunction ');

    expect(
      body,
      'setupSubagentWatcher must pass '
      + '`watcherDependencies: { env: session.codexSpawnEnv || process.env }` to '
      + 'setupCodexWatcherForSession. This is half (b) of critical #1: the codex-viz activation guard '
      + '(detectProducer) has to evaluate the SESSION env — where half (a) prepended the producer shim '
      + 'to PATH — not the bridge process.env, which has no shim. CONSEQUENCE OF DELETING THIS LINE: '
      + 'detectProducer runs against the bridge PATH, finds no producer, and the live view is silently '
      + 'disabled again. The full suite stays GREEN without it, which is exactly why this pin exists.',
    ).toContain('watcherDependencies: { env: session.codexSpawnEnv || process.env }');
  });

  it('sets session.codexSpawnEnv on BOTH spawn paths so the wiring above has a value to read', () => {
    // The watcher reads session.codexSpawnEnv; if a spawn path forgets to set it,
    // the `|| process.env` fallback silently restores the bridge-PATH bug for
    // that path alone. Pin both producers of the field.
    expect(
      src.includes('codexSpawnEnv: spawnEnv,'),
      'the --print spawn path\'s session object must set `codexSpawnEnv: spawnEnv` — the effective env '
      + 'whose PATH carries the prepended shim. Without it session.codexSpawnEnv is undefined on the '
      + 'print path, the watcher falls back to the bridge env, and the live view is silently off for '
      + 'print sessions.',
    ).toBe(true);

    expect(
      src.includes('codexSpawnEnv: interactiveEnv,'),
      'the interactive (iv) spawn path\'s session object must set `codexSpawnEnv: interactiveEnv`. '
      + 'Without it session.codexSpawnEnv is undefined on the iv path, the watcher falls back to the '
      + 'bridge env, and the live view is silently off for iv sessions.',
    ).toBe(true);

    // Exactly the two spawn paths mint the field. The read site uses
    // `session.codexSpawnEnv ||` (no colon) and is not counted here.
    expect(
      src.split('codexSpawnEnv:').length - 1,
      'index.js must set session.codexSpawnEnv at EXACTLY two sites — the --print spawn path '
      + '(`codexSpawnEnv: spawnEnv`) and the iv spawn path (`codexSpawnEnv: interactiveEnv`). A new '
      + 'spawn path that omits it re-opens the silent-off bug for that path; pair any new session '
      + 'object with the session env that carries the shim before changing this count.',
    ).toBe(2);
  });
});
