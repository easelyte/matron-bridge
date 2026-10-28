// Loopback handlers behind the consent_list / consent_decide MCP tools
// (spec docs/superpowers/specs/2026-09-29-coordinator-consent-design.md):
// the Coordinator lists the user's parked chat, spawn and file transfer
// asks and answers them on the user's behalf. Same {status, body} contract as
// lib/missions-tools.js; index.js mounts them with respondAgentChatRoute.
// The journal is the gate (Coordinator only, the off switch, the daily
// cap, no spawn into an offline box); this layer refuses a non-Coordinator
// session first with the clearer sentence, and renders the journal's
// answers as sentences the model can act on. Every string in a pending ask
// is another agent's — peer text, one-lined and capped before it lands in
// a tool result.
import { peerField } from './peer-text.js';
import { humanSize } from './transfer-receiver.js';

const NOT_COORDINATOR = "only the Coordinator may answer consent asks on the user's behalf — this conversation is not the Coordinator";
const REASON_MAX = 200;
const NAME_MAX = 80;
const TEXT_MAX = 300;
const ID_MAX = 128;

export const CONSENT_FRAME_KIND = 'consent';

const bad = (error) => ({ status: 400, body: { error } });

// The journal's refusals of an approval of the Coordinator's OWN ask (one
// whose turn the bridge could not tie to the user's words or tap, or to a
// routine fire within that routine's envelope). The journal answers
// {error: 'forbidden'|'conflict', detail: <code>, why?, cap?}.
const OWN_ASK_CODES = new Set(['own_ask_unverified', 'envelope', 'verifier', 'verifier_unavailable', 'routine_cap']);
const WHY_MAX = 300;

function formatOwnAskRefusal(data, detail, askKind = null) {
  if (!OWN_ASK_CODES.has(detail)) return null;
  const kind = detail;
  const why = peerField(data?.why, WHY_MAX);
  const paren = (text) => (text ? ` (${text})` : '');
  // A file from work the Coordinator relayed is the user's only while their
  // "Let the Coordinator approve file transfers" switch is off.
  if (kind === 'own_ask_unverified' && askKind === 'transfer' && why.includes('Coordinator file approvals are off')) {
    return 'this file comes from work you relayed (a carry-on, room message or spawn of yours), and the user has not switched on "Let the Coordinator approve file transfers" — leave it for the user';
  }
  if (kind === 'own_ask_unverified' && askKind === 'transfer') return `a file your own session sends needs the user's own approval${paren(why && `why: ${why}`)} — leave it for the user`;
  // A request another session made in a turn the Coordinator's carry-on,
  // room message or spawn reached is held to the same rule; the journal's
  // why says so.
  if (kind === 'own_ask_unverified' && why.startsWith('relayed from the Coordinator')) {
    return `this request comes from your own carry-on, room message or spawn, and the journal cannot tie that to the user's words or a routine fire${paren(`why: ${why}`)} — leave it for the user`;
  }
  if (kind === 'own_ask_unverified') return `the journal cannot tie your own request to the user's words or a routine fire${paren(why && `why: ${why}`)} — leave it for the user`;
  if (kind === 'envelope') return `this request is outside the routine's envelope${paren(why)} — leave it for the user or ask the user to widen the envelope`;
  if (kind === 'verifier') return `the verifier judged this request outside the routine's remit${paren(why)} — leave it for the user`;
  if (kind === 'verifier_unavailable') return 'the verifier could not run — the ask stays for the user';
  const cap = Number(data?.cap) || '?';
  return `routine-born approvals are at today's cap (${cap}) — the ask stays for the user`;
}

export function formatJournalConsentError(data, { decision = null, kind = null } = {}) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  const ownAsk = formatOwnAskRefusal(data, detail, kind);
  if (ownAsk) return ownAsk;
  if (code === 'forbidden' && detail === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden' && detail === 'consent_disabled') return 'the user has switched off "Let the Coordinator approve chats and spawns" — leave this ask for them and say so in one line';
  if (code === 'forbidden' && detail === 'secret_scan_flagged') return "the sender's secret scan flagged this file, so only the user may approve it — leave it for them and say so in one line (a decline with a reason is still allowed)";
  if (code === 'forbidden' && detail === 'user_only') return 'this ask involves a box only the user may approve for, so only the user may approve it — leave it for them (a decline with a reason is still allowed)';
  if (code === 'forbidden') return 'the journal refused: this session may not answer consent asks';
  if (code === 'conflict' && detail === 'daily_cap' && kind === 'transfer') return `the daily cap on Coordinator file approvals is reached (${Number(data?.cap) || '?'} in 24 h) — the file stays for the user; tell them in one line`;
  if (code === 'conflict' && detail === 'daily_cap') return `the daily cap on Coordinator approvals is reached (${Number(data?.cap) || '?'} in 24 h) — the ask stays for the user; tell them in one line`;
  if (code === 'conflict' && detail === 'target_offline') return 'the target box is offline and cannot be woken from here — leave this ask for the user (a decline with a reason is still allowed)';
  if (code === 'conflict') return `this ask is no longer waiting — it was already ${decision === 'decline' ? 'answered' : 'answered or has expired'}; consent_list shows what is still pending`;
  if (code === 'not_found') return 'no such ask — the id is wrong or the ask has gone; consent_list shows what is still pending';
  if (code === 'bad_request') return 'the journal rejected it — kind is chat, spawn or transfer, id comes from consent_list, decision is approve or decline, reason is 1–200 characters';
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

// What started the turn the asker made the ask in, as its bridge stamped
// it (the journal shows `causes` on a pending row when there are any): one
// line per cause, none when the row has none, so an older journal's rows
// render as before.
const CAUSE_KIND_MAX = 32;
function causeLines(causes) {
  if (!Array.isArray(causes)) return [];
  return causes
    .map((c) => ({ kind: peerField(c?.kind, CAUSE_KIND_MAX), ref: peerField(c?.ref, ID_MAX * 2) }))
    .filter((c) => c.kind)
    .map((c) => `  started by: ${c.kind}${c.ref ? ` ${c.ref}` : ''}`);
}

// One ask, several lines: what, who, where it goes, the words to judge it
// by, what started the asker's turn, and the exact consent_decide call. The
// box's state is what the Coordinator's rules turn on (never an offline box).
export function formatPendingAsk(ask, { now = Date.now() } = {}) {
  const id = peerField(ask?.id, ID_MAX) || 'unknown';
  const from = peerField(ask?.from_name, NAME_MAX) || 'another agent';
  const fromConvo = peerField(ask?.from_convo_title, NAME_MAX);
  const fromConvoId = peerField(ask?.from_convo_id, ID_MAX);
  const state = peerField(ask?.target_state, 16) || 'unknown';
  const when = age(ask?.created_at, now);
  const item = Number.isInteger(ask?.item_num) ? ` (tracker #${ask.item_num})` : '';
  const asker = `${from}${fromConvo ? ` — session "${fromConvo}"` : ''}${fromConvoId ? ` [${fromConvoId}]` : ''}`;
  if (ask?.kind === 'transfer') return formatTransferAsk(ask, { id, asker, from, when, item });
  if (ask?.kind === 'spawn') {
    const target = peerField(ask?.target_name, NAME_MAX) || `device ${peerField(ask?.target_device_id, ID_MAX) || '?'}`;
    const lines = [
      `spawn ${id}${item} — ${when}: ${asker} asks to start a session on ${target} (box ${state})`,
      `  directory: ${peerField(ask?.workdir, TEXT_MAX) || '?'}${ask?.model ? ` · model: ${peerField(ask.model, 64)}` : ask?.fallback_reason === 'fable_limit' && peerField(ask?.fallback_model, 64) ? ` · model: ${peerField(ask.fallback_model, 64)} — the box is at its Fable weekly limit` : ''}${ask?.mission_num ? ` · joins mission #${Number(ask.mission_num)}` : ''}${ask?.link ? ' · opens a chat room back to the asker' : ''}`,
      `  task: ${peerField(ask?.task, TEXT_MAX) || '(none)'}`,
      ...causeLines(ask?.causes),
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
    ...causeLines(ask?.causes),
    `  consent_decide(kind: "chat", id: "${id}", decision: approve|decline, reason: …)`,
  ].join('\n');
}

// A file another session wants to send into a room. The journal refuses the
// Coordinator's approval of a flagged one, so its decide line offers only
// a decline.
const FINDINGS_SHOWN = 10;
function scanText(ask) {
  if (ask?.scan_verdict === 'clean') return 'clean';
  if (ask?.scan_verdict === 'flagged') {
    const findings = Array.isArray(ask?.scan_findings) ? ask.scan_findings : [];
    const shown = findings.slice(0, FINDINGS_SHOWN).map((f) => {
      const kind = peerField(f?.kind, 40) || 'secret';
      const line = typeof f?.line === 'number' ? `line ${f.line}` : peerField(f?.line, 80);
      return line ? `${kind} (${line})` : kind;
    });
    const more = findings.length > FINDINGS_SHOWN ? `, and ${findings.length - FINDINGS_SHOWN} more` : '';
    return `flagged — ${findings.length} possible secret${findings.length === 1 ? '' : 's'}${shown.length ? `: ${shown.join(', ')}${more}` : ''}`;
  }
  return 'not scanned (binary or unsupported format)';
}

function formatTransferAsk(ask, { id, asker, from, when, item }) {
  const room = peerField(ask?.room_title, NAME_MAX) || peerField(ask?.room_id, ID_MAX) || '?';
  const toNames = (Array.isArray(ask?.to_names) ? ask.to_names : []).map((n) => peerField(n, NAME_MAX)).filter(Boolean);
  const to = toNames.length ? `to ${toNames.join(', ')}` : 'to no other box yet';
  const size = Number.isSafeInteger(ask?.size) && ask.size >= 0 ? `${humanSize(ask.size)} (${ask.size} bytes)` : 'size unknown';
  const sha = typeof ask?.sha256 === 'string' && /^[0-9a-f]{12}/.test(ask.sha256) ? ` · sha256 ${ask.sha256.slice(0, 12)}…` : '';
  const note = peerField(ask?.reason, TEXT_MAX);
  const flagged = ask?.scan_verdict === 'flagged';
  const userOnly = ask?.user_only === true;
  return [
    `transfer ${id}${item} — ${when}: ${asker} asks to send a file into room "${room}", ${to}`,
    `  file: ${peerField(ask?.name, TEXT_MAX) || '?'} · ${size}${sha}`,
    `  secret scan: ${scanText(ask)}`,
    note ? `  note, in ${from}'s words: ${note}` : '  note: (none) — never approve a transfer whose note does not explain it',
    ...causeLines(ask?.causes),
    ...(flagged ? ['  flagged transfers cannot be approved by the Coordinator — leave it for the user, or decline with a reason'] : []),
    ...(userOnly ? ['  only the user can approve this one: a box it involves is one only the user approves for — leave it for them, or decline with a reason'] : []),
    `  consent_decide(kind: "transfer", id: "${id}", decision: ${flagged || userOnly ? 'decline' : 'approve|decline'}, reason: …)`,
  ].join('\n');
}

export function formatPendingList(data, { now = Date.now() } = {}) {
  const asks = Array.isArray(data?.pending) ? data.pending : [];
  if (!asks.length) return 'No chat, spawn or file transfer requests are waiting for approval.';
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
  if (kind === 'transfer') {
    if (decision === 'decline') return `Declined file transfer ${id} on the user's behalf — the journal deletes the file and tells the sender. The card records your reason.`;
    return `Approved file transfer ${id} on the user's behalf — the file goes to the room once its upload is complete; the receiving session is told where it was saved. The card records your reason.`;
  }
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
      const kind = data.kind === 'chat' || data.kind === 'spawn' || data.kind === 'transfer' ? data.kind : null;
      if (!kind) return bad("kind must be 'chat', 'spawn' or 'transfer' — as consent_list shows it");
      const id = typeof data.id === 'string' && data.id.trim() && data.id.length <= ID_MAX ? data.id.trim() : null;
      if (!id) return bad('id is required — the ask id from consent_list');
      const decision = data.decision === 'approve' || data.decision === 'decline' ? data.decision : null;
      if (!decision) return bad("decision must be 'approve' or 'decline'");
      const reason = typeof data.reason === 'string' ? data.reason.replace(/\s+/g, ' ').trim() : '';
      if (!reason || reason.length > REASON_MAX) return bad(`reason is required (1–${REASON_MAX} characters) — it is shown to the user on the card and in the tracker`);
      return passthrough(await client.answer({ convo_id: convoId, kind, id, decision, reason }), { decision, kind });
    },
    _now: now,
  };
}
