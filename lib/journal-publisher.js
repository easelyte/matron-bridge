import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import WebSocket from 'ws';

// Injectable journal dual-post publisher, in the style of lib/live-output.js:
// a plain factory that the bridge wires in and everything else stays ignorant
// of. See docs/superpowers/specs/2026-07-10-matron-protocol-design.md in
// matron-journal for the wire protocol this speaks.
//
// Contract with callers (index.js): every method here MUST fail open. A
// journal outage, a bad token, a network partition, a malformed frame from
// the server — none of it may ever throw, reject, block, or otherwise touch
// Matrix behavior. Every public method below is wrapped so a bug in this
// module degrades to "journal mirroring silently stops" rather than an
// uncaught exception in the bridge's hot path. publishFile/publishImage and
// markRead follow the same contract as the original text/prompt/tool_output
// trio; uploadMedia is the one method that isn't queued (see its own
// comment). publishActivity and streamAppend are EPHEMERAL rather than
// durable: unlike every queued method above, neither is ever enqueued,
// retried, or replayed on reconnect — see publishActivity's own comment for
// why, and streamAppend's for how a dropped frame self-heals (the server's
// stream_resync tells the pump to re-read its log file from the gap).
// finalizeToolOutput is durable/queued like publish — see its own comment.

// --- Wire contract for `stream` (matron-journal src/ws.js `case 'stream'`,
//     src/hub.js sendEphemeral, and docs spec section 6 "ephemeral") ---
// The bridge sends `{op:'stream', convo_id, message_ref, replace_text}`. The
// server does NO length/shape validation and NO journal write; it is a pure
// hub.sendEphemeral fan-out to the owning user's connections that have
// declared `{op:'viewing', convo_id}` for THIS convo (a non-viewing device
// receives nothing). The hub coalesces per `${convo_id}:${message_ref}` key,
// LATEST-WINS, flushing at most one frame per its coalesceMs window (default
// 200ms ~= 5/s). Latest-wins is why we send `replace_text` (the full
// cumulative text), never an incremental `text` delta: a coalesced-away
// snapshot is harmless (the next snapshot supersedes it) but a coalesced-away
// delta would drop text permanently. The message_ref links the ephemeral
// overlay to the eventual DURABLE final message — but the server strips
// idem_key from the journal event shape (journal.js toEventShape) and never
// adds message_ref to a durable frame, so `finalize`'s `fin:<ref>` idem key
// does NOT reach the client. The bridge therefore keeps its existing durable
// `publish` flow authoritative (queued/retried, so the final message survives
// a disconnect even with streaming off) and carries the ref INSIDE the publish
// payload (`payload.message_ref`) — the only channel the server contract
// exposes to a client — so the client retires its overlay by ref, not the
// body-match fallback. finalize is intentionally unused (it would be a second
// durable row = double-publish, and can't deliver the ref any better).

const DEFAULT_QUEUE_LIMIT = 5000;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30000;
const DEFAULT_CURSOR_DEBOUNCE_MS = 1000;
// Protocol-level ping cadence. A NAT/proxy that silently drops the TCP path
// leaves the socket ESTABLISHED forever with no error and no close — the
// 2026-07-17 outage: the bridge looked healthy but received nothing. A ping
// every interval, with "no pong (or any frame) since the last ping" treated
// as dead, bounds that failure to ~2 intervals before terminate + reconnect.
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30000;
// Bridge-side stream coalescing floor: at most one ephemeral stream frame per
// (convo, message_ref) per this window. Matches the server hub's own ~5/s
// (200ms) fan-out coalescing — sending faster is pure waste, the hub would
// just coalesce it away. Tunable via JOURNAL_STREAM_INTERVAL_MS.
const DEFAULT_STREAM_INTERVAL_MS = 200;
// Cap on a single inbound media blob fetched back OUT of the journal blob
// store (a voice note / image / file a Matron client uploaded, then referenced
// by a file/image journal event this bridge consumes). 25MB comfortably covers
// a voice note or a phone photo; a blob past it is aborted and dropped rather
// than risked against the bridge's memory. The Matrix media path has no
// explicit cap, so this is deliberately the stricter of the two.
const DEFAULT_FETCH_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

function noopPublisher() {
  return {
    upsertConvo() {},
    publishText() {},
    publishPrompt() {},
    publishToolOutput() {},
    publishDiff() {},
    publishFile() {},
    publishImage() {},
    publishActivity() {},
    publishStatus() {},
    respondRpc() {},
    stream() {},
    endStream() {},
    streamAppend() {},
    finalizeToolOutput() {},
    markRead() {},
    uploadMedia() { return null; },
    fetchMedia() { return null; },
    flushCursor() {},
    close() {},
  };
}

// Media HTTP base URL is derived from the WS URL per the fixed contract:
// ws:// -> http://, wss:// -> https://, strip a trailing /ws path segment.
// Exported for direct unit coverage; index.js never needs to call this
// itself since uploadMedia does the derivation internally.
export function deriveMediaHttpBaseUrl(wsUrl) {
  if (!wsUrl) return null;
  return wsUrl
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/ws\/?$/, '');
}

export function createJournalPublisher({
  url,
  token,
  log = console,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
  // Bridge-side coalescing floor for `stream` ephemerals (per convo+ref).
  // Defaults to the server hub's own fan-out window; index.js wires
  // JOURNAL_STREAM_INTERVAL_MS here.
  streamIntervalMs = DEFAULT_STREAM_INTERVAL_MS,
  // Cap for fetchMedia (inbound blob download). Factory-injectable so tests
  // can exercise the over-cap reject path with a small blob; index.js never
  // overrides the 25MB default.
  fetchMediaMaxBytes = DEFAULT_FETCH_MEDIA_MAX_BYTES,
  // Inbound-event delivery (Matron -> bridge input). When set, every inbound
  // `{kind:'journal'}` frame — replayed AND live, from every sender
  // (agent-echoes included: loop-prevention filtering is the caller's job,
  // not this module's) — is handed to onEvent, at most once per seq. Left
  // unset, this module behaves exactly as it always has: publish-only, every
  // inbound frame other than hello_ok/error silently ignored.
  onEvent,
  // Inbound stream_resync dispatch (tool-output streaming). When set, every
  // inbound `{kind:'control', op:'stream_resync'}` frame is handed to this
  // callback as (convo_id, message_ref, have) — the pump for that stream
  // rewinds to byte `have` and re-sends (lib/tool-stream-pump.js). Unset:
  // the frames are ignored like any other unrecognised control op.
  onStreamResync,
  // Inbound agent-RPC dispatch (docs/superpowers/specs/
  // 2026-07-15-rpc-consumer-design.md): when set, every inbound
  // `{kind:'rpc', request:{...}}` frame whose request is well-formed
  // (string request_id, integer from_device_id, string method) is handed to
  // this callback. Unset: rpc frames are ignored like any other
  // unrecognised frame. RPC frames carry no seq and never touch the
  // cursor/replay machinery.
  onRpcRequest,
  // Where the highest seq seen is persisted (debounced) so a restart resumes
  // input from where it left off instead of reconnecting live-only forever.
  // Only meaningful when onEvent is set.
  cursorFile,
  cursorDebounceMs = DEFAULT_CURSOR_DEBOUNCE_MS,
  // Dead-connection detection cadence (see DEFAULT_KEEPALIVE_INTERVAL_MS).
  keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
  // Transport injection point for tests only (e.g. to deterministically
  // simulate a dropped/unconfirmed send). index.js never passes this — the
  // real bridge always talks to the actual `ws` WebSocket implementation.
  WebSocketImpl = WebSocket,
} = {}) {
  if (!url || !token) {
    // Matches the disabled-if-unset pattern for HMAC_SECRET/VIEWER_BASE_URL
    // (index.js:162-164): one warning at construction, then a cheap no-op.
    try { log.warn('[journal-publisher] JOURNAL_WS_URL or journal token unset — journal dual-post disabled'); } catch { /* logging must never throw */ }
    return noopPublisher();
  }

  // Derived once at construction; uploadMedia POSTs here. Never re-derived
  // per call — index.js only ever constructs this once at boot.
  const mediaHttpBaseUrl = deriveMediaHttpBaseUrl(url);

  // FIFO queue of not-yet-confirmed frames. Each entry stays in the queue
  // until ws.send(data, cb) confirms the write; frames still present when the
  // socket dies are re-sent, in the same order, on the next connection.
  const queue = [];
  let ws = null;
  let connected = false;
  let closed = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let overflowActive = false;
  // Inbound `error` control frames are logged once per distinct code PER
  // CONNECTION EPOCH (the set is cleared on every hello_ok), not once per
  // occurrence. A read_marker sent to a server that hasn't yet landed agent
  // read_marker support (matron-journal PR #2) rejects every single one with
  // the same 'forbidden' code, and markRead is called after every
  // user-mirrored publish — without this dedup that's an unbounded stream of
  // identical warnings for a condition the first warning already fully
  // describes. Resetting per epoch keeps the anti-spam property within a
  // connection while restoring observability across reconnects: a later,
  // unrelated problem that happens to reuse a previously-seen code (e.g. a
  // real bad_request days after a first one) still gets logged on the next
  // connection instead of staying permanently invisible.
  const warnedErrorCodes = new Set();

  // Per-(convo, message_ref) throttle state for `stream` ephemerals:
  // key -> { convoId, messageRef, lastAt, pending, timer }. `pending` holds the
  // latest not-yet-sent replace_text (latest-wins, like the server hub);
  // `timer` is the trailing-edge flush. An entry is deleted by endStream (turn
  // finalize/end) so a stale trailing frame can never land after the durable
  // final message. Never queued/retried/replayed — same ephemeral contract as
  // publishActivity.
  const streamThrottle = new Map();
  function streamKey(convoId, messageRef) {
    return `${convoId}\0${messageRef}`;
  }

  function warn(msg) {
    try { log.warn(msg); } catch { /* never let logging throw */ }
  }

  // Fire a single stream ephemeral immediately if the socket is live (past
  // hello_ok); otherwise drop it silently. Returns whether it went out, so the
  // throttle only advances its clock on an actual send. Fails open like every
  // other send here.
  function sendStreamFrame(convoId, messageRef, replaceText) {
    if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return false;
    let data;
    try {
      data = JSON.stringify({ op: 'stream', convo_id: convoId, message_ref: messageRef, replace_text: replaceText });
    } catch (e) {
      warn(`[journal-publisher] dropping unserializable stream frame: ${e.message}`);
      return false;
    }
    try {
      ws.send(data);
      return true;
    } catch (e) {
      warn(`[journal-publisher] stream send failed: ${e.message}`);
      return false;
    }
  }

  // --- Inbound cursor tracking (only meaningful when onEvent is set) ---
  //
  // `lastSeq` is the high-water mark of every journal frame seen THIS
  // process lifetime (set even for frames onEvent-delivery skips for other
  // reasons — there are none today, but the field's job is "what's the
  // highest seq I've observed", not "what did onEvent see"). It seeds the
  // cursor sent on every hello (so a reconnect resumes rather than
  // re-replaying from disk), and is the dedupe boundary: a replayed frame
  // with seq <= lastSeq was already delivered and must not be delivered
  // again. It is never reset except by snapshot_required (back to null,
  // live-only) — reconnects do NOT reset it, which is exactly what makes the
  // dedupe work across the replay-overlap window (persisted cursor can lag
  // behind lastSeq by up to cursorDebounceMs of traffic).
  let lastSeq = null;
  let cursorDirty = false;
  let cursorTimer = null;

  function loadPersistedCursor() {
    if (!cursorFile) return null;
    try {
      const raw = readFileSync(cursorFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Number.isInteger(parsed?.cursor) && parsed.cursor >= 0) return parsed.cursor;
      return null;
    } catch {
      // Missing file, unreadable, or malformed JSON — all treated the same:
      // no cursor. This is the "first boot" case (spec: hello with null,
      // live-only — never replay history as input).
      return null;
    }
  }

  function persistCursorNow() {
    if (!cursorFile) return;
    try {
      writeFileSync(cursorFile, JSON.stringify({ cursor: lastSeq }));
      cursorDirty = false;
    } catch (e) {
      warn(`[journal-publisher] failed to persist cursor file: ${e.message}`);
    }
  }

  function scheduleCursorPersist() {
    if (!cursorFile) return;
    cursorDirty = true;
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (cursorDirty) persistCursorNow();
    }, cursorDebounceMs);
    if (typeof cursorTimer.unref === 'function') cursorTimer.unref();
  }

  if (onEvent) lastSeq = loadPersistedCursor();

  function enqueue(frame) {
    queue.push({ frame, sending: false });
    if (queue.length > queueLimit) {
      queue.shift();
      if (!overflowActive) {
        overflowActive = true;
        warn(`[journal-publisher] queue overflow (>${queueLimit} frames) — dropping oldest`);
      }
    } else if (overflowActive) {
      overflowActive = false;
    }
    pump();
  }

  function pump() {
    if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Snapshot the array before iterating: sent entries splice themselves out
    // of `queue` from inside the send callback, which can fire synchronously
    // or interleaved with this loop.
    for (const entry of queue.slice()) {
      if (entry.sending) continue;
      entry.sending = true;
      let data;
      try {
        data = JSON.stringify(entry.frame);
      } catch (e) {
        // Unserializable payload: drop this one frame rather than wedge the
        // whole queue behind it forever.
        warn(`[journal-publisher] dropping unserializable frame: ${e.message}`);
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        continue;
      }
      const socket = ws;
      try {
        socket.send(data, (err) => {
          if (err) {
            // Unconfirmed — leave it in the queue, retried on next connect.
            entry.sending = false;
            return;
          }
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
        });
      } catch {
        entry.sending = false;
      }
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(backoffBaseMs * (2 ** reconnectAttempts), backoffCapMs);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function markDown(socket) {
    if (socket !== ws) return; // stale handler from a socket we've already replaced
    connected = false;
    ws = null;
    for (const entry of queue) entry.sending = false;
    scheduleReconnect();
  }

  function connect() {
    if (closed) return;
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (e) {
      warn(`[journal-publisher] connect failed: ${e.message}`);
      scheduleReconnect();
      return;
    }
    ws = socket;
    connected = false;

    // Keepalive: a silently-dropped path (NAT/proxy discard, no FIN) leaves
    // this socket ESTABLISHED with no 'close'/'error' ever firing, so the
    // publisher would otherwise wait on it forever. Ping every interval; a
    // tick that arrives with no pong seen since the last ping declares the
    // socket dead and terminates it, which fires 'close' → markDown → the
    // normal reconnect-with-backoff path. Guarded on socket.ping existing so
    // an injected test transport without protocol pings simply opts out.
    if (typeof socket.ping === 'function' && keepaliveIntervalMs > 0) {
      let sawPongSinceLastPing = true;
      socket.on('pong', () => { sawPongSinceLastPing = true; });
      const keepaliveTimer = setInterval(() => {
        // Socket already replaced or torn down (close() removeAllListeners
        // also strips the 'close' cleanup below) — self-clear and stop.
        if (socket !== ws) { clearInterval(keepaliveTimer); return; }
        if (!sawPongSinceLastPing) {
          warn(`[journal-publisher] keepalive: no pong within ${keepaliveIntervalMs}ms — terminating half-open socket`);
          clearInterval(keepaliveTimer);
          try { socket.terminate(); } catch { /* already going down */ }
          return;
        }
        sawPongSinceLastPing = false;
        try { socket.ping(); } catch { /* CONNECTING or mid-teardown — next tick decides */ }
      }, keepaliveIntervalMs);
      if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
      socket.on('close', () => clearInterval(keepaliveTimer));
    }

    socket.on('open', () => {
      if (socket !== ws) return;
      try {
        // onEvent unset -> always live-only (cursor:null), matching this
        // module's original publish-only behavior exactly. onEvent set -> the
        // in-memory high-water mark (null until the first frame is ever seen,
        // e.g. no cursor file on first boot — live-only by construction).
        const cursor = onEvent ? lastSeq : null;
        socket.send(JSON.stringify({ op: 'hello', token, cursor }));
      } catch (e) {
        warn(`[journal-publisher] failed to send hello: ${e.message}`);
      }
    });

    socket.on('message', (data) => {
      if (socket !== ws) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'hello_ok') {
        connected = true;
        reconnectAttempts = 0;
        // New connection epoch: reset the per-code error-warning dedup so a
        // recurring (or recurring-looking) problem is logged once per
        // connection rather than once per publisher lifetime.
        warnedErrorCodes.clear();
        pump();
      } else if (msg.op === 'error') {
        const code = msg.code || 'unknown';
        if (!warnedErrorCodes.has(code)) {
          warnedErrorCodes.add(code);
          warn(`[journal-publisher] server error frame: ${JSON.stringify(msg)}`);
        }
      } else if (msg.op === 'snapshot_required') {
        // The replay gap from our persisted cursor is too large. Efficiency
        // valve, not a data-loss boundary (spec §6) — but we have no snapshot
        // consumer here, only a live-input stream, so the correct response is
        // to give up on replay and go live-only: reset the in-memory
        // high-water mark and rewrite the cursor file, so the NEXT hello (the
        // server also closes this socket with 4009 right after this frame,
        // which triggers the normal reconnect-with-backoff path) asks for
        // live traffic only rather than tripping the same valve forever.
        // Anything sent by the user during the now-abandoned gap is lost from
        // the input side — the journal itself still has it forever, just not
        // as a bridge input replay.
        warn('[journal-publisher] snapshot_required — input replay gap too large, resetting to live-only (client inputs sent during the gap were skipped)');
        lastSeq = null;
        cursorDirty = false;
        if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
        persistCursorNow();
      } else if (msg.kind === 'control' && msg.op === 'stream_resync') {
        if (onStreamResync) {
          try {
            onStreamResync(msg.convo_id, msg.message_ref, msg.have);
          } catch (e) {
            warn(`[journal-publisher] onStreamResync handler threw: ${e.message}`);
          }
        }
      } else if (msg.kind === 'rpc' && onRpcRequest) {
        const r = msg.request;
        if (r && typeof r === 'object' && typeof r.request_id === 'string'
            && Number.isInteger(r.from_device_id) && typeof r.method === 'string') {
          try {
            onRpcRequest(r);
          } catch (e) {
            warn(`[journal-publisher] onRpcRequest handler threw: ${e.message}`);
          }
        }
      } else if (msg.kind === 'journal' && onEvent) {
        const seq = msg.seq;
        if (typeof seq === 'number' && lastSeq != null && seq <= lastSeq) {
          return; // already delivered — replay overlap after a reconnect.
        }
        if (typeof seq === 'number') {
          lastSeq = seq;
          scheduleCursorPersist();
        }
        try {
          onEvent(msg);
        } catch (e) {
          warn(`[journal-publisher] onEvent handler threw: ${e.message}`);
        }
      }
      // All other inbound frames (ephemeral deltas, unrecognised control ops)
      // are intentionally ignored.
    });

    socket.on('close', () => markDown(socket));
    socket.on('error', (e) => {
      warn(`[journal-publisher] socket error: ${e.message}`);
      try { socket.terminate(); } catch { /* already going down */ }
    });
  }

  connect();

  function safePublish(convoId, type, payload) {
    try {
      enqueue({ op: 'publish', convo_id: convoId, type, payload, idem_key: randomUUID() });
    } catch (e) {
      warn(`[journal-publisher] publish${type} failed: ${e.message}`);
    }
  }

  // Not queued, unlike everything else here: a media blob has to actually
  // reach the journal server's blob store before the file/image publish that
  // references it means anything, so this is best-effort HTTP work done at
  // call time (POST /media, Bearer <agent token>, raw bytes). Every failure
  // mode — no base URL, missing bytes, network error, non-2xx response, a
  // response body that isn't the JSON we expect — resolves to null rather
  // than rejecting; callers are expected to skip the event publish when this
  // returns null (a file/image event without a blob is useless).
  async function uploadMedia({ bytes, filePath, contentType, name } = {}) {
    if (!mediaHttpBaseUrl) return null;
    try {
      let body = bytes;
      if (body == null && filePath) {
        body = await readFile(filePath);
      }
      if (body == null) {
        warn(`[journal-publisher] uploadMedia called with neither bytes nor filePath (name=${name || '(unnamed)'})`);
        return null;
      }
      const res = await fetch(`${mediaHttpBaseUrl}/media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType || 'application/octet-stream',
        },
        body,
      });
      if (!res.ok) {
        warn(`[journal-publisher] uploadMedia failed: HTTP ${res.status} (name=${name || '(unnamed)'})`);
        return null;
      }
      const data = await res.json();
      // A 2xx status alone doesn't guarantee a usable body — guard against a
      // response missing (or with a non-string) media_id, which would
      // otherwise flow into publishFile/publishImage as blob_ref: undefined.
      // Treat that the same as any other upload failure: null + one warn, so
      // the caller skips the event publish (see this function's own comment).
      if (typeof data.media_id !== 'string' || data.media_id.length === 0) {
        warn(`[journal-publisher] uploadMedia failed: response missing media_id (name=${name || '(unnamed)'})`);
        return null;
      }
      return {
        media_id: data.media_id,
        size: data.size,
        content_type: data.content_type,
        sha256: data.sha256,
      };
    } catch (e) {
      warn(`[journal-publisher] uploadMedia failed: ${e.message} (name=${name || '(unnamed)'})`);
      return null;
    }
  }

  // Counterpart to uploadMedia: fetch a previously-uploaded blob back OUT of
  // the journal's blob store by its id (GET /media/:id, Bearer <agent token>).
  // Used by the journal input path (lib/journal-input-router.js via
  // index.js's journalOnMedia) to materialize a client-sent
  // file/image/voice-note blob so it can be transcribed / saved / attached to
  // the claude prompt, mirroring the Matrix media download path
  // (downloadMatrixFile). Same fail-open contract as uploadMedia: every
  // failure mode — no base URL, a missing/blank blobRef, a network error, a
  // non-2xx response, an over-cap body — resolves to null (plus one warn)
  // rather than throwing; callers drop the media event when this returns null
  // (never inject an unresolvable placeholder into the prompt). The download
  // is capped at fetchMediaMaxBytes: a blob whose declared or actual length
  // exceeds the cap is aborted and dropped, so a hostile/accidental huge
  // upload can't OOM the bridge.
  async function fetchMedia(blobRef) {
    if (!mediaHttpBaseUrl) return null;
    if (typeof blobRef !== 'string' || blobRef.length === 0) {
      warn('[journal-publisher] fetchMedia called with no blob_ref');
      return null;
    }
    const controller = new AbortController();
    try {
      const res = await fetch(`${mediaHttpBaseUrl}/media/${encodeURIComponent(blobRef)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        warn(`[journal-publisher] fetchMedia failed: HTTP ${res.status} (blob_ref=${blobRef})`);
        return null;
      }
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      // Reject an over-cap blob by its declared length before reading a byte,
      // and abort the transfer so we don't drain a huge body just to discard it.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > fetchMediaMaxBytes) {
        warn(`[journal-publisher] fetchMedia aborted: blob ${declared} bytes exceeds ${fetchMediaMaxBytes} cap (blob_ref=${blobRef})`);
        try { controller.abort(); } catch { /* best effort */ }
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      // Second guard for a chunked response that never declared a length.
      if (buffer.length > fetchMediaMaxBytes) {
        warn(`[journal-publisher] fetchMedia aborted: blob ${buffer.length} bytes exceeds ${fetchMediaMaxBytes} cap (blob_ref=${blobRef})`);
        return null;
      }
      return { buffer, contentType };
    } catch (e) {
      warn(`[journal-publisher] fetchMedia failed: ${e.message} (blob_ref=${blobRef})`);
      return null;
    }
  }

  return {
    upsertConvo(convoId, opts) {
      // Destructuring happens inside the try, not in the parameter list: a
      // caller passing `null` (as opposed to omitting the arg / passing
      // undefined) would otherwise throw before fail-open protection kicks in.
      try {
        const { title, sessionState, parentConvoId } = opts || {};
        const frame = { op: 'convo_upsert', convo_id: convoId };
        if (title !== undefined) frame.title = title;
        if (sessionState !== undefined) frame.session_state = sessionState;
        // parent_convo_id links a subagent child conversation to its parent
        // (spec: subagent sub-chats). Immutable server-side — set once at the
        // child's creation, ignored on later upserts — so re-sending it on a
        // child's subsequent upserts is safe. Only emitted when a caller
        // actually passes one, so a plain conversation's frame is unchanged.
        if (parentConvoId !== undefined) frame.parent_convo_id = parentConvoId;
        enqueue(frame);
      } catch (e) {
        warn(`[journal-publisher] upsertConvo failed: ${e.message}`);
      }
    },
    publishText(convoId, payload) {
      safePublish(convoId, 'text', payload);
    },
    publishPrompt(convoId, payload) {
      safePublish(convoId, 'prompt', payload);
    },
    publishToolOutput(convoId, payload) {
      safePublish(convoId, 'tool_output', payload);
    },
    publishDiff(convoId, payload) {
      safePublish(convoId, 'diff', payload);
    },
    publishFile(convoId, payload) {
      safePublish(convoId, 'file', payload);
    },
    publishImage(convoId, payload) {
      safePublish(convoId, 'image', payload);
    },
    // EPHEMERAL — the opposite of every method above. A typing/activity
    // indicator ('thinking' | 'tool' | 'idle') is only meaningful live: a
    // dropped one is harmless (the next state change repaints it), but a
    // queued one replayed minutes later after a reconnect would show the
    // user a stale "Claude is thinking…" long after the turn actually
    // ended — worse than not sending it at all. So, unlike safePublish
    // above: no enqueue (bypasses `queue`/`pump` entirely), no idem_key (an
    // ephemeral has no identity to dedupe by), no resend on reconnect. Fires
    // the frame immediately if the socket is connected (i.e. past hello_ok);
    // otherwise drops it silently. Still fails open like everything else
    // here — a throw here must never reach index.js's hot path.
    publishActivity(convoId, state, detail) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'activity', convo_id: convoId, state };
        if (detail !== undefined) frame.detail = detail;
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable activity frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] publishActivity failed: ${e.message}`);
      }
    },
    // EPHEMERAL — same never-queued/never-replayed contract as
    // publishActivity above. `status` is the session's header data (model,
    // context gauge, rate limits — see lib/session-status.js): only the
    // latest one means anything, so a dropped frame is harmless (the next
    // turn end repaints it) and a replayed stale one would be wrong. The
    // journal server additionally caches the last status per convo and
    // replays it to clients when they start viewing, so "ephemeral" here
    // doesn't cost the header its populate-on-open.
    publishStatus(convoId, status) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'status', convo_id: convoId, status };
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable status frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] publishStatus failed: ${e.message}`);
      }
    },
    // Agent-RPC response — EPHEMERAL, the publishActivity contract exactly:
    // never queued, never retried, never replayed. The journal relay is
    // stateless and the requesting client owns its timeout, so a response
    // that can't go out right now is worthless by the time we reconnect.
    // The answer-every-request guarantee lives in the HANDLER
    // (lib/journal-rpc.js), which relies on this method never throwing.
    respondRpc({ requestId, toDeviceId, ok, result, error }) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'agent_response', request_id: requestId, to_device_id: toDeviceId, ok: !!ok };
        if (ok) frame.result = result ?? null;
        else frame.error = error;
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable agent_response frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] respondRpc failed: ${e.message}`);
      }
    },
    // EPHEMERAL, throttled — in-progress assistant text for viewing clients.
    // Same never-queued/never-replayed contract as publishActivity, plus
    // bridge-side latest-wins coalescing per (convoId, messageRef): the first
    // call in an idle window sends immediately (leading edge); calls within the
    // window replace a single pending frame flushed on the trailing edge. A
    // dropped/coalesced frame is harmless — replace_text always carries the
    // full cumulative text, so the next frame (or the durable final message)
    // supersedes it. `replaceText` is the whole message text so far, NOT a
    // delta (see the wire-contract comment above). Fails open; no idem_key.
    stream(convoId, messageRef, replaceText) {
      try {
        if (closed) return;
        if (convoId == null || messageRef == null) return;
        const text = typeof replaceText === 'string' ? replaceText : String(replaceText ?? '');
        const key = streamKey(convoId, messageRef);
        let st = streamThrottle.get(key);
        if (!st) {
          st = { convoId, messageRef, lastAt: 0, pending: null, timer: null };
          streamThrottle.set(key, st);
        }
        const now = Date.now();
        const elapsed = now - st.lastAt;
        if (!st.timer && elapsed >= streamIntervalMs) {
          // Leading edge: nothing sent recently, so go out now.
          st.pending = null;
          if (sendStreamFrame(convoId, messageRef, text)) st.lastAt = now;
        } else {
          // Inside the window (or a trailing flush is already scheduled):
          // coalesce to the latest text and let the timer flush it.
          st.pending = text;
          if (!st.timer) {
            st.timer = setTimeout(() => {
              st.timer = null;
              if (st.pending == null) return;
              const t = st.pending;
              st.pending = null;
              if (sendStreamFrame(st.convoId, st.messageRef, t)) st.lastAt = Date.now();
            }, Math.max(0, streamIntervalMs - elapsed));
            if (typeof st.timer.unref === 'function') st.timer.unref();
          }
        }
      } catch (e) {
        warn(`[journal-publisher] stream failed: ${e.message}`);
      }
    },
    // End a streaming overlay. ALWAYS discards any pending/scheduled trailing
    // frame for this ref (so a stale coalesced frame can't land after the turn
    // finalizes — the invariant the brief calls out). With {clear:true} it also
    // fires one final empty replace_text so the client collapses a still-open
    // overlay whose turn produced no durable final message (interruption /
    // session exit mid-stream) — the "no dangling overlay" case. Fails open.
    endStream(convoId, messageRef, opts) {
      try {
        const clear = !!(opts && opts.clear);
        const key = streamKey(convoId, messageRef);
        const st = streamThrottle.get(key);
        if (st) {
          if (st.timer) { clearTimeout(st.timer); st.timer = null; }
          streamThrottle.delete(key);
        }
        if (clear) sendStreamFrame(convoId, messageRef, '');
      } catch (e) {
        warn(`[journal-publisher] endStream failed: ${e.message}`);
      }
    },
    // EPHEMERAL — one live tool-output chunk (op stream_append). Same
    // never-queued/never-replayed contract as publishActivity: fires
    // immediately if the socket is live (past hello_ok), otherwise drops
    // silently. A dropped frame self-heals: the server answers the resulting
    // offset gap with stream_resync and the pump re-reads from its log file
    // (see lib/tool-stream-pump.js). NO bridge-side throttle or coalescing
    // here — the pump owns pacing, and appends must never be latest-wins
    // coalesced: unlike replace_text snapshots, a swallowed delta would be a
    // permanent gap. meta rides only on buffer-creating (offset 0) frames.
    streamAppend(convoId, messageRef, offset, chunk, meta) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'stream_append', convo_id: convoId, message_ref: messageRef, offset, chunk };
        if (meta !== undefined) frame.meta = meta;
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable stream_append frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] streamAppend failed: ${e.message}`);
      }
    },
    // DURABLE tool-output completion (op finalize, type tool_output) — the
    // event whose payload.message_ref retires the live overlay and whose
    // arrival frees the server-side stream buffer. Queued FIFO and re-sent on
    // reconnect like every publish; safe because the server composes the idem
    // key itself (`agent:<device>:fin:<message_ref>`), so a retry can't
    // double-publish. blob_ref rides at the TOP LEVEL as well as inside the
    // payload: the top-level copy sets the event row's blob_ref COLUMN (what
    // the server's retention TTL scan keys on); the payload copy is the
    // client-visible one. Unlike the assistant-text flow (which uses publish +
    // payload.message_ref — see the wire-contract comment at the top of this
    // file), tool_output completions genuinely need finalize: it is the only
    // op that both frees the stream buffer and carries the blob_ref column.
    finalizeToolOutput(convoId, messageRef, payload, blobRef) {
      try {
        enqueue({
          op: 'finalize', convo_id: convoId, type: 'tool_output',
          message_ref: messageRef, payload, blob_ref: blobRef ?? null,
        });
      } catch (e) {
        warn(`[journal-publisher] finalizeToolOutput failed: ${e.message}`);
      }
    },
    // No idem_key: re-sending after a reconnect is a harmless re-mark (the
    // server just advances the same read marker again), so this doesn't need
    // the dedup that idem_key gives publishes. Otherwise identical to every
    // other frame here — enqueued FIFO, confirmed on ws.send's callback,
    // re-sent on reconnect if it was never confirmed.
    markRead(convoId) {
      try {
        enqueue({ op: 'read_marker', convo_id: convoId, up_to_seq: null });
      } catch (e) {
        warn(`[journal-publisher] markRead failed: ${e.message}`);
      }
    },
    uploadMedia,
    fetchMedia,
    // Force the inbound cursor to disk NOW, bypassing the debounce. Called by
    // index.js right after dispatching a control-convo command or a
    // prompt_reply: those inputs have side effects (a session spawned, a
    // prompt answered), so an ungraceful crash inside the ~1s debounce window
    // must not replay them on restart as if they never happened. Same
    // fails-open contract as everything else here.
    flushCursor() {
      try {
        if (cursorTimer) {
          clearTimeout(cursorTimer);
          cursorTimer = null;
        }
        if (cursorDirty) persistCursorNow();
      } catch { /* flushCursor() must never throw */ }
    },
    close() {
      try {
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (cursorTimer) {
          clearTimeout(cursorTimer);
          cursorTimer = null;
        }
        // Cancel any scheduled trailing stream flushes so close() leaves no
        // live timers behind.
        for (const st of streamThrottle.values()) {
          if (st.timer) { try { clearTimeout(st.timer); } catch { /* best effort */ } }
        }
        streamThrottle.clear();
        if (cursorDirty) persistCursorNow();
        if (ws) {
          const socket = ws;
          ws = null;
          try { socket.removeAllListeners(); } catch { /* best effort */ }
          // terminate() on a still-CONNECTING socket makes `ws` emit 'error'
          // ("closed before the connection was established") — with all
          // listeners just removed that would be an uncaught exception, so
          // re-attach a swallow-all handler first.
          try { socket.on('error', () => {}); } catch { /* best effort */ }
          try { socket.terminate(); } catch { /* best effort */ }
        }
      } catch { /* close() must never throw */ }
    },
  };
}
