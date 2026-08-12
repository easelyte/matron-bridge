#!/usr/bin/env node

// MCP server providing secure-input tools: request_secret, share_sensitive_data, redact_message.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatBox } from './lib/agent-boxes-format.js';

// Route to whichever bridge spawned us: explicit BRIDGE_API_URL wins, else the
// per-session MATRON_BRIDGE_API_PORT exported by the bridge at spawn (journal=9812,
// old Matrix bridge=9802), else the legacy default. Prevents the inbound-secret
// flow from posting to the wrong bridge process after the journal cutover (loop #504/#549).
const BRIDGE_API = process.env.BRIDGE_API_URL
  || (process.env.MATRON_BRIDGE_API_PORT && `http://127.0.0.1:${process.env.MATRON_BRIDGE_API_PORT}`)
  || 'http://127.0.0.1:9802';
const ROOM_ID = process.env.BRIDGE_ROOM_ID || null;
const POLL_INTERVAL_MS = 500;
const SECRET_TIMEOUT_MS = 300000;    // 5 min max wait for secret submission

const server = new McpServer({
  name: 'ask-user',
  version: '1.0.0',
});

server.tool(
  'request_secret',
  'Request a secret from the user via a secure web form. The secret is written to a file and the file path is returned. Use this for API keys, tokens, passwords — anything that should not appear in chat.',
  {
    label: z.string().describe('A short label describing what secret is needed, e.g. "AWS access key" or "database password"'),
  },
  async ({ label }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, roomId: ROOM_ID }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error requesting secret: ${err}` }] };
      }

      const { secretId } = await postRes.json();

      // Poll for the secret to be submitted
      const deadline = Date.now() + SECRET_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const pollRes = await fetch(`${BRIDGE_API}/secret/${secretId}`);
        if (!pollRes.ok) continue;

        const data = await pollRes.json();
        if (data.answered) {
          return { content: [{ type: 'text', text: `Secret written to: ${data.path}` }] };
        }
      }

      return { content: [{ type: 'text', text: 'Secret request timed out — no input received within 5 minutes.' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
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
  return `Room ${body.room_id}: ${body.status || body.error || 'unknown'}${body.reason ? ` — ${body.reason}` : ''}${body.note ? `. ${body.note}` : ''}`;
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
  "List this user's other agent sessions (boxes, conversation titles, states, rolling summaries) so you can pick a target for agent_chat_start. Excludes yourself.",
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
        .map((c) => {
          // Rows owned by this bridge are listed but are NOT valid
          // agent_chat_start targets (the bridge rejects self-targets).
          const agent = c.agent_device_id == null ? ' (no agent)'
            : (mine != null && c.agent_device_id === mine) ? ' (this bridge — not targetable)'
              : ` (agent ${c.agent_device_id})`;
          const summary = c.summary ? `: ${String(c.summary).slice(0, 200)}` : '';
          return `- ${c.id} — "${c.title || 'untitled'}" [${c.session_state || 'unknown'}]${agent}${summary}`;
        });
      const agents = (data.agents || []).map((a) => `- device ${a.device_id}: ${a.name}`);
      const self = data.self ? `You are "${data.self.name}" (device ${data.self.device_id}).` : 'Your own identity is unknown.';
      return { content: [{ type: 'text', text: `${self}\nOther agents:\n${agents.join('\n') || '- none'}\nConversations:\n${convos.join('\n') || '- none'}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_chat_start',
  "Start a chat room with one of the user's other agent sessions: pick a target conversation from agent_roster, and the bridge invites its agent. If the result is pending or pending_busy, do NOT wait or poll: continue your own work — the answer and any replies arrive automatically as later turns.",
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
  "List the user's other agent boxes (machines) as spawn targets, with recent folders, current activity, and account usage limits. Use this when the user asks to run work on another machine or to find a box with spare capacity: prefer a box whose usage percentages are low and whose activity shows few or no recent sessions. Data may be minutes old; offline boxes cannot be spawned on.",
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
      if (!boxes.length) return { content: [{ type: 'text', text: 'No other boxes found.' }] };
      return { content: [{ type: 'text', text: boxes.map(formatBox).join('\n\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  'agent_session_start',
  "Ask the user's consent to start a new agent session on another of their boxes, seeded with a task. If the user has not already said which box and directory the work should happen in, ask them before calling this — they usually have a preference, and the consent card can only be approved or declined, it cannot be corrected. The result is pending: do NOT wait or poll — the user's decision and the spawn outcome arrive automatically as later turns. On approval a chat room links you to the new session; its reports arrive there.",
  {
    device_id: z.number().int().describe('Target box device id, from agent_boxes'),
    workdir: z.string().describe('Absolute working directory on the target box, from agent_boxes folders'),
    task: z.string().max(2000).describe('The task prompt. Shown VERBATIM on the user\'s consent card and executed verbatim as the new session\'s first turn — write it for both audiences.'),
    topic: z.string().max(200).optional().describe('Optional short room/session title'),
  },
  async ({ device_id, workdir, task, topic }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-session-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, device_id, workdir, task, ...(topic ? { topic } : {}) }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_session_start failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: `Spawn request ${data.spawn_id} sent — awaiting the user's approval. Continue your own work; the outcome will arrive as a later turn.` }] };
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
  'Answer a chat request another agent sent you: accept it and join the room.',
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
  'Answer a chat request another agent sent you: refuse it. The reason is relayed to the caller.',
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

server.tool(
  'agent_chat_leave',
  'Leave an agent chat room. The room and its history remain visible to your user.',
  {
    room_id: z.string().describe('The room id to leave'),
  },
  async ({ room_id }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/agent-chat-leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM_ID, room_id }),
      });
      const data = await postRes.json().catch(() => ({}));
      if (!postRes.ok) {
        return { content: [{ type: 'text', text: `agent_chat_leave failed: ${data.error || `HTTP ${postRes.status}`}` }] };
      }
      return { content: [{ type: 'text', text: `Left room ${room_id}.` }] };
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

const transport = new StdioServerTransport();
await server.connect(transport);
