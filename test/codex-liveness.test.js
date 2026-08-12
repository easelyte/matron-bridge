import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isWrapperAlive, pastDeadline } from '../lib/codex-liveness.js';

function currentStartTicks() {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const fieldsAfterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return fieldsAfterComm[19];
}

describe('isWrapperAlive', () => {
  it('returns true when the pid is alive and its start ticks match', () => {
    expect(isWrapperAlive({
      wrapperPid: process.pid,
      wrapperStartTicks: currentStartTicks(),
    })).toBe(true);
  });

  it('returns false when an alive pid has been reused', () => {
    const staleStartTicks = (BigInt(currentStartTicks()) + 1n).toString();

    expect(isWrapperAlive({
      wrapperPid: process.pid,
      wrapperStartTicks: staleStartTicks,
    })).toBe(false);
  });

  it('returns false when the pid is dead', () => {
    expect(isWrapperAlive({
      wrapperPid: 2_147_483_647,
      wrapperStartTicks: '1',
    })).toBe(false);
  });

  // F2 (T-6.6): non-Linux (dev/macOS) has no /proc — liveness-only via
  // kill(pid,0), start-ticks ignored. Linux keeps the identity check.
  describe('non-linux platform guard (F2)', () => {
    it('reports a live pid alive on darwin without reading /proc start-ticks', () => {
      expect(isWrapperAlive(
        { wrapperPid: process.pid, wrapperStartTicks: 'ignored-off-linux' },
        { platform: 'darwin' },
      )).toBe(true);
    });

    it('reports a dead pid dead on darwin', () => {
      expect(isWrapperAlive(
        { wrapperPid: 2_147_483_647, wrapperStartTicks: 'ignored-off-linux' },
        { platform: 'darwin' },
      )).toBe(false);
    });

    // These two read the caller's real /proc/<pid>/stat via currentStartTicks(),
    // which throws off Linux — skip there (macOS is a documented dev platform).
    it.skipIf(process.platform !== 'linux')('still rejects a start-tick mismatch on linux (identity check intact)', () => {
      const staleStartTicks = (BigInt(currentStartTicks()) + 1n).toString();
      expect(isWrapperAlive(
        { wrapperPid: process.pid, wrapperStartTicks: staleStartTicks },
        { platform: 'linux' },
      )).toBe(false);
    });

    it.skipIf(process.platform !== 'linux')('still accepts matching start-ticks on linux', () => {
      expect(isWrapperAlive(
        { wrapperPid: process.pid, wrapperStartTicks: currentStartTicks() },
        { platform: 'linux' },
      )).toBe(true);
    });
  });
});

describe('pastDeadline', () => {
  it('returns true only beyond the deadline', () => {
    const meta = { deadlineTs: 1_000 };

    expect(pastDeadline(meta, 1_001)).toBe(true);
    expect(pastDeadline(meta, 1_000)).toBe(false);
  });
});
