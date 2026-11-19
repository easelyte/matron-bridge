// The local API must answer a failed call with the real error, and one failed
// call or stray promise must never end the bridge process.
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { respondApiError, guardApiListener, installUnhandledRejectionLogger } from '../lib/api-guard.js';

function fakeRes({ headersSent = false, writableEnded = false } = {}) {
  return {
    headersSent, writableEnded, status: null, body: null, destroyed: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
  };
}

describe('respondApiError', () => {
  it('answers 500 with the error message', () => {
    const res = fakeRes();
    respondApiError(res, new Error('room store is read-only'), { log: () => {} });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'room store is read-only' });
  });

  it('falls back to a generic message for a throw with no message', () => {
    const res = fakeRes();
    respondApiError(res, undefined, { log: () => {} });
    expect(JSON.parse(res.body)).toEqual({ error: 'internal error' });
  });

  it('does not write headers twice when the response has started', () => {
    const res = fakeRes({ headersSent: true });
    res.writeHead = () => { throw new Error('ERR_HTTP_HEADERS_SENT'); };
    expect(() => respondApiError(res, new Error('late'), { log: () => {} })).not.toThrow();
    // A half-written answer is cut off so the caller sees a failure, not a hang.
    expect(res.destroyed).toBe(true);
  });

  it('leaves a finished response alone', () => {
    const res = fakeRes({ headersSent: true, writableEnded: true });
    respondApiError(res, new Error('after the answer'), { log: () => {} });
    expect(res.destroyed).toBe(false);
    expect(res.body).toBe(null);
  });

  it('logs the error', () => {
    const log = vi.fn();
    const error = new Error('boom');
    respondApiError(fakeRes(), error, { log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('guardApiListener', () => {
  it('turns a throw in an async listener into a 500, not a rejection', async () => {
    const res = fakeRes();
    const listener = guardApiListener(res, async () => { throw new Error('upload failed'); }, { log: () => {} });
    await expect(listener()).resolves.toBeUndefined();
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'upload failed' });
  });

  it('stays out of the way when the listener answers', async () => {
    const res = fakeRes();
    await guardApiListener(res, async () => { res.writeHead(200); res.end('{"ok":true}'); }, { log: () => {} })();
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it('answers a real request whose handler throws after reading the body', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', guardApiListener(res, async () => { throw new Error('store unavailable'); }, { log: () => {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/x`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'store unavailable' });
    } finally {
      server.close();
    }
  });
});

describe('installUnhandledRejectionLogger', () => {
  it('logs a rejection nobody handled and keeps the process running', () => {
    const proc = new EventEmitter();
    const log = vi.fn();
    installUnhandledRejectionLogger(proc, { log });
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    proc.emit('unhandledRejection', new Error('journal unreachable'), Promise.resolve());
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('journal unreachable');
  });

  it('logs a rejection that is not an Error, and survives a logger that throws', () => {
    const proc = new EventEmitter();
    const log = vi.fn();
    installUnhandledRejectionLogger(proc, { log });
    proc.emit('unhandledRejection', 'plain reason');
    expect(log.mock.calls[0][0]).toContain('plain reason');
    const proc2 = new EventEmitter();
    installUnhandledRejectionLogger(proc2, { log: () => { throw new Error('log failed'); } });
    expect(() => proc2.emit('unhandledRejection', new Error('x'))).not.toThrow();
  });

  it('does not take over uncaught exceptions', () => {
    const proc = new EventEmitter();
    installUnhandledRejectionLogger(proc, { log: () => {} });
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });
});

// The guards only help where index.js uses them; nothing short of starting
// the whole bridge exercises these lines, so pin the wiring as text.
describe('index.js wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('guards Claude stdin whether or not steering is on', () => {
    expect(src).toMatch(/\n {2}attachStdinErrorHandler\(proc, \{/);
    expect(src).not.toMatch(/CLAUDE_STEER_ENABLED && proc\.stdin/);
  });

  it('logs unhandled rejections and leaves uncaught exceptions fatal', () => {
    expect(src).toMatch(/installUnhandledRejectionLogger\(process/);
    expect(src).not.toMatch(/process\.on\('uncaughtException'/);
  });

  it('guards both body listeners of the local API', () => {
    expect(src.match(/req\.on\('end', guardApiListener\(res, async \(\) => \{/g)).toHaveLength(2);
  });

  it('keeps "Invalid JSON" for a body that does not parse, and nothing else', () => {
    expect(src.match(/error: 'Invalid JSON'/g)).toHaveLength(1);
    expect(src).toMatch(/try \{ data = JSON\.parse\(body\); \}\s*catch \{[\s\S]{0,160}'Invalid JSON'/);
    expect(src).toMatch(/\} catch \(e\) \{\n\s+respondApiError\(res, e\);/);
  });
});
