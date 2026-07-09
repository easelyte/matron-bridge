import { describe, it, expect } from 'vitest';
import {
  BRIDGE_COMMAND_NAMES,
  COMMAND_HOLD_DISCARD,
  commandHoldAction,
  isBridgeCommandEligible,
} from '../lib/message-coalescer.js';

describe('isBridgeCommandEligible', () => {
  it('genuine text command qualifies', () => {
    expect(isBridgeCommandEligible({ msgtype: 'm.text', text: '!status' })).toBe(true);
  });

  it('media caption that looks like a command does NOT', () => {
    expect(isBridgeCommandEligible({ msgtype: 'm.image', text: '!status' })).toBe(false);
  });

  it('plain text is not a command', () => {
    expect(isBridgeCommandEligible({ msgtype: 'm.text', text: 'hello' })).toBe(false);
  });

  it('exports the full command-name set', () => {
    expect(BRIDGE_COMMAND_NAMES.has('status')).toBe(true);
  });

  it('exports the command hold discard set', () => {
    expect(COMMAND_HOLD_DISCARD.has('flush')).toBe(true);
  });

  it('maps discard commands to discard action', () => {
    for (const cmd of ['esc', 'escape', 'stop', 'restart', 'clearall', 'flush']) {
      expect(commandHoldAction(cmd)).toBe('discard');
    }
  });

  it('maps other commands to flush action', () => {
    for (const cmd of ['status', 'model', 'effort', 'start', 'resume', 'workdir', 'help']) {
      expect(commandHoldAction(cmd)).toBe('flush');
    }
  });
});
