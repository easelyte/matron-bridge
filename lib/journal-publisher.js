import { createHash, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';

import { atomicWriteFileSync } from './atomic-write.js';
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
// Bounded settle window for gracefulShutdown().flush() — resolves when the
// outbound queue drains or this elapses, whichever first, so a dead socket can't
// hang shutdown. Comfortably inside systemd's 90s TimeoutStopSec default.
export const FLUSH_TIMEOUT_MS = 2000;
const DEFAULT_PENDING_REPAIR_LIMIT = 5000;
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
export const PEER_MESSAGE_RETRY_HORIZON_MS = 30000;

// JSON array serialization is the shared canonical tuple encoding for the
// peer-message producer. Its element boundaries make ("ab","c","d") distinct
// from ("a","bc","d"), unlike plain concatenation. SHA-256 keeps the wire key
// comfortably under the journal's 128-character cap.
export function peerMessageIdemKey(fromConvo, targetConvo, body) {
  return createHash('sha256')
    .update(JSON.stringify([fromConvo, targetConvo, body]))
    .digest('hex');
}

function noopPublisher() {
  return {
    upsertConvo() { return true; },
    upsertConvoBestEffort() { return true; },
    publishText() { return true; },
    publishTextBestEffort() { return true; },
    publishPrompt() {},
    publishPermissionRequest() { return false; },
    publishPromptReply() {},
    publishToolOutput() {},
    publishDiff() {},
    publishFile() {},
    publishImage() {},
    publishSummary() {},
    publishActivity() {},
    publishStatus() { return false; },
    publishHostVitals() { return false; },
    respondRpc() {},
    stream() {},
    endStream() {},
    streamAppend() {},
    finalizeToolOutput() {},
    markRead() {},
    uploadMedia() { return null; },
    fetchMedia() { return null; },
    async sendPeerMessage() { return { queued: false, uncertain: true }; },
    sendRoomOp() { return false; },
    identity() { return null; },
    async fetchRoster() { return null; },
    async fetchMessages() { return null; },
    hasQueuedIdem() { return false; },
    flush() { return Promise.resolve({ drained: true }); },
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
  pendingRepairLimit = Math.min(DEFAULT_PENDING_REPAIR_LIMIT, queueLimit),
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
  // Inbound agent-chat invite dispatch (journal protocol.md "Agent chat
  // rooms > Delivery"): when set, every inbound `{kind:'invite'}` frame with
  // a string `event` and string `room_id` is handed to this callback. These
  // frames are ephemeral — no seq, never journaled — so they never touch the
  // cursor/replay machinery. Unset: ignored like any other unrecognised
  // frame. Wrapped in try/catch like onEvent.
  onInviteFrame,
  // Inbound agent-spawn dispatch (docs/superpowers/specs/
  // 2026-08-10-agent-spawn-bridge-capacity-design.md): when set, every
  // inbound `{kind:'spawn'}` frame with a string `event` is handed to this
  // callback. Ephemeral like onInviteFrame — no seq, never journaled, unset
  // means the frame is ignored. Wrapped in try/catch like the others.
  onSpawnFrame,
  // Inbound op-error dispatch: when set, every inbound
  // `{kind:'control', op:'error'}` frame is ALSO handed to this callback as
  // `{code, ref, detail, roomId}`, after the existing warn-once logging.
  // `roomId` is the frame's `room_id` when the journal stamps one (newer
  // journals echo the failing room op's room_id); null otherwise, so
  // consumers can fall back to ref-level correlation against older
  // journals. Lets the agent-chat invite manager correlate a rejected room
  // op (ref: 'agent_invite' etc.) back to its waiting tool call. Wrapped in
  // try/catch — a throwing handler never kills the socket handler.
  onOpError,
  // Connection-epoch hook. Fired once for every accepted `hello_ok`, after
  // the publisher is marked connected, so callers can safely enqueue repair
  // frames that were lost during a deploy skew. Unset preserves the existing
  // behavior.
  onReconnect,
  // Send-completion hook (queued-release durability, spec §3 step 6). Fired
  // once each time pump() confirms a send and the outbound queue has headroom
  // (length < queueLimit). This is the MANDATORY retry trigger that re-publishes
  // an overflow-evicted release frame on a HEALTHY socket that never reconnects
  // — the failure a reconnect-only design misses. Coalescing/dedup is the
  // caller's job (the retry driver's in-progress flag + deterministic idem_key).
  onSendCapacity,
  // Where the highest seq seen is persisted (debounced) so a restart resumes
  // input from where it left off instead of reconnecting live-only forever.
  // Only meaningful when onEvent is set.
  cursorFile,
  cursorDebounceMs = DEFAULT_CURSOR_DEBOUNCE_MS,
  // Dead-connection detection cadence (see DEFAULT_KEEPALIVE_INTERVAL_MS).
  keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
  // Test seam for the peer-message transport horizon. Production never
  // overrides the 30s cap; even a larger supplied value is clamped to it so a
  // retransmit cannot approach the journal's 120s dedup-window boundary.
  peerMessageRetryHorizonMs = PEER_MESSAGE_RETRY_HORIZON_MS,
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
  // Reconnect repairs yield to an existing outage backlog, but they must not
  // disappear just because the bounded queue is full at hello_ok time. Map
  // insertion order is their FIFO; a repeated repair for the same conversation
  // refreshes its frame without moving it behind later repairs.
  const pendingRepairs = new Map();
  // Registered flush() waiters — re-checked on every confirmed send so an
  // awaiting gracefulShutdown resolves as soon as the queue drains.
  const flushWaiters = new Set();
  const boundedPendingRepairLimit = Number.isInteger(pendingRepairLimit) && pendingRepairLimit >= 0
    ? pendingRepairLimit
    : Math.min(DEFAULT_PENDING_REPAIR_LIMIT, queueLimit);
  const boundedPeerMessageRetryHorizonMs = Number.isFinite(peerMessageRetryHorizonMs)
    ? Math.max(0, Math.min(peerMessageRetryHorizonMs, PEER_MESSAGE_RETRY_HORIZON_MS))
    : PEER_MESSAGE_RETRY_HORIZON_MS;
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
  // This bridge's own agent identity, captured from a hello_ok that carries
  // device_id/name (journal Phase 3+). Stays null forever against an older
  // journal — consumers (the room input path's own-echo guard) treat null as
  // "unknown" and fail CLOSED.
  let identity = null;

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
      // Atomic replace (PR #151 follow-up): a truncating rewrite that dies
      // mid-write leaves a corrupt cursor file, which loadPersistedCursor
      // treats as "first boot" — replaying the overlap window as input.
      atomicWriteFileSync(cursorFile, JSON.stringify({ cursor: lastSeq }));
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
  // The journal high-water at process start (persisted cursor), captured once
  // and immutable for this process lifetime. Any frame with seq <= this was
  // published before this bridge started; a prompt_reply targeting such a seq
  // is answering a prompt whose asking session is gone (the ghost-answer
  // window — see the router's processStartSeq handling). Null on first boot
  // (no persisted cursor) or when this instance has no onEvent consumer.
  const startSeq = onEvent ? lastSeq : null;

  function enqueue(frame, onDelivered, onEvicted) {
    const entry = { frame, sending: false, onDelivered, onEvicted, evicted: false };
    queue.push(entry);
    if (queue.length > queueLimit) {
      const dropped = queue.shift();
      if (dropped) {
        dropped.evicted = true;
        try { dropped.onEvicted?.(); }
        catch (e) { warn(`[journal-publisher] eviction callback failed: ${e?.message ?? String(e)}`); }
      }
      if (!overflowActive) {
        overflowActive = true;
        warn(`[journal-publisher] queue overflow (>${queueLimit} frames) — dropping oldest`);
      }
    } else if (overflowActive) {
      overflowActive = false;
    }
    pump();
    return !entry.evicted;
  }

  // Remove one bounded-retry frame without disturbing FIFO order for the rest
  // of the durable queue. A late ws.send callback may still arrive, but the
  // caller's settle-once guard ignores it after the horizon has fired.
  function expireQueuedFrame(frame) {
    const idx = queue.findIndex((entry) => entry.frame === frame);
    if (idx === -1) return false;
    const [entry] = queue.splice(idx, 1);
    entry.evicted = true;
    entry.sending = false;
    drainPendingRepairs();
    queueMicrotask(pump);
    return true;
  }

  function drainPendingRepairs() {
    while (queue.length < queueLimit && pendingRepairs.size > 0) {
      const [repairKey, repair] = pendingRepairs.entries().next().value;
      pendingRepairs.delete(repairKey);
      queue.push({ ...repair, sending: false });
    }
  }

  // Reconnect-only repairs are idempotent. Unlike normal durable traffic,
  // they must never evict an older queued frame when the bounded queue is
  // already full; retain them in FIFO order until send confirmations create
  // headroom on this same connection.
  function enqueueBestEffort(frame, onDelivered) {
    if (queue.length >= queueLimit || pendingRepairs.size > 0) {
      const repairKey = frame.idem_key || `${frame.op}:${frame.convo_id}`;
      if (!pendingRepairs.has(repairKey) && pendingRepairs.size >= boundedPendingRepairLimit) {
        warn(`[journal-publisher] pending repair overflow (>=${boundedPendingRepairLimit} frames) — retry deferred until reconnect`);
        return false;
      }
      pendingRepairs.set(repairKey, { frame, onDelivered });
      return false;
    }
    queue.push({ frame, sending: false, onDelivered });
    pump();
    return true;
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
        drainPendingRepairs();
        queueMicrotask(pump);
        continue;
      }
      const socket = ws;
      try {
        socket.send(data, (err) => {
          if (err) {
            // Unconfirmed — leave it in the queue, retried on next connect.
            entry.sending = false;
            // peer_message has a bounded retry horizon, so do not wait for a
            // separate close event that a broken transport may never emit.
            // Tearing down this failed socket enters the normal reconnect path
            // and retransmits the exact queued frame/key inside the horizon.
            if (!entry.evicted && entry.frame?.op === 'peer_message') {
              try { socket.terminate(); } catch { /* close may already be in flight */ }
            }
            return;
          }
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
          try { entry.onDelivered?.(); }
          catch (e) { warn(`[journal-publisher] delivery callback failed: ${e?.message ?? String(e)}`); }
          drainPendingRepairs();
          // Notify flush() waiters + fire the send-completion retry trigger once
          // the queue drains / regains headroom (queued-release durability).
          if (queue.length === 0 && flushWaiters.size > 0) {
            for (const w of [...flushWaiters]) { try { w(); } catch { /* waiter cleanup is its own concern */ } }
          }
          if (queue.length < queueLimit && typeof onSendCapacity === 'function') {
            try { onSendCapacity(); }
            catch (e) { warn(`[journal-publisher] onSendCapacity handler threw: ${e?.message ?? String(e)}`); }
          }
          // send callbacks may be synchronous in injected transports. Defer
          // the next pass so the current queue snapshot finishes in FIFO order
          // without recursively growing the stack.
          queueMicrotask(pump);
        });
      } catch {
        entry.sending = false;
        if (!entry.evicted && entry.frame?.op === 'peer_message') {
          try { socket.terminate(); } catch { /* close may already be in flight */ }
        }
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
        // Identity from the journal (Phase 3): only overwrite when the frame
        // actually carries a well-formed pair, so a transient hello_ok from
        // an older server can't null out a previously-captured identity.
        identity = (Number.isInteger(msg.device_id) && typeof msg.name === 'string')
          ? { deviceId: msg.device_id, name: msg.name }
          : identity;
        if (onReconnect) {
          try {
            onReconnect();
          } catch (e) {
            warn(`[journal-publisher] onReconnect handler threw: ${e?.message ?? String(e)}`);
          }
        }
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
        if (onOpError) {
          try { onOpError({ code: msg.code, ref: msg.ref, detail: msg.detail, roomId: typeof msg.room_id === 'string' && msg.room_id ? msg.room_id : null }); } catch { /* handler's problem, not the socket's */ }
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
      } else if (msg.kind === 'invite' && onInviteFrame) {
        // Ephemeral invite-lifecycle relay (journal protocol.md "Agent chat
        // rooms > Delivery"): no seq, never journaled — so no dedupe/cursor.
        if (typeof msg.event === 'string' && typeof msg.room_id === 'string') {
          try {
            onInviteFrame(msg);
          } catch (e) {
            warn(`[journal-publisher] onInviteFrame handler threw: ${e.message}`);
          }
        }
      } else if (msg.kind === 'spawn' && onSpawnFrame) {
        // Ephemeral agent-spawn relay: no seq, never journaled — same as the
        // invite branch above. request_id gated here, at the one entry
        // point: every spawn frame correlates by it (pending/targets ->
        // waiter maps, outcome -> pendingSpawns + the parent notice), so a
        // frame without one could only mis-key those maps — worst case an
        // 'undefined'-keyed tombstone and a "Spawn undefined" notice. 128 =
        // the wire contract's request_id cap.
        if (typeof msg.event === 'string'
            && typeof msg.request_id === 'string' && msg.request_id && msg.request_id.length <= 128) {
          try {
            onSpawnFrame(msg);
          } catch (e) {
            warn(`[journal-publisher] onSpawnFrame handler threw: ${e.message}`);
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

  function safePublish(convoId, type, payload, options) {
    try {
      const { idemKey, onDelivered, onEvicted } = options || {};
      return enqueue({
        op: 'publish',
        convo_id: convoId,
        type,
        payload,
        idem_key: typeof idemKey === 'string' && idemKey ? idemKey : randomUUID(),
      },
        typeof onDelivered === 'function' ? onDelivered : undefined,
        typeof onEvicted === 'function' ? onEvicted : undefined);
    } catch (e) {
      warn(`[journal-publisher] publish${type} failed: ${e?.message ?? String(e)}`);
      return false;
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
  async function uploadMedia({ bytes, filePath, contentType, name, timeoutMs } = {}) {
    if (!mediaHttpBaseUrl) return null;
    const controller = new AbortController();
    const timeout = timeoutMs == null
      ? null
      : setTimeout(() => controller.abort(), timeoutMs);
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
        signal: controller.signal,
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
    } finally {
      if (timeout !== null) clearTimeout(timeout);
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

  // Shared shape for the agent-chat JSON GETs below (GET /roster and
  // GET /convo/:id/messages): Bearer auth against the derived HTTP base URL,
  // a 10s abort timeout, and the uploadMedia convention — every failure mode
  // (no base URL, network error, non-2xx, non-JSON body) resolves to null
  // plus one warn, never a throw/reject.
  async function fetchJson(pathAndQuery, label) {
    if (!mediaHttpBaseUrl) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, 10_000);
    if (typeof timeout.unref === 'function') timeout.unref();
    try {
      const res = await fetch(`${mediaHttpBaseUrl}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        warn(`[journal-publisher] ${label} failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        warn(`[journal-publisher] ${label} failed: non-object response body`);
        return null;
      }
      return data;
    } catch (e) {
      warn(`[journal-publisher] ${label} failed: ${e.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // GET /roster — the journal's agent-chat targeting surface: this user's
  // agent devices and their conversations ({agents, conversations}), or null
  // on any failure.
  async function fetchRoster() {
    return fetchJson('/roster', 'fetchRoster');
  }

  // GET /convo/:id/messages — agent-gated room-message read ({events}), or
  // null on any failure. before_seq is omitted (not sent as null) when the
  // caller doesn't page backwards.
  async function fetchMessages(convoId, { beforeSeq = null, limit = 50 } = {}) {
    const params = new URLSearchParams();
    if (beforeSeq != null) params.set('before_seq', String(beforeSeq));
    params.set('limit', String(limit));
    return fetchJson(`/convo/${encodeURIComponent(convoId)}/messages?${params}`, 'fetchMessages');
  }

  return {
    // Journal high-water at process start (see `startSeq` above). Read by
    // index.js to seed the router's ghost-answer refusal boundary.
    startSeq,
    upsertConvo(convoId, opts, options) {
      // Destructuring happens inside the try, not in the parameter list: a
      // caller passing `null` (as opposed to omitting the arg / passing
      // undefined) would otherwise throw before fail-open protection kicks in.
      try {
        const { title, sessionState, parentConvoId, summary, sessionOutcome, agentKind } = opts || {};
        const frame = { op: 'convo_upsert', convo_id: convoId };
        if (title !== undefined) frame.title = title;
        if (sessionState !== undefined) frame.session_state = sessionState;
        // Which backend runs this conversation ('claude' | 'codex'), so clients
        // can mark codex vs claude on top-level rows (loop #619). Omit-don't-null
        // like summary/session_outcome: only carried when a caller supplies it,
        // and the server COALESCEs an omitted field, leaving the recorded kind
        // untouched.
        if (agentKind !== undefined) frame.agent_kind = agentKind;
        // Rolling conversation summary for the agent roster (journal
        // protocol.md "Agent chat rooms"). Same omit-don't-null discipline as
        // title: only carried when a caller actually passes one, so every
        // other upsert path leaves the server's existing summary untouched
        // (the server COALESCEs an omitted field).
        if (summary !== undefined) frame.summary = summary;
        // parent_convo_id links a subagent child conversation to its parent
        // (spec: subagent sub-chats). Immutable server-side — set once at the
        // child's creation, ignored on later upserts — so re-sending it on a
        // child's subsequent upserts is safe. Only emitted when a caller
        // actually passes one, so a plain conversation's frame is unchanged.
        if (parentConvoId !== undefined) frame.parent_convo_id = parentConvoId;
        // Codex children persist their terminal outcome separately from the
        // server's fixed session_state enum. Omit the key for every existing
        // caller (including subagents) unless it was explicitly supplied.
        if (sessionOutcome !== undefined) frame.session_outcome = sessionOutcome;
        // Optional onDelivered fires only after the server confirms the send
        // (see pump()), letting a caller treat a durable record as a
        // write-ahead log it clears only once the transition is delivered
        // (subagent finish() removal). Absent for every legacy caller.
        const onDelivered = typeof options?.onDelivered === 'function' ? options.onDelivered : undefined;
        enqueue(frame, onDelivered);
        return true;
      } catch (e) {
        warn(`[journal-publisher] upsertConvo failed: ${e?.message ?? String(e)}`);
        return false;
      }
    },
    // Used by reconnect repair fan-out only. A full queue means the outage
    // backlog goes first; the repair is retained and admitted in FIFO order as
    // confirmations free capacity, without waiting for another reconnect.
    upsertConvoBestEffort(convoId, opts, options) {
      try {
        const { title, sessionState, parentConvoId, sessionOutcome, agentKind } = opts || {};
        const frame = { op: 'convo_upsert', convo_id: convoId };
        if (title !== undefined) frame.title = title;
        if (sessionState !== undefined) frame.session_state = sessionState;
        if (parentConvoId !== undefined) frame.parent_convo_id = parentConvoId;
        if (sessionOutcome !== undefined) frame.session_outcome = sessionOutcome;
        if (agentKind !== undefined) frame.agent_kind = agentKind;
        // onDelivered rides the pending-repair record too, so it fires whether
        // the frame goes straight onto the live queue or is retained for a
        // later drain (reconciliation clears its store record only on confirmed
        // delivery — a capacity-rejected send leaves it for retry).
        const onDelivered = typeof options?.onDelivered === 'function' ? options.onDelivered : undefined;
        return enqueueBestEffort(frame, onDelivered);
      } catch (e) {
        warn(`[journal-publisher] best-effort upsertConvo failed: ${e?.message ?? String(e)}`);
        return false;
      }
    },
    publishText(convoId, payload, options) {
      return safePublish(convoId, 'text', payload, options);
    },
    publishTextBestEffort(convoId, payload, options) {
      try {
        const { idemKey, onDelivered } = options || {};
        return enqueueBestEffort({
          op: 'publish',
          convo_id: convoId,
          type: 'text',
          payload,
          idem_key: typeof idemKey === 'string' && idemKey ? idemKey : randomUUID(),
        }, typeof onDelivered === 'function' ? onDelivered : undefined);
      } catch (e) {
        warn(`[journal-publisher] best-effort publishText failed: ${e?.message ?? String(e)}`);
        return false;
      }
    },
    publishPrompt(convoId, payload) {
      return safePublish(convoId, 'prompt', payload);
    },
    publishPromptReply(convoId, payload, options) {
      // options ({idemKey, onDelivered, onEvicted}) threads a deterministic
      // idem_key for queued-release durability (spec §2); omitted by every other
      // caller, which keeps the random-UUID behavior (safePublish :567).
      safePublish(convoId, 'prompt_reply', payload, options);
    },
    // Queued-release retry driver support: is a frame with this idem_key already
    // sitting in the outbound queue? Lets the driver avoid double-enqueuing a
    // release whose frame is still pending (acceptance §1). Cheap linear scan of
    // the bounded queue.
    hasQueuedIdem(idemKey) {
      if (typeof idemKey !== 'string' || !idemKey) return false;
      return queue.some((entry) => entry?.frame?.idem_key === idemKey);
    },
    // Bounded shutdown settle: resolves when the outbound queue drains or
    // timeoutMs elapses (spec §4). A dead socket cannot hang shutdown.
    flush({ timeoutMs = FLUSH_TIMEOUT_MS } = {}) {
      if (queue.length === 0) return Promise.resolve({ drained: true });
      return new Promise((resolve) => {
        let done = false;
        const finish = (drained) => {
          if (done) return;
          done = true;
          flushWaiters.delete(check);
          clearTimeout(timer);
          resolve({ drained });
        };
        const check = () => { if (queue.length === 0) finish(true); };
        const timer = setTimeout(() => finish(false), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        flushWaiters.add(check);
        pump(); // nudge in case the socket is live but idle
      });
    },
    publishPermissionRequest(convoId, payload, options) {
      return safePublish(convoId, 'permission_request', payload, options);
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
    publishSummary(convoId, payload) {
      safePublish(convoId, 'summary', payload);
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
    // Returns true only when the frame was actually handed to the socket —
    // callers throttling on "last published" must not count dropped frames
    // (socket down, unserializable payload) against their repaint window.
    publishStatus(convoId, status) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return false;
        const frame = { op: 'status', convo_id: convoId, status };
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable status frame: ${e.message}`);
          return false;
        }
        ws.send(data);
        return true;
      } catch (e) {
        warn(`[journal-publisher] publishStatus failed: ${e.message}`);
        return false;
      }
    },
    // EPHEMERAL host-level telemetry — same never-queued/never-replayed
    // contract as publishStatus above, but NOT scoped to any convo. `vitals`
    // is host CPU/RAM sampled on a ~5s timer decoupled from turns; only the
    // latest reading means anything, so a dropped frame is harmless (the next
    // tick repaints it) and a replayed stale one would be wrong. No convo_id:
    // this is a single host-wide gauge, not per-session header data.
    publishHostVitals(vitals) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'host_vitals', vitals };
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable host_vitals frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] publishHostVitals failed: ${e.message}`);
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
    fetchRoster,
    fetchMessages,
    // This bridge's own agent identity ({deviceId, name}) as reported by the
    // journal's hello_ok, or null against a journal that predates identity
    // (or before the first successful handshake). Read by the room input
    // path's own-echo guard, which fails closed on null.
    identity() {
      return identity;
    },
    // Durable peer coordination uses the agent WebSocket directly. Unlike the
    // ordinary indefinitely-replayed journal mirror queue, this frame has a
    // hard transport horizon shorter than the server's 120s dedup window. The
    // same frame object (and therefore the same content-derived idem_key) stays
    // queued across reconnects until ws.send confirms it or the horizon expires.
    sendPeerMessage({ targetConvo, fromConvo, body, priority } = {}) {
      try {
        const frame = {
          op: 'peer_message',
          target_convo: targetConvo,
          from_convo: fromConvo,
          body,
          idem_key: peerMessageIdemKey(fromConvo, targetConvo, body),
          // Only carry the key when true — the journal reconstructs the stored payload
          // field-by-field and includes priority only when present, so a normal peer
          // message keeps its 4-key payload (the byte-identical cross-repo fixture is
          // a non-priority message and stays unchanged). Idem key intentionally excludes
          // priority: a same-body priority re-send within the 120s window dedupes.
          ...(priority === true ? { priority: true } : {}),
        };
        return new Promise((resolve) => {
          let settled = false;
          let timer = null;
          const finish = (outcome) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(outcome);
          };
          timer = setTimeout(() => {
            expireQueuedFrame(frame);
            warn('[journal-publisher] peer_message transport retry horizon exhausted; delivery uncertain');
            finish({ queued: false, uncertain: true });
          }, boundedPeerMessageRetryHorizonMs);

          const accepted = enqueue(
            frame,
            () => finish({ sent: true }),
            () => finish({ queued: false, uncertain: true }),
          );
          if (!accepted) finish({ queued: false, uncertain: true });
        });
      } catch (e) {
        warn(`[journal-publisher] sendPeerMessage failed: ${e?.message ?? String(e)}`);
        return Promise.resolve({ queued: false, uncertain: true });
      }
    },
    // Direct agent-chat room-op send (agent_invite / agent_join /
    // agent_invite_ack / agent_invite_answer / agent_leave — callers build
    // the exact frames; the invite manager owns the shapes). Room-op sends
    // are deliberately NOT queued: a stale agent_invite delivered minutes
    // after a reconnect would fire a consent prompt nobody asked for.
    // Connected-or-refuse, same stance as the ephemerals.
    sendRoomOp(frame) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame));
        return true;
      } catch { return false; }
    },
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
