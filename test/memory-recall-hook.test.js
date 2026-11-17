import { describe, it, expect } from 'vitest';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { memoryRecallEntry, memoryRecallHookOutput, MEMORY_RECALL_HOOK_TIMEOUT_S } from '../lib/memory-recall-hook.js';
import { buildPrintSessionSettings } from '../lib/permission-prompt.js';

const HOOKS_DIR = '/opt/bridge/hooks';
const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'hooks', 'memory-recall.mjs');

describe('memory-recall hook entry', () => {
  it('posix: node + the .mjs + port, room and token file, with a short limit', () => {
    const e = memoryRecallEntry({ hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'room-1', apiHeaderFile: '/run/h', platform: 'linux' });
    expect(e.hooks).toHaveLength(1);
    expect(e.hooks[0].command).toBe(`node '${path.posix.join(HOOKS_DIR, 'memory-recall.mjs')}' --port '9802' --room 'room-1' --auth '/run/h'`);
    expect(e.hooks[0].timeout).toBe(MEMORY_RECALL_HOOK_TIMEOUT_S);
  });
  it('win32: exec form', () => {
    const e = memoryRecallEntry({ hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'room 1', platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
    expect(e.hooks[0]).toMatchObject({ command: 'C:\\nodejs\\node.exe', args: [path.win32.join(HOOKS_DIR, 'memory-recall.mjs'), '--port', '9802', '--room', 'room 1'] });
  });
  it('print sessions carry it as their UserPromptSubmit hook, bypass or not', () => {
    for (const bypass of [true, false]) {
      const s = buildPrintSessionSettings({ bypass, hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'room-1', apiHeaderFile: '/run/h', platform: 'linux' });
      expect(s.hooks.UserPromptSubmit).toEqual([memoryRecallEntry({ hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'room-1', apiHeaderFile: '/run/h', platform: 'linux' })]);
    }
    expect(buildPrintSessionSettings({ bypass: true, hooksDir: HOOKS_DIR, apiPort: 9802, roomId: '', platform: 'linux' }).hooks.UserPromptSubmit).toBeUndefined();
  });
  it('interactive sessions carry it too (source inspection)', () => {
    const index = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
    expect(index).toContain("UserPromptSubmit: [memoryRecallEntry({ hooksDir: path.join(__dirname, 'hooks'), apiPort: API_PORT, roomId, apiHeaderFile: apiHeaderFileFor(roomId) })],");
  });
});

describe('memoryRecallHookOutput', () => {
  it('nothing matched → null; a match → additionalContext for UserPromptSubmit', () => {
    expect(memoryRecallHookOutput({ memories: [] })).toBeNull();
    expect(memoryRecallHookOutput(null)).toBeNull();
    const out = memoryRecallHookOutput({ memories: [{ name: 'book-vans', description: 'Book vans early.', body: '', scope: 'global', tier: 'on_demand' }] });
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('### `book-vans`');
  });
});

// The script itself, against a stand-in bridge.
function runHook(args, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(stdin);
  });
}
async function withBridge(answer, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      const [status, data] = answer;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('hooks/memory-recall.mjs', () => {
  it('posts the prompt for its room and prints the context', async () => {
    await withBridge([200, { memories: [{ name: 'book-vans', description: 'Book vans early.', body: 'Why: they sell out.' }] }], async (port, seen) => {
      const r = await runHook(['--port', String(port), '--room', 'room-1'], JSON.stringify({ prompt: 'book a van for friday please' }));
      expect(r.code).toBe(0);
      expect(seen).toEqual([{ url: '/memory/recall-turn', body: { roomId: 'room-1', text: 'book a van for friday please' } }]);
      const out = JSON.parse(r.out);
      expect(out.hookSpecificOutput.additionalContext).toContain('Why: they sell out.');
    });
  });
  it('prints nothing and exits 0 on no match, a bridge error, bad input or no bridge', async () => {
    await withBridge([200, { memories: [] }], async (port) => {
      expect(await runHook(['--port', String(port), '--room', 'r'], JSON.stringify({ prompt: 'hello there friend' }))).toEqual({ code: 0, out: '' });
    });
    await withBridge([500, { error: 'boom' }], async (port) => {
      expect(await runHook(['--port', String(port), '--room', 'r'], JSON.stringify({ prompt: 'hello there friend' }))).toEqual({ code: 0, out: '' });
    });
    expect(await runHook(['--port', '1', '--room', 'r'], 'not json')).toEqual({ code: 0, out: '' });
    expect(await runHook(['--room', 'r'], JSON.stringify({ prompt: 'hello there friend' }))).toEqual({ code: 0, out: '' });
  });
});
