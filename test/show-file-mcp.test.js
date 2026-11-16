import { describe, expect, it, vi } from 'vitest';
import { createShowFileHandler } from '../lib/show-file-mcp-adapter.js';

const DENIAL_REASONS = [
  'sensitive',
  'outside-scope',
  'too-large',
  'not-a-file',
  'unreadable',
  'symlink',
  'relative-path',
  'bad-workdir',
  'upload-failed',
  'saturated',
];

describe('show-file MCP adapter', () => {
  it.each(DENIAL_REASONS)('preserves the %s endpoint denial', async (reason) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: reason }),
      {
        status: reason === 'upload-failed' ? 502 : 403,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    const handleShowFile = createShowFileHandler({
      bridgeApi: 'http://bridge.test',
      token: 'test-token',
      fetchImpl,
    });

    const result = await handleShowFile({ path: `/work/${reason}` });

    expect(result.content).toEqual([{
      type: 'text',
      text: `Could not show ${reason}: ${reason}`,
    }]);
    expect(fetchImpl).toHaveBeenCalledWith('http://bridge.test/show-file', expect.objectContaining({
      method: 'POST',
    }));
  });

  it.each([
    ['missing-token', 400],
    ['invalid-token', 403],
  ])('maps %s to a self-explaining "not enabled" message', async (reason, status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'token must be a non-empty string', reason }),
      { status, headers: { 'Content-Type': 'application/json' } },
    ));
    const handleShowFile = createShowFileHandler({
      bridgeApi: 'http://bridge.test',
      token: 'test-token',
      fetchImpl,
    });

    const result = await handleShowFile({ path: '/work/chart.png' });

    expect(result.content[0].text).toBe(
      'Could not show chart.png: show_file is not enabled for this session',
    );
  });

  it.each(['invalid-body', 'invalid-path', 'invalid-caption'])(
    'surfaces the %s validation reason instead of a generic internal error',
    async (reason) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: 'human-readable message', reason }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ));
      const handleShowFile = createShowFileHandler({
        bridgeApi: 'http://bridge.test',
        token: 'test-token',
        fetchImpl,
      });

      const result = await handleShowFile({ path: '/work/chart.png' });

      expect(result.content[0].text).toBe(`Could not show chart.png: ${reason}`);
    },
  );

  it('surfaces Retry-After for a saturated endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'saturated' }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
      },
    ));
    const handleShowFile = createShowFileHandler({
      bridgeApi: 'http://bridge.test',
      token: 'test-token',
      fetchImpl,
    });

    const result = await handleShowFile({ path: '/work/chart.png' });

    expect(result.content[0].text).toBe('Could not show chart.png: saturated (Retry-After: 1)');
  });

  it('tells the agent when the file was already shown and nothing was posted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, media_id: 'm1', kind: 'image', deduped: true, deduped_at: Date.UTC(2026, 0, 2, 3, 4, 5) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handleShowFile = createShowFileHandler({ bridgeApi: 'http://bridge.test', token: 't', fetchImpl });

    const result = await handleShowFile({ path: '/work/chart.png' });

    expect(result.content[0].text).toContain('Already shown to operator at 2026-01-02T03:04:05.000Z');
    expect(result.content[0].text).toContain('Not posted again');
    expect(result.content[0].text).not.toMatch(/^Shown to operator/);
  });
});
