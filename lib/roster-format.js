// The agent_roster picker's one line per conversation. Extracted from
// ask-user.js so it is unit-testable (ask-user.js starts an MCP server on
// import). `mine` is this bridge's device id (null when unknown).
import { formatConvoStatus } from './convo-status-format.js';

export function rosterLine(c, mine, now = Date.now()) {
  const agent = c.agent_device_id == null ? ' (no agent)'
    : (mine != null && c.agent_device_id === mine) ? ' (this bridge)'
      : ` (agent ${c.agent_device_id})`;
  const summary = c.summary ? `: ${String(c.summary).slice(0, 200)}` : '';
  const status = formatConvoStatus(c.status, now);
  const state = `${c.session_state || 'unknown'}${status ? ` · ${status}` : ''}`;
  return `- ${c.id} — "${c.title || 'untitled'}" [${state}]${agent}${summary}`;
}
