import { describe, it, expect } from 'vitest';
import { switchModelInSession, modelButtons, planPrintModelSwitch } from '../lib/model-command.js';

function fakeSession({ iv = null, currentModel = null } = {}) {
  const sent = [];
  const typed = [];
  return {
    currentModel,
    iv: iv === 'live' ? { alive: true, sendText: (t) => typed.push(t) } : iv,
    _sent: sent,
    _typed: typed,
    send: (m) => sent.push(m),
  };
}

describe('switchModelInSession', () => {
  it('drives /model <alias> into the PTY and confirms on a valid alias', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchModelInSession(s, 'sonnet', s.send);
    expect(ok).toBe(true);
    expect(s._typed).toEqual(['/model sonnet']);
    expect(s._sent.join(' ')).toMatch(/Sonnet/);
  });

  it('normalizes the alias before sending', () => {
    const s = fakeSession({ iv: 'live' });
    switchModelInSession(s, '  OPUS[1M] ', s.send);
    expect(s._typed).toEqual(['/model opus[1m]']);
  });

  it('rejects an unknown alias without touching the PTY', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchModelInSession(s, 'banana', s.send);
    expect(ok).toBe(false);
    expect(s._typed).toEqual([]);
    expect(s._sent.join(' ')).toMatch(/Unknown model/);
  });

  it('degrades gracefully when there is no live TUI (print mode)', () => {
    const s = fakeSession({ iv: null, currentModel: 'claude-opus-4-8' });
    const ok = switchModelInSession(s, 'sonnet', s.send);
    expect(ok).toBe(false);
    expect(s._sent.join(' ')).toMatch(/interactive mode/);
    expect(s._sent.join(' ')).toMatch(/claude-opus-4-8/);
  });

  it('does not falsely confirm when the PTY write fails (dead session)', () => {
    const sent = [];
    const session = {
      currentModel: null,
      // A dead iv session: sendText returns false and writes nothing.
      iv: { alive: false, sendText: () => false },
    };
    const ok = switchModelInSession(session, 'sonnet', (m) => sent.push(m));
    expect(ok).toBe(false);
    expect(sent.join(' ')).not.toMatch(/Switching to/);
    expect(sent.join(' ')).toMatch(/isn't accepting input|couldn't|could not/i);
  });

  it('refuses (does not type) while the session is still resuming (input hold)', () => {
    const sent = [];
    const typed = [];
    const session = {
      currentModel: null,
      _awaitingInputReady: true, // auto-resume hold is active
      iv: { alive: true, sendText: (t) => { typed.push(t); return true; } },
    };
    const ok = switchModelInSession(session, 'sonnet', (m) => sent.push(m));
    expect(ok).toBe(false);
    expect(typed).toEqual([]); // never wrote to the PTY
    expect(sent.join(' ')).not.toMatch(/Switching to/);
    expect(sent.join(' ')).toMatch(/resuming/i);
  });
});

describe('modelButtons', () => {
  it('builds one namespaced button per switchable alias', () => {
    const buttons = modelButtons();
    expect(buttons).toHaveLength(8);
    expect(buttons[0]).toEqual({ id: 'model-default', label: 'Default', value: 'model:default' });
    expect(buttons.find(b => b.label === 'Opus 1M')).toEqual({
      id: 'model-opus[1m]', label: 'Opus 1M', value: 'model:opus[1m]',
    });
  });
});

describe('planPrintModelSwitch', () => {
  it('approves a valid alias and returns the normalized value', () => {
    const d = planPrintModelSwitch({ busy: false, claudeSessionId: 'abc', _sessionConfirmed: true }, '  SONNET ');
    expect(d.ok).toBe(true);
    expect(d.normalized).toBe('sonnet');
    expect(d.message).toMatch(/Sonnet/);
  });
  it('refuses a provisional (unconfirmed) print session — --resume would fail on an unpersisted id', () => {
    const d = planPrintModelSwitch({ busy: false, claudeSessionId: 'abc', _sessionConfirmed: false }, 'sonnet');
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/starting up/i);
  });
  it('rejects an unknown alias', () => {
    const d = planPrintModelSwitch({ busy: false, claudeSessionId: 'abc' }, 'banana');
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/Unknown model/);
  });
  // Mid-turn is no longer a refusal: the planner hands back a defer signal
  // (with the normalized alias) so the caller can park `!model <alias>` on
  // the deferred-command stash — replayed at the turn-end seam BEFORE the
  // queue flush, so the switch applies ahead of every queued message,
  // /compact included.
  it('defers while the session is busy, normalized alias included', () => {
    const d = planPrintModelSwitch({ busy: true, claudeSessionId: 'abc', _sessionConfirmed: true }, '  SONNET ');
    expect(d.ok).toBe(false);
    expect(d.defer).toBe(true);
    expect(d.normalized).toBe('sonnet');
    expect(d.message).toMatch(/queued/i);
    expect(d.message).toMatch(/before any queued/i);
  });

  it('still rejects an unknown alias outright while busy — never parks garbage', () => {
    const d = planPrintModelSwitch({ busy: true, claudeSessionId: 'abc' }, 'banana');
    expect(d.ok).toBe(false);
    expect(d.defer).toBeFalsy();
    expect(d.message).toMatch(/Unknown model/);
  });
  it('refuses while the session has no id yet (fresh print session)', () => {
    const d = planPrintModelSwitch({ busy: false, claudeSessionId: null }, 'sonnet');
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/starting up/i);
  });
  it('refuses an otherwise-approvable switch while media is in flight (drain gate)', () => {
    // A print-mode /model switch recreates the claude -p process; doing it
    // mid-media-prep drops the in-flight attachment at the router's canonicality
    // guard — same gate as /switch, /restart, /mode. Checked after the busy
    // defer, so a busy session still parks; only an immediate recreate is blocked.
    const ready = { busy: false, claudeSessionId: 'abc', _sessionConfirmed: true };
    const d = planPrintModelSwitch(ready, 'sonnet', { hasInflightMedia: true });
    expect(d.ok).toBe(false);
    expect(d.defer).toBeFalsy();
    expect(d.message).toMatch(/attachment/i);
    // No regression when nothing is in flight.
    expect(planPrintModelSwitch(ready, 'sonnet', { hasInflightMedia: false }).ok).toBe(true);
    expect(planPrintModelSwitch(ready, 'sonnet').ok).toBe(true);
    // A busy session still parks (defer wins over the media gate).
    expect(planPrintModelSwitch({ ...ready, busy: true }, 'sonnet', { hasInflightMedia: true }).defer).toBe(true);
  });
});
