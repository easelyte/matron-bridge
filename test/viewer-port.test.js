import { describe, it, expect, vi } from 'vitest';
import { resolveViewerPort } from '../viewer/server.js';

// The Matrix→Matron rename left old .envs setting MATRIX_VIEWER_PORT while
// the viewer reads MATRON_VIEWER_PORT. The silent `|| 9803` fallback bound
// the viewer on the wrong port for weeks with both services "active" — the
// Cloudflare tunnel 502 of 2026-08-10. A stale name must still work, but
// loudly, so the .env actually gets fixed.
describe('resolveViewerPort', () => {
  it('prefers MATRON_VIEWER_PORT, silently', () => {
    const warn = vi.fn();
    expect(resolveViewerPort({ MATRON_VIEWER_PORT: '9801', MATRIX_VIEWER_PORT: '1111' }, warn)).toBe('9801');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the legacy MATRIX_VIEWER_PORT with a warning naming both vars', () => {
    const warn = vi.fn();
    expect(resolveViewerPort({ MATRIX_VIEWER_PORT: '9801' }, warn)).toBe('9801');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/MATRIX_VIEWER_PORT/);
    expect(warn.mock.calls[0][0]).toMatch(/MATRON_VIEWER_PORT/);
  });

  it('defaults to 9803 when neither is set', () => {
    const warn = vi.fn();
    expect(resolveViewerPort({}, warn)).toBe(9803);
    expect(warn).not.toHaveBeenCalled();
  });
});
