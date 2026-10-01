// Loopback handlers behind the consent_list / consent_decide MCP tools
// (spec docs/superpowers/specs/2026-09-29-coordinator-consent-design.md):
// the Coordinator lists the user's parked chat and spawn asks and answers
// them on the user's behalf. Same {status, body} contract as
// lib/missions-tools.js; index.js mounts them with respondAgentChatRoute.
// The journal is the gate (Coordinator only, the off switch, the daily
// cap, no spawn into an offline box); this layer refuses a non-Coordinator
// session first with the clearer sentence, and renders the journal's
// answers as sentences the model can act on. Every string in a pending ask
// is another agent's — peer text, one-lined and capped before it lands in
// a tool result.
import { peerField } from './peer-text.js';

const NOT_COORDINATOR = "only the Coordinator may approve chats and spawns on the user's behalf — this conversation is not the Coordinator";
const REASON_MAX = 200;
const NAME_MAX = 80;
const TEXT_MAX = 300;
const ID_MAX = 128;

export const CONSENT_FRAME_KIND = 'consent';

const bad = (error) => ({ status: 400, body: { error } });

export function formatJournalConsentError(data, { decision = null } = {}) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  if (code === 'forbidden' && detail === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden' && detail === 'consent_disabled') return 'the user has switched off "Let the Coordinator approve chats and spawns" — leave this ask for them and say so in one line';
  if (code === 'forbidden') return 'the journal refused: this session may not answer consent asks';
  if (code === 'conflict' && detail === 'daily_cap') return `the daily cap on Coordinator approvals is reached (${Number(data?.cap) || '?'} in 24 h) — the ask stays for the user; tell them in one line`;
  if (code === 'conflict' && detail === 'target_offline') return 'the target box is offline and cannot be woken from here — leave this ask for the user (a decline with a reason is still allowed)';
  if (code === 'conflict') return `this ask is no longer waiting — it was already ${decision === 'decline' ? 'answered' : 'answered or has expired'}; consent_list shows what is still pending`;
  if (code === 'not_found') return 'no such ask — the id is wrong or the ask has gone; consent_list shows what is still pending';
  if (code === 'bad_request') return 'the journal rejected it — kind is chat or spawn, id comes from consent_list, decision is approve or decline, reason is 1–200 characters';
  if (code === 'journal unreachable') return 'journal unreachable';
  return code || 'unknown error';
}

const age = (createdAt, now) => {
  const ms = now - Number(createdAt || now);
  if (!(ms > 0)) return 'just now';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

// One ask, several lines: what, who, where it goes, the words to judge it
// by, and the exact consent_decide call. The box's state is what the
// Coordinator's rules turn on (never an offline box).
export function formatPendingAsk(ask, { now = Date.now() } = {}) {
  const id = peerField(ask?.id, ID_MAX) || 'unknown';
  const from = peerField(ask?.from_name, NAME_MAX) || 'another agent';
  const fromConvo = peerField(ask?.from_convo_title, NAME_MAX);
  const fromConvoId = peerField(ask?.from_convo_id, ID_MAX);
  const state = peerField(ask?.target_state, 16) || 'unknown';
  const when = age(ask?.created_at, now);
  const item = Number.isInteger(ask?.item_num) ? ` (tracker #${ask.item_num})` : '';
  const asker = `${from}${fromConvo ? ` — session "${fromConvo}"` : ''}${fromConvoId ? ` [${fromConvoId}]` : ''}`;
  if (ask?.kind === 'spawn') {
    const target = peerField(ask?.target_name, NAME_MAX) || `device ${peerField(ask?.target_device_id, ID_MAX) || '?'}`;
    const lines = [
      `spawn ${id}${item} — ${when}: ${asker} asks to start a session on ${target} (box ${state})`,
      `  directory: ${peerField(ask?.workdir, TEXT_MAX) || '?'}${ask?.model ? ` · model: ${peerField(ask.model, 64)}` : ''}${ask?.mission_num ? ` · joins mission #${Number(ask.mission_num)}` : ''}${ask?.link ? ' · opens a chat room back to the asker' : ''}`,
      `  task: ${peerField(ask?.task, TEXT_MAX) || '(none)'}`,
      `  consent_decide(kind: "spawn", id: "${id}", decision: approve|decline, reason: …)`,
    ];
    return lines.join('\n');
  }
  const to = peerField(ask?.to_name, NAME_MAX) || `device ${peerField(ask?.to_device_id, ID_MAX) || '?'}`;
  const toConvo = peerField(ask?.to_convo_title, NAME_MAX);
  const topic = peerField(ask?.topic, NAME_MAX);
  const what = ask?.request === 'join'
    ? `asks to join ${to}'s room "${peerField(ask?.room_title, NAME_MAX) || peerField(ask?.room_id, ID_MAX) || '?'}"`
    : `asks to chat with ${to}${toConvo ? ` — session "${toConvo}"` : ''}${topic ? ` about "${topic}"` : ''}`;
  return [
    `chat ${id}${item} — ${when}: ${asker} ${what} (box ${state})`,
    `  why, in ${from}'s words: ${peerField(ask?.justification, TEXT_MAX) || '(none)'}`,
    `  consent_decide(kind: "chat", id: "${id}", decision: approve|decline, reason: …)`,
  ].join('\n');
}

export function formatPendingList(data, { now = Date.now() } = {}) {
  const asks = Array.isArray(data?.pending) ? data.pending : [];
  if (!asks.length) return 'No chat or spawn requests are waiting for approval.';
  const head = `${asks.length} request${asks.length === 1 ? '' : 's'} waiting for the user's approval (oldest first). Approve only what follows the rules in your instructions; give a reason every time; leave the rest for the user.`;
  return [head, ...asks.map((a) => formatPendingAsk(a, { now }))].join('\n\n');
}

// The turn the Coordinator gets when the journal nudges it about another
// agent's ask (the {kind:'consent', event:'pending'} frame). Names the ask
// and the tools; never the decision.
export function formatConsentNudge(frame, { now = Date.now() } = {}) {
  const ask = frame?.ask;
  if (!ask || typeof ask !== 'object') return null;
  return `🤝 A consent request is waiting for the user: \n${formatPendingAsk(ask, { now })}\nThe user has the card too and may answer first. Decide with consent_decide if it follows your rules and give your reason; otherwise leave it, or decline with a reason. Say in one line what you did.`;
}

export function formatDecideAck(data, { kind, decision, id }) {
  const what = kind === 'spawn' ? 'spawn request' : 'chat request';
  if (decision === 'decline') return `Declined ${what} ${id} on the user's behalf. The card and its tracker item record your reason.`;
  if (kind === 'spawn') return `Approved ${what} ${id} on the user's behalf — the session is being started (the box is woken first if it was asleep); the outcome reaches the asking session as a turn. The card and its tracker item record your reason.`;
  const delivered = data?.delivered === true ? 'the invitation was delivered to the target box' : 'the target box is being woken and gets the invitation when it connects';
  return `Approved ${what} ${id} on the user's behalf — ${delivered}. The card and its tracker item record your reason.`;
}

// `isCoordinator(session, convoId)` decides the local refusal. The default
// is the session's spawn-time flag; index.js passes one that also asks the
// journal's current role holder (coordinatorLookup), because the flag stays
// false on a session that gained the role live, until it respawns, and true
// on one that lost it (Bugbot) — the nudge already resolves the role that
// way, and the journal is the real gate either way.
export function createConsentHandlers({ sessions, journalConvoIdFor, client, isCoordinator = (session) => session?.coordinator === true, now = () => Date.now() }) {
  function caller(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!isCoordinator(session, convoId)) return { err: { status: 403, body: { error: NOT_COORDINATOR } } };
    if (!convoId) return { err: { status: 409, body: { error: 'this session has no journal conversation yet' } } };
    return { session, convoId };
  }
  const passthrough = (r, opts) => {
    if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
    if (r.status >= 400) return { status: r.status, body: { ...r.data, error: formatJournalConsentError(r.data, opts) } };
    return { status: r.status, body: r.data };
  };

  return {
    async list(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const r = passthrough(await client.pending(convoId));
      if (r.status === 404) return { status: 404, body: { error: 'this journal has no /consent routes yet — deploy the journal update (matron-journal coordinator consent)' } };
      return r;
    },
    async decide(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const kind = data.kind === 'chat' || data.kind === 'spawn' ? data.kind : null;
      if (!kind) return bad("kind must be 'chat' or 'spawn' — as consent_list shows it");
      const id = typeof data.id === 'string' && data.id.trim() && data.id.length <= ID_MAX ? data.id.trim() : null;
      if (!id) return bad('id is required — the ask id from consent_list');
      const decision = data.decision === 'approve' || data.decision === 'decline' ? data.decision : null;
      if (!decision) return bad("decision must be 'approve' or 'decline'");
      const reason = typeof data.reason === 'string' ? data.reason.replace(/\s+/g, ' ').trim() : '';
      if (!reason || reason.length > REASON_MAX) return bad(`reason is required (1–${REASON_MAX} characters) — it is shown to the user on the card and in the tracker`);
      return passthrough(await client.answer({ convo_id: convoId, kind, id, decision, reason }), { decision });
    },
    _now: now,
  };
}
