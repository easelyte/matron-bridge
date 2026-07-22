import { describe, it, expect, vi } from 'vitest';
import { isPickerValue, handlePickerValue } from '../lib/picker-dispatch.js';

describe('isPickerValue', () => {
  it('recognizes the three namespaced picker values', () => {
    expect(isPickerValue('model:sonnet')).toBe(true);
    expect(isPickerValue('effort:high')).toBe(true);
    expect(isPickerValue('mode:interactive')).toBe(true);
    expect(isPickerValue('mode:print')).toBe(true);
    expect(isPickerValue('model:claude-opus-4-8')).toBe(true);
  });

  it('rejects queue-action, pending-prompt, and free-text values', () => {
    expect(isPickerValue('interrupt')).toBe(false);
    expect(isPickerValue('cancel:2')).toBe(false);
    expect(isPickerValue('prompt-opt:1')).toBe(false);
    expect(isPickerValue('yes do it')).toBe(false);
    expect(isPickerValue('model')).toBe(false); // no colon+arg
    expect(isPickerValue('model:')).toBe(false); // empty arg
  });

  it('never throws on non-strings', () => {
    expect(isPickerValue(null)).toBe(false);
    expect(isPickerValue(undefined)).toBe(false);
    expect(isPickerValue(42)).toBe(false);
    expect(isPickerValue({})).toBe(false);
  });
});

describe('handlePickerValue', () => {
  function seams() {
    return {
      applyModelSwitch: vi.fn(),
      switchEffortInSession: vi.fn(),
      applyModeSwitch: vi.fn(),
      sendReply: vi.fn(),
      sendHtml: vi.fn(),
    };
  }

  it('dispatches model:<alias> to applyModelSwitch(roomId, session, alias, ctx)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('model:sonnet', 'room-1', session, s)).toBe(true);
    expect(s.applyModelSwitch).toHaveBeenCalledWith('room-1', session, 'sonnet', {
      sendReply: s.sendReply, sendHtml: s.sendHtml,
    });
    expect(s.switchEffortInSession).not.toHaveBeenCalled();
    expect(s.applyModeSwitch).not.toHaveBeenCalled();
  });

  it('dispatches effort:<level> to switchEffortInSession(session, level, sendReply)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('effort:high', 'room-1', session, s)).toBe(true);
    expect(s.switchEffortInSession).toHaveBeenCalledWith(session, 'high', s.sendReply);
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
  });

  it('dispatches mode:interactive to applyModeSwitch(...true...) and mode:print to (...false...)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('mode:interactive', 'room-1', session, s)).toBe(true);
    expect(s.applyModeSwitch).toHaveBeenCalledWith('room-1', session, true, {
      sendReply: s.sendReply, sendHtml: s.sendHtml,
    });
    s.applyModeSwitch.mockClear();
    expect(handlePickerValue('mode:print', 'room-1', session, s)).toBe(true);
    expect(s.applyModeSwitch).toHaveBeenCalledWith('room-1', session, false, {
      sendReply: s.sendReply, sendHtml: s.sendHtml,
    });
  });

  it('returns false and dispatches nothing for a non-picker value', () => {
    const s = seams();
    expect(handlePickerValue('interrupt', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('prompt-opt:1', 'room-1', {}, s)).toBe(false);
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
    expect(s.switchEffortInSession).not.toHaveBeenCalled();
    expect(s.applyModeSwitch).not.toHaveBeenCalled();
  });
});
