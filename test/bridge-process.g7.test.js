import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startBridge } from './helpers/bridge-process.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

it.each([
  ['print', "proc.on('close', (exitCode) => {", 'function createCodexSessionForRoom('],
  ['PTY', "iv.on('exit', exitCode => {", 'async function handleInteractivePrompt('],
])('passes shutdown state to the %s crash-restart decision', (_mode, start, end) => {
  const handler = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  expect(handler).toContain('shouldAutoRestart(exitCode, session, shuttingDown)');
});

it('stops Codex turn-exit recovery and retains queued work during shutdown', () => {
  const start = source.indexOf("codex.on('turn-exit',");
  const handler = source.slice(start, source.indexOf('session.resetTimeout =', start));
  expect(handler).toContain('if (shuttingDown || !session.alive) {');
  expect(handler).toMatch(/if \(shuttingDown \|\| !session\.alive\) \{[\s\S]*?discardOutput: true,[\s\S]*?preserveQueue: shuttingDown,[\s\S]*?return;/);
});

async function assertShutdown(interactive, nonzeroSignalExit = false) {
  const originalTreeCopy = fs.cpSync;
  // Publisher confirmations are ws.send callbacks, not journal ack frames.
  // Withhold those confirmations only in the disposable transport fixture.
  const treeCopy = vi.spyOn(fs, 'cpSync').mockImplementation((source, target, options) => {
    originalTreeCopy(source, target, options);
    if (path.basename(source) !== 'index.js') return;
    // Exercise nonzero signal exits even where node-pty reports signals as zero.
    if (nonzeroSignalExit) fs.writeFileSync(target, fs.readFileSync(target, 'utf8')
      .replace("iv.on('exit', exitCode => {", "iv.on('exit', exitCode => { if (shuttingDown) exitCode = 1;"));
    fs.appendFileSync(target, `
import ShutdownWebSocket from 'ws';
const shutdownSend = ShutdownWebSocket.prototype.send;
ShutdownWebSocket.prototype.send = function(data, callback) {
  return shutdownSend.call(this, data, JSON.parse(data).op === 'hello' ? callback : undefined);
};
`);
  });
  let bridge;
  try {
    bridge = await startBridge({ interactive });
  } finally {
    treeCopy.mockRestore();
  }
  try {
    const session = await bridge.startSession();
    expect(session.alive).toBe(true);
    await bridge.echo('shutdown ready');
    expect(bridge.stubLaunches().filter(launch => launch.args.includes(session.claudeSessionId))).toHaveLength(1);
    const launches = () => bridge.stubLaunches().length;
    const before = launches();
    const started = Date.now();
    const exit = await bridge.terminate();
    const elapsed = Date.now() - started;
    const respawns = launches() - before;
    expect(respawns, `expected 0 respawns during gracefulShutdown, got ${respawns}`).toBe(0);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(4000);
    expect(bridge.frames.some(frame => frame.op === 'hello')).toBe(true);
  } finally {
    await bridge.close();
  }
}

it.each([true, false])('does not respawn during gracefulShutdown (interactive=%s)', async interactive => {
  await assertShutdown(interactive);
}, 20000);

it('does not respawn on a nonzero PTY signal exit during shutdown', async () => {
  await assertShutdown(true, true);
}, 20000);
