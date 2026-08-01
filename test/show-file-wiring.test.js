import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');

describe('show-file bridge wiring', () => {
  it('pins roots and mints tokens only at the share-enabled pre-spawn seam', () => {
    expect(src.match(/const shareEnabled = effectiveMcpExtras\.includes\('share'\);/g)).toHaveLength(2);
    expect(src.match(/let showFileToken;/g)).toHaveLength(2);
    expect(src.match(/let showFilePinnedRoots = null;/g)).toHaveLength(2);
    expect(src.match(/pinAllowedRootsSync\(\[cwd, \.\.\.SHOW_FILE_ARTIFACT_ROOTS\]\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/showFilePinnedRoots \?\?=/);
  });

  it('fails closed without aborting session creation when root pinning fails', () => {
    expect(src.match(/try \{\s*showFilePinnedRoots = pinAllowedRootsSync/g)).toHaveLength(2);
    expect(src.match(/catch \(error\) \{\s*console\.warn\(`\[show-file\] disabled/g)).toHaveLength(2);
    expect(src.match(/if \(showFileToken\) (?:spawnEnv|interactiveEnv)\.SHOW_FILE_TOKEN = showFileToken;/g))
      .toHaveLength(2);
    expect(src.match(/\.\.\.\(showFileToken \? \{ showFileToken \} : \{\}\),\s*showFilePinnedRoots,/g))
      .toHaveLength(2);
  });

  it('strips inherited tokens and injects them only for share-enabled children', () => {
    expect(src.match(/delete (?:spawnEnv|interactiveEnv)\.SHOW_FILE_TOKEN;/g)).toHaveLength(2);
    expect(src.match(/if \(showFileToken\) (?:spawnEnv|interactiveEnv)\.SHOW_FILE_TOKEN = showFileToken;/g))
      .toHaveLength(2);
  });

  it('validates the complete request shape before resolving a session', () => {
    const handler = src.slice(src.indexOf("if (url.pathname === '/show-file')"));
    expect(handler.indexOf('validateShowFileBody(data)')).toBeLessThan(handler.indexOf('sessions.values()'));
    expect(src).toContain("typeof data.path !== 'string' || data.path.trim() === ''");
    expect(src).toContain("typeof data.token !== 'string' || data.token.trim() === ''");
    expect(src).toContain('data.caption.length > 4096');
  });

  it('enforces per-session and global concurrency and byte reservations and audits all failure classes', () => {
    expect(src).toContain('const SHOW_FILE_MAX_IN_FLIGHT_PER_SESSION = 1');
    expect(src).toContain('(session._showFileInFlight || 0) >= SHOW_FILE_MAX_IN_FLIGHT_PER_SESSION');
    expect(src).toContain('session._showFileInFlight = (session._showFileInFlight || 0) + 1');
    expect(src).toContain('session._showFileInFlight -= 1');
    expect(src).toContain('showFileInFlight >= SHOW_FILE_MAX_IN_FLIGHT');
    expect(src).toContain('showFileReservedBytes + SHOW_FILE_MAX_BYTES > SHOW_FILE_GLOBAL_BYTE_BUDGET');
    expect(src).toContain("res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })");
    expect(src).toContain("res.end(JSON.stringify({ error: 'saturated' }))");
    for (const result of [
      'method-not-allowed', 'request-too-large', 'invalid-json', 'invalid-token', 'saturated',
      'internal-error',
    ]) {
      expect(src).toContain(`result: '${result}'`);
    }
    expect(src).toContain("reason: 'missing-token'");
    expect(src).not.toMatch(/auditShowFile\(\{[^}]*\btoken\s*[,}]/s);
  });
});
