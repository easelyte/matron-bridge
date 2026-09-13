import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { handleCodexControl, isCodexAuthError } from '../lib/codex-controls.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('Codex authentication recovery in the bridge', () => {
  it('turns the observed 401 into device login after releasing busy state, retaining queued work', async () => {
    const codex = Object.assign(new EventEmitter(), { transport: 'app-server', rpc: vi.fn(async () => ({
      loginId: 'login', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device',
    })) });
    const queuedMessages = [[{ type: 'text', text: 'follow-up' }]];
    const session = { codex, alive: true, busy: true, queuedMessages, _codexTurnFinished: false,
      _codexLastError: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' };
    const reply = vi.fn();
    const finishCodexTurn = vi.fn(s => { s.busy = false; s._codexTurnFinished = true; });
    const context = vm.createContext({ codex, session, clearInterval, CODEX_APP_SERVER: true, isCodexAuthError,
      refreshCodexTelemetry: vi.fn(), refreshCodexMetadata: vi.fn(), finishCodexTurn, offerCodexBuild: vi.fn(),
      runCodexControl: (s, command) => handleCodexControl(s, command, { reply }),
    });
    const start = source.indexOf("  codex.on('turn-exit',");
    vm.runInContext(source.slice(start, source.indexOf('\n  });', start) + 6), context);
    codex.emit('turn-exit', { code: 1, sawTurnCompleted: false });
    await settle();
    expect(finishCodexTurn).toHaveBeenCalledWith(session, expect.objectContaining({ preserveQueue: true }));
    expect(codex.rpc).toHaveBeenCalledExactlyOnceWith('account/login/start', { type: 'chatgptDeviceCode' });
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('ABCD-1234'));
    expect(session.queuedMessages).toBe(queuedMessages);
    // A duplicate terminal event must not replace the active login.
    codex.emit('turn-exit', { code: 1, sawTurnCompleted: false });
    expect(codex.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([{ _codexLoginId: 'login' }, { _codexAccountCommandPending: true }])('keeps input out of the model while signing in: %j', state => {
    const session = { alive: true, codex: { transport: 'app-server', send: vi.fn() }, ...state };
    const reportSessionSendFailure = vi.fn(() => false);
    const context = vm.createContext({ reportSessionSendFailure });
    const start = source.indexOf('function sendToSession(');
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);
    expect(context.sendToSession(session, [{ type: 'text', text: 'ABCD-1234' }])).toBe(false);
    expect(session.codex.send).not.toHaveBeenCalled();
    expect(reportSessionSendFailure).toHaveBeenCalledWith(session, expect.stringContaining('Enter the device code there'));
  });
});
