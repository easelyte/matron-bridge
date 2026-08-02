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
});

describe('pastDeadline', () => {
  it('returns true only beyond the deadline', () => {
    const meta = { deadlineTs: 1_000 };

    expect(pastDeadline(meta, 1_001)).toBe(true);
    expect(pastDeadline(meta, 1_000)).toBe(false);
  });
});
