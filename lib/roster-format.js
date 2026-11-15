// The agent_roster picker's one line per conversation. Extracted from
// ask-user.js so it is unit-testable (ask-user.js starts an MCP server on
// import). `mine` is this bridge's device id (null when unknown).
import { formatConvoStatus } from './convo-status-format.js';

// A conversation the user pinned to their sidebar carries the user's own name
// for it ("📚 Docs"), so an agent can find the conversation by what the
// user calls it. Journal-sanitised already; flattened again here because it lands
// in an agent prompt.
function pinLabel(pin) {
  const label = pin && typeof pin.label === 'string' ? pin.label.replace(/\s+/g, ' ').trim() : '';
  if (!label) return '';
  const emoji = typeof pin.emoji === 'string' ? pin.emoji.replace(/\s+/g, '') : '';
  return `📌 ${emoji ? `${emoji} ` : ''}${label} · `;
}

export function rosterLine(c, mine, now = Date.now()) {
  const agent = c.agent_device_id == null ? ' (no agent)'
    : (mine != null && c.agent_device_id === mine) ? ' (this bridge)'
      : ` (agent ${c.agent_device_id})`;
  // The conversation's current mission (journal /roster `mission_num`; a
  // journal without it sends none and the line keeps its old shape).
  const mission = Number.isInteger(c.mission_num) && c.mission_num > 0 ? ` · mission #${c.mission_num}` : '';
  const summary = c.summary ? `: ${String(c.summary).slice(0, 200)}` : '';
  const status = formatConvoStatus(c.status, now);
  const state = `${c.session_state || 'unknown'}${status ? ` · ${status}` : ''}`;
  return `- ${c.id} — ${pinLabel(c.pin)}"${c.title || 'untitled'}" [${state}]${agent}${mission}${summary}`;
}
