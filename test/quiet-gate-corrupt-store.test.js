import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSubagentRunningStore } from '../lib/subagent-running-store.js';
import { evaluateQuiet } from '../lib/restart-quiet.js';

let dir;
let file;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'quiet-corrupt-')); file = path.join(dir, 'running.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function gate(store, prev) {
  return evaluateQuiet({
    sessions: new Map([['a', { alive: true, journalConvoId: 'a' }]]), bootAt: 1000, prev,
    readProcessTable: () => ({ ok: true, table: [] }),
    listRunningSubagents: () => {
      const result = store.listStrict();
      if (result.ok !== true) throw new Error('subagents unavailable');
      return result.records;
    },
  });
}

describe('background markers with a damaged subagent store', () => {
  it.each([
    ['unparseable bytes', '{invalid'],
    ['a non-object payload', '[]'],
    ['a record without a usable timestamp', JSON.stringify({ child: { parentConvoId: 'a', agentId: 'x', addedAt: 'soon' } })],
    ['a record that is not an object', JSON.stringify({ child: 'oops' })],
  ])('keeps the gate closed with an explicit probe_error for %s', (_label, bytes) => {
    writeFileSync(file, bytes);
    const store = createSubagentRunningStore({ file, log: { warn() {} } });
    let result;
    expect(() => { result = gate(store, { consecutiveQuiet: 5 }); }).not.toThrow();
    expect(result.probe_error).toBe('subagents');
    expect(result.quiet).toBe(false);
    expect(result.consecutiveQuiet).toBe(0);
  });

  it('recovers after a later valid write', () => {
    writeFileSync(file, '{invalid');
    const store = createSubagentRunningStore({ file, bootAt: 1000, log: { warn() {} } });
    expect(gate(store).probe_error).toBe('subagents');
    expect(store.add('child-a', { parentConvoId: 'other', agentId: 'x' })).toBe(true);
    store.remove('child-a');
    const first = gate(store);
    expect(first.probe_error).toBeNull();
    expect(gate(store, first).quiet).toBe(true);
  });
});
