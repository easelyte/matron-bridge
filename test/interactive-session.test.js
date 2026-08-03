import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInteractiveSession, InteractiveSession, transcriptPathFor } from '../lib/interactive-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, 'stub-claude.mjs');

async function waitFor(cond, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, interval));
  }
}

describe('transcriptPathFor', () => {
  it('encodes the workdir path with dashes', () => {
    const p = transcriptPathFor('/home/danbarker/foo', 'abc-123');
    expect(p).toBe(path.join(os.homedir(), '.claude', 'projects', '-home-danbarker-foo', 'abc-123.jsonl'));
  });
});

it('uses the synchronous zero-window transcript drain fast path', () => {
  const tail = new EventEmitter();
  tail.drain = (...args) => { tail.args = args; return Promise.resolve({ ok: true }); };
  tail.stop = () => Promise.resolve();
  const ptyHandle = {
    onData() {},
    onExit() {},
  };
  const session = new InteractiveSession({
    roomId: 'room', workdir: '/tmp', sessionId: 'session', ptyHandle, tail,
  });

  expect(() => session.drainTranscript()).not.toThrow();
  expect(tail.args).toEqual([{ windowMs: 0 }]);
});

describe('createInteractiveSession', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a message through the stub binary', async () => {
    const txPath = path.join(dir, 'session.jsonl');
    const session = createInteractiveSession({
      roomId: 'room1',
      workdir: dir,
      sessionId: 'sid-test',
      claudeBin: process.execPath,
      claudeArgs: [STUB],
      env: { ...process.env, TRANSCRIPT_PATH: txPath, MATRON_BASH_TEE_ENABLED: undefined },
      transcriptPath: txPath,
    });
    const events = [];
    session.on('event', e => events.push(e));
    session.sendText('hello');
    await waitFor(() => events.filter(e => e.type === 'result').length >= 1);
    session.sendText('/exit');
    await new Promise(resolve => session.on('exit', resolve));
    const types = events.map(e => e.type);
    expect(types).toContain('user');
    expect(types).toContain('assistant');
    expect(types).toContain('result');
    const userText = events.find(e => e.type === 'user').message.content[0].text;
    expect(userText).toBe('hello');
    const assistantText = events.find(e => e.type === 'assistant').message.content[0].text;
    expect(assistantText).toBe('echo: hello');
  }, 15000);

  it('emits exit when the child process ends', async () => {
    const txPath = path.join(dir, 'session.jsonl');
    const session = createInteractiveSession({
      roomId: 'room2',
      workdir: dir,
      sessionId: 'sid-test-exit',
      claudeBin: process.execPath,
      claudeArgs: [STUB],
      env: { ...process.env, TRANSCRIPT_PATH: txPath, MATRON_BASH_TEE_ENABLED: undefined },
      transcriptPath: txPath,
    });
    session.sendText('/exit');
    const exitCode = await new Promise(resolve => session.on('exit', resolve));
    expect(exitCode).toBe(0);
    expect(session.alive).toBe(false);
  }, 10000);

  it('detects a TUI prompt and responds via keystroke', async () => {
    const txPath = path.join(dir, 'session.jsonl');
    const session = createInteractiveSession({
      roomId: 'room-prompt',
      workdir: dir,
      sessionId: 'sid-prompt',
      claudeBin: process.execPath,
      claudeArgs: [STUB],
      env: { ...process.env, TRANSCRIPT_PATH: txPath, MATRON_BASH_TEE_ENABLED: undefined },
      transcriptPath: txPath,
    });
    const events = [];
    const prompts = [];
    session.on('event', e => events.push(e));
    session.on('prompt', p => prompts.push(p));
    // Trigger the stub's fake prompt.
    session.sendText('__prompt__');
    await waitFor(() => prompts.length >= 1, { timeout: 4000 });
    expect(prompts[0].kind).toBe('yes-no');
    // Respond 'y'. The stub treats 'y' followed by Enter as a normal user
    // message, so it'll emit user/assistant/result events.
    session.respondToPrompt({ kind: 'yes-no', key: 'y' });
    await waitFor(() => events.filter(e => e.type === 'result').length >= 1, { timeout: 4000 });
    const userEvent = events.find(e => e.type === 'user');
    expect(userEvent.message.content[0].text).toBe('y');
    session.sendText('/exit');
    await new Promise(resolve => session.on('exit', resolve));
  }, 15000);

  it('writes workspace trust to a custom claudeJsonPath before spawning', async () => {
    const txPath = path.join(dir, 'session.jsonl');
    const claudeJsonPath = path.join(dir, '.claude.json');
    const session = createInteractiveSession({
      roomId: 'room3',
      workdir: dir,
      sessionId: 'sid-trust',
      claudeBin: process.execPath,
      claudeArgs: [STUB],
      env: { ...process.env, TRANSCRIPT_PATH: txPath, MATRON_BASH_TEE_ENABLED: undefined },
      transcriptPath: txPath,
      claudeJsonPath,
    });
    expect(fs.existsSync(claudeJsonPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(cfg.projects[dir].hasTrustDialogAccepted).toBe(true);
    session.sendText('/exit');
    await new Promise(resolve => session.on('exit', resolve));
  }, 10000);
});
