import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// index.js has no unit harness; pin the reconcile wiring by source inspection.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('reconcileStrandedSubagents: a resumed child supersedes a pending done repair', () => {
  const start = index.indexOf('function reconcileStrandedSubagents(');
  const body = index.slice(start, index.indexOf('\n}\n', start) + 2);

  it('remembers the record stamp the repair was built from', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/const addedAt = entries\.find\(\(entry\) => entry\.childConvoId === childConvoId\)\?\.addedAt;/);
  });

  it('removes the record on delivery only while it is still that record', () => {
    const delivered = body.slice(body.indexOf('onDelivered'));
    expect(delivered).toContain('subagentRunningStore.list().find((entry) => entry.childConvoId === childConvoId)');
    expect(delivered).toMatch(/if \(current && current\.addedAt === addedAt\) subagentRunningStore\.remove\(childConvoId\);/);
    // No unconditional remove left behind.
    expect(body).not.toContain('onDelivered: () => subagentRunningStore.remove(childConvoId)');
  });
});
