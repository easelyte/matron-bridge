import { describe, it, expect } from 'vitest';
import { formatSubagentToolBody } from '../lib/subagent-tool-format.js';

// Regression under test (Dan, 2026-07-16): sub-chat panels showed only the
// subagent's text messages. The old inline formatter in index.js returned
// null for every tool outside a tiny whitelist (WebSearch/WebFetch/Task/
// TodoWrite) — and subagents overwhelmingly run Bash/Read/Grep, so their
// panels looked empty of work. The child convo is the subagent's own
// dedicated surface: every tool call formats to SOMETHING (a generic
// `🔧 Name` at worst); only the diff-card tools return null, because the
// caller publishes a structured diff for those instead.
describe('formatSubagentToolBody', () => {
  it('formats Bash commands in backticks', () => {
    expect(formatSubagentToolBody('Bash', { command: 'ls -la' }))
      .toBe('🔧 `ls -la`');
  });

  it('truncates long Bash commands at 100 chars, matching the parent indicator', () => {
    const long = 'x'.repeat(150);
    const body = formatSubagentToolBody('Bash', { command: long });
    expect(body).toBe(`🔧 \`${'x'.repeat(100)}…\``);
  });

  it('formats Read with the file path', () => {
    expect(formatSubagentToolBody('Read', { file_path: '/tmp/a.txt' }))
      .toBe('📖 /tmp/a.txt');
  });

  it('formats Glob and Grep with the pattern', () => {
    expect(formatSubagentToolBody('Glob', { pattern: '**/*.swift' }))
      .toBe('🔍 **/*.swift');
    expect(formatSubagentToolBody('Grep', { pattern: 'TODO' }))
      .toBe('🔍 TODO');
  });

  it('formats WebSearch and WebFetch', () => {
    expect(formatSubagentToolBody('WebSearch', { query: 'swift textkit' }))
      .toBe('🌐 swift textkit');
    expect(formatSubagentToolBody('WebFetch', { url: 'https://x.test/a' }))
      .toBe('🌐 https://x.test/a');
  });

  it('formats a nested Task/Agent spawn from description or prompt', () => {
    expect(formatSubagentToolBody('Task', { description: 'scan logs' }))
      .toBe('🔀 Nested subtask: scan logs');
    expect(formatSubagentToolBody('Agent', { prompt: 'p'.repeat(120) }))
      .toBe(`🔀 Nested subtask: ${'p'.repeat(80)}`);
  });

  it('formats TodoWrite with status icons', () => {
    const body = formatSubagentToolBody('TodoWrite', {
      todos: [
        { status: 'completed', content: 'done thing' },
        { status: 'in_progress', content: 'doing thing' },
        { status: 'pending', content: 'next thing' },
      ],
    });
    expect(body).toBe('📋 Todos:\n✅ done thing\n🔄 doing thing\n⬚ next thing');
  });

  it('returns null for the diff-card tools — the caller publishes a structured diff', () => {
    expect(formatSubagentToolBody('Edit', { file_path: '/a' })).toBeNull();
    expect(formatSubagentToolBody('Write', { file_path: '/a' })).toBeNull();
    expect(formatSubagentToolBody('MultiEdit', { file_path: '/a' })).toBeNull();
  });

  it('falls back to a generic indicator for any other tool instead of dropping it', () => {
    expect(formatSubagentToolBody('LSP', { op: 'hover' })).toBe('🔧 LSP');
    expect(formatSubagentToolBody('NotebookEdit', {})).toBe('🔧 NotebookEdit');
  });

  it('formats Bash without a command via the generic fallback', () => {
    expect(formatSubagentToolBody('Bash', {})).toBe('🔧 Bash');
  });

  it('returns null for a missing tool name and tolerates missing input', () => {
    expect(formatSubagentToolBody(undefined)).toBeNull();
    expect(formatSubagentToolBody('')).toBeNull();
    expect(formatSubagentToolBody('Read')).toBe('🔧 Read');
  });
});
