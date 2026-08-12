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
});
