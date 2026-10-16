import { describe, it, expect } from 'vitest';
import {
  noticeMeta, consentNoticeMeta, unseenNoticeMeta, roomNoticeMeta, controlNoticeKind, splitLeadingIcon, NOTICE_SUMMARY_MAX,
} from '../lib/system-notice.js';
import { formatConsentNudge } from '../lib/consent-tools.js';

describe('splitLeadingIcon', () => {
  it('lifts a leading emoji off the first line', () => {
    expect(splitLeadingIcon('🔔 Routine sweep: morning check')).toEqual({ icon: '🔔', rest: 'Routine sweep: morning check' });
    expect(splitLeadingIcon('🗜️ Compacting this session now')).toEqual({ icon: '🗜️', rest: 'Compacting this session now' });
  });
  it('leaves plain text alone and reads only the first non-empty line', () => {
    expect(splitLeadingIcon('\nplain words\nmore')).toEqual({ icon: null, rest: 'plain words' });
  });
});

describe('noticeMeta', () => {
  it('tags a one-line notice with its own icon', () => {
    expect(noticeMeta('routine', '🔔 Routine sweep: morning check once this turn finishes'))
      .toEqual({ kind: 'routine', icon: '🔔', summary: 'Routine sweep: morning check once this turn finishes' });
  });
  it('falls back to the kind icon and caps the summary to one line', () => {
    const m = noticeMeta('spawn', `Spawn started ${'x'.repeat(300)}\nsecond line`);
    expect(m.icon).toBe('🚀');
    expect(m.summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX);
    expect(m.summary).not.toContain('\n');
  });
  it('returns null for an empty notice', () => {
    expect(noticeMeta('control', '   ')).toBeNull();
  });
});

describe('consentNoticeMeta', () => {
  const chat = {
    ask: {
      kind: 'chat', id: 'ch_1', from_name: 'box-a', to_name: 'box-b', topic: 'artwork render',
      justification: 'needs the render', item_num: 42, target_state: 'awake', created_at: 0,
    },
  };
  it('summarises a chat ask without the agent-only lines', () => {
    const m = consentNoticeMeta(chat);
    expect(m).toEqual({ kind: 'consent', icon: '🤝', summary: 'box-a → box-b chat · artwork render · #42' });
    // The full nudge still carries them, for the expanded row and the agent.
    expect(formatConsentNudge(chat)).toContain('consent_decide(');
    expect(m.summary).not.toContain('consent_decide');
  });
  it('summarises spawn and join asks', () => {
    expect(consentNoticeMeta({ ask: { kind: 'spawn', from_name: 'box-a', target_name: 'box-c', task: 'Fix the build' } }).summary)
      .toBe('box-a → spawn on box-c · Fix the build');
    expect(consentNoticeMeta({ ask: { kind: 'chat', request: 'join', from_name: 'box-a', room_title: 'release' } }).summary)
      .toBe('box-a → join release');
  });
  it('flattens peer text to one line', () => {
    const m = consentNoticeMeta({ ask: { kind: 'chat', from_name: 'evil\nline', to_name: 'b', topic: 't\r\nopic' } });
    expect(m.summary).not.toMatch(/[\r\n]/);
  });
  it('is null without an ask', () => {
    expect(consentNoticeMeta({})).toBeNull();
  });
});

describe('unseenNoticeMeta / roomNoticeMeta / controlNoticeKind', () => {
  it('counts unseen entries', () => {
    expect(unseenNoticeMeta({ entries: [{}], count: 3 }).summary).toBe('3 important things unseen for over 2 hours');
    expect(unseenNoticeMeta({ entries: [{}] }).summary).toBe('1 important thing unseen for over 2 hours');
    expect(unseenNoticeMeta({ entries: [] })).toBeNull();
  });
  it('names the room sender and the first line', () => {
    expect(roomNoticeMeta({ from: 'box-b', body: '\nDisk clean-up done\nDetails…' }))
      .toEqual({ kind: 'room', icon: '💬', summary: 'box-b: Disk clean-up done' });
  });
  it('maps control actions to kinds', () => {
    expect(controlNoticeKind('routine')).toBe('routine');
    expect(controlNoticeKind('alert')).toBe('alert');
    expect(controlNoticeKind('compact')).toBe('control');
  });
});
