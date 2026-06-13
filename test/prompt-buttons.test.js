import { describe, it, expect } from 'vitest';
import { promptButtons, promptResponseForButton } from '../lib/prompt-buttons.js';

const numbered = {
  kind: 'numbered',
  question: 'Pick one:',
  options: [{ key: '1', label: 'Alpha' }, { key: '2', label: 'Beta' }],
  freeTextIdx: null,
};
const yesno = {
  kind: 'yes-no',
  question: 'Proceed?',
  options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }],
  freeTextIdx: null,
};
const arrow = {
  kind: 'arrow-menu',
  question: 'Choose:',
  options: [{ label: 'One', selected: true }, { label: 'Two', selected: false }],
  freeTextIdx: null,
};

describe('promptButtons', () => {
  it('builds namespaced buttons for a numbered menu', () => {
    expect(promptButtons(numbered)).toEqual({
      mode: 'pick_one',
      buttons: [
        { id: 'prompt-opt-0', label: 'Alpha', value: 'prompt-opt:0' },
        { id: 'prompt-opt-1', label: 'Beta', value: 'prompt-opt:1' },
      ],
    });
  });

  it('builds buttons for yes-no and arrow menus', () => {
    expect(promptButtons(yesno).buttons.map(b => b.label)).toEqual(['Yes', 'No']);
    expect(promptButtons(arrow).buttons.map(b => b.value)).toEqual(['prompt-opt:0', 'prompt-opt:1']);
  });

  it('returns null (→ text fallback) for a free-text slot', () => {
    expect(promptButtons({ ...numbered, freeTextIdx: 1 })).toBeNull();
    expect(promptButtons({ ...numbered, freeTextIdx: 0 })).toBeNull();
  });

  it('returns null for multiSelect, no options, or empty labels', () => {
    expect(promptButtons({ ...numbered, multiSelect: true })).toBeNull();
    expect(promptButtons({ kind: 'numbered', options: [], freeTextIdx: null })).toBeNull();
    expect(promptButtons(null)).toBeNull();
    expect(promptButtons({ ...numbered, options: [{ key: '1', label: '  ' }] })).toBeNull();
  });
});

describe('promptResponseForButton', () => {
  it('maps numbered/lettered to the option key', () => {
    expect(promptResponseForButton(numbered, 1)).toEqual({ kind: 'numbered', key: '2' });
  });
  it('maps yes-no to the option key (y/n)', () => {
    expect(promptResponseForButton(yesno, 0)).toEqual({ kind: 'yes-no', key: 'y' });
    expect(promptResponseForButton(yesno, 1)).toEqual({ kind: 'yes-no', key: 'n' });
  });
  it('maps arrow-menu to the index', () => {
    expect(promptResponseForButton(arrow, 1)).toEqual({ kind: 'arrow-menu', key: '1' });
  });
  it('returns null for out-of-range or bad input', () => {
    expect(promptResponseForButton(numbered, 5)).toBeNull();
    expect(promptResponseForButton(numbered, -1)).toBeNull();
    expect(promptResponseForButton(null, 0)).toBeNull();
    expect(promptResponseForButton({ kind: 'numbered', options: [{ label: 'Foo' }], freeTextIdx: null }, 0)).toBeNull();
  });
});
