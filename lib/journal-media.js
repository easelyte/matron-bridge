// Journal media input orchestration: fetch a client-sent file/image/voice-note
// blob back OUT of the journal blob store and feed it to the claude session
// exactly the way the Matrix media path does — audio is transcribed and
// injected as if the user had typed it, images/files are saved to the same
// per-session location and attached to the next prompt. Pure orchestration
// with every I/O boundary injected (fetchMedia, transcribe, the save/build and
// inject sinks), so it's unit-testable without a real journal server, whisper,
// or claude session — in the same factory style as createJournalInputConsumer
// and createJournalPublisher.
//
// Contract: the returned routeMedia NEVER throws or rejects. The journal input
// consumer calls it fire-and-forget from inside its own try/catch, but that
// catch is synchronous and can't observe an async rejection, so everything is
// swallowed here. A failed / oversized / unresolvable fetch, or a failed
// transcription, logs and drops — it never injects an unresolvable placeholder
// into the prompt (the brief's explicit rule).

export function createJournalMediaRouter({
  // async (blobRef) -> { buffer, contentType } | null. index.js wires
  // journalPublisher.fetchMedia, which already fails open (null on any error,
  // including an over-cap blob) and never throws.
  fetchMedia,
  // async (buffer, mime) -> transcript string. index.js wires transcribeAudio.
  transcribe,
  // (session, { buffer, mime, isImage, name, dims }) -> content blocks[] or a
  // promise of them (the inline-image downscale step is async). The
  // save-to-disk + inline-block builder shared with the Matrix media path.
  buildSavedBlocks,
  // (session, text) -> boolean. Inject a plain user turn (voice-note
  // transcript). index.js wires sendTextToSession (mirrors into the journal).
  injectText,
  // (session, blocks) -> boolean. Inject media content blocks WITHOUT
  // re-mirroring into the journal (the client's own file/image event is
  // already there). index.js wires sendToSession(..., {skipJournalMirror:true}).
  injectBlocks,
  // async (session, {blocks, mirrorToJournal, preview, fullText}) -> void. Queue a
  // PREPARED media injection while the session is busy, instead of injecting
  // it immediately — the same contract journal TEXT and Matrix media honor
  // (a mid-turn send must land in session.queuedMessages and flush at turn
  // end, never race the running turn). Only consulted when session.busy;
  // without this seam wired, media always injects immediately (the pre-queue
  // behavior). index.js wires journalQueueMedia, which pushes onto
  // session.queuedMessages and posts the shared "📨 Queued" tile. fullText
  // defines the structured card item: the voice-note injected string for
  // audio, and the filename/preview for file and image media (which have no
  // separate full text). blocks is
  // fetched/transcribed/built eagerly here (mirroring the Matrix busy media
  // path, which also builds before queueing), so flush is a plain re-send with
  // no deferred I/O. mirrorToJournal distinguishes the two entry shapes: a
  // voice-note transcript IS journal-mirrored on flush (matching the immediate
  // sendTextToSession), a saved file/image is NOT (the client's own event is
  // already in the journal).
  queueMedia = null,
  // (session) -> boolean. True while `session` is still the live, canonical
  // session for its room. Consulted at DELIVERY time, after the async
  // fetch/transcribe/build, because the session captured at entry may have been
  // stopped, idle-reaped, or replaced by an agent switch meanwhile. index.js
  // wires isCanonicalLiveSession (alive AND still the sessions-map object).
  // REQUIRED (no default) so a missing/misspelled wiring fails loud rather than
  // silently disabling stale-session protection — a fail-open default would let
  // media queue/inject onto detached sessions again (Codex review #537 F2).
  isCanonicalSession,
  // (session, plain, html) -> void. Echo a room-facing line (skips journal
  // re-mirror). index.js wires journalEchoToRoom.
  echoToRoom,
  // (convoId, body) -> void. A journal-side assistant notice for the
  // undeliverable cases. index.js wires journalPublishNotice.
  publishNotice,
  escapeHtml = (s) => String(s),
  log = console,
} = {}) {
  // Fail loud at construction, not lazily at first delivery: isCanonicalSession
  // is the stale-session safety guard, so a missing/misspelled wiring must abort
  // wiring rather than quietly disable protection and surface only as a swallowed
  // throw on the media hot path (Codex review #537 F2/F3).
  if (typeof isCanonicalSession !== 'function') {
    throw new TypeError('createJournalMediaRouter: isCanonicalSession dependency is required (function)');
  }
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // A prepared injection queues (rather than injects now) only when the
  // session is mid-turn AND a queueMedia sink is wired. Read at DELIVERY time —
  // after the (async) fetch/transcribe/build — so a turn that ended while we
  // were fetching correctly injects immediately instead of queueing forever.
  function shouldQueue(session) {
    return typeof queueMedia === 'function' && !!(session && session.busy);
  }

  // Per-conversation promise chains: each frame's fetch/inject runs only
  // after the previous one for that convo settled, so attachments sent in
  // quick succession reach claude (or the busy queue) in journal order
  // rather than fetch-completion order. Entries never reject (routeOne
  // catches everything), and a settled chain removes itself so the map
  // doesn't grow with dead convos.
  const chains = new Map();

  function routeMedia(session, media, ctx = {}) {
    const key = (session && session.claudeSessionId) || 'unknown';
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(() => routeOne(session, media, ctx));
    chains.set(key, run);
    run.then(() => { if (chains.get(key) === run) chains.delete(key); });
    return run;
  }

  async function routeOne(session, media, ctx = {}) {
    try {
      const { type, blobRef, contentType, name, dims, caption } = media || {};
      const username = ctx.username || '';
      // Notice target = the STABLE journal conversation id (mirrors index.js
      // journalConvoIdFor: journalConvoId || claudeSessionId). After an agent
      // switch journalConvoId survives while claudeSessionId becomes the new
      // provider-native id, and the journal server hard-rejects publishes to
      // convos it doesn't know — so a bare claudeSessionId would drop every
      // failure notice in exactly the teardown/switch case they exist for.
      const convoId = session && (session.journalConvoId || session.claudeSessionId);

      // Room-facing "sent a file/image/voice note" line, classified by the
      // declared content type (the fetched type is checked again below for the
      // actual transcribe-vs-save decision).
      const declaredAudio = typeof contentType === 'string' && contentType.startsWith('audio/');
      const kindLabel = declaredAudio
        ? 'a voice note'
        : (type === 'image' ? 'an image' : `a file${name ? `: ${name}` : ''}`);
      echoToRoom(session,
        `📱 ${username} (Matron) sent ${kindLabel}`,
        `📱 <b>${escapeHtml(username)} (Matron)</b> sent ${escapeHtml(kindLabel)}`);

      const fetched = await fetchMedia(blobRef);
      if (!fetched || !fetched.buffer) {
        // fetchMedia already warned with the specifics (HTTP status, over-cap,
        // network error). Drop — never inject an unresolvable placeholder into
        // the prompt (brief's rule). But DO tell the user, mirroring the
        // transcription-failure path's publishNotice: the room already shows a
        // success-style "sent a file" echo, so without this the attachment
        // silently never reaches claude with no hint why.
        warn(`[journal-media] fetch returned nothing for convo=${convoId} blob_ref=${blobRef} — dropping`);
        const failLabel = declaredAudio ? 'voice note' : (type === 'image' ? 'image' : 'attachment');
        publishNotice(convoId, `Couldn't fetch that ${failLabel} — it wasn't delivered to claude.`);
        return;
      }
      const { buffer } = fetched;
      // Early teardown check, BEFORE the expensive/side-effecting prep
      // (transcription, image downscale, and buildSavedBlocks' synchronous disk
      // write). If a /stop, idle-reap, or agent switch already landed while this
      // frame's fetch was pending, skip the work entirely — otherwise a burst of
      // queued uploads on teardown transcribes/downscales and writes an orphan
      // file per frame before the delivery-time guard below drops them (wasted
      // CPU + disk). The delivery-time guard stays authoritative: state can also
      // change DURING transcribe/build (Codex review #537 F2).
      if (!isCanonicalSession(session)) {
        const failLabel = declaredAudio ? 'voice note' : (type === 'image' ? 'image' : 'attachment');
        publishNotice(convoId, `Couldn't deliver that ${failLabel}${name ? ` (${name})` : ''} — the session ended before it was ready.`);
        return;
      }
      // Transcribe when EITHER the frame's declared type or the store's
      // fetched type says audio — a client that uploads with a generic
      // application/octet-stream must not shadow an audio/* blob (and vice
      // versa), or the voice note gets saved as a file instead of
      // transcribed like the Matrix path.
      const audioMime = [contentType, fetched.contentType]
        .find((t) => typeof t === 'string' && t.startsWith('audio/'));
      const mime = audioMime || contentType || fetched.contentType || 'application/octet-stream';

      if (audioMime) {
        // Voice note: transcribe and inject the transcript as if the user had
        // typed it — the SAME wording claude sees from the Matrix m.audio
        // path, so the two transports are identical from claude's perspective.
        let transcript;
        try {
          transcript = await transcribe(buffer, mime);
        } catch (e) {
          warn(`[journal-media] voice-note transcription failed for convo=${convoId}: ${e.message}`);
          publishNotice(convoId, '🎤 Could not transcribe that voice note.');
          return;
        }
        if (!transcript || !String(transcript).trim()) {
          warn(`[journal-media] empty transcription for convo=${convoId} — dropping`);
          publishNotice(convoId, '🎤 Could not transcribe that voice note.');
          return;
        }
        echoToRoom(session,
          `🎤 ${username} (Matron): ${transcript}`,
          `🎤 <b>${escapeHtml(username)} (Matron):</b> ${escapeHtml(transcript)}`);
        const injected = `[Voice note transcription]: ${transcript}`;
        // Revalidate liveness after the async transcribe: a session stopped,
        // idle-reaped, or replaced by an agent switch while we transcribed must
        // not have queue state recreated on it (the flush that would send it is
        // gone, so the media is lost and its queued-tile taps dangle). Drop
        // with a notice instead of queueing/injecting onto a dead session.
        if (!isCanonicalSession(session)) {
          publishNotice(convoId, "Couldn't deliver that voice note — the session ended before it was ready.");
          return;
        }
        if (shouldQueue(session)) {
          // Queue exactly like a busy-time text send: a plain text block that
          // DOES mirror into the journal on flush (mirrorToJournal), matching
          // the immediate injectText/sendTextToSession above.
          const preview = transcript.length > 40 ? `${transcript.slice(0, 37)}…` : transcript;
          const blocks = [{ type: 'text', text: injected }];
          await queueMedia(session, {
            blocks,
            mirrorToJournal: true,
            preview: `🎤 ${preview}`,
            fullText: blocks[0].text,
          });
          return;
        }
        if (!injectText(session, injected)) {
          publishNotice(convoId, "Couldn't deliver that voice note — the session isn't available.");
        }
        return;
      }

      // image / other file: save + attach exactly like the Matrix media path.
      // `caption` is what the user typed in the composer alongside the
      // attachment; buildSavedBlocks folds it into the prompt so claude
      // reads the sentence and the file as one turn.
      const blocks = await buildSavedBlocks(session, {
        buffer, mime, isImage: type === 'image', name, dims, caption,
      });
      if (!Array.isArray(blocks) || blocks.length === 0) {
        warn(`[journal-media] media produced no blocks for convo=${convoId} name=${name || '?'} mime=${mime} — dropping`);
        // The room already carries a success-style "sent a file" echo, so a
        // silent drop leaves the user believing claude has the file — notify
        // unconditionally, matching the fetch/transcribe failure notices
        // above. Name the file when we can: attachments route through a
        // per-convo chain, so several can fail in quick succession.
        const failLabel = type === 'image' ? 'image' : 'attachment';
        publishNotice(convoId, `Couldn't deliver that ${failLabel}${name ? ` (${name})` : ''} to claude.`);
        return;
      }
      // Revalidate liveness after the async save/build — see the voice-note
      // path above. Queueing prepared blocks onto a dead/detached session loses
      // the media and leaves dangling card taps.
      if (!isCanonicalSession(session)) {
        const failLabel = type === 'image' ? 'image' : 'attachment';
        publishNotice(convoId, `Couldn't deliver that ${failLabel}${name ? ` (${name})` : ''} — the session ended before it was ready.`);
        return;
      }
      if (shouldQueue(session)) {
        // Queue the prepared saved-media blocks. mirrorToJournal:false — the
        // client's own file/image event is already in the journal, so the
        // flush must NOT re-mirror it (the immediate path skips the mirror for
        // the same reason).
        const preview = name || (type === 'image' ? '[image]' : '[file]');
        await queueMedia(session, {
          blocks,
          mirrorToJournal: false,
          preview,
          fullText: preview,
        });
        return;
      }
      if (!injectBlocks(session, blocks)) {
        publishNotice(convoId, "Couldn't deliver that file — the session isn't available.");
      }
    } catch (e) {
      warn(`[journal-media] routeMedia threw: ${e && e.message}`);
      // The room already carries a success-style "sent a file" echo — an
      // unexpected throw (save/queue/inject) must leave the same journal
      // notice the fetch/transcription failure paths do, not silence.
      try {
        const convoId = session && (session.journalConvoId || session.claudeSessionId);
        if (convoId) publishNotice(convoId, "Couldn't deliver that attachment to claude.");
      } catch { /* notices must never mask the original failure */ }
    }
  }

  return routeMedia;
}
