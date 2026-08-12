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
  // Misconfiguration / bad-request reasons the handler can also emit. Without
  // these a misconfigured session (root pin failed -> no token -> every call
  // 400 missing-token) surfaces as a confusing "internal error" dead tool.
  'invalid-body',
  'invalid-path',
  'invalid-caption',
  'missing-token',
  'invalid-token',
]);

// Friendlier text for reasons whose bare code isn't self-explaining to an agent.
const REASON_MESSAGES = {
  'missing-token': 'show_file is not enabled for this session',
  'invalid-token': 'show_file is not enabled for this session',
};

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
        // Prefer the machine reason code (validation branches carry it); fall back
        // to the error field for denial responses that only send the code there.
        const code = typeof data?.reason === 'string' ? data.reason : data?.error;
        const known = DENIAL_REASONS.has(code);
        const reason = known ? (REASON_MESSAGES[code] || code) : 'internal error';
        const retryAfter = postRes.headers.get('Retry-After');
        const retryHint = code === 'saturated' && retryAfter
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
