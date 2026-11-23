import { describe, it, expect } from 'vitest';
import { memoryLine, formatMemoryList, formatMemoryDetail, formatSaveAck, formatDeleteAck, formatProposalOutcome, formatRecall, formatRecallContext } from '../lib/memory-format.js';

const m = { id: 'me_1', name: 'avoid-box-a', type: 'feedback', description: 'Never use box-a.', body: '**Why:** reserved.', created_by: 'agent', updated_by: 'user', created_at: 1000, updated_at: 2000, origin_convo_id: 'c1' };

describe('memory renderers', () => {
  it('memoryLine: name, type, description, updated time and who', () => {
    expect(memoryLine(m)).toBe('`avoid-box-a` (feedback, global, always): Never use box-a. — updated 1970-01-01T00:00:02.000Z by user');
    expect(memoryLine({ ...m, scope: 'repo:acme-app' })).toContain('(feedback, repo:acme-app, always)');
  });
  it('formatMemoryList: one line per memory, or a placeholder', () => {
    expect(formatMemoryList({ memories: [m, { ...m, name: 'b' }] }).split('\n')).toHaveLength(2);
    expect(formatMemoryList({ memories: [] })).toBe('(no memories yet)');
    expect(formatMemoryList(null)).toBe('(no memories yet)');
  });
  it('formatMemoryList: a filtered answer ends with how many were left out and how to see them', () => {
    const out = formatMemoryList({ memories: [m], scopes: ['global', 'repo:x'], omitted: 3, omitted_scopes: ['coordinator', 'repo:y'] });
    expect(out.split('\n')).toHaveLength(2);
    expect(out.endsWith('… 3 more in other scopes (coordinator, repo:y) — memory_list with all: true lists them.')).toBe(true);
    expect(formatMemoryList({ memories: [], scopes: ['global'], omitted: 2, omitted_scopes: ['coordinator'] }))
      .toBe("(none in this session's scopes: global)\n… 2 more in other scopes (coordinator) — memory_list with all: true lists them.");
    expect(formatMemoryList({ memories: [m], scopes: null, omitted: 0, omitted_scopes: [] }).split('\n')).toHaveLength(1);
  });
  it('formatMemoryDetail: the fields then the body', () => {
    const out = formatMemoryDetail({ memory: m });
    expect(out).toContain('name: avoid-box-a');
    expect(out).toContain('type: feedback');
    expect(out).toContain('scope: global');
    expect(formatMemoryDetail({ memory: { ...m, scope: 'coordinator' } })).toContain('scope: coordinator');
    expect(out).toContain('origin conversation: c1');
    expect(out.endsWith('\n\n**Why:** reserved.')).toBe(true);
    expect(formatMemoryDetail({ memory: { ...m, body: '', origin_convo_id: null } })).toContain('(no body)');
  });
  it('formatSaveAck says created or updated; formatDeleteAck names the memory', () => {
    expect(formatSaveAck({ memory: m, created: true })).toBe('Saved memory `avoid-box-a` (created, scope global, always): Never use box-a.');
    expect(formatSaveAck({ memory: { ...m, scope: 'repo:acme-app' }, created: false })).toBe('Saved memory `avoid-box-a` (updated, scope repo:acme-app, always): Never use box-a.');
    expect(formatDeleteAck({ memory: m })).toBe('Deleted memory `avoid-box-a`');
  });
  it('a pending save or delete says plainly that nothing changed, names the item, and says not to retry', () => {
    const saved = formatSaveAck({ pending: true, action: 'save', name: 'avoid-elm', item_num: 41, item_id: 'it_9' });
    expect(saved).toMatch(/^NOT saved yet: memory `avoid-elm` is a proposal waiting for the user's approval on item #41\./);
    expect(saved).toContain('outside a turn the user started themselves');
    expect(saved).toContain('reach you as a later turn');
    expect(saved).toContain('Do not retry');
    expect(saved).toContain('If they reply on it instead of tapping, read the thread with item_get("#41") and answer there with item_comment');
    expect(formatSaveAck({ pending: true, action: 'save', name: 'avoid-elm', item_num: null, item_id: 'it_abc' })).toContain('item_get("it_abc")');
    const noRef = formatSaveAck({ pending: true, action: 'save', name: 'avoid-elm', item_num: null, item_id: null });
    expect(noRef).not.toContain('item_get');
    expect(noRef).toContain('save again under the same name');
    expect(saved).not.toMatch(/^Saved memory/);
    const deleted = formatDeleteAck({ pending: true, action: 'delete', name: 'avoid-elm', item_num: null });
    expect(deleted).toMatch(/^NOT deleted yet: memory `avoid-elm` is a proposal waiting for the user's approval on a tracker item\./);
    expect(deleted).toContain('the memory still applies');
  });
  it('formatProposalOutcome words each outcome; anything that is not one is null', () => {
    const p = { proposal_id: 'mp_1', name: 'avoid-elm', action: 'save', outcome: 'approved', item: { id: 'it_9', num: 41 } };
    expect(formatProposalOutcome(p)).toBe('[Matron: memory proposal (item #41)] The user approved it: memory `avoid-elm` is now saved.');
    expect(formatProposalOutcome({ ...p, action: 'delete' })).toContain('is now deleted');
    expect(formatProposalOutcome({ ...p, outcome: 'declined' })).toContain('The user declined it: memory `avoid-elm` was not saved');
    expect(formatProposalOutcome({ ...p, outcome: 'replaced', item: null })).toBe('[Matron: memory proposal] A newer proposal for memory `avoid-elm` took its place; this one was set aside and nothing changed.');
    expect(formatProposalOutcome({ ...p, outcome: 'expired' })).toContain('Nobody answered within 7 days');
    expect(formatProposalOutcome({ ...p, outcome: 'stale' })).toMatch(/had changed since you proposed, so nothing was saved\..*propose it once more/);
    expect(formatProposalOutcome({ ...p, outcome: 'stale', action: 'delete' })).toContain('nothing was deleted');
    for (const bad of [null, 'x', {}, { ...p, outcome: 'saved' }, { ...p, outcome: undefined }, { ...p, action: undefined }, { ...p, action: 'update' }, { ...p, action: 'Save' }, { ...p, action: null }, { ...p, name: 'Not A Slug' }, { ...p, name: 'a`b' }, { ...p, name: 'a\nb' }]) {
      expect(formatProposalOutcome(bad)).toBe(null);
    }
  });
  it('unknown shapes degrade, never throw', () => {
    expect(memoryLine(null)).toBe('(unknown memory)');
    expect(formatMemoryDetail({})).toBe('(unknown memory)');
    expect(formatSaveAck({})).toBe('Saved memory');
    expect(formatDeleteAck(undefined)).toBe('Deleted memory `(unnamed)`');
  });
  it('tier and topic show in the line, the detail and the save ack', () => {
    const od = { ...m, tier: 'on_demand', topic: 'couriers' };
    expect(memoryLine(od)).toContain('(feedback, global, on demand, topic: couriers)');
    expect(formatMemoryDetail({ memory: od })).toContain('\ntier: on demand, topic: couriers\n');
    expect(formatMemoryDetail({ memory: m })).toContain('\ntier: always\n');
    expect(formatSaveAck({ memory: od, created: true })).toContain('on demand, topic: couriers');
  });
  it('formatRecall: each memory whole, a long body cut with a pointer; nothing matched says so', () => {
    const out = formatRecall({ memories: [{ ...m, tier: 'on_demand', topic: 'couriers' }, { ...m, name: 'long', body: 'y'.repeat(5000) }] });
    expect(out).toContain('### `avoid-box-a` (global, on demand, topic: couriers)\nNever use box-a.\n\n**Why:** reserved.');
    expect(out).toContain('… (cut; memory_get long for the rest)');
    expect(formatRecall({ memories: [] })).toMatch(/^No memory matched/);
  });
  it('formatRecallContext: a labelled block for the turn, or nothing at all', () => {
    expect(formatRecallContext({ memories: [] })).toBe('');
    expect(formatRecallContext(null)).toBe('');
    const out = formatRecallContext({ memories: [{ ...m, tier: 'on_demand', body: 'z'.repeat(2000) }] });
    expect(out.startsWith('[Matron: memories that may bear on this message]\n')).toBe(true);
    expect(out).toContain('### `avoid-box-a`');
    expect(out).toContain('(cut; memory_get avoid-box-a for the rest)');
  });
});
