import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSubagentToolBody, subagentToolStep } from '../lib/subagent-tool-format.js';

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

// payload.step (2026-09-26): the structured twin of the text body, read by
// matron-web's plain-English activity (src/journal/activity-text.ts payloadStep:
// a flat { tool, command?, path?, pattern?, url?, description? }).
describe('subagentToolStep', () => {
  it('describes each call with the fields the body shows', () => {
    expect(subagentToolStep('Bash', { command: 'pnpm test' })).toEqual({ tool: 'Bash', command: 'pnpm test' });
    expect(subagentToolStep('Read', { file_path: '/tmp/a.txt' })).toEqual({ tool: 'Read', path: '/tmp/a.txt' });
    expect(subagentToolStep('Grep', { pattern: 'TODO' })).toEqual({ tool: 'Grep', pattern: 'TODO' });
    expect(subagentToolStep('Glob', { pattern: '**/*.swift' })).toEqual({ tool: 'Glob', pattern: '**/*.swift' });
    expect(subagentToolStep('WebSearch', { query: 'swift textkit' })).toEqual({ tool: 'WebSearch', pattern: 'swift textkit' });
    expect(subagentToolStep('WebFetch', { url: 'https://x.test/a' })).toEqual({ tool: 'WebFetch', url: 'https://x.test/a' });
    expect(subagentToolStep('Task', { description: 'scan logs' })).toEqual({ tool: 'Task', description: 'scan logs' });
    expect(subagentToolStep('TodoWrite', { todos: [] })).toEqual({ tool: 'TodoWrite' });
    expect(subagentToolStep('mcp__ask-user__item_create', {})).toEqual({ tool: 'mcp__ask-user__item_create' });
  });

  it('never carries more of a command than the body does', () => {
    const step = subagentToolStep('Bash', { command: 'x'.repeat(150) });
    expect(step.command).toBe(`${'x'.repeat(100)}…`);
    expect(formatSubagentToolBody('Bash', { command: 'x'.repeat(150) })).toContain(step.command);
  });

  it('is null exactly when no text line is published (diff-card tools, no tool name)', () => {
    expect(subagentToolStep('Edit', { file_path: '/a' })).toBeNull();
    expect(subagentToolStep('Write', { file_path: '/a' })).toBeNull();
    expect(subagentToolStep('MultiEdit', { file_path: '/a' })).toBeNull();
    expect(subagentToolStep('', {})).toBeNull();
    expect(subagentToolStep(undefined, {})).toBeNull();
  });

  it('is published with the body on the subagent text event', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
    expect(source).toMatch(/const step = subagentToolStep\(block\.name, block\.input \|\| \{\}\);\s*journalPublisher\.publishText\(convoId, \{ body, from: 'assistant', \.\.\.\(step \? \{ step \} : \{\}\) \}\);/);
  });
});
