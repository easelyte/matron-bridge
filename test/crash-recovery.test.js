import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCrashWatch, appendCrashLog, truncateSnapshot, describeExit, recoveryPrompt, burstNoticeText,
} from '../lib/crash-recovery.js';
import { processTableCommand } from '../lib/process-table.js';
import { noticeMeta } from '../lib/system-notice.js';
import { carryOnCause } from '../lib/turn-cause.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('createCrashWatch', () => {
  it('does not flag repeated crashes of one conversation as a burst', () => {
    const w = createCrashWatch({ now: () => 1000 });
    for (let i = 0; i < 3; i += 1) {
      const result = w.note({ convoId: 'a', exitCode: 143 });
      expect(result.burst).toBe(false);
      expect(result.count).toBe(1);
      expect(result.events).toHaveLength(i + 1);
    }
  });

  it('counts distinct conversations while retaining every crash and exit', () => {
    const w = createCrashWatch({ now: () => 1000 });
    const crashes = [
      { convoId: 'a', exitCode: 143 },
      { convoId: 'a', exitCode: 137 },
      { convoId: 'b', exitCode: 1 },
      { convoId: 'b', exitCode: null, signal: 'SIGKILL' },
      { convoId: 'c', exitCode: 143 },
    ];
    for (const crash of crashes.slice(0, -1)) {
      expect(w.note(crash).burst).toBe(false);
    }
    const result = w.note(crashes[4]);
    expect(result.burst).toBe(true);
    expect(result.count).toBe(3);
    expect(result.events).toEqual(crashes.map(crash => ({ at: 1000, signal: null, wasBusy: false, ...crash })));
    const text = burstNoticeText({ count: result.count, exits: result.events.map(describeExit) });
    expect(text).toContain('3 sessions crashed within 60s');
    expect(text).toContain('(exit 143 (SIGTERM), exit 137 (SIGKILL), exit 1, signal SIGKILL)');
  });

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
    expect(w.note({ convoId: 'd', exitCode: 143 }).burst).toBe(false);
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

  it('reopens a burst when distinct conversations age out despite repeated crashes remaining', () => {
    let t = 0;
    const w = createCrashWatch({ now: () => t });
    w.note({ convoId: 'a', exitCode: 143 });
    w.note({ convoId: 'b', exitCode: 143 });
    expect(w.note({ convoId: 'c', exitCode: 143 }).burst).toBe(true);
    t = 30_000;
    for (let i = 0; i < 3; i += 1) w.note({ convoId: 'c', exitCode: 143 });
    t = 61_000;
    const second = w.note({ convoId: 'd', exitCode: 143 });
    expect(second.count).toBe(2);
    expect(second.burst).toBe(false);
    const third = w.note({ convoId: 'e', exitCode: 143 });
    expect(third.count).toBe(3);
    expect(third.burst).toBe(true);
  });

  it('caps remembered events even inside one window', () => {
    const w = createCrashWatch({ now: () => 5, windowMs: 60_000, threshold: 3, maxEvents: 10 });
    let last;
    for (let i = 0; i < 50; i += 1) last = w.note({ convoId: `s${i}`, exitCode: 1 });
    expect(last.count).toBe(10);
    expect(last.events).toHaveLength(10);
    expect(last.events[0].convoId).toBe('s40');
    expect(w.size()).toBe(10);
  });

  it('reopens a burst when the event cap removes distinct conversations', () => {
    const w = createCrashWatch({ now: () => 1000, maxEvents: 3 });
    w.note({ convoId: 'a', exitCode: 143 });
    w.note({ convoId: 'b', exitCode: 143 });
    expect(w.note({ convoId: 'c', exitCode: 143 }).burst).toBe(true);
    const repeated = w.note({ convoId: 'c', exitCode: 143 });
    expect(repeated.count).toBe(2);
    expect(repeated.burst).toBe(false);
    expect(w.note({ convoId: 'd', exitCode: 143 }).burst).toBe(false);
    const next = w.note({ convoId: 'e', exitCode: 143 });
    expect(next.count).toBe(3);
    expect(next.burst).toBe(true);
  });
});

describe('appendCrashLog', () => {
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crash-log-')), 'log.jsonl');

  it('appends one JSON line per crash', () => {
    const file = tmpFile();
    expect(appendCrashLog(file, { n: 1 })).toBe(true);
    expect(appendCrashLog(file, { n: 2 })).toBe(true);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).n)).toEqual([1, 2]);
  });

  it('keeps only the newest entries', () => {
    const file = tmpFile();
    for (let n = 0; n < 12; n += 1) appendCrashLog(file, { n }, { maxEntries: 5 });
    const kept = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).n);
    expect(kept).toEqual([7, 8, 9, 10, 11]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['log.jsonl']);
  });

  it('never throws on an unwritable path', () => {
    expect(appendCrashLog(path.join(os.tmpdir(), 'no-such-dir-crash', 'x', 'log.jsonl'), { n: 1 })).toBe(false);
  });
});

describe('process snapshot', () => {
  it('uses the portable process table command, with no GNU-only ps flags', () => {
    const { file, args } = processTableCommand('darwin');
    expect(file).toBe('ps');
    expect(args.join(' ')).not.toMatch(/--sort|etime|pcpu/);
    expect(source).toMatch(/const \{ file, args \} = processTableCommand\(\);/);
    expect(source).not.toContain("'--sort=-pcpu'");
  });

  it('caps lines and line length', () => {
    const text = Array.from({ length: 100 }, () => 'x'.repeat(500)).join('\n');
    const out = truncateSnapshot(text, { maxLines: 5, maxLineLength: 20 }).split('\n');
    expect(out).toHaveLength(5);
    expect(out[0]).toHaveLength(20);
  });
});

describe('texts', () => {
  it('names the exit', () => {
    expect(describeExit({ exitCode: 143 })).toBe('exit 143 (SIGTERM)');
    expect(describeExit({ exitCode: null, signal: 'SIGKILL' })).toBe('signal SIGKILL');
    expect(describeExit({ exitCode: 2 })).toBe('exit 2');
  });

  it('tells the agent its previous run died mid-turn and what to do', () => {
    const p = recoveryPrompt({ exitCode: 143 });
    expect(p).toContain('previous run died mid-turn');
    expect(p).toContain('exit 143');
    expect(p).toContain('tell the user plainly which work was lost');
  });

  it('summarises a burst, in the notice shape the apps expect', () => {
    const text = burstNoticeText({ count: 7, exits: ['exit 143 (SIGTERM)', 'exit 143 (SIGTERM)', 'signal SIGKILL'] });
    expect(text).toContain('7 sessions');
    expect(text).toContain('(exit 143 (SIGTERM), signal SIGKILL)');
    const meta = noticeMeta('alert', text, { icon: '⚠️', summary: '7 sessions crashed within 60s' });
    expect(meta).toEqual({ kind: 'alert', icon: '⚠️', summary: '7 sessions crashed within 60s' });
  });
});

describe('wiring in index.js', () => {
  const fn = source.slice(source.indexOf('function onCrashRestart('), source.indexOf('function createSession('));

  it('carries a mid-turn crash on through carryOnConvo with a carry_on cause', () => {
    expect(fn).toMatch(/if \(wasBusy\) \{[\s\S]*?carryOnConvo\(convoId, target, null, text, undefined, \{ causes: \[carryOnCause\(\)\], keepRestartBudget: true \}\)/);
    expect(carryOnCause().kind).toBe('carry_on');
    const carry = source.slice(source.indexOf('async function carryOnConvo('), source.indexOf('async function carryOnConvo(') + 2400);
    expect(carry).toContain('journalRouteTextToSession(target, text, { causes, keepRestartBudget })');
  });

  it('ignores child exits during shutdown and falls back to the session chat for the notice', () => {
    expect(fn).toMatch(/if \(shuttingDown\) return;/);
    expect(fn).toContain('coordinatorLookup.snapshot().convoId || convoId');
  });

  it('posts the burst as a tagged notice and runs on both crash paths', () => {
    expect(fn).toMatch(/journalPublishNotice\(noticeConvoId, text, noticeMeta\('alert', text, \{/);
    expect(source.match(/^\s+onCrashRestart\(session, restarted, exitCode.*;$/gm)).toHaveLength(2);
  });
});
