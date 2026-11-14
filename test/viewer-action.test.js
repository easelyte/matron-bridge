import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

let app, generateSignedUrl;

// Exercise the real Express middleware without binding a network socket.
function request(url) {
  return new Promise(resolve => {
    const req = new IncomingMessage(new PassThrough());
    req.method = 'GET';
    req.url = url;
    req.push(null);
    const res = new ServerResponse(req);
    res.end = () => resolve(res);
    app(req, res);
  });
}

beforeAll(async () => {
  vi.stubEnv('HMAC_SECRET', 'test-secret');
  ({ app, generateSignedUrl } = await import('../viewer/server.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected bridge API call'));
});

afterEach(() => vi.restoreAllMocks());

describe('removed viewer action route', () => {
  it.each(['', '?token=invalid'])('returns 404 without forwarding for /action%s', async (query) => {
    const res = await request(`/action${query}`);
    expect(res.statusCode).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['interrupt', 'cancel'])('does not forward a valid signed %s link', async (action) => {
    const url = generateSignedUrl('', null, undefined, 60, {
      action, roomId: 'test-room', index: 0,
    }).replace('/view?', '/action?');
    const res = await request(url);
    expect(res.statusCode).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
