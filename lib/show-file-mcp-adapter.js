import path from 'node:path';

export const DENIAL_REASONS = new Set([
  'relative-path',
  'symlink',
  'bad-workdir',
  'sensitive',
  'outside-scope',
  'not-a-file',
  'unreadable',
  'too-large',
  'upload-failed',
  'saturated',
]);

export function createShowFileHandler({ bridgeApi, token, fetchImpl = fetch }) {
  return async ({ path: filePath, caption }) => {
    const basename = path.basename(filePath);

    try {
      const postRes = await fetchImpl(`${bridgeApi}/show-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, caption, token }),
      });
      const data = await postRes.json();

      if (!postRes.ok) {
        const reason = DENIAL_REASONS.has(data?.error) ? data.error : 'internal error';
        const retryAfter = postRes.headers.get('Retry-After');
        const retryHint = reason === 'saturated' && retryAfter
          ? ` (Retry-After: ${retryAfter})`
          : '';
        return { content: [{ type: 'text', text: `Could not show ${basename}: ${reason}${retryHint}` }] };
      }

      if (!data?.ok || (data.kind !== 'image' && data.kind !== 'file')) {
        return { content: [{ type: 'text', text: `Could not show ${basename}: internal error` }] };
      }

      return { content: [{ type: 'text', text: `Shown to operator: ${basename} (${data.kind}).` }] };
    } catch (_error) {
      return { content: [{ type: 'text', text: `Could not show ${basename}: internal error` }] };
    }
  };
}
