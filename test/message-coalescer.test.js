import { describe, it, expect } from 'vitest';
import { mergeContentBlockGroups } from '../lib/message-coalescer.js';

describe('mergeContentBlockGroups', () => {
  it('passes a single text group through', () => {
    expect(mergeContentBlockGroups([[{ type: 'text', text: 'hi' }]]))
      .toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('joins consecutive text groups with double newline', () => {
    expect(mergeContentBlockGroups([
      [{ type: 'text', text: 'a' }],
      [{ type: 'text', text: 'b' }],
    ])).toEqual([{ type: 'text', text: 'a\n\nb' }]);
  });

  it('splices media groups in arrival order, flushing text runs around them', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
    expect(mergeContentBlockGroups([
      [{ type: 'text', text: 'before' }],
      [{ type: 'text', text: 'saved' }, img],
      [{ type: 'text', text: 'after' }],
    ])).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'saved' }, img,
      { type: 'text', text: 'after' },
    ]);
  });

  it('skips empty groups', () => {
    expect(mergeContentBlockGroups([[], [{ type: 'text', text: 'x' }], []]))
      .toEqual([{ type: 'text', text: 'x' }]);
  });
});
