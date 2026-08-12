// Rendering for `agent_boxes` output (spec: 2026-08-10 agent-spawn bridge +
// capacity design). Pulled out of ask-user.js (a standalone stdio MCP
// process with no module exports — importing it directly in a test would
// execute `await server.connect(transport)` at import time) so this pure
// formatter is independently unit-testable, same as
// formatRoomMessageNotice/formatInviteRequestNotice elsewhere in lib/.
//
// Every interpolated field below is PEER- or SUBPROCESS-authored, not
// bridge-composed: `name` is another bridge's own SERVER_LABEL, folder/
// activity paths and limit labels are relayed from that bridge's
// `recent_folders` RPC reply (labels ultimately come from parsing
// `claude -p "/usage"` output on the far side). All of it is rendered as
// plain lines in the tool's text result, so the same forgery risk
// room-delivery.js documents applies: an unflattened newline could forge an
// extra "box" entry or a fake activity/limits line. Every such field goes
// through peerField first — same discipline, same module, as every other
// peer-rendering path in this codebase.
import { peerField, PEER_NAME_MAX } from './peer-text.js';

// Deliberately generous relative to PEER_NAME_MAX: unlike a chat notice, a
// folder path here is not just prose — the agent may feed it straight back
// into agent_session_start's `workdir` argument, so truncating it would
// silently hand back a broken path. Matches lib/agent-spawn.js's own
// WORKDIR_MAX_CHARS (the journal-enforced wire cap for the same field), so
// nothing legitimate that made it across the wire gets cut here.
const PEER_PATH_MAX = 1024;

// One block of `agent_boxes` output per box. `activity`/`limits` are
// optional — an older bridge on the far side answers with folders only, so
// both blocks are simply omitted rather than rendered empty.
//
// The whole body runs inside a try/catch: `box.limits.as_of` is only bounds-
// checked by the journal's own sanitizer for INTEGER-ness, not range — an
// out-of-range value (e.g. 1e16, past JS's max time value) makes
// `new Date(...).toISOString()` throw a RangeError. One malformed box must
// degrade to a single safe line, not blank the whole `agent_boxes` listing
// for every OTHER box the caller asked about (see ask-user.js's `agent_boxes`
// tool, which maps this over every box in one text result).
export function formatBox(box) {
  // A primitive or array element never throws on property access, so the
  // try below cannot catch it — it would render a plausible-looking header
  // (`unknown (device undefined) — offline`) for garbage. Gate the shape
  // first: the degrade line is the honest output for anything not
  // box-shaped.
  if (!box || typeof box !== 'object' || Array.isArray(box)) return 'unknown (device ?) — (unavailable)';
  // Nothing else dereferences `box` outside the try: any throw inside must
  // take the degrade path too, not blank the listing this guard protects.
  let name = 'unknown';
  let device = '?';
  try {
    name = peerField(box.name, PEER_NAME_MAX) || 'unknown';
    device = box.device_id;
    const lines = [`${name} (device ${device}) — ${box.online ? 'online' : 'offline'}`];
    for (const f of (box.folders || []).slice(0, 5)) {
      const path = peerField(f.path, PEER_PATH_MAX);
      if (path) lines.push(`  ${path}`);
    }
    if (box.activity) {
      const entries = box.activity.last_hour || [];
      const shown = entries
        .slice(0, 5)
        .map((e) => `${peerField(e.path, PEER_PATH_MAX)} (${e.sessions})`);
      if (entries.length > 5) shown.push(`+${entries.length - 5} more`);
      lines.push(`  activity: ${box.activity.live_sessions} live${shown.length ? `; last hour: ${shown.join(', ')}` : ''}`);
    }
    if (box.limits) {
      const parts = (box.limits.lines || []).map((l) => `${peerField(l.label, PEER_NAME_MAX)} ${l.percent}%`);
      lines.push(`  limits: ${parts.join(' · ')} (as of ${new Date(box.limits.as_of).toISOString()})`);
    }
    return lines.join('\n');
  } catch {
    return `${name} (device ${device}) — (unavailable)`;
  }
}
