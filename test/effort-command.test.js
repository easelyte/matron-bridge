import { describe, it, expect } from 'vitest';
import {
  switchEffortInSession,
  effortButtons,
  isValidEffortArg,
  effortLabel,
} from '../lib/effort-command.js';

function fakeSession({ iv = null } = {}) {
  const sent = [];
  const typed = [];
  return {
    iv: iv === 'live' ? { alive: true, sendText: (t) => { typed.push(t); return true; } } : iv,
    _sent: sent,
    _typed: typed,
    send: (m) => sent.push(m),
  };
}

describe('switchEffortInSession', () => {
  it('drives /effort <level> into the PTY and confirms on a valid level', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchEffortInSession(s, 'high', s.send);
    expect(ok).toBe(true);
    expect(s._typed).toEqual(['/effort high']);
    expect(s._sent.join(' ')).toMatch(/High/);
  });

  it('normalizes the level before sending', () => {
    const s = fakeSession({ iv: 'live' });
    switchEffortInSession(s, '  XHIGH ', s.send);
    expect(s._typed).toEqual(['/effort xhigh']);
  });

  it('rejects an unknown level without touching the PTY', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchEffortInSession(s, 'banana', s.send);
    expect(ok).toBe(false);
    expect(s._typed).toEqual([]);
    expect(s._sent.join(' ')).toMatch(/Unknown effort level/);
  });

  it('degrades gracefully when there is no live TUI (print mode)', () => {
    const s = fakeSession({ iv: null });
    const ok = switchEffortInSession(s, 'high', s.send);
    expect(ok).toBe(false);
    expect(s._typed).toEqual([]);
    expect(s._sent.join(' ')).toMatch(/interactive mode/);
  });

  it('does not falsely confirm when the PTY write fails (dead session)', () => {
    const sent = [];
    const session = {
      // A dead iv session: sendText returns false and writes nothing.
      iv: { alive: false, sendText: () => false },
    };
    const ok = switchEffortInSession(session, 'high', (m) => sent.push(m));
    expect(ok).toBe(false);
    expect(sent.join(' ')).not.toMatch(/Switching effort/);
    expect(sent.join(' ')).toMatch(/isn't accepting input|couldn't|could not/i);
  });

  it('refuses (does not type) while the session is still resuming (input hold)', () => {
    const sent = [];
    const typed = [];
    const session = {
      _awaitingInputReady: true, // auto-resume hold is active
      iv: { alive: true, sendText: (t) => { typed.push(t); return true; } },
    };
    const ok = switchEffortInSession(session, 'high', (m) => sent.push(m));
    expect(ok).toBe(false);
    expect(typed).toEqual([]); // never wrote to the PTY
    expect(sent.join(' ')).not.toMatch(/Switching effort/);
    expect(sent.join(' ')).toMatch(/resuming/i);
  });

  it('accepts every advertised level', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultracode']) {
      expect(isValidEffortArg(level)).toBe(true);
      const s = fakeSession({ iv: 'live' });
      const ok = switchEffortInSession(s, level, s.send);
      expect(ok).toBe(true);
      expect(s._typed).toEqual([`/effort ${level}`]);
    }
  });
});

describe('effortButtons', () => {
  it('builds one namespaced button per effort level', () => {
    const buttons = effortButtons();
    expect(buttons).toHaveLength(7);
    expect(buttons[0]).toEqual({ id: 'effort-low', label: 'Low', value: 'effort:low' });
    expect(buttons.find(b => b.label === 'X-High')).toEqual({
      id: 'effort-xhigh', label: 'X-High', value: 'effort:xhigh',
    });
    expect(buttons.find(b => b.label === 'Ultracode')).toEqual({
      id: 'effort-ultracode', label: 'Ultracode', value: 'effort:ultracode',
    });
  });
});

describe('effortLabel', () => {
  it('maps known levels to labels and passes through unknown', () => {
    expect(effortLabel('xhigh')).toBe('X-High');
    expect(effortLabel('  HIGH ')).toBe('High');
    expect(effortLabel('weird')).toBe('weird');
  });
});
