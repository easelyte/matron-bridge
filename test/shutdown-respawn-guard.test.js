import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function loadShouldAutoRestart() {
  const start = source.indexOf('function shouldAutoRestart(');
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, source.indexOf('\n}\n', start) + 2)}\nthis.fn = shouldAutoRestart;`, context);
  return context.fn;
}

describe('shutdown respawn guard', () => {
  const shouldAutoRestart = loadShouldAutoRestart();

  it('respawns a crashed child within budget when not shutting down', () => {
    expect(shouldAutoRestart(1, { restartCount: 0 }, false)).toBe(true);
    expect(shouldAutoRestart(1, { restartCount: 2 }, false)).toBe(true);
    expect(shouldAutoRestart(null, { restartCount: 0 }, false)).toBe(true);
  });

  it('keeps the existing crash limits', () => {
    expect(shouldAutoRestart(0, { restartCount: 0 }, false)).toBe(false);
    expect(shouldAutoRestart(1, { restartCount: 3 }, false)).toBe(false);
    expect(shouldAutoRestart(1, { restartCount: 0, _resumeFailed: true }, false)).toBe(false);
  });

  it('never respawns once shutdown has begun', () => {
    expect(shouldAutoRestart(1, { restartCount: 0 }, true)).toBe(false);
    expect(shouldAutoRestart(137, { restartCount: 1 }, true)).toBe(false);
    expect(shouldAutoRestart(null, { restartCount: 0 }, true)).toBe(false);
  });

  it.each([
    ['print', "proc.on('close', (exitCode) => {", 'function createCodexSessionForRoom('],
    ['interactive', "iv.on('exit', exitCode => {", 'async function handleInteractivePrompt('],
  ])('passes shutdown state to the %s-mode decision', (_mode, start, end) => {
    const from = source.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    const handler = source.slice(from, source.indexOf(end, from));
    expect(handler).toContain('shouldAutoRestart(exitCode, session, shuttingDown)');
    // Shutdown takes a quiet branch before the respawn/ended decision.
    expect(handler).toMatch(/\} else if \(shuttingDown\) \{[\s\S]*?\} else if \(shouldAutoRestart\(/);
  });

  it.each([
    ['print', "proc.on('close', (exitCode) => {", 'function createCodexSessionForRoom('],
    ['interactive', "iv.on('exit', exitCode => {", 'async function handleInteractivePrompt('],
  ])('clears the activity overlay on the quiet branch (%s)', (_mode, start, end) => {
    const from = source.indexOf(start);
    const handler = source.slice(from, source.indexOf(end, from));
    const branch = handler.match(/\} else if \(shuttingDown\) \{([\s\S]*?)\} else if \(shouldAutoRestart\(/)[1];
    expect(branch).toContain("journalActivity(session, 'idle')");
    // Still resumable: never marks the conversation done or posts an ended notice.
    expect(branch).not.toContain("journalSessionState(session, 'done')");
    expect(branch).not.toContain('Session ended');
  });

  it('keeps the print-mode reset when /logout completes during the quiet branch', () => {
    const from = source.indexOf("iv.on('exit', exitCode => {");
    const handler = source.slice(from, source.indexOf('async function handleInteractivePrompt(', from));
    const branch = handler.match(/\} else if \(shuttingDown\) \{([\s\S]*?)\} else if \(shouldAutoRestart\(/)[1];
    expect(branch).toMatch(/_accountLogoutPending && exitCode === 0/);
    expect(branch).toContain('_accountFlowReturnToPrint');
    expect(branch).toContain('interactiveMode: false');
  });
});
