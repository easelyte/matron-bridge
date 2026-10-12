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
    const context = vm.createContext({ codex, session, clearInterval, shuttingDown: false, CODEX_APP_SERVER: true, isCodexAuthError,
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

  it.each([true, false])('suppresses recovery and queued dispatch during shutdown (auth error=%s)', authError => {
    for (const shuttingDown of [true, false]) {
      const codex = Object.assign(new EventEmitter(), { transport: 'app-server' });
      const queuedMessages = [[{ type: 'text', text: 'follow-up' }]];
      const session = { codex, alive: true, busy: true, queuedMessages, _codexTurnFinished: false,
        _codexLastError: authError ? '401 Unauthorized' : 'turn failed', turnCount: 0, toolCalls: [] };
      const runCodexControl = vi.fn();
      const flushPendingSessionQueue = vi.fn(s => { s.queuedMessages = null; return true; });
      const context = vm.createContext({ codex, session, clearInterval, shuttingDown, CODEX_APP_SERVER: true,
        isCodexAuthError, runCodexControl, flushPendingSessionQueue,
        refreshCodexTelemetry: vi.fn(), refreshCodexMetadata: vi.fn(), offerCodexBuild: vi.fn(),
        flushResponse: vi.fn(), journalStreamClear: vi.fn(), journalSessionState: vi.fn(),
        journalActivity: vi.fn(), maybeSummarizeAtTurnEnd: vi.fn(), journalStatus: vi.fn(),
        inflightMarker: { noteTurnEnd: vi.fn() }, journalConvoIdFor: vi.fn(),
        dispatchDeferredCommand: vi.fn(() => false), maybeFlushRoomDelivery: vi.fn(), endRestartNoticeTurn: vi.fn(), sessionHasBackgroundWork: vi.fn(() => false),
      });
      const finishStart = source.indexOf('function finishCodexTurn(');
      vm.runInContext(source.slice(finishStart, source.indexOf('\n}\n', finishStart) + 2), context);
      const exitStart = source.indexOf("  codex.on('turn-exit',");
      vm.runInContext(source.slice(exitStart, source.indexOf('\n  });', exitStart) + 6), context);
      codex.emit('turn-exit', { code: 1, sawTurnCompleted: false });
      expect(session.busy).toBe(false);
      expect(session._codexTurnFinished).toBe(true);
      if (shuttingDown) {
        expect(runCodexControl).not.toHaveBeenCalled();
        expect(flushPendingSessionQueue).not.toHaveBeenCalled();
        expect(session.queuedMessages).toBe(queuedMessages);
        expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'follow-up' }]]);
      } else if (authError) {
        expect(runCodexControl).toHaveBeenCalledExactlyOnceWith(session, '/login');
        expect(flushPendingSessionQueue).not.toHaveBeenCalled();
        expect(session.queuedMessages).toBe(queuedMessages);
      } else {
        expect(runCodexControl).not.toHaveBeenCalled();
        expect(flushPendingSessionQueue).toHaveBeenCalledExactlyOnceWith(session);
        expect(session.queuedMessages).toBeNull();
      }
    }
  });

  it.each([{ _codexLoginId: 'login' }, { _codexAccountCommandPending: true }])('keeps input out of the model while signing in: %j', state => {
    const session = { alive: true, codex: { transport: 'app-server', send: vi.fn() }, ...state };
    const reportSessionSendFailure = vi.fn(() => false);
    const context = vm.createContext({ restartLatch: undefined, reportSessionSendFailure });
    const start = source.indexOf('function sendToSession(');
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);
    let dispatched;
    expect(() => { dispatched = context.sendToSession(session, [{ type: 'text', text: 'ABCD-1234' }]); }).not.toThrow();
    expect(dispatched).toBe(false);
    expect(session.codex.send).not.toHaveBeenCalled();
    expect(reportSessionSendFailure).toHaveBeenCalledWith(session, expect.stringContaining('Enter the device code there'));
  });
});
