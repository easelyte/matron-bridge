import { describe, expect, it } from 'vitest';
import {
  createCrashWatch, lostWorkLikely, describeExit, recoveryPrompt, crashNoticeText, burstNoticeText,
} from '../lib/crash-recovery.js';

describe('createCrashWatch', () => {
  it('flags a burst once, on the crash that crosses the threshold', () => {
    let t = 1000;
    const w = createCrashWatch({ now: () => t, windowMs: 60_000, threshold: 3 });
    expect(w.note({ convoId: 'a', exitCode: 143 }).burst).toBe(false);
    t += 1000;
    expect(w.note({ convoId: 'b', exitCode: 143 }).burst).toBe(false);
    t += 1000;
    const third = w.note({ convoId: 'c', exitCode: 143 });
    expect(third.burst).toBe(true);
    expect(third.count).toBe(3);
    t += 1000;
    const fourth = w.note({ convoId: 'd', exitCode: 143 });
    expect(fourth.burst).toBe(false);
    expect(fourth.inBurst).toBe(true);
  });

  it('does not count crashes that are far apart', () => {
    let t = 0;
    const w = createCrashWatch({ now: () => t, windowMs: 60_000, threshold: 3 });
    for (let i = 0; i < 6; i += 1) {
      expect(w.note({ convoId: `s${i}`, exitCode: 1 }).burst).toBe(false);
      t += 61_000;
    }
    expect(w.size()).toBe(0);
  });

  it('reports a second burst after the first has aged out', () => {
    let t = 0;
    const w = createCrashWatch({ now: () => t, windowMs: 10_000, threshold: 2 });
    w.note({ convoId: 'a', exitCode: 143 });
    expect(w.note({ convoId: 'b', exitCode: 143 }).burst).toBe(true);
    t += 20_000;
    w.note({ convoId: 'c', exitCode: 143 });
    expect(w.note({ convoId: 'd', exitCode: 143 }).burst).toBe(true);
  });
});

describe('lostWorkLikely', () => {
  it('is true mid-turn or with background work on the last observation', () => {
    expect(lostWorkLikely({ busy: true, bgWorkObserved: { hasWork: false } })).toBe(true);
    expect(lostWorkLikely({ busy: false, bgWorkObserved: { hasWork: true } })).toBe(true);
  });
  it('is false when nothing was seen running, or nothing was observed yet', () => {
    expect(lostWorkLikely({ busy: false, bgWorkObserved: { hasWork: false } })).toBe(false);
    expect(lostWorkLikely({ busy: false, bgWorkObserved: null })).toBe(false);
  });
});

describe('texts', () => {
  it('names the exit', () => {
    expect(describeExit({ exitCode: 143 })).toBe('exit 143 (SIGTERM)');
    expect(describeExit({ exitCode: null, signal: 'SIGKILL' })).toBe('signal SIGKILL');
    expect(describeExit({ exitCode: 2 })).toBe('exit 2');
  });
  it('tells the agent what died and what to do', () => {
    const p = recoveryPrompt({ exitCode: 143, wasBusy: false });
    expect(p).toContain('exit 143');
    expect(p).toContain('background shell tasks');
    expect(p).toContain('tell the user plainly which work was lost');
  });
  it('says whether a recovery prompt was sent', () => {
    expect(crashNoticeText({ exitCode: 143, restartCount: 1, willResume: true })).toContain('asked to check');
    expect(crashNoticeText({ exitCode: 1, restartCount: 2, willResume: false })).toContain('No in-flight work');
  });
  it('summarises a burst for the coordinator', () => {
    const t = burstNoticeText({ count: 7, exitCodes: [143, 143, 1] });
    expect(t).toContain('7 sessions');
    expect(t).toContain('143, 1');
  });
});
