import { describe, it, expect } from 'vitest';
import { memoryLine, formatMemoryList, formatMemoryDetail, formatSaveAck, formatDeleteAck } from '../lib/memory-format.js';

const m = { id: 'me_1', name: 'avoid-eric', type: 'feedback', description: 'Never use eric.', body: '**Why:** reserved.', created_by: 'agent', updated_by: 'user', created_at: 1000, updated_at: 2000, origin_convo_id: 'c1' };

describe('memory renderers', () => {
  it('memoryLine: name, type, description, updated time and who', () => {
    expect(memoryLine(m)).toBe('`avoid-eric` (feedback): Never use eric. — updated 1970-01-01T00:00:02.000Z by user');
  });
  it('formatMemoryList: one line per memory, or a placeholder', () => {
    expect(formatMemoryList({ memories: [m, { ...m, name: 'b' }] }).split('\n')).toHaveLength(2);
    expect(formatMemoryList({ memories: [] })).toBe('(no memories yet)');
    expect(formatMemoryList(null)).toBe('(no memories yet)');
  });
  it('formatMemoryDetail: the fields then the body', () => {
    const out = formatMemoryDetail({ memory: m });
    expect(out).toContain('name: avoid-eric');
    expect(out).toContain('type: feedback');
    expect(out).toContain('origin conversation: c1');
    expect(out.endsWith('\n\n**Why:** reserved.')).toBe(true);
    expect(formatMemoryDetail({ memory: { ...m, body: '', origin_convo_id: null } })).toContain('(no body)');
  });
  it('formatSaveAck says created or updated; formatDeleteAck names the memory', () => {
    expect(formatSaveAck({ memory: m, created: true })).toBe('Saved memory `avoid-eric` (created): Never use eric.');
    expect(formatSaveAck({ memory: m, created: false })).toBe('Saved memory `avoid-eric` (updated): Never use eric.');
    expect(formatDeleteAck({ memory: m })).toBe('Deleted memory `avoid-eric`');
  });
  it('unknown shapes degrade, never throw', () => {
    expect(memoryLine(null)).toBe('(unknown memory)');
    expect(formatMemoryDetail({})).toBe('(unknown memory)');
    expect(formatSaveAck({})).toBe('Saved memory');
    expect(formatDeleteAck(undefined)).toBe('Deleted memory `(unnamed)`');
  });
});
