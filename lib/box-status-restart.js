const REQUEST_LIMIT = 20;
const SHA_LIMIT = 80;
const REASON_LIMIT = 200;
const PAYLOAD_LIMIT = 64 * 1024;
const truncate = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : null;
const number = value => Number.isFinite(value) ? value : null;

// Durable state remains authoritative, including terminal states until the
// next request. Only a bounded public summary leaves the bridge.
export function buildRestartStatus(state, verdict) {
  if (!state?.id || !state.state) return null;
  const truncated = {};
  const omit = (field, count) => { if (count) truncated[field] = (truncated[field] || 0) + count; };
  const list = (values, field, map) => {
    omit(field, Math.max(0, values.length - REQUEST_LIMIT));
    return values.slice(0, REQUEST_LIMIT).map(map);
  };
  let budget = 200;
  function results(value, depth = 0) {
    if (--budget < 0 || depth > 4) { omit('results', 1); return null; }
    if (typeof value === 'string') return truncate(value, REASON_LIMIT);
    if (Array.isArray(value)) return list(value, 'results', entry => results(entry, depth + 1));
    if (value && typeof value === 'object') {
      const entries = list(Object.entries(value), 'results', ([key, entry]) =>
        [key.slice(0, REASON_LIMIT), results(entry, depth + 1)]);
      return Object.fromEntries(entries);
    }
    return value;
  }
  const waiting = verdict?.waiting_on ?? {
    quiet: { holders: [], probe_error: 'restart gate unavailable' },
    code: null, preflight: { unknown: true }, collect: null, unwarned: [],
  };
  const status = {
    id: truncate(state.id, REASON_LIMIT),
    state: truncate(state.state, REASON_LIMIT),
    requests: list(state.requests, 'requests', request => ({
      sha: truncate(request.sha, SHA_LIMIT), reason: truncate(request.reason, REASON_LIMIT),
    })),
    pending_since: number(state.pending_since),
    waiting_on: {
      quiet: {
        holders: list(waiting.quiet.holders, 'holders', holder => ({
          convoId: truncate(holder.convoId, REASON_LIMIT), why: truncate(holder.why, REASON_LIMIT),
        })),
        probe_error: truncate(waiting.quiet.probe_error, REASON_LIMIT),
      },
      code: truncate(waiting.code, REASON_LIMIT),
      preflight: waiting.preflight === null ? null : waiting.preflight?.error != null
        ? { error: (['mode unsupported at HEAD', 'config invalid'].includes(waiting.preflight.error) ? waiting.preflight.error : 'preflight failed') } : { unknown: true },
      collect: waiting.collect === null ? null : { remaining_ms: number(waiting.collect.remaining_ms) },
      unwarned: list(waiting.unwarned, 'unwarned', value => truncate(value, REASON_LIMIT)),
    },
    expected_sha: truncate(state.expected_sha, SHA_LIMIT),
    ...(state.results ? { results: results(state.results) } : {}),
  };
  if (Object.keys(truncated).length) status.truncated = truncated;
  const oversized = () => Buffer.byteLength(JSON.stringify(status)) > PAYLOAD_LIMIT;
  if (oversized() && Object.hasOwn(status, 'results')) {
    omit('results', Array.isArray(status.results) ? status.results.length : 1);
    delete status.results;
    status.truncated = truncated;
  }
  // Escaped strings can expand on the wire. Keep at least one holder and
  // unwarned session so a capped report never suggests those gates are clear.
  for (const [field, values, keep] of [['requests', status.requests, 0],
    ['holders', status.waiting_on.quiet.holders, 1], ['unwarned', status.waiting_on.unwarned, 1]]) {
    while (oversized() && values.length > keep) {
      values.pop();
      omit(field, 1);
      status.truncated = truncated;
    }
  }
  return status;
}
