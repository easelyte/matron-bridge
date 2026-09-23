import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Loop #787: the router calls resumeSessionForConvo(convoId, {username}), but
// journalResumeConvo's second parameter is the NOTICE TEXT. Binding the seam
// straight to journalResumeConvo published the router ctx as the auto-resume
// notice — `{"body":{"username":"fantin"}}` after every message that woke a
// reaped session (191 journal events, 2026-09-13..23). The seam must drop the
// ctx, and journalResumeConvo must never publish a non-string notice.
describe('journal auto-resume notice wiring', () => {
  const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('does not hand the router ctx to journalResumeConvo as its notice text', () => {
    expect(indexSrc).not.toMatch(/resumeSessionForConvo:\s*journalResumeConvo\s*,/);
    expect(indexSrc).toMatch(/resumeSessionForConvo:\s*\(convoId\)\s*=>\s*journalResumeConvo\(convoId\)\s*,/);
  });

  it('falls back to the default notice when noticeText is not a string', () => {
    const fn = indexSrc.match(/function journalResumeConvo\(convoId, noticeText = JOURNAL_RESUME_NOTICE\) \{[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/if \(typeof noticeText !== 'string'\) noticeText = JOURNAL_RESUME_NOTICE;/);
  });
});
