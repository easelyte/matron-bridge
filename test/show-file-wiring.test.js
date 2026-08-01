import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');

describe('show-file bridge wiring', () => {
  it('pins roots and mints tokens only at the share-enabled pre-spawn seam', () => {
    expect(src.match(/const shareEnabled = mcpExtras\.includes\('share'\);/g)).toHaveLength(2);
    expect(src.match(/showFileToken = shareEnabled \? randomUUID\(\) : undefined/g)).toHaveLength(2);
    expect(src.match(/pinAllowedRootsSync\(\[cwd, \.\.\.SHOW_FILE_ARTIFACT_ROOTS\]\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/showFilePinnedRoots \?\?=/);
  });

  it('strips inherited tokens and injects them only for share-enabled children', () => {
    expect(src.match(/delete (?:spawnEnv|interactiveEnv)\.SHOW_FILE_TOKEN;/g)).toHaveLength(2);
    expect(src.match(/if \(shareEnabled\) (?:spawnEnv|interactiveEnv)\.SHOW_FILE_TOKEN = showFileToken;/g))
      .toHaveLength(2);
    expect(src.match(/\.\.\.\(shareEnabled \? \{ showFileToken, showFilePinnedRoots \} : \{\}\)/g))
      .toHaveLength(2);
  });

  it('validates the complete request shape before resolving a session', () => {
    const handler = src.slice(src.indexOf("if (url.pathname === '/show-file')"));
    expect(handler.indexOf('validateShowFileBody(data)')).toBeLessThan(handler.indexOf('sessions.values()'));
    expect(src).toContain("typeof data.path !== 'string' || data.path.trim() === ''");
    expect(src).toContain("typeof data.token !== 'string' || data.token.trim() === ''");
    expect(src).toContain('data.caption.length > 4096');
  });

  it('enforces global concurrency and byte reservations and audits all failure classes', () => {
    expect(src).toContain('showFileInFlight >= SHOW_FILE_MAX_IN_FLIGHT');
    expect(src).toContain('showFileReservedBytes + SHOW_FILE_MAX_BYTES > SHOW_FILE_GLOBAL_BYTE_BUDGET');
    expect(src).toContain("res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })");
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
