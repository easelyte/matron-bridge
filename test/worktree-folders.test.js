import { describe, expect, it } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';

const silentLog = { warn: () => {}, error: () => {} };
const REQ = (method, params, id = 'r1') => ({ request_id: id, from_device_id: 7, method, params });

function harness(overrides = {}) {
  const responses = [];
  const handler = createRpcRequestHandler({
    respondRpc: (args) => responses.push(args),
    startSession: () => ({ claudeSessionId: 'session-uuid-1' }),
    stopSession: () => {},
    listPersistedSessions: () => [],
    defaultWorkdir: '/home/alice',
    defaultAgent: 'claude',
    expandHome: (p) => p,
    statSync: () => ({ isDirectory: () => true }),
    log: silentLog,
    ...overrides,
  });
  return { handler, responses };
}

describe('recent_folders and worktrees', () => {
  const records = [
    { workdir: '/repo', lastUsed: 10 },
    { workdir: '/repo/.claude/worktrees/fix-1', lastUsed: 30 },
    { workdir: '/repo/.claude/worktrees/fix-1/pkg', lastUsed: 25 },
  ];

  it('keeps worktree folders out of the folder list', () => {
    const { handler, responses } = harness({ listPersistedSessions: () => records });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders.map((f) => f.path)).toEqual(['/repo', '/home/alice']);
  });

  it('a repository folder and its other folders are untouched', () => {
    const { handler, responses } = harness({ listPersistedSessions: () => [{ workdir: '/repo', lastUsed: 10 }, { workdir: '/repo/.claude', lastUsed: 5 }] });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders.map((f) => f.path)).toEqual(['/repo', '/repo/.claude', '/home/alice']);
  });
});
