import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (see start-model-flag-wiring.test.js),
// so the wiring of worktree sessions is pinned by source inspection. The
// behaviour itself is tested in worktree*.test.js.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function block(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

describe('worktree wiring in index.js', () => {
  const start = block("case '!start':", "case '!stop':");

  it('only !start takes --worktree', () => {
    expect(start).toContain('extractWorktreeFlag');
    for (const [from, to] of [["case '!restart':", "case '!resume':"], ["case '!resume':", "case '!workdir':"], ["case '!workdir':", "case '!status':"]]) {
      expect(block(from, to)).not.toContain('extractWorktreeFlag');
    }
    expect(indexSource.match(/extractWorktreeFlag\(/g)).toHaveLength(1);
  });

  it('reads the positional workdir from the filtered tokens and refuses before any session exists', () => {
    expect(start).toContain('const startModelFlag = extractModelFlag(');
    expect(start).toContain('extractWorktreeFlag(startModelFlag.rest)');
    expect(start).toContain('const arg = worktreeFlag.rest[0];');
    expect(start.indexOf('worktreeService.start')).toBeGreaterThan(-1);
    expect(start.indexOf('worktreeService.start')).toBeLessThan(start.indexOf('createSession('));
    expect(start).toContain('Worktree not created:');
  });

  it('only creates a worktree when the flag was given', () => {
    expect(start).toMatch(/if \(worktreeFlag\.present\) \{[\s\S]*worktreeService\.start/);
  });

  it('every spawn adds the worktree notice to the system prompt', () => {
    expect(indexSource.match(/worktreeService\.info\(cwd\)/g)).toHaveLength(3);
    expect(indexSource.match(/matronMd\.block = \[worktreeNoticeBlock\(worktreeInfo\), matronMd\.block\]/g)).toHaveLength(3);
  });

  it('resuming in a removed worktree is refused at every resume entry point', () => {
    // createSession itself never throws for a removed worktree: callers check first.
    expect(block('function createSession(', 'const guarded')).not.toContain('WorktreeRemovedError');
    expect(block("case '!resume':", "case '!workdir':")).toContain('worktreeRemovedForResume(actualWorkdir');
    // checked even when the conversation has no native session ID yet, and said through the journal too
    const idle = block('function resumePersistedSession(', 'newSession.originRoomId');
    expect(idle).toContain('worktreeRemovedForResume(');
    expect(idle).not.toMatch(/resumeSessionId \? worktreeRemovedForResume/);
    expect(idle).toContain('journalPublishNotice(');
    expect(block('function recreateSession(', 'killSession(existing')).toContain('worktreeRemovedFor(existing.workdir)');
    expect(block('function noteWorktreeGone(', '\n}')).toContain('worktreeRemovedFor(session.workdir)');
    // Both exit handlers (print and interactive) stop a respawn into a removed worktree.
    expect(indexSource.match(/sweepToolStreams\(session\);\n {4}noteWorktreeGone\(session\);/g)).toHaveLength(2);
  });

  it('the background step runs after the session started, not before', () => {
    expect(start.indexOf('startedWorktree.background()')).toBeGreaterThan(start.indexOf('session started'));
  });
});
