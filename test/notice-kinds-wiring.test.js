import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the idiom of the other *-wiring tests:
// index.js has no unit harness). Routine events get a payload.notice kind
// at their emit sites; warnings stay untagged so the web app keeps them prominent.
describe('extra notice kinds are set where the events already happen', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('sendKindNotice sends through sendToRoom with the notice tag and tells the caller when it could not', () => {
    const start = index.indexOf('function sendKindNotice(');
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, index.indexOf('\n}\n', start));
    expect(body).toMatch(/if \(!meta \|\| !session\?\.roomId\) return false;/);
    expect(body).toMatch(/sendToRoom\(session\.roomId, plain, html, \{ notice: meta \}\)/);
    expect(body).toMatch(/\.catch\(/);
    expect(body).toMatch(/return true;/);
    expect(body).toMatch(/return false;/);
  });

  it('keeps both crash-restart notices untagged (print mode and interactive mode)', () => {
    const sites = index.match(/const n = notice\('warning',\s*\n\s*`\[Session crashed[\s\S]*?restarted\.sendHtml\(n\.plain, n\.html\);/g);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).not.toMatch(/sendKindNotice|noticeMeta/);
    }
    expect(index).not.toContain('crash_restart');
  });

  it('tags the slow-tool notice and falls back to the plain callback', () => {
    expect(index).toMatch(/noticeMeta\('slow_tool', text, \{ summary: slowToolNoticeSummary\(\{ toolName, elapsedMs, reminder \}\) \}\)/);
    expect(index).toMatch(/if \(!sendKindNotice\(session, 'slow_tool', text, markdownToHtml\(text\), meta\)\) session\.sendCallback\(text\);/);
  });

  it('tags the !restart result line', () => {
    expect(index).toMatch(/sendKindNotice\(restarted, 'restart', restartedLine, markdownToHtml\(restartedLine\)\)\) await sendReply\(restartedLine\)/);
  });

  it('keeps delivery failures untagged: dropped queued messages, a failed room flush, stranded room messages, a lost timer', () => {
    // The web app collapses payload.notice rows, so these stay untagged to
    // keep their full-width warning.
    expect(index).toContain("journalPublishNotice(journalConvoIdFor(session), flushLine, flushed ? noticeMeta('queue', flushLine) : null);");
    expect(index).toContain('journalPublishNotice(convoId, formatRoomDeliveryFailedNotice(strandedRoomMessages));');
    expect(index).not.toContain('delivery_failed');
    expect(index).not.toContain('crash_' + 'restart');
  });

  it('adds no turn-start marker: no turn_start key is published', () => {
    expect(index).not.toMatch(/turn_start\s*:/);
  });
});
