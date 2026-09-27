// easelyte fork delta (#632): per-session codex-viz sink-dir teardown.
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { removeCodexSinkForSession } from '../lib/codex-paths.js';

describe('removeCodexSinkForSession', () => {
  it('removes the whole <sessionId> dir under the sinks root', () => {
    const rmSync = vi.fn();
    removeCodexSinkForSession('sid-1', { root: '/sinks', fsImpl: { rmSync } });
    expect(rmSync).toHaveBeenCalledWith(path.join('/sinks', 'sid-1'), { recursive: true, force: true });
  });

  it('refuses traversal-shaped ids without touching the filesystem', () => {
    const rmSync = vi.fn();
    for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x..y', undefined, 42]) {
      removeCodexSinkForSession(id, { root: '/sinks', fsImpl: { rmSync } });
    }
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('never throws when removal fails', () => {
    const rmSync = vi.fn(() => { throw new Error('EBUSY'); });
    expect(() => removeCodexSinkForSession('sid', { root: '/sinks', fsImpl: { rmSync } })).not.toThrow();
  });
});
