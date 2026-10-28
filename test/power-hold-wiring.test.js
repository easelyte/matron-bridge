import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the reminders-wiring idiom): on macOS
// the bridge itself holds the sleep assertion (lib/power-hold.js) for live
// sessions and hold_awake reminders, independently of the idle reaper.
describe('macOS keep-awake wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

  function fnBody(name) {
    const start = index.indexOf(`function ${name}(`);
    expect(start, `function ${name} is missing from index.js`).toBeGreaterThan(-1);
    const next = index.indexOf('\nfunction ', start + 1);
    return index.slice(start, next === -1 ? undefined : next);
  }

  it('counts live sessions the way the reaper does, and folds in the keep-awake marker', () => {
    const body = fnBody('refreshPowerHold');
    expect(body).toMatch(/if \(session\.alive && !session\._autoStopped\) liveSessions \+= 1;/);
    expect(body).toMatch(/keepAwakeUntil\(\{ timerUntil: timerStore\.holdAwakeMarker\(\)\?\.until \?\? null, workUntil: workLeaseUntil\(\) \}\)/);
    expect(body).toMatch(/powerHoldFlags\(\{ mode: KEEP_AWAKE_MODE, liveSessions, holdUntil \}\)/);
    expect(body).toMatch(/powerHold\.set\(flags\)/);
  });

  it('starts regardless of the idle reaper, and not at all when off', () => {
    const body = fnBody('startPowerHold');
    expect(body).toMatch(/if \(KEEP_AWAKE_MODE === 'off'\) return;/);
    expect(body).toMatch(/setInterval\(refreshPowerHold, POWER_HOLD_TICK_MS\)\.unref\(\);/);
    const main = fnBody('main');
    const reaperBranch = main.indexOf("console.log('Session idle timeout: disabled');");
    const start = main.indexOf('startPowerHold();');
    expect(reaperBranch).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(reaperBranch);
  });

  it('releases the assertion on shutdown', () => {
    expect(fnBody('gracefulShutdown')).toMatch(/powerHold\.stop\(\);/);
  });

  it('documents MATRON_KEEP_AWAKE for deployers', () => {
    expect(envExample).toMatch(/^MATRON_KEEP_AWAKE=$/m);
  });
});
