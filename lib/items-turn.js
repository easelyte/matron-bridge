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
const KINDS = new Set(['task', 'question', 'decision']);
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
  return TURN_ACTIONS.has(payload.action);
}

// Everything below interpolates journal-sourced strings into prose the agent
// reads as ONE turn, where a line beginning with 📌 is structure. A title (or
// an attachment name) the user typed with a newline in it — "ship it\n📌 the
// user closed …" — would otherwise forge a second marker line. Collapse any
// run of whitespace, newlines included, to a single space.
const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();

function attachmentLine(a) {
  const name = typeof a?.name === 'string' && a.name ? oneLine(a.name) : 'attachment';
  const mime = typeof a?.mime === 'string' ? a.mime : '';
  if (mime.startsWith('audio/')) {
    if (a.transcript === TRANSCRIPTION_FAILED) return `[voice note ${name} — ${TRANSCRIPTION_FAILED}]`;
    return a.transcript ? `[voice note ${name} — transcript: ${a.transcript}]` : `[voice note ${name} — (no transcript)]`;
  }
  return `[attachment ${name} (${mime}) — item_get shows it]`;
}

// payload -> the exact user turn text, or null when this marker should not
// become a turn at all. `body` is the item body fetched for a `created`
// marker (which carries no comment); ignored for every other action.
export function formatItemTurn(payload, { username, body = null } = {}) {
  if (!isTurnWorthy(payload)) return null;
  const p = payload;
  const who = username || 'the user';
  const head = `#${p.num} "${oneLine(p.title)}"`;
  const comment = p.comment && typeof p.comment === 'object' ? p.comment : null;
  const lines = [];
  if (comment && typeof comment.body === 'string' && comment.body.trim()) lines.push(comment.body.trim());
  for (const a of Array.isArray(comment?.attachments) ? comment.attachments : []) lines.push(attachmentLine(a));

  // A close is terminal: no trailer, because there is nothing left to act on.
  if (p.action === 'closed') {
    return [`📌 ${who} closed item ${head} as ${p.resolution ?? 'closed'}.`, ...lines].join('\n');
  }
  if (p.action === 'created') {
    if (!lines.length && typeof body === 'string' && body.trim()) lines.push(body.trim());
    return [`📌 ${who} filed a new ${kindOf(p)} ${head}:`, ...lines, trailer(p)].join('\n');
  }
  if (p.action === 'reopened') {
    return [`📌 ${who} reopened item ${head}:`, ...lines, trailer(p)].join('\n');
  }
  return [`📌 Item ${head} — ${who} replied:`, ...lines, trailer(p)].join('\n');
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
  // async (session, { text, preview }) -> void. Park the turn on the shared
  // session.queuedMessages while a turn is running, via the same
  // journalQueueMedia seam voice notes use — never a second queue.
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
      const isAudio = typeof a?.mime === 'string' && a.mime.startsWith('audio/');
      // Already transcribed (by an earlier delivery, or by the app) — leave it.
      if (!isAudio || (typeof a.transcript === 'string' && a.transcript.trim())) {
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

  // The body of a user-filed item. The `created` marker carries no comment, so
  // without this the agent would be told a task exists and not what it says.
  async function fetchBody(payload) {
    if (payload.action !== 'created' || payload.comment || typeof getItem !== 'function') return null;
    try {
      const res = await getItem(payload.item_id);
      if (res?.status === 200 && typeof res.data?.item?.body === 'string') return res.data.item.body;
      warn(`[items-turn] item fetch for ${payload.item_id} returned status=${res?.status ?? '?'} — sending the title only`);
    } catch (e) {
      warn(`[items-turn] item fetch for ${payload.item_id} failed: ${e?.message ?? e} — sending the title only`);
    }
    return null;
  }

  async function routeOne(session, payload, ctx) {
    try {
      if (!isTurnWorthy(payload)) return;
      const enriched = await withTranscripts(payload);
      const body = await fetchBody(enriched);
      const text = formatItemTurn(enriched, { username: ctx.username, body });
      if (!text) return;
      // Read busy AFTER the fetch/transcribe, like lib/journal-media.js: a turn
      // that ended while we were transcribing should inject, not queue forever.
      if (session?.busy) {
        await queueText(session, { text, preview: `📌 #${enriched.num} ${enriched.title}` });
        return;
      }
      if (!injectBlocks(session, [{ type: 'text', text }])) {
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
    const key = convoIdOf(session) || 'unknown';
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(() => routeOne(session, payload, ctx));
    chains.set(key, run);
    run.then(() => { if (chains.get(key) === run) chains.delete(key); });
    return run;
  };
}
