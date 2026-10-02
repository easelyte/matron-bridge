#!/usr/bin/env node

// MCP server providing secure-input tools: request_secret, share_sensitive_data, redact_message.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolvePermissionTimeoutMs, classifyPermissionPostResponse } from './lib/permission-prompt.js';
import { formatBox } from './lib/agent-boxes-format.js';
import { itemLine, formatItemList, formatItemDetail, formatCommentAck } from './lib/items-format.js';
import { formatStartAck, formatCreateAck, formatMilestoneAck, formatMissionDetail, missionLine, formatBlocked, formatJournalError, formatStatusAck, formatMissionList, formatJoinAck, formatLeaveAck, formatUpdateAck } from './lib/missions-format.js';
import { missionIdemKey, itemIdemKey } from './lib/missions-idem.js';
import { projectLine, formatProjectList, formatProjectDetail, formatProjectCreateAck, formatProjectStatusAck, formatProjectMergeAck, formatProjectBlocked, formatProjectJournalError } from './lib/projects-format.js';
import { formatMemoryList, formatMemoryDetail, formatSaveAck, formatDeleteAck } from './lib/memory-format.js';
import { formatReminderLine } from './lib/reminder-tools.js';
import { rosterLine } from './lib/roster-format.js';
import { formatPendingList, formatDecideAck } from './lib/consent-tools.js';
import { formatUnseenList, formatUnseenMine, formatFlagAck } from './lib/unseen-tools.js';
import { formatRoutineList, formatRoutineUpdateAck, formatRoutineRunAck } from './lib/routines-tools.js';

// Route to whichever bridge spawned us: explicit BRIDGE_API_URL wins, else the
// per-session MATRON_BRIDGE_API_PORT exported by the bridge at spawn (journal=9812,
// old Matrix bridge=9802), else the legacy default. Prevents the inbound-secret
// flow from posting to the wrong bridge process after the journal cutover.
const BRIDGE_API = process.env.BRIDGE_API_URL
  || (process.env.MATRON_BRIDGE_API_PORT && `http://127.0.0.1:${process.env.MATRON_BRIDGE_API_PORT}`)
  || 'http://127.0.0.1:9802';
const ROOM_ID = process.env.BRIDGE_ROOM_ID || null;
const POLL_INTERVAL_MS = 500;
// Max wait for a permission tap — the bridge's registry TTL resolves from the
// same env var through the same validation, keeping one expiry for the whole
// request lifecycle (default 5 min; out-of-range overrides fall back).
const PERMISSION_TIMEOUT_MS = resolvePermissionTimeoutMs(process.env.PERMISSION_PROMPT_TIMEOUT_MS);
// Per-request cap on any single bridge round-trip: the deny-on-timeout
// guarantee only holds if no individual fetch can hang past the deadline.
const BRIDGE_FETCH_TIMEOUT_MS = 10000;

const server = new McpServer({
  name: 'ask-user',
  version: '1.0.0',
});

server.tool(
  'request_secret',
  'Request a secret from the user via a secure web form: API keys, tokens, passwords, or whole key files (multiline: true) — anything that must not appear in chat. This tool does NOT block and returns nothing secret: it files the request in the user\'s tracker (their Decisions list) alongside a chat link, then returns immediately. The user has 24 hours. When they submit, you receive a turn telling you the local file path to read the value from — so carry on with other work in the meantime and never poll for it.',
  {
    label: z.string().describe('A short label describing what secret is needed, e.g. "AWS access key" or "database password"'),
    multiline: z.boolean().optional().describe('Render a multi-line box instead of a masked one-line field. Use for PEM keys, certificates and JSON service-account files, whose newlines a one-line field would destroy.'),
  },
  async ({ label, multiline }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, roomId: ROOM_ID, multiline: multiline === true }),
      });

      if (!postRes.ok) {
        // The bridge answers JSON (a 429 is the per-session pending cap) —
        // show its sentence, not the raw envelope.
        const raw = await postRes.text();
        let err = raw;
        try { err = JSON.parse(raw).error || raw; } catch { /* not JSON — show it as-is */ }
        return { content: [{ type: 'text', text: `Error requesting secret: ${err}` }] };
      }

      // No polling: the bridge holds the request for 24 h and delivers the
      // answer as a turn. The request id is the fallback identifier when the
      // tracker item could not be filed (no journal on this box).
      const { secretId, itemNum, itemError } = await postRes.json();
      const ref = Number.isInteger(itemNum) ? `#${itemNum}` : secretId;
      const filed = itemError ? ` The tracker item could not be filed (${itemError}) — the chat link still works.` : '';
      return {
        content: [{
          type: 'text',
          text: `Secret requested (${ref}) — the user has 24 hours; you will receive a turn "🔐 Secret "${label}" submitted — read it from <path>" when it lands. Carry on with other work; do not poll.${filed}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'permission_request',
  'Internal: Claude Code invokes this automatically (via --permission-prompt-tool) to ask the user for tool permission through Matron. Never call it yourself.',
  {
    tool_name: z.string().describe('Name of the tool Claude wants to use'),
    input: z.any().describe('The input Claude wants to pass to the tool'),
    tool_use_id: z.string().optional().describe('The tool use id this permission request is for'),
    permission_suggestions: z.any().optional().describe('Permission rule suggestions from Claude Code (accepted and ignored)'),
  },
  async ({ tool_name, input }) => {
    // The return text IS the protocol: Claude Code JSON-parses it. Fail
    // CLOSED — any relay failure denies rather than silently allowing.
    const deny = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message }) }] });
    const allow = () => ({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: input ?? {} }) }] });
    try {
      const postRes = await fetch(`${BRIDGE_API}/permission-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, toolName: tool_name, input: input ?? {} }),
        signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
      });
      if (!postRes.ok) {
        return deny(`Matron bridge rejected the permission request (HTTP ${postRes.status}).`);
      }
      const data = await postRes.json();
      // The bridge is the deciding layer: a grant or classifier allow → silent
      // allow (no card); a classifier policy deny → deny with the bridge's
      // message (no card); otherwise poll the minted card. See
      // classifyPermissionPostResponse (extracted for testing).
      const mapped = classifyPermissionPostResponse(data);
      if (mapped.action === 'allow') return allow();
      if (mapped.action === 'deny') return deny(mapped.message);
      const { requestId } = mapped;
      const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        // Transient poll failures (bridge restart, timeout) retry until the
        // deadline; only the deadline itself resolves the request (→ deny).
        let status;
        try {
          const pollRes = await fetch(`${BRIDGE_API}/permission-request/${requestId}`, {
            signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
          });
          if (!pollRes.ok) continue;
          status = await pollRes.json();
        } catch {
          continue;
        }
        if (status.answered) {
          return status.behavior === 'allow'
            ? allow()
            : deny(status.message || 'The user denied this tool use from Matron.');
        }
      }
      return deny(`The user did not answer the permission prompt within ${Math.round(PERMISSION_TIMEOUT_MS / 60000)} minutes. You may continue other work that does not need this permission.`);
    } catch (err) {
      return deny(`Permission relay error: ${err.message}`);
    }
  }
);

server.tool(
  'share_sensitive_data',
  'CRITICAL: Use this to share ANY sensitive data (API keys, tokens, passwords, credentials) with the user via a secure viewer link instead of posting in chat. Returns a one-time secure URL. The data is NOT logged in conversation history.',
  {
    label: z.string().describe('Short description of the sensitive data, e.g. "Gemini API Key" or "Database Password"'),
    content: z.string().describe('The sensitive data to share securely'),
    ttl: z.number().optional().describe('Time-to-live in seconds (default: 3600 = 1 hour, max: 86400 = 24 hours)'),
    filename: z.string().optional().describe('Suggested filename for the viewer\'s Download button, e.g. "install.sh". Falls back to a name derived from the label.'),
    download: z.boolean().optional().describe('If true, the link downloads the content directly as a file instead of showing a page.'),
    one_time: z.boolean().optional().describe('Default true: the link is consumed on first use. Set false for a multi-use link that works until the ttl expires (use with a short ttl).'),
  },
  async ({ label, content, ttl, filename, download, one_time }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/share-sensitive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label, content, ttl: ttl || 3600, roomId: ROOM_ID, filename,
          download: download === true, oneTime: one_time !== false,
        }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error creating secure link: ${err}` }] };
      }

      const { url, expiresAt, notified } = await postRes.json();
      const usage = one_time !== false
        ? 'can only be viewed once'
        : 'can be used repeatedly until it expires';
      const notice = notified ? `\nNotification posted in ${notified} — verify that is the current chat.` : '';
      return {
        content: [{
          type: 'text',
          text: `Secure link created for "${label}":\n${url}\n\nThis link expires at ${new Date(expiresAt).toISOString()} and ${usage}.${notice}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'redact_message',
  'Redact (delete) a message that was sent by the bridge to the user in the Matron chat. Use this to remove sensitive information that was accidentally posted. Note: Only messages sent by the bridge bot can be redacted.',
  {
    eventId: z.string().describe('The event ID of the message to redact'),
    reason: z.string().optional().describe('Optional reason for redacting the message'),
  },
  async ({ eventId, reason }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/redact-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, eventId, reason }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error redacting message: ${err}` }] };
      }

      return {
        content: [{
          type: 'text',
          text: `Message ${eventId} has been redacted.${reason ? ` Reason: ${reason}` : ''}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'send_attachment',
  'Send a file from disk into the Matron chat as a real attachment: images (png/jpg/gif/webp/heic) render inline; PDFs, logs, and other files appear as tappable file attachments. Use this for screenshots, plots, generated documents, and build artifacts instead of describing them or pasting their contents. Do NOT use for secrets or credential files — use share_sensitive_data for those. The file must be inside the session working directory, and attachments are capped at 50 MB. Keep it purposeful: send the artifact the user needs, not every intermediate file.',
  {
    path: z.string().describe('Path to the file — absolute, or relative to the session working directory'),
    caption: z.string().optional().describe('Optional caption rendered with the attachment, like a message body'),
    chat_room_id: z.string().optional().describe('Optional agent chat room id — post the attachment into that room instead of this conversation (you must be a participant of the room)'),
  },
  async ({ path, caption, chat_room_id }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/send-attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, path, caption, ...(chat_room_id ? { chat_room_id } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `send_attachment failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: `Sent ${data.kind} "${data.name}" (${data.size} bytes) into ${chat_room_id ? `room ${chat_room_id}` : 'the chat'}.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

// --- Agent-to-agent chat rooms ---
// Thin POST wrappers over the bridge's loopback agent-chat routes. Success
// text is a short English rendering of the response body; errors surface
// data.error with an `HTTP <status>` fallback (the send_attachment shape).

// Formats a chatStart/chatJoin outcome body ({room_id, status, reason?, note?, error?}).
function describeRoomOutcome(body) {
  // A reused room (chatStart's reuse-first path) answers {ok, room_id, note}
  // with no `status` — it is not an invite outcome, it is the room the pair
  // already has. Falling straight through to 'unknown' would read as a
  // failure, so `ok` speaks for itself.
  const state = body.status || (body.ok ? 'ok' : null) || body.error || 'unknown';
  return `Room ${body.room_id}: ${state}${body.reason ? ` — ${body.reason}` : ''}${body.note ? `. ${body.note}` : ''}`;
}

// formatBox (agent_boxes rendering) lives in lib/agent-boxes-format.js —
// pulled out so it's independently unit-testable and so its peer-text
// sanitization (name/paths/labels are another bridge's own strings, not
// bridge-composed) shares the one peerField implementation everything else
// in this codebase uses.

// Same sender rendering as live room delivery (index.js journalOnRoomFrame):
// `box2 (agent)` / `dan`, never raw `agent:box2`. Shared by agent_chat_read
// and agent_chat_accept's joined-room backfill.
const senderLabel = (s) => typeof s !== 'string' ? String(s)
  : s.startsWith('agent:') ? `${s.slice(6)} (agent)`
    : s.startsWith('user:') ? s.slice(5) : s;
const messageLine = (m) => `${senderLabel(m.sender)}: ${m.body}${m.caption ? ` — ${m.caption}` : ''}`;

server.tool(
  'agent_roster',
  "List this user's other agent sessions (boxes, conversation titles, states, rolling summaries) so you can pick a target for agent_chat_start, plus each session's model, context gauge (tokens used of its window, e.g. `870k/1m 87%`) and any usage-limit stall (`stalled: usage limit, resets HH:MM UTC`), as last reported by its bridge — so you can also see which sessions are near full or out of allowance. Excludes yourself.",
  {},
  async () => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-roster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_roster failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      // Cap the rendering: 30 most recent conversations, summaries clipped
      // to 200 chars — the roster is a picker, not a transcript.
      const mine = data.self?.device_id;
      const convos = (data.conversations || [])
        .slice()
        .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0))
        .slice(0, 30)
        // Rows owned by this bridge are valid targets too (same-bridge
        // rooms): the invite is delivered locally instead of via the
        // journal. Only the caller's OWN conversation is refused.
        .map((c) => rosterLine(c, mine));
      // `connected`/`wakeable` are journal-composed. An asleep box is still a
      // valid chat target: the journal wakes it when the invite parks, so the
      // answer just takes a few minutes longer.
      const agentState = (a) => a.connected === true ? 'online' : a.wakeable === true ? 'asleep (woken on demand)' : a.connected === false ? 'offline' : '';
      const agents = (data.agents || []).map((a) => `- device ${a.device_id}: ${a.name}${agentState(a) ? ` — ${agentState(a)}` : ''}`);
      const self = data.self ? `You are "${data.self.name}" (device ${data.self.device_id}).` : 'Your own identity is unknown.';
      return { content: [{ type: 'text', text: `${self}\nOther agents:\n${agents.join('\n') || '- none'}\nConversations:\n${convos.join('\n') || '- none'}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_sessions',
  "List this user's addressable agent sessions for direct coordination. Each entry includes its conversation id, title, state, agent kind, and whether it is this session; never target an entry where is_self is true.",
  {},
  async () => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_sessions failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data.sessions || [], null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_message',
  "Send a concise coordination line to another of the operator's agent sessions. Choose target_convo from agent_sessions; use this for outcomes, questions, and decisions rather than running commentary.",
  {
    target_convo: z.string().min(1).describe('Conversation id of the target session, from agent_sessions'),
    body: z.string().min(1).describe('The coordination line to send'),
    priority: z
      .boolean()
      .optional()
      .describe(
        "Mark this as a priority message. The target surfaces it with a louder in-timeline marker, and while the target is mid-turn on lower-priority work (a coordinating peer turn, or autonomous work) a priority message may interrupt that turn so it is handled sooner. It never interrupts the operator's own in-progress turn or an equal-priority peer turn, and when the target is idle at a prompt it is delivered normally without interrupting. Use sparingly, for time-sensitive coordination.",
      ),
  },
  async ({ target_convo, body, priority }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only serialize priority when true — a normal message carries no priority at any hop.
        body: JSON.stringify({ roomId: ROOM_ID, target_convo, body, ...(priority === true ? { priority: true } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_message failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_start',
  "Start a chat room with one of the user's other agent sessions: pick a target conversation from agent_roster, and the bridge invites its agent. Sessions on this same bridge are valid targets too (the invite is delivered locally). The user approves the invite on a consent card; once approved, the peer's bridge joins its agent to the room at once (there is no accept step on that side) and the agent reads your opening message as its next turn. A target whose box is asleep is fine: the journal wakes the box while the invite waits for the user's consent, so it just takes a few minutes longer. You and a given peer session share ONE room for the life of both conversations — it survives an idle reap, a restart and the box sleeping, and a peer's message wakes this conversation: calling this again at the same target returns that existing room (and posts your message into it) rather than opening a second one — there is no way to close a room, so use agent_chat_mute if one goes wrong. If the result is pending or pending_busy, do NOT wait or poll: continue your own work — the answer and any replies arrive automatically as later turns.",
  {
    target_convo_id: z.string().describe('Conversation id of the target session, from agent_roster'),
    topic: z.string().optional().describe('Optional short topic for the room title'),
    justification: z.string().describe('Why you want to talk to that agent — shown to it with the request'),
    message: z.string().describe('The opening message posted into the room'),
  },
  async ({ target_convo_id, topic, justification, message }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, target_convo_id, topic, justification, message }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_start failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: describeRoomOutcome(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_boxes',
  "List the user's agent boxes (machines) as spawn targets — including this one, marked \"this box\" — with recent folders, current activity, and account usage limits. Use this when the user asks to start a new session here or on another machine, or to find a box with spare capacity: prefer a box whose usage percentages are low and whose activity shows few or no recent sessions. Data may be minutes old. A box shown asleep is a valid target: the journal wakes it when you spawn on it or invite it, and the session or invite goes through a few minutes later once it is up. A box shown offline cannot be reached from here.",
  {},
  async () => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-boxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_boxes failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      const boxes = data.boxes || [];
      if (!boxes.length) return { content: [{ type: 'text', text: 'No boxes found.' }] };
      return { content: [{ type: 'text', text: boxes.map(formatBox).join('\n\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_session_start',
  "Ask the user's consent to start a new agent session on one of their boxes — this one included, when the work has to happen here — seeded with a task. If the user has not already said which box and directory the work should happen in, ask them before calling this — they usually have a preference, and the consent card can only be approved or declined, it cannot be corrected. The result is pending: do NOT wait or poll — the user's decision and the spawn outcome arrive automatically as later turns. On approval the new session runs detached by default: it does the task and does not report back — a clean break, which is what a spawn normally is. Pass link: true only when you need its results in a chat room; the room is then created on approval and the child is told to report there. Pass mission: N to put the new session on mission #N from its first turn (the consent card says so) — the way to assign a mission made with mission_create.",
  {
    device_id: z.number().int().describe('Target box device id, from agent_boxes'),
    workdir: z.string().describe('Absolute working directory on the target box, from agent_boxes folders'),
    task: z.string().max(2000).describe('The task prompt. Shown VERBATIM on the user\'s consent card and executed verbatim as the new session\'s first turn — write it for both audiences.'),
    topic: z.string().max(200).optional().describe('Optional short room/session title'),
    model: z.string().optional().describe('Optional Claude model alias for the new session: default, opus, opus[1m], sonnet, sonnet[1m], haiku, opusplan, fable (or a full claude-* model name). Omit to use the target box\'s own default — only set it if the user asked for a specific model.'),
    link: z.boolean().optional().describe('Open a chat room between this session and the new one, and have it report its outcome there. Default false: the spawned session is detached and simply does its task. Set true only when you need its results back here.'),
    mission: z.number().int().min(1).optional().describe('Mission number the new session joins before its first turn — e.g. one you made with mission_create. The consent card shows it.'),
  },
  async ({ device_id, workdir, task, topic, model, link, mission }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-session-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, device_id, workdir, task, ...(topic ? { topic } : {}), ...(model ? { model } : {}), ...(link === true ? { link: true } : {}), ...(mission ? { mission } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_session_start failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      const waking = data.target_waking === true
        ? ' The target box is asleep and is being woken: the session starts once the user approves and the box is up, which takes a few minutes for a cold start — a slow outcome is not a failure.'
        : '';
      const joins = mission ? ` The new session joins mission #${mission} from its first turn.` : '';
      return { content: [{ type: 'text', text: `Spawn request ${data.spawn_id} sent — awaiting the user's approval.${joins}${waking} Continue your own work; the outcome will arrive as a later turn.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

const SESSION_CONTROL_WHAT = "Session control is for the user's Coordinator only (the journal refuses anyone else): it acts on ANOTHER session, found by its conversation id from agent_roster or mission_get. The target bridge resumes the session if it is idle-reaped, parks the action while the session is mid-turn or waiting on a prompt, applies it at the session's next idle point, and writes a one-line notice into that session's chat saying the Coordinator did it and why. The tool returns as soon as the journal has taken the request; the outcome (applied / parked / failed) arrives in this chat as a later notice, minutes later if the target box had to be woken. Never expect an immediate effect on a running session.";

server.tool(
  'session_set_model',
  `Switch another session's model, or move it between Claude and Codex. ${SESSION_CONTROL_WHAT} Use it when a session is stalled on a usage limit for its current model (agent_roster shows "stalled: usage limit") and waiting for the reset is not acceptable, or when the user asks for a different model on a session. A print-mode Claude session restarts to apply the switch (history kept); an interactive one applies it on its next message.`,
  {
    target_convo_id: z.string().describe('The target conversation id (from agent_roster or mission_get) — never this conversation'),
    model: z.string().max(64).optional().describe('Claude: default, opus, opus[1m], sonnet, sonnet[1m], haiku, opusplan, fable, or a full claude-* name. Codex: a Codex model id, or "default". Optional when only `agent` changes.'),
    agent: z.enum(['claude', 'codex']).optional().describe('Move the session to this backend first (the bridge hands the unseen transcript over on the next turn). Omit to keep the current one.'),
    reason: z.string().max(200).optional().describe('One line shown in the target chat, e.g. "Fable limit reached, resets 15:00 UTC"'),
  },
  async ({ target_convo_id, model, agent, reason }) => sessionControlCall('/session-set-model', { target_convo_id, ...(model ? { model } : {}), ...(agent ? { agent } : {}), ...(reason ? { reason } : {}) }, 'session_set_model')
);

server.tool(
  'session_compact',
  `Compact another session's context (/compact at its next idle point). ${SESSION_CONTROL_WHAT} Use it when agent_roster or mission_get shows a session above about 80% of its window and it is still working; a compact goes ahead of anything else queued for that session.`,
  {
    target_convo_id: z.string().describe('The target conversation id (from agent_roster or mission_get) — never this conversation'),
    reason: z.string().max(200).optional().describe('One line shown in the target chat, e.g. "context at 92%"'),
  },
  async ({ target_convo_id, reason }) => sessionControlCall('/session-compact', { target_convo_id, ...(reason ? { reason } : {}) }, 'session_compact')
);

server.tool(
  'session_carry_on',
  `Tell another session to carry on: the message is sent into it as a turn attributed to the Coordinator. ${SESSION_CONTROL_WHAT} A session stalled on a usage limit is carried on automatically by its own bridge when the limit resets (and moved to the default model if its model became unavailable), so use this for what the automatic path cannot know: a session with no reset time, one you want continued with different instructions, or one that simply stopped. With when: "after_limit_reset" the message replaces the automatic carry-on's default text and fires at the reset time (refused as not_stalled / no_reset_time when that does not apply).`,
  {
    target_convo_id: z.string().describe('The target conversation id (from agent_roster or mission_get) — never this conversation'),
    message: z.string().max(2000).describe('What the session should do next, written to the agent in that session'),
    when: z.enum(['now', 'after_limit_reset']).optional().describe('Default now. after_limit_reset: hold it until the usage-limit stall the session reported has reset.'),
    reason: z.string().max(200).optional().describe('One line shown in the target chat'),
  },
  async ({ target_convo_id, message, when, reason }) => sessionControlCall('/session-carry-on', { target_convo_id, message, ...(when ? { when } : {}), ...(reason ? { reason } : {}) }, 'session_carry_on')
);

// --- Coordinator consent approval (spec 2026-09-29 coordinator consent) ---
// consent_list / consent_decide go through the bridge loopback
// (index.js mounts lib/consent-tools.js at /consent/<op>); the journal
// allows both to the Coordinator alone.
const CONSENT_WHAT = "Consent approval is for the user's Coordinator only (the journal refuses anyone else) and only for the user's own agents and boxes. It covers agent chat invites, room join requests and agent_session_start spawns — never tool permission prompts or secret requests, which stay with the user. The user always sees the card too and may answer first; every decision you make shows on the card and in the tracker as made by the Coordinator, with your reason, and the user can stop the session or mute the room with one tap. Follow the rules in your instructions: approve only what you understand and that follows the box rules, never into an offline box, give a reason every time, and leave the rest for the user.";

async function callConsent(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/consent/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `consent_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `consent_${name} failed: ${err.message}` }] };
  }
}

server.tool(
  'consent_list',
  `List the chat invites, room join requests and spawn requests waiting for the user's approval, oldest first, each with who asks whom, the box and its state, the task or justification, and the consent_decide call to answer it. ${CONSENT_WHAT} Call it when the journal nudges you about a pending request, when your own agent_session_start or agent_chat_start is waiting, and when you sweep the state of the world.`,
  {},
  async () => callConsent('list', {}, formatPendingList),
);

server.tool(
  'consent_decide',
  `Approve or decline one waiting chat or spawn request on the user's behalf, with a reason the user will read. ${CONSENT_WHAT} The journal's operator may cap approvals per day; at that cap, and for a box that is offline, the journal refuses and the request stays for the user — say so in one line. Declines are never capped.`,
  {
    kind: z.enum(['chat', 'spawn']).describe('As consent_list shows it'),
    id: z.string().max(128).describe('The request id from consent_list (a spawn id, or room_id/device_id for a chat)'),
    decision: z.enum(['approve', 'decline']),
    reason: z.string().min(1).max(200).describe('One line the user reads on the card and in the tracker: why this follows the rules, or why not'),
  },
  async (args) => callConsent('decide', args, (d) => formatDecideAck(d, args)),
);

// --- Read state (spec: matron-journal 2026-09-30 read state) ---
// unseen_list (Coordinator), unseen_mine (any agent, its own messages) and
// unseen_flag go through the bridge loopback (index.js mounts
// lib/unseen-tools.js at /unseen/<op>); the journal is the gate.
async function callUnseen(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/unseen/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `unseen_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `unseen_${name} failed: ${err.message}` }] };
  }
}

server.tool(
  'unseen_list',
  "List what the user hasn't actually seen — messages that were never on their screen and tracker items they haven't opened — grouped by conversation, important first, each with why it matters and a ref. Coordinator only. Importance comes from the journal: items waiting on the user, questions, unanswered prompts, a session's last message before it stopped, failures. Agent-to-agent rooms are never important on their own (what needs the user there becomes a tracker item). Use it in every status update (a short \"You haven't seen\" section, at most 5 lines) and when the journal nudges you. Things already raised (unseen_flag) are left out unless include_flagged.",
  {
    older_than: z.string().max(16).optional().describe("Skip what's newer than this — the user may be about to read it. Default 30m."),
    since: z.string().max(16).optional().describe('How far back to look, e.g. 3d (default), up to 30d.'),
    importance: z.enum(['important', 'all']).optional().describe("'important' (default) or 'all' unseen agent messages"),
    conversation: z.string().max(128).optional().describe('Only this conversation (its id)'),
    mission: z.number().int().min(1).optional().describe('Only this mission number'),
    include_flagged: z.boolean().optional().describe('Include entries already raised with the user'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
  },
  async (args) => callUnseen('list', args, formatUnseenList),
);

server.tool(
  'unseen_mine',
  "Which of YOUR messages in this conversation the user hasn't seen yet — they were never on the user's screen. Check it when you finish a long turn: if something that matters went unseen, restate it once, briefly, in your closing message (\"Earlier I said X; you may have missed it\"), then unseen_flag its ref. Never repeat a restatement, and never tell the user they haven't read something.",
  {
    older_than: z.string().max(16).optional().describe('Skip messages newer than this. Default 10m.'),
    room_id: z.string().max(128).optional().describe('An agent chat room you take part in, instead of this conversation'),
  },
  async (args) => callUnseen('mine', args, formatUnseenMine),
);

server.tool(
  'unseen_flag',
  "Record that you've raised these unseen entries with the user, so they are never listed or nudged about again. Pass refs exactly as unseen_list or unseen_mine gave them. An ordinary agent may only flag its own messages in this conversation.",
  {
    refs: z.array(z.string().max(200)).min(1).max(100).describe('Refs from unseen_list / unseen_mine'),
  },
  async (args) => callUnseen('flag', args, (d) => formatFlagAck(d, d.refs || args.refs)),
);

// --- Coordinator routines (spec: matron-journal 2026-10-01 coordinator routines) ---
// routine_list / routine_update / routine_run go through the bridge loopback
// (index.js mounts lib/routines-tools.js at /routine/<op>); the journal
// allows all three to the Coordinator alone. Create and delete stay in the apps.
const ROUTINE_WHAT = "A routine is a prompt the journal owns and fires into the Coordinator conversation, on a schedule or when a trigger trips (a session past a context threshold, a session stalled on a usage limit, a box low on disk), as a turn starting `[routine <name>, fired by the journal …]`, waking the box if needed — nothing in any conversation keeps it alive, so never set reminders for routine work. Coordinator only.";

async function callRoutine(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/routine/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `routine_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `routine_${name} failed: ${err.message}` }] };
  }
}

server.tool(
  'routine_list',
  `List the user's Coordinator routines: name, title, schedule in words, next fire, last fire and outcome, paused or not. ${ROUTINE_WHAT} Call it when a routine turn seems to be missing or doubled, and when the user asks what runs when.`,
  {},
  async () => callRoutine('list', {}, formatRoutineList),
);

server.tool(
  'routine_update',
  `Pause (enabled: false), resume (enabled: true) or edit one routine — its title, schedule (five cron fields, in tz), zone, prompt, or for a triggered routine its trigger threshold. ${ROUTINE_WHAT} The schedule must fire at least 15 minutes apart. Resuming or rescheduling recomputes the next fire from now. The user creates and deletes routines in the apps (Settings ▸ Coordinator ▸ Routines); only change one when the user asks or the playbook says to.`,
  {
    name: z.string().max(64).describe('The routine\'s slug, as routine_list shows it'),
    title: z.string().max(200).optional().describe('One line'),
    schedule: z.string().max(64).optional().describe('Five cron fields: minute hour day-of-month month day-of-week, e.g. "5 7 * * *" (daily 07:05) or "0 */2 * * *" (every 2 h)'),
    tz: z.string().max(64).optional().describe('IANA zone the schedule is in, e.g. Europe/London'),
    prompt: z.string().max(2000).optional().describe('The turn text the journal fires; keep it one line pointing at the playbook section'),
    enabled: z.boolean().optional().describe('false pauses, true resumes'),
    trigger: z.object({ kind: z.enum(['context_over', 'stalled', 'disk_under']), pct: z.number().int().min(1).max(99).optional(), reset_minutes: z.number().int().min(0).optional() }).optional().describe('For a triggered routine: the rule it fires on — context_over/disk_under take pct, stalled takes reset_minutes (fire only when the reset is at least that far away, or unknown)'),
  },
  async (args) => callRoutine('update', args, (d) => formatRoutineUpdateAck(d, args)),
);

server.tool(
  'routine_run',
  `Fire one routine now, whatever its schedule or paused state says; the journal delivers its prompt to this conversation as a later turn, so do not wait or run it twice. ${ROUTINE_WHAT}`,
  {
    name: z.string().max(64).describe('The routine\'s slug, as routine_list shows it'),
  },
  async (args) => callRoutine('run', args, (d) => formatRoutineRunAck(d, args.name)),
);

async function sessionControlCall(route, body, name) {
  try {
    const postRes = await fetch(`${BRIDGE_API}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...body }),
    });
    const data = await postRes.json().catch(() => ({}));
    if (!postRes.ok) {
      return { content: [{ type: 'text', text: `${name} failed: ${data.error || `HTTP ${postRes.status}`}` }] };
    }
    const waking = data.target_waking === true
      ? ' The target box is asleep and is being woken; the action applies once it is up, which takes a few minutes.'
      : '';
    return { content: [{ type: 'text', text: `Sent to the target session's bridge.${waking} It applies at that session's next idle point (parked if it is mid-turn); the outcome arrives here as a later notice — do not poll, and do not send it again.` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}

server.tool(
  'restart_session',
  "Restart THIS session's own agent process — the way to get browser tools (chrome-devtools MCP) mid-conversation, or to move onto a different model, without asking the user to do it. The conversation, workdir and history are kept; only the underlying process is respawned. continue_with is a message the bridge sends back into the restarted session as its first turn, so the work carries on unattended — write it as an instruction to your future self, including whatever context the restart is about to cost you. The restart does NOT happen instantly: it is parked until your current turn ends, so finish up and stop working rather than starting anything new after calling this. There is a small budget of consecutive self-restarts; once it runs out you must ask the user. Never call this in a loop.",
  {
    continue_with: z.string().max(2000).describe('The message to send into the restarted session as its first turn. Written for your future self: what you were doing, what to do next.'),
    browser: z.boolean().optional().describe('Restart with browser tools (chrome-devtools MCP) enabled. Omit to keep the session\'s current MCP servers.'),
    model: z.string().optional().describe('Optional Claude model alias to restart onto: default, opus, opus[1m], sonnet, sonnet[1m], haiku, opusplan, fable (or a full claude-* name). Omit to keep the current model.'),
    reason: z.string().max(200).optional().describe('Short reason shown to the user in chat, e.g. "need to screenshot the rendered page".'),
  },
  async ({ continue_with, browser, model, reason }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/restart-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: ROOM_ID,
          continue_with,
          ...(browser != null ? { browser } : {}),
          ...(model ? { model } : {}),
          ...(reason ? { reason } : {}),
        }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        // The refusal text is the useful part — a bad model alias or an
        // exhausted budget is something the agent can act on.
        return { content: [{ type: 'text', text: `restart_session refused: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: data.parked
        ? 'Restart parked — it runs the moment this turn ends. Wrap up now: say what you were doing and stop. Do not start new work, and do not call this tool again. Your continuation message will arrive as the first turn of the restarted session.'
        : 'Restarting now. Your continuation message will arrive as the first turn of the restarted session.' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_send',
  'Send a message into an agent chat room. Keep room messages concise and coordination-focused: outcomes, questions, decisions — not running commentary. Optional wait_seconds (max 60) blocks your turn for up to that long waiting for a reply — use it only for a short back-and-forth with a peer you know is idle; a busy or unjoined peer will burn the whole wait. Either way, replies always arrive as later turns regardless, so never poll.',
  {
    room_id: z.string().describe('The agent chat room id'),
    message: z.string().describe('The message to post into the room'),
    wait_seconds: z.number().optional().describe('Optionally wait up to this many seconds (max 60) for a quick reply'),
  },
  async ({ room_id, message, wait_seconds }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id, message, ...(wait_seconds != null ? { wait_seconds } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_send failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      const text = data.reply ? `Reply from ${data.reply.from}: ${data.reply.body}` : (data.note || 'Sent.');
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_accept',
  "Accept a chat request that still needs an answer: a same-bridge invite, or a request from a third agent to join a room you own. An invite from another box that your user approved has ALREADY joined you to the room by the time you read it (you are told 'You are now in a room with…'), so calling this on such a room is a harmless no-op — just reply with agent_chat_send.",
  {
    room_id: z.string().describe('The room id from the chat request'),
  },
  async ({ room_id }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_accept failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      // An OWNER accepting a third party's join request admits the requester
      // — it does not "join" a room it already owns.
      if (data.admitted) {
        return { content: [{ type: 'text', text: `Admitted the requesting agent to your room ${data.room_id}.` }] };
      }
      // Approved invites join on delivery: there was nothing left to accept.
      if (data.already_joined) {
        return { content: [{ type: 'text', text: `You are already in room ${data.room_id} — the invite joined you when it was approved. Reply with agent_chat_send.` }] };
      }
      const backlog = (data.messages || []).map(messageLine);
      const text = `Joined room ${data.room_id}. Messages from it arrive as later turns.`
        + (backlog.length ? `\nThe room so far:\n${backlog.join('\n')}` : '')
        + (data.note ? `\n${data.note}` : '');
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_refuse',
  'Refuse a chat request that still needs an answer: a same-bridge invite, or a request from a third agent to join a room you own. The reason is relayed to the caller. On a room you are already in (an approved invite from another box joins you on delivery) this cannot un-join you: it mutes the room with your reason instead, exactly as agent_chat_mute would.',
  {
    room_id: z.string().describe('The room id from the chat request'),
    reason: z.string().optional().describe('Optional short reason, relayed to the requesting agent'),
  },
  async ({ room_id, reason }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-refuse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id, ...(reason ? { reason } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_refuse failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      if (data.muted) {
        return { content: [{ type: 'text', text: `You were already in room ${data.room_id} (the approved invite joined you on delivery), so it has been muted instead. ${data.note || ''}`.trim() }] };
      }
      return { content: [{ type: 'text', text: `Refused room ${data.room_id}.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_join',
  'Ask to join an existing agent chat room by id (e.g. one your user handed you). If the result is pending, do NOT wait or poll: continue your own work — the answer arrives as a later turn.',
  {
    room_id: z.string().describe('The room id to join'),
    justification: z.string().describe('Why you want to join — shown to the room owner'),
  },
  async ({ room_id, justification }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id, justification }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_join failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: describeRoomOutcome(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

// There is deliberately NO agent_chat_leave tool (2026-08-19). A room lives
// for the life of the two conversations: agents kept closing rooms and opening
// new ones for every exchange, which filled the user's chat list with dead
// single-exchange rooms and lost the thread between two sessions that talk
// repeatedly. agent_chat_mute below is the escape hatch instead. The
// /agent-chat-leave route and chatLeave internals still exist, but since
// 2026-09-21 no teardown calls them: a room outlives the claude process (idle
// reap, restart, box asleep) and is only left, lazily, once its conversation
// can no longer be resumed (index.js orphanRoomBinding).

server.tool(
  'agent_chat_invite',
  "Invite another of the user's agent sessions into a chat room you ALREADY own — the proactive inverse of agent_chat_join. You must be the room's owner (the session that started it with agent_chat_start). Pick the invitee's conversation from agent_roster; the bridge asks its agent, which accepts with agent_chat_accept exactly like a fresh chat request. The invitee must accept — you cannot force-add. Same-box sessions cannot be added this way in v1; invite a session on another box. If the result is pending or pending_busy, do NOT wait or poll: continue your own work — the answer and any replies arrive automatically as later turns.",
  {
    room_id: z.string().describe('The id of a room you own and want to invite into'),
    target_convo_id: z.string().describe('Conversation id of the session to invite, from agent_roster'),
    topic: z.string().optional().describe('Optional short topic, shown to the invitee with the request'),
    justification: z.string().describe('Why you want that agent in the room — shown to it with the request'),
  },
  async ({ room_id, target_convo_id, topic, justification }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id, target_convo_id, justification, ...(topic ? { topic } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_invite failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: describeRoomOutcome(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_mute',
  'Mute an agent chat room: its messages stop being delivered to you. Use this when a room has gone wrong — the peer is looping, spamming, or malfunctioning — instead of trying to leave (you cannot: a room stays open for the life of both conversations, across restarts and sleeps). The room stays open and readable with agent_chat_read, you can still post into it, and your user sees why you muted it and can unmute you with one tap.',
  {
    room_id: z.string().describe('The agent chat room id to mute'),
    reason: z.string().describe('Why you are muting it, in one line — shown to your user, who decides whether to unmute'),
  },
  async ({ room_id, reason }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-mute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id, reason }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_mute failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: `Muted room ${room_id}. ${data.note || ''}`.trim() }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_unmute',
  'Unmute an agent chat room you previously muted: messages are delivered to you again. Nothing that arrived while it was muted is replayed — use agent_chat_read to catch up.',
  {
    room_id: z.string().describe('The agent chat room id to unmute'),
  },
  async ({ room_id }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-unmute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_unmute failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: `Unmuted room ${room_id}. ${data.note || ''}`.trim() }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_read',
  'Read recent messages from an agent chat room you participate in — inbox-style catch-up mid-turn. Not a polling tool: new messages arrive as later turns on their own.',
  {
    room_id: z.string().describe('The room id to read'),
    limit: z.number().optional().describe('Max messages to return (default 50, max 200)'),
  },
  async ({ room_id, limit }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id, ...(limit != null ? { limit } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_read failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      const msgs = data.messages || [];
      if (!msgs.length) return { content: [{ type: 'text', text: `No messages in room ${room_id} yet.` }] };
      const lines = msgs.map(messageLine);
      return { content: [{ type: 'text', text: `Last ${msgs.length} messages in room ${room_id}:\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

// --- Task & decision tracker (spec 2026-09-08) ---
//
// The seven item_* tools share one shape: POST the args to the loopback
// route, render `data.error` / `HTTP <status>` on failure, and a compact
// English line on success (the rendering lives in lib/items-format.js so it
// is testable without a journal). Never isError: a tool result that reads as
// a sentence keeps the model working instead of retrying blindly.
async function callItems(name, args, render) {
  const payload = { roomId: ROOM_ID, ...args };
  // The two minting/appending item ops carry an idempotency key the model never
  // sees or supplies: a harness-retried item_create/item_comment
  // would otherwise duplicate the item/comment AND re-upload its attachment blob
  // (permanently orphaning the first upload — retention.js never reaps it). The
  // key is derived from the call (op, room, content, +id for comments) inside a
  // ten-minute bucket, so a retry replays the existing row instead. See
  // lib/missions-idem.js.
  if (name === 'create' || name === 'comment') {
    payload.idem_key = itemIdemKey({ op: `item_${name}`, roomId: ROOM_ID, args: args || {} });
  }
  try {
    const res = await fetch(`${BRIDGE_API}/items/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `item_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}

server.tool(
  'item_create',
  "File an item in the user's task & decision tracker — a panel beside the chat, so it survives this session and the user can answer in their own time. Use kind 'question' for EACH decision you need from the user instead of listing questions in prose: the user answers in that item's own thread and their reply reaches you as a 📌 turn, so do not block waiting for it. Use 'decision' to record a choice you made yourself (what and why, in body) and 'task' for work to do later. Markdown body; attach screenshots or files by local path (uploaded and shown inline). When the question has an obvious one-tap answer — a go-ahead, or a choice between 2–3 options — pass `actions` so the user can tap instead of typing (they can still reply in words).",
  {
    kind: z.enum(['task', 'question', 'decision']),
    title: z.string().describe('One line, ≤200 chars'),
    body: z.string().optional().describe('Markdown. For a question: the options and your recommendation. For a decision: what and why.'),
    attachments: z.array(z.string()).optional().describe('Local file paths inside the working directory'),
    labels: z.array(z.string()).optional(),
    links: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional().describe('e.g. a GitHub issue or PR'),
    awaiting: z.enum(['user', 'agent']).nullable().optional().describe('Who acts next. Defaults: question→user, task→agent, decision→nobody'),
    position: z.enum(['top', 'bottom']).optional().describe('Where a task lands in the ordered task list'),
    supersedes: z.string().optional().describe('Item id of a decision this one replaces'),
    actions: z.array(z.string()).max(4).optional().describe('Up to 4 short one-tap reply labels (≤40 chars each, unique), e.g. ["Go"] or ["Option A","Option B"]. Tapping one behaves exactly like the user typing that label as a reply.'),
  },
  async (args) => callItems('create', args, (d) => itemLine(d.item)),
);

server.tool(
  'item_list',
  "List tracker items. By default: THIS conversation's open items, in list order. scope 'all' widens to every conversation of this user (other agents' items too). Worth checking at the start of a session, and before asking the user anything — the answer may already be filed.",
  {
    scope: z.enum(['convo', 'all']).default('convo').describe("Only this conversation's items unless set to 'all'"),
    kind: z.enum(['task', 'question', 'decision']).optional(),
    state: z.enum(['open', 'closed', 'any']).default('open').describe("'any' includes closed items"),
    awaiting: z.enum(['user', 'agent']).optional().describe("'user' = blocked on the user; 'agent' = yours to act on"),
    label: z.string().optional(),
    since: z.number().int().optional().describe('Only items updated at/after this ms timestamp — cheap polling'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async (args) => callItems('list', args, formatItemList),
);

server.tool(
  'item_get',
  "Read one item in full: its body and its whole comment thread — the user's answers, attachments, voice-note transcripts and status changes. File attachments are downloaded to disk and each is listed with the absolute path to Read it from.",
  { id: z.string().describe("Item id ('it_…') or '#12'") },
  async (args) => callItems('get', args, formatItemDetail),
);

server.tool(
  'item_comment',
  "Add a comment to an item (text and/or attachments by local path) — progress, findings, or a follow-up question in the same thread. The item is the full record of that piece of work: put follow-up screenshots, images and files in `attachments` here, not in the chat with a note that they are in the conversation. Optionally set `awaiting` to hand the item to the user ('user'), take it back ('agent'), or clear it (null). Prefer `item_close` when the item is actually resolved.",
  {
    id: z.string().describe("Item id ('it_…') or '#12'"),
    body: z.string().optional().describe('Markdown'),
    attachments: z.array(z.string()).optional().describe('Local file paths inside the working directory'),
    awaiting: z.enum(['user', 'agent']).nullable().optional().describe('Who acts next after this comment; omit to leave it unchanged'),
  },
  async (args) => callItems('comment', args, (d) => formatCommentAck(d, args.awaiting)),
);

server.tool(
  'item_close',
  "Close an item with a resolution: 'answered' (a question you have acted on), 'done' or 'cancelled' (task), 'decided' or 'reversed' (decision). Optional closing comment — say what happened.",
  {
    id: z.string().describe("Item id ('it_…') or '#12'"),
    resolution: z.enum(['done', 'answered', 'decided', 'reversed', 'cancelled']),
    comment: z.string().optional().describe('Closing note, added to the thread'),
  },
  async (args) => callItems('close', args, (d) => itemLine(d.item)),
);

server.tool(
  'item_reopen',
  'Reopen a closed item, with an optional comment explaining why it is back.',
  {
    id: z.string().describe("Item id ('it_…') or '#12'"),
    comment: z.string().optional(),
  },
  async (args) => callItems('reopen', args, (d) => itemLine(d.item)),
);

server.tool(
  'item_reorder',
  'Move an item in the ordered list: to the top or bottom, or after/before another item. Exactly one of position, after or before.',
  {
    id: z.string().describe("Item id ('it_…') or '#12'"),
    position: z.enum(['top', 'bottom']).optional(),
    after: z.string().optional().describe('Item id to place this one after'),
    before: z.string().optional().describe('Item id to place this one before'),
  },
  async (args) => callItems('reorder', args, (d) => itemLine(d.item)),
);

// --- Missions & milestones (spec 2026-09-10) ---
//
// Same shape as callItems. A 409 is the interesting case here: the journal
// says WHY (blocked_by) and the renderer turns that into the next call the
// model should make — never isError, never raw JSON. Other errors go
// through formatJournalError, which turns the journal's machine words into
// sentences.
//
// The two creating ops carry an idempotency key the model never sees or
// supplies: a retried milestone_post would otherwise mint a second
// milestone AND a second transcript marker (see lib/missions-idem.js).
async function callMissions(name, args, render) {
  const payload = { roomId: ROOM_ID, ...args };
  if (name === 'start' || name === 'post' || name === 'create') {
    payload.idem_key = missionIdemKey({ op: name, roomId: ROOM_ID, kind: args?.kind, title: args?.title, body: args?.body, mission: args?.mission });
  }
  try {
    const res = await fetch(`${BRIDGE_API}/missions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) return { content: [{ type: 'text', text: `${missionToolName(name)} failed: ${formatBlocked(data)}` }] };
    if (!res.ok) return { content: [{ type: 'text', text: `${missionToolName(name)} failed: ${formatJournalError(name, data) || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `${missionToolName(name)} failed: ${err.message}` }] };
  }
}
const missionToolName = (op) => ({ start: 'mission_start', create: 'mission_create', post: 'milestone_post', update: 'mission_update', join: 'mission_join', leave: 'mission_leave', get: 'mission_get', close: 'mission_close' }[op] || `mission_${op}`);

server.tool(
  'mission_start',
  "Start the mission for this conversation — the human-readable record of one piece of work, shared by every agent and app of this user. Do this as soon as you know what the work is (usually right after the user's first substantive input): name it and state the goal in body, with the whole conversation as context. Milestones are refused until the conversation has a mission. If it already has a current mission this returns that one unchanged; to move on to different work, mission_create the new mission and mission_join it. Run project_list first and pass project: N when the work belongs to an existing project.",
  {
    title: z.string().describe('One line, ≤200 chars — what the work is'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal and the standing description'),
    project: z.number().int().min(1).optional().describe('A project number from project_list to file the mission in'),
  },
  async (args) => callMissions('start', args, formatStartAck),
);

server.tool(
  'mission_create',
  "Create a mission WITHOUT joining this conversation to it (an unassigned mission) — for work you are handing to another agent, or new work you will mission_join yourself. Assign it by starting a session with agent_session_start and mission: N, or by asking a running agent (agent_chat_start) to mission_join N. mission_start is the one that creates AND joins, for your own work when this conversation has no mission yet. Pass project: N to file it in a project. Returns the mission number.",
  {
    title: z.string().describe('One line, ≤200 chars — what the work is'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal: what done looks like, constraints, links'),
    project: z.number().int().min(1).optional().describe('A project number from project_list to file the mission in'),
  },
  async (args) => callMissions('create', args, formatCreateAck),
);

server.tool(
  'milestone_post',
  "Post a milestone: a checkpoint on this conversation's current mission that is also a jump target back to this exact point in the transcript. kind 'user_input' whenever an input from the user starts or redirects work (skip typos, one-word answers, clarifications) — the user's stated purpose is to get back to their last input easily. kind 'progress' as often as useful: a landed PR, a diagnosis, a decision, a phase done. There is no cap. Pass `mission` to post to another mission this conversation is on (mission_get lists them). Refused with an instruction if the conversation has no mission yet.",
  {
    kind: z.enum(['user_input', 'progress']),
    title: z.string().describe('One line, ≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB — what happened, in a sentence or two'),
    mission: z.number().int().min(1).optional().describe('A mission this conversation is on; omit for the current mission'),
  },
  async (args) => callMissions('post', args, formatMilestoneAck),
);

server.tool(
  'mission_update',
  "Rename a mission, rewrite its standing description, or file it in a project (project: N; null takes it out — a mission is in one project or none). Default: this conversation's current mission. Pass `mission` to change another mission — e.g. the Coordinator applying a filing the user approved.",
  {
    title: z.string().optional().describe('≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB'),
    project: z.number().int().min(1).nullable().optional().describe('A project number from project_list, or null to take the mission out of its project'),
    mission: z.number().int().min(1).optional().describe("Another mission's number; omit for this conversation's current mission"),
  },
  async (args) => callMissions('update', args, formatUpdateAck),
);

server.tool(
  'mission_status',
  "Set the mission's status — one short paragraph (≤600 chars) saying where the work is, what's next, and anything blocked or waiting on the user. It is the headline on the mission's card in the apps, so write it for the user at a glance, not as a log. Replace it whenever that picture changes: after a progress milestone, when you get blocked, when you hand off. Pass `mission` only to set another mission's status (the Coordinator does this).",
  {
    status: z.string().describe('One short paragraph, ≤600 characters'),
    mission: z.number().int().min(1).optional().describe("Another mission's number (the Coordinator); omit for this conversation's mission"),
  },
  async (args) => callMissions('status', args, formatStatusAck),
);

server.tool(
  'mission_list',
  "List the user's missions — open by default, state: 'closed' for closed ones — each with its counts, its status (when and by whom) and its last milestone. The Coordinator uses it to find every mission whose status to refresh.",
  { state: z.enum(['open', 'closed']).optional().describe("Default 'open'") },
  async (args) => callMissions('list', args, formatMissionList),
);

server.tool(
  'mission_join',
  "Join a mission by number and make it this conversation's current mission — milestones and new items go there by default. Use it when you move on to other work (mission_create the new mission first if it does not exist yet), or to pick up work handed over from another session. The missions this conversation was already on stay linked; mission_leave ends one.",
  { num: z.number().int().min(1).describe('The mission number, e.g. 61') },
  async (args) => callMissions('join', args, formatJoinAck),
);

server.tool(
  'mission_leave',
  "End this conversation's link to a mission you are done with while the mission itself goes on (closing it is mission_close). If it was the current mission, the most recently joined remaining one becomes current, or none. The link stays in the mission's history.",
  { num: z.number().int().min(1).describe('The mission number to leave') },
  async (args) => callMissions('leave', args, formatLeaveAck),
);

server.tool(
  'mission_get',
  "Read a mission: its milestones newest first, open items (awaiting the user first) and conversations. Default: this conversation's current mission, plus every mission this conversation is on (current, also on, earlier).",
  { num: z.number().int().min(1).optional().describe('A mission number; omit for this conversation\'s mission') },
  async (args) => callMissions('get', args, formatMissionDetail),
);

server.tool(
  'mission_close',
  "Close this conversation's mission when the work is DONE (not when the session ends), with a summary. Refuses while items are open: close each with a real resolution, or item_move it to the mission it belongs to. Items awaiting the user block you outright — only they can clear those. Pass `mission` to close another mission by number — one this conversation is also on, or (the Coordinator) any mission whose session has gone; the same open-item rules apply, so resolve or move its items first.",
  {
    summary: z.string().describe('Markdown ≤32 KiB — how it went, what shipped, what is left'),
    mission: z.number().int().min(1).optional().describe("Another mission's number — one this conversation is also on, or the Coordinator's; omit for this conversation's current mission"),
  },
  async (args) => callMissions('close', args, (d) => missionLine(d.mission)),
);

server.tool(
  'item_move',
  "Move an item to another mission by number, or detach it (mission: null). The only way an item's mission ever changes.",
  {
    id: z.string().describe("Item id ('it_…') or '#12'"),
    mission: z.number().int().min(1).nullable().describe('Target mission number, or null to detach'),
  },
  async (args) => callItems('move', args, (d) => itemLine(d.item)),
);

// --- Projects (spec 2026-09-30 projects §5) ---
//
// Same shape as callMissions: the bridge loopback (index.js mounts
// lib/projects-tools.js at /projects/<op>), a 409 rendered as the next move,
// other errors through the journal-error mapper — never isError, never raw
// JSON. project_create carries an idempotency key the model never sees.
async function callProjects(name, args, render) {
  const payload = { roomId: ROOM_ID, ...args };
  if (name === 'create') payload.idem_key = missionIdemKey({ op: 'project_create', roomId: ROOM_ID, title: args?.title, body: args?.body });
  try {
    const res = await fetch(`${BRIDGE_API}/projects/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) return { content: [{ type: 'text', text: `project_${name} failed: ${formatProjectBlocked(data)}` }] };
    if (!res.ok) return { content: [{ type: 'text', text: `project_${name} failed: ${formatProjectJournalError(name, data) || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `project_${name} failed: ${err.message}` }] };
  }
}

const PROJECT_WHAT = 'A Project is the user\'s tracker object that groups related missions (e.g. "Promo launch" groups the launch-day mission, the promo branch and SEO phase 2) — not a working directory, and nothing to do with ~/.claude/projects. A mission is in one project or none.';

server.tool(
  'project_list',
  `List the user's projects — open by default, state: 'closed' for closed ones — each with its status, its missions' activity (running / waiting / idle / quiet, and closed), needs-you and open-item counts, and when it last moved. Run it before you file a mission and before project_create: file into an existing project when one fits. ${PROJECT_WHAT}`,
  { state: z.enum(['open', 'closed']).optional().describe("Default 'open'") },
  async (args) => callProjects('list', args, formatProjectList),
);

server.tool(
  'project_get',
  "Read a project: its missions with their status, items awaiting the user across them, the latest milestones and sessions per box. Default: the project of this conversation's current mission.",
  { num: z.number().int().min(1).optional().describe("A project number; omit for the project of this conversation's current mission") },
  async (args) => callProjects('get', args, formatProjectDetail),
);

server.tool(
  'project_create',
  `Create a project — only after project_list shows none that fits (the Coordinator merges duplicates). Then file missions into it with mission_update project: N, or mission_start / mission_create with project: N. Returns the project number. ${PROJECT_WHAT}`,
  {
    title: z.string().describe('One line, ≤200 chars — what the missions in it add up to'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal, and what belongs in it'),
  },
  async (args) => callProjects('create', args, formatProjectCreateAck),
);

server.tool(
  'project_update',
  'Rename a project or rewrite its description (the goal it groups missions under).',
  {
    num: z.number().int().min(1).describe('The project number'),
    title: z.string().optional().describe('≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB'),
  },
  async (args) => callProjects('update', args, (d) => projectLine(d.project)),
);

server.tool(
  'project_status',
  "Set a project's status — one short paragraph (≤600 chars) summing up its missions: what is moving, what waits on the user, the next date or blocker. The headline on the project's card in the apps; the Coordinator writes these in its status sweep.",
  {
    num: z.number().int().min(1).describe('The project number'),
    status: z.string().describe('One short paragraph, ≤600 characters'),
  },
  async (args) => callProjects('status', args, formatProjectStatusAck),
);

server.tool(
  'project_close',
  "Close a finished project with a summary. The Coordinator only (the journal allows it to the Coordinator alone). Refused while missions in it are open — only the user closes a project with open missions.",
  {
    num: z.number().int().min(1).describe('The project number'),
    summary: z.string().describe('Markdown ≤32 KiB — what the project delivered'),
  },
  async (args) => callProjects('close', args, (d) => projectLine(d.project)),
);

server.tool(
  'project_merge',
  'Merge project #num into project #into: every mission in #num moves to #into, and #num closes as "Merged into #into" (its number keeps pointing there). The Coordinator only — for near-duplicate projects; report each merge to the user.',
  {
    num: z.number().int().min(1).describe('The project to fold away'),
    into: z.number().int().min(1).describe('The project to keep'),
  },
  async (args) => callProjects('merge', args, (d) => formatProjectMergeAck(d, args)),
);

// --- Memories (spec 2026-09-27 memories): the user's shared agent memory ---
// The four memory_* tools go through the bridge loopback (index.js mounts
// lib/memory-tools.js at /memory/<op>), the items/missions shape.
async function callMemory(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/memory/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `memory_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}

const MEMORY_WHAT = "The user's memories are their standing rules and facts about how they want their agents to work (which boxes to avoid, which model to use, how to report), saved in the journal, shared by every session on every box, and listed under \"Your memories\" in every session's instructions at spawn. Each has a scope: 'global' (every session), 'coordinator' (the user's Coordinator only) or 'repo:<name>' (sessions working in that repo); a session is given the global memories, its repo's, and all of them when it is the Coordinator.";

server.tool(
  'memory_save',
  `Save or update one of the user's memories. ${MEMORY_WHAT} Save a memory the moment the user states such a rule — one memory per rule — and confirm in one line. The \`description\` is the one line every session sees at spawn, so write it as the actionable rule itself; put the why and the how in \`body\`. The same \`name\` overwrites the WHOLE memory, so send the body back when updating one. Not for project or code facts an ordinary session should keep in its own Claude Code memory directory.`,
  {
    name: z.string().describe("Kebab-case slug, unique per user: lowercase letters, digits and dashes, ≤64 chars, e.g. 'avoid-eric-and-fatima'. Reuse an existing name to update it."),
    description: z.string().describe('One line, ≤200 chars: the rule as every session should read it.'),
    body: z.string().optional().describe('Markdown, ≤8 KB: **Why:** and **How to apply:**. Omitted on an update clears the stored body — send it back.'),
    type: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe("Defaults to 'feedback' (how the user wants work done). 'user' = who they are; 'project' = ongoing work or constraints; 'reference' = a pointer (URL, dashboard, ticket)."),
    scope: z.string().optional().describe("Who the memory is for: 'global' (every session; the default on create), 'coordinator' (a rule only the Coordinator acts on: sweeps, compaction, usage limits, box capacity) or 'repo:<name>' (a rule about one repo's workflow, e.g. 'repo:yearbook-app' — the bare repo name). Omitted on an update keeps the stored scope."),
  },
  async (args) => callMemory('save', args, formatSaveAck),
);

server.tool(
  'memory_list',
  `List the user's memories: name, type, scope, description and when each was last updated. ${MEMORY_WHAT} Without \`all\` an ordinary session gets the memories in its own scopes and a count of the rest; the Coordinator always gets every one. Call it before deciding anything a standing rule might cover if your instructions do not already carry the list.`,
  { all: z.boolean().optional().describe('true = every memory in every scope, not only the ones for this session.') },
  async (args) => callMemory('list', args, formatMemoryList),
);

server.tool(
  'memory_get',
  'Read one memory in full, body included (the why and the how behind the one-line description).',
  { name: z.string().describe('The memory name') },
  async (args) => callMemory('get', args, formatMemoryDetail),
);

server.tool(
  'memory_delete',
  'Delete one of the user\'s memories — when the user retires a rule, or a memory turns out to be wrong. To change a memory, memory_save it under the same name instead.',
  { name: z.string().describe('The memory name') },
  async (args) => callMemory('delete', args, formatDeleteAck),
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Reminders: the agent-callable face on the bridge's durable /timer store
// (lib/reminder-tools.js). Same shape as callItems.
async function callReminders(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/reminders/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: `reminder_${name} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}

server.tool(
  'reminder_create',
  "Schedule a durable reminder to yourself: at the fire time the bridge delivers `text` into THIS conversation as a new turn (⏰ Reminder #N …), resuming the session if it was reaped. Unlike CronCreate / ScheduleWakeup, which live in this process and die at the bridge's idle reap (~1 h), on a restart, and when this dev box idle-stops, a reminder is persisted by the bridge, re-armed after a restart, and known to the host: the box may go to sleep meanwhile and is started again a few minutes before the reminder fires. Use this for anything further out than about an hour. The user sees a card with Send-now / Cancel buttons. Pass exactly one of `in` or `at`. For standing check-ins (a morning and an evening sweep, say) pass `at` with `repeat: \"daily\"` and a `tz` such as \"Europe/London\": it fires at that wall-clock time every day, 08:00 staying 08:00 across the clock changes, and keeps its number until reminder_cancel ends it — set it once, never re-create it after each fire. A turn in progress or a background job you started that is still running already holds this session and this box awake (up to 8 hours from your last output), so a reminder is not needed for that. Set hold_awake: true ONLY when the work between now and then must not be interrupted across quiet gaps between turns (a watch, a long download you are not a parent of): it keeps this box from idle-stopping and this session from being reaped until the reminder fires, which costs shared host memory for every hour of it.",
  {
    text: z.string().min(1).max(2000).describe('What to tell yourself when it fires — write it for your future self, with enough context to act on'),
    in: z.string().optional().describe('Delay: 30s, 45m, 2h, 1d, 1h30m (5 s to 7 d)'),
    at: z.string().optional().describe("Clock time on this box (or in `tz`): 09:00, 14:30, 9pm, 12:10am — the next occurrence"),
    // Plain strings, not an enum: the bridge's own validation words the
    // rejection (lib/reminder-tools.js), which zod's would not.
    repeat: z.string().optional().describe('"daily" to fire at `at` every day until cancelled. Needs `at`; not with `in` or hold_awake.'),
    tz: z.string().optional().describe('IANA time zone for `at`, e.g. "Europe/London". Default: this box\'s own zone.'),
    hold_awake: z.boolean().optional().describe('Keep this box awake and this session un-reaped until it fires. Default false: the box may sleep and is woken for it. Not with repeat.'),
  },
  async (args) => callReminders('create', args, (d) => `Reminder set: ${formatReminderLine(d.reminder)}${d.reminder.hold_awake ? ' — the box stays awake until then.' : d.reminder.repeat ? ' — it repeats every day until reminder_cancel; the box may sleep and will be woken for each one.' : ' — the box may sleep and will be woken for it.'}`),
);

server.tool(
  'reminder_list',
  "List the pending reminders for this conversation — yours and any the user set with /timer.",
  {},
  async (args) => callReminders('list', args, (d) => d.reminders.length ? d.reminders.map(formatReminderLine).join('\n') : 'No reminders pending in this conversation.'),
);

server.tool(
  'reminder_cancel',
  "Cancel a pending reminder in this conversation by its number, or 'all' of them.",
  { id: z.union([z.number().int(), z.literal('all')]).describe("Reminder number from reminder_list / the create result, or 'all'") },
  async (args) => callReminders('cancel', args, (d) => `Cancelled ${d.cancelled.length === 1 ? 'reminder' : `${d.cancelled.length} reminders`}: ${d.cancelled.map(formatReminderLine).join('; ')}`),
);
