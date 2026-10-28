import { describe, it, expect } from 'vitest';
import { loopbackRefusal } from '../lib/loopback-guard.js';

describe('loopbackRefusal', () => {
  it('lets the bridge’s own callers through', () => {
    expect(loopbackRefusal({ host: '127.0.0.1:9802' })).toBeNull();
    expect(loopbackRefusal({ host: 'localhost:9802' })).toBeNull();
    expect(loopbackRefusal({ host: '[::1]:9802' })).toBeNull();
    expect(loopbackRefusal({ host: 'LOCALHOST' })).toBeNull();
  });

  it('refuses a rebound hostname', () => {
    expect(loopbackRefusal({ host: 'rebind.example.com:9802' })).toBe('non-loopback host');
    expect(loopbackRefusal({ host: '127.0.0.1.example.com:9802' })).toBe('non-loopback host');
  });

  it('refuses a missing Host header', () => {
    expect(loopbackRefusal({})).toBe('non-loopback host');
  });

  it('refuses anything a browser sent', () => {
    expect(loopbackRefusal({ host: '127.0.0.1:9802', origin: 'https://example.com' })).toBe('browser origin');
    expect(loopbackRefusal({ host: '127.0.0.1:9802', origin: 'null' })).toBe('browser origin');
    expect(loopbackRefusal({ host: '127.0.0.1:9802', 'sec-fetch-site': 'cross-site' })).toBe('browser fetch');
  });
});
