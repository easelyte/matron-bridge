// The usage_history MCP tool: how much of each account's weekly allowance
// went unused, week by week (journal GET /usage/history). The handler is
// the loopback side ({status, body}, like lib/routines-tools.js); the
// formatter lives here rather than in ask-user.js so it is unit-testable
// (ask-user.js connects its transport at import time).
//
// Account emails, box names and meter labels are relayed from other
// bridges, so each goes through peerField before it lands in the tool's
// text result (same forgery discipline as lib/agent-boxes-format.js).
import { peerField, PEER_NAME_MAX } from './peer-text.js';

export const WEEKS_DEFAULT = 12;
export const WEEKS_MAX = 104;
const NO_ROUTE = 'the journal did not answer — it may be unreachable, or this journal deployment does not have the /usage/history route yet (deploy the journal update)';

export function createUsageHistoryHandler({ fetchUsageHistory }) {
  return async function usageHistory(data) {
    // Every caller names its room: the loopback's foreign-turn gate works
    // from it, so a request without one must not reach the journal.
    if (typeof data?.roomId !== 'string' || !data.roomId) return { status: 400, body: { error: 'roomId is required' } };
    const weeks = data?.weeks ?? WEEKS_DEFAULT;
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > WEEKS_MAX) {
      return { status: 400, body: { error: `weeks must be a whole number from 1 to ${WEEKS_MAX}` } };
    }
    const history = await fetchUsageHistory(weeks);
    if (!history || !Array.isArray(history.accounts)) return { status: 502, body: { error: NO_ROUTE } };
    return { status: 200, body: history };
  };
}

const day = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '?';
};
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '?');

function accountName(a) {
  const agent = a.agent === 'codex' ? 'Codex' : 'Claude';
  const boxes = (Array.isArray(a.boxes) ? a.boxes : []).map((b) => peerField(b, PEER_NAME_MAX)).filter(Boolean);
  const who = typeof a.email === 'string' && a.email ? peerField(a.email, 254) : (boxes[0] || 'a removed box');
  const on = a.email && boxes.length ? ` (${boxes.join(', ')})` : '';
  return `${agent} · ${who}${on}`;
}

// One block per account; under it one line per meter with the finished
// weeks newest first, each as "<week ending> <unused>".
export function formatUsageHistory(history) {
  const accounts = Array.isArray(history?.accounts) ? history.accounts : [];
  if (!accounts.length) return 'No usage history yet. The journal starts keeping it from the first weekly reading after the update; a week shows up here once it has reset.';
  const blocks = accounts.map((a) => {
    const lines = [accountName(a)];
    for (const m of Array.isArray(a.meters) ? a.meters : []) {
      const label = peerField(m.label, 64) || 'Weekly';
      const windows = Array.isArray(m.windows) ? m.windows : [];
      const avg = Number.isFinite(m.average_unused) ? `, average ${pct(m.average_unused)} unused over ${windows.length} week${windows.length === 1 ? '' : 's'}` : '';
      lines.push(`  ${label}${avg}`);
      if (m.current) lines.push(`    this week so far: ${pct(m.current.unused)} left, resets ${day(m.current.resets_at)}`);
      if (windows.length) lines.push(`    unused by week ending: ${windows.map((w) => `${day(w.resets_at)} ${pct(w.unused)}`).join(', ')}`);
      else lines.push('    no finished week yet');
    }
    return lines.join('\n');
  });
  return `Weekly allowance left unused, last ${history.weeks ?? WEEKS_DEFAULT} weeks (unused = 100 − the last reading before that week's reset):\n\n${blocks.join('\n\n')}`;
}
