import { describe, it, expect } from 'vitest';
import {
  renderPermissionCard,
  permissionButtons,
  parsePermTap,
  permissionSpawnArgs,
  resolveBypassMode,
  createPermissionRegistry,
  resolvePermissionTimeoutMs,
  DENY_MESSAGE,
} from '../lib/permission-prompt.js';

const UUID = '01234567-89ab-cdef-0123-456789abcdef';

describe('permissionButtons', () => {
  it('builds the three verdict buttons with perm-namespaced ids and values', () => {
    const { buttons, mode } = permissionButtons(UUID, 'Bash');
    expect(mode).toBe('pick_one');
    expect(buttons).toEqual([
      { id: 'perm-allow', label: 'Allow once', value: `perm:${UUID}:allow` },
      { id: 'perm-always', label: 'Always allow Bash (session)', value: `perm:${UUID}:always` },
      { id: 'perm-deny', label: 'Deny', value: `perm:${UUID}:deny` },
    ]);
  });

  it('strips bidirectional control characters from the always-allow label', () => {
    const { buttons } = permissionButtons(UUID, 'Bash‮hsab');
    expect(buttons[1].label).toBe('Always allow Bashhsab (session)');
  });
});

describe('parsePermTap', () => {
  it('round-trips every button value permissionButtons emits', () => {
    for (const b of permissionButtons(UUID, 'WebFetch').buttons) {
      const parsed = parsePermTap(b.value);
      expect(parsed).not.toBeNull();
      expect(parsed.requestId).toBe(UUID);
      expect(['allow', 'always', 'deny']).toContain(parsed.verdict);
    }
  });

  it('rejects malformed and foreign values', () => {
    expect(parsePermTap('perm:not-a-uuid:allow')).toBeNull();
    expect(parsePermTap(`perm:${UUID}:maybe`)).toBeNull();
    expect(parsePermTap(`perm:${UUID}`)).toBeNull();
    expect(parsePermTap('model:sonnet')).toBeNull();
    expect(parsePermTap('')).toBeNull();
    expect(parsePermTap(null)).toBeNull();
    expect(parsePermTap(42)).toBeNull();
  });
});

describe('renderPermissionCard', () => {
  it('shows the command (and description) for Bash', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'Bash',
      input: { command: 'rm -rf build', description: 'Clean build dir' },
    });
    expect(plain).toContain('Bash');
    expect(plain).toContain('rm -rf build');
    expect(plain).toContain('Clean build dir');
    expect(html).toContain('<code>');
  });

  it('shows compact JSON for non-Bash tools and escapes html', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'WebFetch',
      input: { url: 'https://x.test/<b>' },
    });
    expect(plain).toContain('"url"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>"');
  });

  it('truncates long previews to ~500 chars', () => {
    const { plain } = renderPermissionCard({
      toolName: 'Bash',
      input: { command: 'x'.repeat(2000) },
    });
    expect(plain.length).toBeLessThan(700);
    expect(plain).toContain('…');
  });

  it('tolerates missing/unserializable input', () => {
    expect(() => renderPermissionCard({ toolName: 'Weird' })).not.toThrow();
    const cyc = {}; cyc.self = cyc;
    expect(() => renderPermissionCard({ toolName: 'Weird', input: cyc })).not.toThrow();
  });

  it('strips bidirectional control characters from tool name and preview', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'Bash‮',
      input: { command: 'echo ‮gnp.tseb‬ safe', description: 'desc⁦iso⁩' },
    });
    for (const out of [plain, html]) {
      expect(out).not.toMatch(/[؜‎‏‪-‮⁦-⁩]/);
    }
    expect(plain).toContain('gnp.tseb safe');
  });
});

describe('permissionSpawnArgs', () => {
  it('default: auto mode plus the prompt tool', () => {
    expect(permissionSpawnArgs(false)).toEqual([
      '--permission-mode', 'auto',
      '--permission-prompt-tool', 'mcp__ask-user__permission_request',
    ]);
  });

  it('bypass: the old skip-permissions flag', () => {
    expect(permissionSpawnArgs(true)).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('resolveBypassMode', () => {
  it('defaults to bypass when nothing is set anywhere', () => {
    expect(resolveBypassMode(undefined, undefined)).toBe(true);
  });

  it('an explicit flag wins over both persisted value and box default', () => {
    expect(resolveBypassMode(false, true, true)).toBe(false);
    expect(resolveBypassMode(true, false, false)).toBe(true);
  });

  it('the persisted value wins over the box default', () => {
    expect(resolveBypassMode(undefined, false, true)).toBe(false);
    expect(resolveBypassMode(undefined, true, false)).toBe(true);
  });

  it('MATRON_PERMISSION_MODE=auto flips the fallback', () => {
    expect(resolveBypassMode(undefined, undefined, false)).toBe(false);
  });

  it('a pre-feature session (no persisted bypassMode) lands on the box default, never coerced to auto', () => {
    expect(resolveBypassMode(null, undefined, true)).toBe(true);
  });
});

// Hand-rolled controllable timers, per the room-reply-waiters convention.
function fakeTimers() {
  const timers = new Map();
  let nextHandle = 1;
  return {
    setTimeout: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, ms }); return h; },
    clearTimeout: (h) => { timers.delete(h); },
    fire: (h) => { const t = timers.get(h); timers.delete(h); t?.fn(); },
    handles: () => [...timers.keys()],
    count: () => timers.size,
  };
}

describe('createPermissionRegistry', () => {
  const mkReg = (over = {}) => {
    const t = fakeTimers();
    let n = 0;
    const reg = createPermissionRegistry({
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
      mintId: () => `id-${++n}`,
      ...over,
    });
    return { reg, t };
  };

  it('create → allow answer → consumed read', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'room-1', toolName: 'Bash' });
    expect(reg.read(id)).toEqual({ answered: false });
    expect(reg.answer(id, 'allow')).toEqual({
      roomId: 'room-1', toolName: 'Bash', verdict: 'allow', behavior: 'allow',
    });
    expect(reg.read(id)).toEqual({ answered: true, behavior: 'allow', message: null });
    // consumed on answered read
    expect(reg.read(id)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it('always verdict reports behavior allow and the toolName', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'WebFetch' });
    expect(reg.answer(id, 'always')).toEqual({
      roomId: 'r', toolName: 'WebFetch', verdict: 'always', behavior: 'allow',
    });
  });

  it('deny carries DENY_MESSAGE through read', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    reg.answer(id, 'deny');
    expect(reg.read(id)).toEqual({ answered: true, behavior: 'deny', message: DENY_MESSAGE });
  });

  it('double answer returns null and keeps the first verdict', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    expect(reg.answer(id, 'deny')).not.toBeNull();
    expect(reg.answer(id, 'allow')).toBeNull();
    expect(reg.read(id).behavior).toBe('deny');
  });

  it('unknown id: answer and read return null', () => {
    const { reg } = mkReg();
    expect(reg.answer('nope', 'allow')).toBeNull();
    expect(reg.read('nope')).toBeNull();
  });

  it('TTL expiry deletes the entry (poller then 404s → tool fail-closes)', () => {
    const { reg, t } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    expect(t.count()).toBe(1);
    t.fire(t.handles()[0]);
    expect(reg.read(id)).toBeNull();
    expect(reg.answer(id, 'allow')).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it('answered read clears the TTL timer', () => {
    const { reg, t } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    reg.answer(id, 'allow');
    reg.read(id);
    expect(t.count()).toBe(0);
  });

  it('wrong-room answer is refused without consuming the entry', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'room-1', toolName: 'Bash' });
    expect(reg.answer(id, 'allow', 'room-2')).toBeNull();
    // still unanswered — a poller must NOT see an allow
    expect(reg.read(id)).toEqual({ answered: false });
    // the right room can still answer
    expect(reg.answer(id, 'deny', 'room-1')).not.toBeNull();
    expect(reg.read(id).behavior).toBe('deny');
  });

  it('rejects verdicts outside the closed set without changing state', () => {
    const { reg } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    expect(reg.answer(id, 'maybe', 'r')).toBeNull();
    expect(reg.read(id)).toEqual({ answered: false });
  });

  it('answering re-arms a grace timer so a late poller can still read the verdict', () => {
    const { reg, t } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    reg.answer(id, 'allow', 'r');
    // old TTL timer replaced by exactly one grace timer
    expect(t.count()).toBe(1);
    // firing the grace timer reaps the answered-but-never-read entry
    t.fire(t.handles()[0]);
    expect(reg.read(id)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it('cancel removes a pending entry and its timer', () => {
    const { reg, t } = mkReg();
    const { id } = reg.create({ roomId: 'r', toolName: 'Bash' });
    expect(reg.cancel(id)).toBe(true);
    expect(t.count()).toBe(0);
    expect(reg.read(id)).toBeNull();
    expect(reg.answer(id, 'allow', 'r')).toBeNull();
    expect(reg.cancel(id)).toBe(false);
  });
});

describe('resolvePermissionTimeoutMs', () => {
  it('defaults to 5 minutes when unset', () => {
    expect(resolvePermissionTimeoutMs(undefined)).toBe(300000);
    expect(resolvePermissionTimeoutMs('')).toBe(300000);
  });

  it('accepts a finite positive override within the 1-hour cap', () => {
    expect(resolvePermissionTimeoutMs('120000')).toBe(120000);
    expect(resolvePermissionTimeoutMs('3600000')).toBe(3600000);
  });

  it('falls back to the default for NaN, non-positive, infinite, or over-cap values', () => {
    for (const raw of ['abc', '0', '-5', 'Infinity', 'NaN', '3600001']) {
      expect(resolvePermissionTimeoutMs(raw)).toBe(300000);
    }
  });
});
