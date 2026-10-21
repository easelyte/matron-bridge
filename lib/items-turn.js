// Inbound side of the task & decision tracker (spec: 2026-09-08
// task-decision-tracker, "Routing"). A user-authored `item` marker on a
// conversation this bridge owns becomes ONE synthetic user turn, so the agent
// hears the answer to its question without polling item_list. Everything
// I/O-shaped is injected (same discipline as lib/journal-media.js), so this
// module is unit-testable without a journal server, whisper, or a session.
//
// Contract: the returned routeItemToSession never throws or rejects — the
// journal input consumer calls it fire-and-forget, and its own try/catch is
// synchronous and cannot observe an async rejection. Every failure degrades to
// a less complete turn (a transcript line that says so, a title-only created
// turn), never to a lost one and never to a thrown error.

// Marker actions that DO produce a turn. An allowlist, not a denylist of the
// silent ones (`reordered` is pure backlog housekeeping, `updated` is a field
// edit — neither is the user saying something to the agent): a newer journal
// will grow actions this build has never heard of, and the safe default for an
// unknown one is silence, not a turn interrupting the agent with a marker
// nobody here knows how to render.
const TURN_ACTIONS = new Set(['created', 'commented', 'closed', 'reopened']);

// Substituted for an audio attachment's transcript when transcription could
// not produce one. It reads as the attachment line's text, and it is also what
// tells formatItemTurn to render the failure rather than a "no transcript yet"
// line — the marker's own `transcript: null` means "nobody has tried".
const TRANSCRIPTION_FAILED = '(transcription failed)';

// What the user is told when the turn could not be handed to a session. One
// string, one meaning: the reply is safe in the journal, it just didn't reach
// the agent — so it reads the same whether inject refused or the route threw.
const UNDELIVERABLE = "Couldn't deliver your item reply — the session isn't available.";

// The tracker's item kinds. A marker from a newer journal carrying a kind this
// build has never heard of still has to read as English — "filed a new item
// #13" beats "filed a new undefined #13" — so anything off the list degrades
// to the neutral word rather than being interpolated raw.
const KINDS = new Set(['task', 'question', 'decision', 'notice']);
const kindOf = (p) => (KINDS.has(p?.kind) ? p.kind : 'item');

const trailer = (p) => `(${kindOf(p)}, now awaiting: ${p.awaiting ?? 'nobody'}. `
  + `item_get ${p.item_id} for the full thread; item_close when acted on.)`;

// Is this payload shaped like something we can render? Exported because the
// journal input router needs the SAME rule to decide whether an item marker
// may auto-resume a reaped session (spec: a reply "wakes the box if asleep") —
// a reorder, a field edit, an action this build doesn't know or a malformed
// marker must never respawn a session for a turn that would then be thrown
// away. Also checked here before any I/O, so such a marker costs no blob fetch
// and no journal round trip.
export function isTurnWorthy(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.item_id !== 'string' || !payload.item_id) return false;
  if (!Number.isInteger(payload.num) || typeof payload.title !== 'string') return false;
  // The user tapping Seen on a notice: the journal closes it and says so with
  // `seen: true`. That is the user acknowledging an FYI, not saying anything
  // to the agent, so it stays silent — and, through the router's use of this
  // same rule, never wakes a reaped session either.
  if (payload.action === 'closed' && payload.seen === true) return false;
  return TURN_ACTIONS.has(payload.action) || isTranscriptionFollowUp(payload) || isHandoverMarker(payload);
}

// Item handover (journal: "Item handover"). The journal tells each stage of a
// handover to the sessions concerned with a quiet `updated` marker, sender
// `journal`, carrying `handover: {stage, from_convo_id, to_convo_id, ...}`.
// The router accepts these from the journal only (an agent can never publish
// an item marker); which side this conversation is on decides the wording.
const HANDOVER_STAGES = new Set(['offered', 'approved', 'accepted', 'declined', 'withdrawn', 'refused', 'expired']);
export function isHandoverMarker(p) {
  return p?.action === 'updated' && !!p.handover && typeof p.handover === 'object'
    && HANDOVER_STAGES.has(p.handover.stage)
    && typeof p.handover.from_convo_id === 'string' && typeof p.handover.to_convo_id === 'string';
}

// An agent session commenting on an item another conversation owns. The
// journal marks it `agent_comment: true` with the commenter's convo id and
// title; the sender stays `agent:<device>`, which the router otherwise drops
// as bridge echo. This is the one agent-sender item marker it lets through,
// and only for the owner: never the commenter's own conversation.
export function isAgentCommentMarker(p, viewerConvoId) {
  if (!p || p.agent_comment !== true || p.action !== 'commented') return false;
  if (typeof p.from_convo_id !== 'string' || !p.from_convo_id || p.from_convo_id === viewerConvoId) return false;
  if (typeof p.origin_convo_id === 'string' && p.origin_convo_id !== viewerConvoId) return false;
  return true;
}

// payload -> the turn for this conversation's side of the handover, or null
// when this side has nothing to hear (the target that just accepted, say).
export function formatHandoverTurn(p, { convoId = null } = {}) {
  if (!isHandoverMarker(p)) return null;
  const h = p.handover;
  const side = convoId === h.to_convo_id ? 'to' : convoId === h.from_convo_id ? 'from'
    : (convoId && convoId === h.offered_by_convo_id) ? 'offerer' : null;
  if (!side) return null;
  const head = `#${p.num} "${oneLine(p.title)}"`;
  const from = oneLine(h.from_label || h.from_convo_id);
  const to = oneLine(h.to_label || h.to_convo_id);
  const note = typeof h.note === 'string' && h.note.trim() ? ` Note: ${oneLine(h.note)}` : '';
  const reason = typeof h.reason === 'string' && h.reason.trim() ? ` Reason: ${oneLine(h.reason).replace(/[.!?]?$/, '.')}` : '';
  const by = h.offered_by === 'coordinator' ? ' (offered by the Coordinator on the user\'s behalf)'
    : h.offered_by === 'user' ? ' (offered by the user)' : '';
  const get = `item_get ${p.item_id} for the full thread.`;
  // The conversation that made the offer for somebody else's item (the
  // Coordinator) hears how it ended.
  if (side === 'offerer') {
    const yours = `the offer you made of item ${head} to ${to}`;
    switch (h.stage) {
      case 'approved': return `📌 Handover: the user approved ${yours}. It is with ${to} to accept.`;
      case 'accepted': return `📌 Handover done: ${to} accepted ${yours}. The user's replies on it now go there.`;
      case 'declined': return `📌 Handover declined: ${to} turned down ${yours}.${reason} It stays with ${from}.`;
      case 'refused': return `📌 Handover refused: the user tapped "Keep it here" on ${yours}. It stays with ${from}.`;
      case 'expired': return `📌 Handover expired: ${yours} got no answer within 24 h. It stays with ${from}.`;
      case 'withdrawn':
        if (h.by === h.offered_by) return null;
        return `📌 Handover withdrawn: ${yours} was taken back${h.by === 'closed' ? ' when the item was closed' : h.by === 'owner' ? ` by ${from}` : h.by === 'user' ? ' by the user' : ''}.${reason} It stays with ${from}.`;
      default: return null;
    }
  }
  if (side === 'to') {
    switch (h.stage) {
      case 'offered':
        return `📌 Handover offer: item ${head} — ${from} offers it to you${by}.${note}\n`
          + `If it is work this conversation should take on under your rules, call item_accept ${p.item_id}: from then on the user's replies and taps on it come here. `
          + `If not, call item_decline ${p.item_id} with a reason. Until you accept, it stays with ${from}. ${get}`;
      case 'withdrawn':
        return `📌 Handover offer withdrawn: item ${head} is not being handed to you any more, so don't act on it.${reason}`;
      case 'expired':
        return `📌 Handover offer expired: item ${head} was not handed to you (nobody accepted within 24 h). It stays with ${from}.`;
      default:
        return null;
    }
  }
  switch (h.stage) {
    case 'offered':
      // The owner made the offer itself: it already knows.
      return h.offered_by === 'owner' ? null
        : `📌 Handover: item ${head} has been offered to ${to}${by}.${note} It stays yours until ${to} accepts; carry on with it until then.`;
    case 'approved':
      return `📌 Handover: the user approved handing item ${head} to ${to}. It is with ${to} to accept; it stays yours until they do.`;
    case 'accepted':
      return `📌 Handover done: item ${head} now belongs to ${to}. The user's replies and taps on it go there, not here — stop working on it, and don't comment on it unless the user asks you to.`;
    case 'declined':
      return `📌 Handover declined: ${to} did not take item ${head}.${reason} It stays yours. ${get}`;
    case 'withdrawn': {
      // The owner taking back its own offer already knows.
      if (h.by === 'owner') return null;
      const who = h.by === 'coordinator' ? 'the Coordinator' : h.by === 'user' ? 'the user' : h.by === 'closed' ? 'closing the item' : null;
      return `📌 Handover withdrawn: the offer of item ${head} to ${to} was taken back${who ? ` by ${who}` : ''}.${reason} It stays yours.`;
    }
    case 'refused':
      return `📌 Handover refused: the user tapped "Keep it here", so item ${head} stays yours and was not offered to ${to}.`;
    case 'expired':
      return `📌 Handover expired: the offer of item ${head} to ${to} got no answer within 24 h. It stays yours.`;
    default:
      return null;
  }
}

// A journal with whisper of its own transcribes a voice note on upload. It
// announces the comment with `transcript_status:'pending'` on the audio, and
// when its job settles sends a second, quiet marker: `action:'updated'` with
// `transcription:'done'|'failed'`, `for_action` (the action the turn belongs
// to) and the comment again, transcripts filled in. The turn is held for that
// marker rather than sent wordless or transcribed twice. This is the ONE
// `updated` marker that is input; a plain field edit still is not.
export function isTranscriptionFollowUp(p) {
  return p?.action === 'updated'
    && (p.transcription === 'done' || p.transcription === 'failed')
    && TURN_ACTIONS.has(p.for_action)
    && typeof p.comment?.id === 'string' && !!p.comment.id;
}

const isAudio = (a) => typeof a?.mime === 'string' && a.mime.startsWith('audio/');
const hasWords = (a) => typeof a?.transcript === 'string' && !!a.transcript.trim();

// The comment id to hold the turn on, or null when nothing is pending (an
// older journal, a journal without whisper, a comment with no voice note).
function pendingCommentId(p) {
  const c = p?.comment;
  if (!c || typeof c.id !== 'string' || !c.id || !Array.isArray(c.attachments)) return null;
  return c.attachments.some((a) => isAudio(a) && a.transcript_status === 'pending' && !hasWords(a)) ? c.id : null;
}

// Everything below interpolates journal-sourced strings into prose the agent
// reads as ONE turn, where a line beginning with 📌 is structure. A title (or
// an attachment name) the user typed with a newline in it — "ship it\n📌 the
// user closed …" — would otherwise forge a second marker line. Collapse any
// run of whitespace, newlines included, to a single space.
const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();

// The label the user tapped, if this comment is a one-tap reply rather than
// typed prose (item-actions-contract: "Comment JSON exposes action (from
// meta)"). A journal a version behind may still carry it nested under meta.
function tappedLabel(comment) {
  if (!comment || typeof comment !== 'object') return null;
  if (typeof comment.action === 'string' && comment.action.trim()) return oneLine(comment.action);
  const meta = comment.meta;
  if (meta && typeof meta === 'object' && typeof meta.action === 'string' && meta.action.trim()) return oneLine(meta.action);
  return null;
}

function attachmentLine(a) {
  const name = typeof a?.name === 'string' && a.name ? oneLine(a.name) : 'attachment';
  const mime = typeof a?.mime === 'string' ? a.mime : '';
  if (mime.startsWith('audio/')) {
    if (a.transcript === TRANSCRIPTION_FAILED) return `[voice note ${name} — ${TRANSCRIPTION_FAILED}]`;
    return a.transcript ? `[voice note ${name} — transcript: ${a.transcript}]` : `[voice note ${name} — (no transcript)]`;
  }
  // A file the bridge downloaded (lib/item-attachments.js) is named by its
  // absolute path so the agent can Read it. One it could not download is
  // still named: item_get retries the download.
  // oneLine on the path too: the saver already sanitises the filename, but
  // this renderer must not depend on it — the directory part comes from
  // config, and any future saver could be less careful.
  if (typeof a.path === 'string' && a.path) return `[attachment ${name} (${mime}) — saved to ${oneLine(a.path)}]`;
  return `[attachment ${name} (${mime}) — not downloaded; item_get retries it]`;
}

// A tracker item is user-scoped, so a marker can be delivered to a session
// other than the one the item was filed against. When origin != viewer, tag
// the turn with the origin conversation so the agent instantly sees the reply
// belongs to a DIFFERENT session's context, not the one it is running in.
// Same-session, or an unknown viewer / origin (older marker, older session),
// gets no tag — the safe default is the unadorned line. Title may be '' (the
// conversations.title default) or absent, in which case we say "another
// session" without naming it.
function provenancePrefix(p, viewerConvoId) {
  const origin = typeof p.origin_convo_id === 'string' && p.origin_convo_id ? p.origin_convo_id : null;
  if (!origin || !viewerConvoId || origin === viewerConvoId) return '';
  const title = typeof p.origin_convo_title === 'string' ? oneLine(p.origin_convo_title) : '';
  return title ? `(from ${title}) ` : '(from another session) ';
}

// payload -> the exact user turn text, or null when this marker should not
// become a turn at all. `body` is the item body fetched for a `created`
// marker (which carries no comment); ignored for every other action.
// `convoId` is the journal convo id of the session receiving this turn;
// `viewerConvoId` defaults to it and, when it differs from the item's origin,
// prefixes the line with provenance.
export function formatItemTurn(payload, { username, body = null, convoId = null, viewerConvoId = convoId } = {}) {
  if (!isTurnWorthy(payload)) return null;
  if (isHandoverMarker(payload)) return formatHandoverTurn(payload, { convoId });
  // Another agent session's comment: worded as an agent, never as the user,
  // and never a tapped button (an agent cannot tap one).
  if (payload.agent_comment === true && payload.action === 'commented') {
    const c = payload.comment && typeof payload.comment === 'object' ? payload.comment : null;
    const from = typeof payload.from_label === 'string' && oneLine(payload.from_label) ? oneLine(payload.from_label) : 'another session';
    const alines = [];
    if (c && typeof c.body === 'string' && c.body.trim()) alines.push(c.body.trim());
    for (const a of Array.isArray(c?.attachments) ? c.attachments : []) alines.push(attachmentLine(a));
    return [`📌 Item #${payload.num} "${oneLine(payload.title)}" — session "${from}" (another agent session, not the user) commented:`, ...alines, trailer(payload)].join('\n');
  }
  // A transcription follow-up reads as the action it completes.
  const p = isTranscriptionFollowUp(payload) ? { ...payload, action: payload.for_action } : payload;
  const who = username || 'the user';
  const prov = provenancePrefix(p, viewerConvoId);
  const head = `#${p.num} "${oneLine(p.title)}"`;
  const comment = p.comment && typeof p.comment === 'object' ? p.comment : null;
  const lines = [];
  if (comment && typeof comment.body === 'string' && comment.body.trim()) lines.push(comment.body.trim());
  for (const a of Array.isArray(comment?.attachments) ? comment.attachments : []) lines.push(attachmentLine(a));

  // A close is terminal: no trailer, because there is nothing left to act on.
  if (p.action === 'closed') {
    return [`📌 ${prov}${who} closed item ${head} as ${p.resolution ?? 'closed'}.`, ...lines].join('\n');
  }
  if (p.action === 'created') {
    // A `created` marker carries a comment only for the BODY's attachments
    // (voice notes the journal transcribed); that synthetic comment has no
    // prose of its own, so the item body still leads.
    const hasProse = !!(comment && typeof comment.body === 'string' && comment.body.trim());
    if (!hasProse && typeof body === 'string' && body.trim()) lines.unshift(body.trim());
    return [`📌 ${prov}${who} filed a new ${kindOf(p)} ${head}:`, ...lines, trailer(p)].join('\n');
  }
  if (p.action === 'reopened') {
    return [`📌 ${prov}${who} reopened item ${head}:`, ...lines, trailer(p)].join('\n');
  }
  // A one-tap reply button reads as "tapped", not "replied" — same trailer
  // and attachment/body lines as an ordinary reply, just a different head.
  const tapped = tappedLabel(comment);
  if (tapped) {
    return [`📌 ${prov}Item ${head} — ${who} tapped "${tapped}".`, ...lines, trailer(p)].join('\n');
  }
  return [`📌 ${prov}Item ${head} — ${who} replied:`, ...lines, trailer(p)].join('\n');
}

export function createItemTurnRouter({
  // async (blobRef) -> { buffer, contentType } | null. index.js wires
  // journalPublisher.fetchMedia (fails open, never throws).
  fetchMedia,
  // async (buffer, mime) -> transcript string. index.js wires transcribeAudio —
  // the SAME seam lib/journal-media.js uses for voice notes, not a second one.
  transcribe,
  // (session, blocks) -> boolean. Inject the synthetic turn WITHOUT mirroring
  // it back into the journal: the item marker is already the durable record,
  // and a mirror would show the user their own reply twice.
  injectBlocks,
  // async (session, { text, preview, source }) -> void. Park the turn on the
  // shared session.queuedMessages while a turn is running, via the same
  // journalQueueMedia seam voice notes use — never a second queue. `source`
  // ({ item_id, comment_id? }) tags the queued card with the reply it holds,
  // so the item's thread can show that reply as queued with a Send now.
  queueText,
  // (convoId, body) -> void. Journal-side assistant notice for the
  // undeliverable case.
  publishNotice,
  // async (itemId, commentId, { blob_ref, transcript }) -> {status, data}.
  // Best-effort write-back so the transcript the bridge computed is visible in
  // the app and in item_get (the journal strips client-supplied transcripts,
  // so it arrives null and only we can fill it).
  setTranscript,
  // async (itemId) -> {status, data}. Fetches the item body for a `created`
  // marker, which carries no comment. Optional: without it a user-filed item
  // still delivers, title only.
  getItem = null,
  // async (session, attachments) -> attachments, each non-audio one carrying
  // `path` once downloaded (lib/item-attachments.js). Optional: without it a
  // file attachment reaches the agent as a name only.
  saveAttachments = null,
  // (convoId) -> the conversation's CURRENT session, or null. A held turn can
  // outlive the session it arrived for (reaped, restarted); optional — without
  // it the turn goes to the session captured when the marker arrived.
  resolveSession = null,
  // How long a turn waits for the journal's transcript before this bridge
  // gives up and runs its own whisper. The journal's job is ffmpeg (30 s) +
  // whisper (120 s) at worst, behind a one-at-a-time queue.
  holdTimeoutMs = 180000,
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // Where an item-side notice goes, and the chain key. Mirrors index.js's
  // journalConvoIdFor so a session predating the journalConvoId field still
  // resolves.
  const convoIdOf = (session) => session?.journalConvoId || session?.claudeSessionId || null;

  // Fill in transcripts for voice-note attachments the journal handed us with
  // `transcript: null`. Returns a COPY of the payload — the frame is shared
  // with whatever else the consumer does, so it is never mutated in place.
  async function withTranscripts(payload) {
    const comment = payload.comment && typeof payload.comment === 'object' ? payload.comment : null;
    if (!comment || !Array.isArray(comment.attachments) || !comment.attachments.length) return payload;
    const attachments = [];
    for (const a of comment.attachments) {
      // Already transcribed (by the journal, or an earlier delivery) — leave it.
      if (!isAudio(a) || hasWords(a)) {
        attachments.push(a);
        continue;
      }
      let transcript = null;
      try {
        const fetched = await fetchMedia(a.blob_ref);
        if (fetched?.buffer) transcript = await transcribe(fetched.buffer, a.mime);
        else warn(`[items-turn] fetch returned nothing for blob_ref=${a.blob_ref} — no transcript`);
      } catch (e) {
        warn(`[items-turn] transcription failed for blob_ref=${a.blob_ref}: ${e?.message ?? e}`);
      }
      if (typeof transcript === 'string' && transcript.trim()) {
        transcript = transcript.trim();
        // Best effort: the turn is what matters, the write-back is a nicety.
        // A comment with no id cannot be addressed by the PATCH route at all,
        // so don't fire a request that can only fail — the transcript still
        // reaches the agent in this turn, it just isn't persisted.
        if (typeof comment.id === 'string' && comment.id) {
          try { await setTranscript(payload.item_id, comment.id, { blob_ref: a.blob_ref, transcript }); }
          catch (e) { warn(`[items-turn] transcript write-back failed for ${payload.item_id}/${comment.id}: ${e?.message ?? e}`); }
        } else {
          warn(`[items-turn] comment on ${payload.item_id} has no id — transcript delivered but not persisted`);
        }
        attachments.push({ ...a, transcript });
      } else {
        attachments.push({ ...a, transcript: TRANSCRIPTION_FAILED });
      }
    }
    return { ...payload, comment: { ...comment, attachments } };
  }

  // Download the comment's file attachments so the turn can name their paths.
  // Fail-open like withTranscripts: any failure leaves the attachment list as
  // it was, and the turn still goes out.
  async function withFiles(session, payload) {
    const comment = payload.comment && typeof payload.comment === 'object' ? payload.comment : null;
    if (typeof saveAttachments !== 'function' || !comment || !Array.isArray(comment.attachments) || !comment.attachments.length) return payload;
    try {
      const attachments = await saveAttachments(session, comment.attachments);
      if (Array.isArray(attachments)) return { ...payload, comment: { ...comment, attachments } };
    } catch (e) {
      warn(`[items-turn] attachment download failed for ${payload.item_id}: ${e?.message ?? e} — sending names only`);
    }
    return payload;
  }

  // The body of a user-filed item. The `created` marker carries no comment, so
  // without this the agent would be told a task exists and not what it says.
  async function fetchBody(payload) {
    // A comment on a `created` marker is the body's attachments, not its
    // prose — only a comment that HAS words makes the fetch unnecessary.
    const hasProse = typeof payload.comment?.body === 'string' && !!payload.comment.body.trim();
    if (payload.action !== 'created' || hasProse || typeof getItem !== 'function') return null;
    try {
      const res = await getItem(payload.item_id);
      if (res?.status === 200 && typeof res.data?.item?.body === 'string') return res.data.item.body;
      warn(`[items-turn] item fetch for ${payload.item_id} returned status=${res?.status ?? '?'} — sending the title only`);
    } catch (e) {
      warn(`[items-turn] item fetch for ${payload.item_id} failed: ${e?.message ?? e} — sending the title only`);
    }
    return null;
  }

  // --- Holding a turn for the journal's transcript ---------------------------
  // holds: comment id -> resolver of the turn waiting on it. early: a follow-up
  // that arrived before its turn reached the front of the chain. delivered:
  // comment ids already turned into a turn, so a follow-up that lands after
  // the timeout fallback is not delivered a second time. Both maps are bounded
  // — a dropped entry only costs a wait or (at worst) a repeated turn.
  const holds = new Map();
  const early = new Map();
  const delivered = new Set();
  const remember = (set, key, value) => {
    if (set instanceof Map) set.set(key, value); else set.add(key);
    if (set.size > 200) set.delete(set.keys().next().value);
  };

  function waitForTranscript(commentId) {
    if (early.has(commentId)) {
      const got = early.get(commentId);
      early.delete(commentId);
      return Promise.resolve(got);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { holds.delete(commentId); resolve(null); }, holdTimeoutMs);
      timer.unref?.();
      holds.set(commentId, (got) => { clearTimeout(timer); holds.delete(commentId); resolve(got); });
    });
  }

  async function routeOne(session, payload, ctx) {
    try {
      if (!isTurnWorthy(payload)) return;
      // A handover stage carries the journal's thread line as its comment, and
      // the SAME line goes to both sides of the handover — which may share
      // this bridge. Keyed by comment id it would reach only the first, so a
      // handover marker is never deduped (the journal sends each stage once
      // per conversation).
      const commentId = !isHandoverMarker(payload) && typeof payload.comment?.id === 'string' ? payload.comment.id : null;
      if (isTranscriptionFollowUp(payload)) {
        // Reached through the chain only when no turn was holding for it: the
        // `commented` marker was consumed by a previous bridge process (or
        // never seen). The follow-up carries everything the turn needs.
        if (delivered.has(commentId)) return;
        early.delete(commentId);
        payload = { ...payload, action: payload.for_action };
      } else {
        // A replayed `commented` frame for a turn already delivered must not
        // sit out a whole hold and then deliver again.
        if (commentId && delivered.has(commentId)) return;
        const holdId = pendingCommentId(payload);
        if (holdId) {
          const got = await waitForTranscript(holdId);
          if (got) {
            // Deliver from the follow-up: same comment, words filled in, and
            // the session the router resolved NOW rather than minutes ago.
            payload = { ...got.payload, action: got.payload.for_action };
            session = got.session || session;
          } else {
            // Minutes have passed: deliver to whoever holds the conversation now.
            if (typeof resolveSession === 'function') {
              try { session = resolveSession(convoIdOf(session)) || session; } catch { /* keep the captured one */ }
            }
            warn(`[items-turn] no transcript from the journal for ${payload.item_id}/${holdId} after ${holdTimeoutMs} ms — transcribing here`);
          }
        }
      }
      const enriched = await withFiles(session, await withTranscripts(payload));
      const body = await fetchBody(enriched);
      const text = formatItemTurn(enriched, { username: ctx.username, body, convoId: convoIdOf(session) });
      if (!text) return;
      // Read busy AFTER the fetch/transcribe, like lib/journal-media.js: a turn
      // that ended while we were transcribing should inject, not queue forever.
      // `delivered` means DELIVERED: recorded only once the turn is queued or
      // injected, so a follow-up replayed after a failed hand-over still has a
      // chance to land.
      if (session?.busy) {
        await queueText(session, {
          text,
          preview: `📌 #${enriched.num} ${enriched.title}`,
          source: { item_id: enriched.item_id, ...(commentId ? { comment_id: commentId } : {}) },
        });
        if (commentId) remember(delivered, commentId);
        return;
      }
      if (injectBlocks(session, [{ type: 'text', text }])) {
        if (commentId) remember(delivered, commentId);
      } else {
        publishNotice(convoIdOf(session), UNDELIVERABLE);
      }
    } catch (e) {
      warn(`[items-turn] routing failed for ${payload?.item_id ?? '?'}: ${e?.message ?? e}`);
      // Say so where the user can see it, not only in the bridge log — the
      // same stance lib/journal-media.js's catch takes. The user tapped send
      // on a reply; silence would look like it landed.
      try {
        const convoId = convoIdOf(session);
        if (convoId) publishNotice(convoId, UNDELIVERABLE);
      } catch { /* a notice must never mask the original failure */ }
    }
  }

  // Per-conversation promise chains, exactly as lib/journal-media.js does it:
  // each marker's transcribe/fetch/inject runs only after the previous one for
  // that convo settled, so two replies sent seconds apart reach the agent in
  // MARKER order rather than transcription-completion order (a voice note takes
  // seconds; a text reply behind it would otherwise overtake it). Entries never
  // reject — routeOne catches everything — and a settled chain removes itself
  // so the map doesn't grow with dead convos.
  const chains = new Map();

  return function routeItemToSession(session, { payload } = {}, ctx = {}) {
    // The journal's transcript for a held turn: hand it to the waiter and stay
    // OUT of the chain — the turn it releases is the chain's current entry, so
    // queueing behind it would deadlock until the timeout.
    if (isTurnWorthy(payload) && isTranscriptionFollowUp(payload)) {
      const id = payload.comment.id;
      const release = holds.get(id);
      if (release) { release({ payload, session }); return Promise.resolve(); }
      if (delivered.has(id)) return Promise.resolve();
      // Its turn may still be queued behind an earlier marker: leave the words
      // where waitForTranscript will find them, and fall through to the chain
      // so a follow-up with no turn at all still delivers.
      remember(early, id, { payload, session });
    }
    const key = convoIdOf(session) || 'unknown';
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(() => routeOne(session, payload, ctx));
    chains.set(key, run);
    run.then(() => { if (chains.get(key) === run) chains.delete(key); });
    return run;
  };
}
