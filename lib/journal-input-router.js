// Journal return-path routing: turns inbound journal frames (client `send` /
// `prompt_reply` ops, fanned back to the bridge's agent socket by the
// journal server) into bridge input. Pure filter/dispatch logic, no I/O — the
// caller (index.js) supplies session lookup, pending-prompt resolution, and
// reply/notice delivery as small injectable functions, so this module is
// unit-testable without booting the Matrix client or a real Claude session.
// See lib/journal-publisher.js's `onEvent` for how frames arrive here: every
// kind:'journal' frame, undiscriminated by sender — the loop-prevention
// filter (sender must start with `user:`) lives HERE, not in the publisher.

import { createConvoSeqRegistry } from './convo-seq-registry.js';
import {
  buildPermissionKey,
  PERMISSION_DECISION_TIMEOUT_MS,
  PERMISSION_MAX_PENDING_GLOBAL,
  PERMISSION_MAX_PENDING_PER_CONVO,
} from './permission-registry.js';

const QUEUED_RELEASE_SEQ_RETENTION = 512;

// Bound on how many recent picker frames stay dispatchable per convo. A long
// conversation that repeatedly opens pickers must not grow the record without
// limit (only the recent ones can plausibly be the frame a reply targets); the
// oldest are dropped past this window.
const PICKER_FRAME_RETENTION = 16;
const PERMISSION_RESOLVED_SEQ_RETENTION = 512;

const INPUT_TYPES = new Set(['text', 'prompt_reply']);
const QUEUED_RELEASE_ACTIONS = new Set(['send', 'cancel']);
// Client-sent media events (a Matron file/image/voice-note send). Routed only
// when a routeMediaToSession seam is supplied; without it, file/image frames
// fall through untouched exactly as they always have (publish-only). The
// blob itself is NOT in the frame — the payload carries a blob_ref the caller
// fetches out of the journal blob store.
const MEDIA_TYPES = new Set(['file', 'image']);

// Issue #98: the bridge publishes a `prompt` event for EVERY button message
// it sends — including the no-arg /model, /effort and /mode pickers and the
// queued-while-busy "📨 Queued" notification. None of those create
// pending-answer state in the bridge (pickers are answered — if at all —
// via Matrix button values like `model:<alias>`; queued-release taps DO arrive
// as journal prompt_replies now, classified by target_seq membership and
// intercepted before the guard in onJournalEvent below), so they must not
// advance the reply staleness guard:
// recording them made the guard falsely refuse a valid reply to the prompt
// the user was actually looking at, just because a picker was mirrored
// between the prompt and the reply.
//
// Classified by option ID shape — ids are bridge-controlled constants
// (never user or model text), which is what makes shape-matching safe:
//   answerable:     prompt-opt-<n>  (iv TUI prompts, lib/prompt-buttons.js)
//                   opt_<letter>    (AskUserQuestion sets, sendAllQuestions)
//   non-answerable: model-* / effort-* / mode-*  (pickers)
//                   timer-*                      (timer-card cancel buttons)
//                   resume-*                     (restart carry-on cards)
//                   cancel / interrupt           (queue-notification actions)
// Defaults to TRUE (guard stays active) for anything unrecognized, so a
// future answerable prompt kind fails safe — worst case a refusal notice —
// rather than silently unguarded.
const PICKER_OPTION_ID = /^(?:model|effort|mode|timer|resume)-/;
const QUEUE_ACTION_OPTION_IDS = new Set(['cancel', 'interrupt']);

export function promptExpectsReply(payload) {
  if (payload?.kind === 'queued_release') return false;
  const options = Array.isArray(payload?.options) ? payload.options : [];
  if (options.length === 0) return true;
  return !options.every(o => o && typeof o.id === 'string'
    && (PICKER_OPTION_ID.test(o.id) || QUEUE_ACTION_OPTION_IDS.has(o.id)));
}

// A /model, /effort or /mode picker frame, or a timer confirmation card
// (whose sole Cancel button rides the same dispatch path): every option id is
// a picker id (model-* / effort-* / mode-* / timer-*). Distinct from a
// queue-notification frame
// (cancel / interrupt ids). Used to record picker frames so a reply can be
// dispatched as a picker command ONLY when its target_seq names one of these
// frames AND its choice is one of THAT frame's own offered values — value shape
// alone can't prove picker origin (an AskUserQuestion option's value is its raw
// model-generated label), and a frame must not authorize a value it never
// offered (e.g. a mode picker must not honour a model: value).
export function isPickerFrame(payload) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  return options.length > 0
    && options.every(o => o && typeof o.id === 'string' && PICKER_OPTION_ID.test(o.id));
}

// The set of option VALUES a picker frame offered (e.g. {'model:sonnet',
// 'model:opus'}). A reply's choice must be a member to be dispatched as a
// command against that frame.
export function pickerFrameValues(payload) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const values = new Set();
  for (const o of options) {
    if (o && typeof o.value === 'string') values.add(o.value);
  }
  return values;
}

// A prompt_reply that is a verified restart carry-on tap: the choice is a
// `resume:` value AND the frame it targets actually offered that value.
// Both halves matter — an AskUserQuestion option can be labelled literally
// `resume:whatever`, so value shape alone must never be trusted (the same
// stance the picker-vs-answer dispatch below takes).
export function isResumePickerTap(offeredValues, choice) {
  return !!offeredValues
    && typeof choice === 'string'
    && choice.startsWith('resume:')
    && offeredValues.has(choice);
}

// Resolve a prompt_reply's `choice` against a pending prompt's option list.
// `options` is the same `[{id, label, ...}]` shape journaled as a `prompt`
// event's `options` field (see lib/prompt-buttons.js promptButtons() and
// index.js's sendAllQuestions button-building — both already produce this
// shape). Liberal per the brief: accepts a 1-based number, an option id, an
// option value, or a case-insensitive label match, in that order. Value
// matching matters because a Matron card tap sends the button's VALUE as
// `choice` (the app's .buttonResponse channel sends values — same channel
// the queue-tile actions arrive on): iv TUI prompt buttons carry
// value `prompt-opt:<i>` alongside id `prompt-opt-<i>`, so without it every
// tap on a TUI prompt (login picker, permission confirms) failed to resolve
// and the user got "Nothing to answer right now". Returns
// `{ option, index }` on a match, or null (never throws, tolerates a
// missing/non-array options list). Free-text fallback (when `choice` doesn't
// resolve, or a prompt has no fixed options at all) is the caller's job —
// this function only ever answers "does `choice` name one of `options`?".
export function resolvePromptChoice(options, choice) {
  const list = Array.isArray(options) ? options : [];
  if (choice == null) return null;
  const choiceStr = String(choice).trim();
  if (!choiceStr) return null;

  if (/^\d+$/.test(choiceStr)) {
    const idx = parseInt(choiceStr, 10) - 1;
    if (idx >= 0 && idx < list.length) return { option: list[idx], index: idx };
  }

  let idx = list.findIndex(o => o && String(o.id) === choiceStr);
  if (idx !== -1) return { option: list[idx], index: idx };

  idx = list.findIndex(o => o && o.value != null && String(o.value) === choiceStr);
  if (idx !== -1) return { option: list[idx], index: idx };

  idx = list.findIndex(o => o && typeof o.label === 'string' && o.label.toLowerCase() === choiceStr.toLowerCase());
  if (idx !== -1) return { option: list[idx], index: idx };

  return null;
}

// Build the routing function index.js wires as journal-publisher's `onEvent`.
// Every argument is an injectable seam:
//   isControlConvo(convoId) -> bool
//   handleControlCommand(commandBody, {username}) -> void (may be async; not awaited)
//   findSessionByConvoId(convoId) -> session-like object | null
//   routeTextToSession(session, body, {username}) -> void
//   routeMediaToSession(session, {type, blobRef, contentType, name, size, dims}, {username}) -> void (optional)
//   routePromptReply(session, {target_seq, choice, text}, {username}) -> void
//   notePermissionSeq(key, seq, convoId) -> bool (true only on fresh assignment; consumed by T-2.3)
//   resolvePermissionReply(key, decision, {username}) -> bool (consumed by T-2.4)
//   hasLivePermissionPending(convoId) -> bool (consumed by T-2.4)
//   isLivePendingToolUse(key, convoId, nonce) -> bool (consumed by T-2.3)
//   resumeSessionForConvo(convoId, {username}) -> session-like object | null (optional)
//   noticeUnknownConvo(convoId, {type, username}) -> void (optional)
//   noticeStalePromptReply(convoId, {username, targetSeq, latestSeq}) -> void (optional)
//   noticeQueuedReleaseIgnored(convoId, {reason, username}) -> void (optional)
//   noticeGhostPromptReply(convoId, {username, targetSeq}) -> void (optional)
//   emitRelease(convoId, {promptId, action, releasedIds}) -> void (optional)
//   roomFor(convoId) -> room record | null (optional) — an ACTIVE agent-chat
//     room this bridge participates in (agent-rooms registry; the caller
//     applies the isActive gate). A frame in a room convo takes the room
//     path below instead of the main-convo input path.
//   routeRoomFrame(room, frame) -> void (optional) — the room delivery path.
//   selfAgentName() -> string | null (optional) — this bridge's own device
//     name (publisher identity), used to drop its own agent echoes in rooms
//     when device ids are unavailable.
//   selfAgentDeviceId() -> integer | null (optional) — this bridge's own
//     device id (publisher identity). When BOTH it and the frame's
//     sender_device_id are known, own echoes are dropped by exact id and
//     same-named peers route; either missing falls back to selfAgentName.
//   processStartSeq: number | null — journal high-water at process start; a
//     prompt_reply whose target_seq is <= this predates this bridge process
//     and is refused (the ghost-answer window). Null disables the check.
export function createJournalInputConsumer({
  isControlConvo,
  handleControlCommand,
  findSessionByConvoId,
  routeTextToSession,
  routeMediaToSession,
  routePromptReply,
  notePermissionSeq,
  resolvePermissionReply,
  hasLivePermissionPending,
  isLivePendingToolUse,
  resumeSessionForConvo,
  noticeUnknownConvo,
  noticeStalePromptReply,
  noticeQueuedReleaseIgnored,
  noticeGhostPromptReply,
  processStartSeq = null,
  emitRelease,
  roomFor,
  routeRoomFrame,
  selfAgentName,
  selfAgentDeviceId,
  // Queued-release echo-ack (spec §3 step 5). Fired when the bridge observes the
  // journal echo of its OWN queued_release release (sender agent:*), which means
  // the journal ran append() and assigned a seq — the release is committed and
  // fanned out. This flips the durable outbox record `acked` (in memory,
  // unconditionally). Universal across send/cancel/expired. Optional.
  onReleaseEcho,
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // One-shot (per consumer instance, mirroring the publisher's warn-once
  // convention): an agent frame in a room can't be proven not-our-own-echo
  // until the journal has told us our identity, so we drop and say why ONCE
  // rather than spam a line per frame.
  let warnedNoIdentity = false;
  function warnOnceNoIdentity() {
    if (warnedNoIdentity) return;
    warnedNoIdentity = true;
    warn('[journal-input] agent frame in a room but own identity is unknown (no hello_ok identity yet) — dropping room frames from agents until it arrives');
  }

  // Same one-shot convention: devices.name has NO unique constraint on the
  // journal side, so on the name-fallback path (no sender_device_id) a room
  // peer configured with the SAME device name as this bridge is
  // indistinguishable from our own echoes — both directions get classified
  // own-echo and the room dies silently. Frames where BOTH ids are known
  // never hit this: exact-id matching disambiguates same-named peers. The
  // drop is the correct fail-safe; the silence isn't, so say why once.
  let warnedAmbiguousPeerName = false;
  function warnOnceAmbiguousPeerName() {
    if (warnedAmbiguousPeerName) return;
    warnedAmbiguousPeerName = true;
    warn('[journal-input] a room peer has the same device name as this bridge — its messages are indistinguishable from our own echoes and are being dropped; rename one of the devices');
  }

  // Same one-shot convention: a non-integer sender_device_id (a journal or
  // proxy stringifying the field) silently demotes echo detection to the
  // name path, indistinguishable in behavior from an old journal — so the
  // downgrade gets one diagnostic line instead of staying invisible.
  let warnedNonIntegerSenderId = false;
  function warnOnceNonIntegerSenderId() {
    if (warnedNonIntegerSenderId) return;
    warnedNonIntegerSenderId = true;
    warn('[journal-input] room frame carries a non-integer sender_device_id — ignoring it and falling back to name-based echo detection');
  }

  // Staleness-guard state: the journal seq of the latest ANSWERABLE `prompt`
  // event seen per convo (promptExpectsReply above — pickers and queue
  // notifications never advance it, issue #98). Recorded from prompt frames
  // — which in practice means the bridge's OWN published prompts echoing
  // back with sender agent:*, so this bookkeeping happens BEFORE the user:*
  // input filter below. Used to refuse a prompt_reply whose target_seq
  // references a prompt that has since been superseded by a newer one:
  // without it, a delayed reply resolves against whatever prompt is
  // CURRENTLY pending and can mis-answer it. In-memory only — after a bridge
  // restart there's no record for a convo, and its replies are accepted
  // exactly as before (fails open). Evicted on session teardown via
  // evictConvo (attached to the returned function below) so entries for dead
  // convos don't accumulate for the life of the process.
  const latestPromptSeqByConvo = new Map();
  // Picker frames (/model, /effort, /mode) the bridge published per convo, as
  // seq -> {the exact option VALUES that frame offered}. A picker reply is
  // dispatched as a command ONLY when its target_seq names one of these frames
  // AND its choice is one of that frame's values — binding the dispatch to the
  // originating frame (not the reply's value shape), so neither a genuine
  // answer that merely looks like a picker value nor a value the frame never
  // offered can trigger an unintended switch. Bounded per convo, and each frame
  // is single-use (consumed on dispatch, below). Same in-memory / evict-on-
  // teardown contract as latestPromptSeqByConvo. KNOWN LIMITATION: this record
  // is process-local, so after a bridge restart a picker card published before
  // the restart is no longer dispatchable (its reply falls through to ordinary
  // prompt handling). That is acceptable here because a journal-bridge restart
  // does not carry live sessions across anyway — the card's session is gone, so
  // the switch has nothing to act on. A durable design (validating target_seq
  // against the canonical journal event) is deferred.
  const pickerFrames = createConvoSeqRegistry({ retention: PICKER_FRAME_RETENTION });
  // Permission cards are concurrent, so their echoed journal seqs need a
  // per-convo seq -> P56 tuple-key registry rather than the singleton latest
  // prompt seq. T-2.3/T-2.4 add the echo/reply consumers; this task establishes
  // canonical ownership and keeps their index.js operations in the same
  // closure without importing index.js back into this module.
  const permissionFramesByConvo = new Map();
  // Recently resolved/expired permission seqs remain classified after their
  // live membership is evicted. Otherwise a duplicate late tap can fall
  // through to an unrelated ordinary prompt after the permission finalizer
  // removes the seq -> key entry. Bounded per convo and cleared on teardown.
  const resolvedPermissionSeqsByConvo = new Map();
  // Replies can reach the bridge before its own permission_request echo has
  // supplied the journal seq. T-2.4 populates this per-convo holding map; the
  // echo branch below is the sole owner of draining it once provenance is
  // established. It shares whole-convo teardown with the frame registry.
  const permissionReplyBuffer = new Map();
  let permissionReplyBufferCount = 0;
  const permissionState = Object.freeze({
    framesByConvo: permissionFramesByConvo,
    notePermissionSeq,
    resolvePermissionReply,
    hasLivePermissionPending,
    isLivePendingToolUse,
  });

  function noticeNothingToAnswer(convoId, { username, targetSeq, latestSeq }) {
    if (typeof noticeStalePromptReply !== 'function') return;
    try {
      noticeStalePromptReply(convoId, { username, targetSeq, latestSeq });
    } catch (e) {
      warn(`[journal-input] noticeStalePromptReply failed: ${e.message}`);
    }
  }

  function resolvePermissionDecision(key, decision, { username } = {}) {
    if (typeof resolvePermissionReply !== 'function') return;
    resolvePermissionReply(key, decision, { username });
  }

  function tombstonePermissionSeq(convoId, seq) {
    let seqs = resolvedPermissionSeqsByConvo.get(convoId);
    if (!seqs) {
      seqs = new Set();
      resolvedPermissionSeqsByConvo.set(convoId, seqs);
    }
    // Refreshing an existing value keeps the most recently retired seqs.
    seqs.delete(seq);
    seqs.add(seq);
    while (seqs.size > PERMISSION_RESOLVED_SEQ_RETENTION) {
      seqs.delete(seqs.values().next().value);
    }
  }

  function drainPermissionReplyBuffer(convoId, seq) {
    const replies = permissionReplyBuffer.get(convoId);
    const buffered = replies?.get(seq);
    if (!buffered) return;
    clearTimeout(buffered.timer);
    replies.delete(seq);
    permissionReplyBufferCount -= 1;
    if (replies.size === 0) permissionReplyBuffer.delete(convoId);

    const key = permissionFramesByConvo.get(convoId)?.get(seq);
    if (!key || typeof resolvePermissionReply !== 'function') return;
    resolvePermissionDecision(key, buffered.decision, { username: buffered.username });
  }
  // Stable queue-card identity is owned here rather than on a session because
  // prompt echoes arrive before session lookup. `queuedReleaseSeqs` is a
  // bounded classification tombstone (seq -> true): resolving a card removes
  // its live prompt entry from `queuedPrompts`, but its echoed seq stays
  // recognizable until retention eviction or terminal convo eviction.
  // `queuedPrompts` maps prompt_id -> { prompt_id, itemIds, seq }. Both share
  // the same per-convo-registry primitive as the picker frames above.
  const queuedReleaseSeqs = createConvoSeqRegistry();
  const queuedPrompts = createConvoSeqRegistry();

  // Drop resolved release seqs past the retention window, keeping every seq
  // still bound to a live queued prompt. Recomputed from `queuedPrompts` so the
  // "is this seq still live?" test never drifts from the source of truth.
  function pruneReleaseSeqs(convoId) {
    const liveSeqs = new Set();
    for (const entry of queuedPrompts.values(convoId)) {
      if (Number.isInteger(entry.seq)) liveSeqs.add(entry.seq);
    }
    queuedReleaseSeqs.pruneWhere(convoId, QUEUED_RELEASE_SEQ_RETENTION, seq => liveSeqs.has(seq));
  }

  function noteQueued(convoId, { promptId, itemId } = {}) {
    if (typeof convoId !== 'string' || !convoId
      || typeof promptId !== 'string' || !promptId
      || typeof itemId !== 'string' || !itemId) return;
    const existing = queuedPrompts.get(convoId, promptId);
    if (existing) {
      if (!existing.itemIds.includes(itemId)) existing.itemIds.push(itemId);
      return;
    }
    queuedPrompts.set(convoId, promptId, { prompt_id: promptId, itemIds: [itemId], seq: null });
  }

  function annotateSeq(convoId, seq, promptId) {
    if (typeof convoId !== 'string' || !convoId || !Number.isInteger(seq)) return;
    queuedReleaseSeqs.set(convoId, seq, true);
    const entry = queuedPrompts.get(convoId, promptId);
    if (entry) entry.seq = seq;
    pruneReleaseSeqs(convoId);
  }

  function classifyBySeq(convoId, targetSeq) {
    if (!queuedReleaseSeqs.has(convoId, targetSeq)) {
      return { state: 'unknown' };
    }
    for (const entry of queuedPrompts.values(convoId)) {
      if (entry.seq === targetSeq) {
        return {
          state: 'live',
          entry: { ...entry, itemIds: [...entry.itemIds] },
        };
      }
    }
    return { state: 'tombstoned' };
  }

  function dropItem(convoId, itemId) {
    for (const [promptId, entry] of queuedPrompts.entries(convoId)) {
      const index = entry.itemIds.indexOf(itemId);
      if (index === -1) continue;
      entry.itemIds.splice(index, 1);
      if (entry.itemIds.length === 0) queuedPrompts.delete(convoId, promptId);
      pruneReleaseSeqs(convoId);
      return;
    }
  }

  function listLive(convoId) {
    const live = [];
    for (const [promptId, entry] of queuedPrompts.entries(convoId)) {
      for (const itemId of entry.itemIds) live.push({ promptId, itemId });
    }
    return live;
  }

  function carryForward(fromConvoId, toConvoId) {
    if (typeof fromConvoId !== 'string' || !fromConvoId
      || typeof toConvoId !== 'string' || !toConvoId
      || fromConvoId === toConvoId) return;
    // Seqs: source ordered first, presence-only so collisions are harmless.
    queuedReleaseSeqs.merge(fromConvoId, toConvoId, { fromFirst: true });
    // Prompts: target ordered first, source wins a prompt_id collision (its
    // entry is the more recent one being carried forward).
    queuedPrompts.merge(fromConvoId, toConvoId, { fromFirst: false });
    pruneReleaseSeqs(toConvoId);
  }

  const queueRelease = Object.freeze({
    noteQueued,
    annotateSeq,
    classifyBySeq,
    dropItem,
    listLive,
    carryForward,
  });

  function onJournalEvent(frame) {
    try {
      if (!frame || typeof frame !== 'object') return;
      const { sender, type, convo_id: convoId, payload } = frame;

      if (type === 'prompt' && Number.isInteger(frame.seq)) {
        if (promptExpectsReply(payload)) {
          latestPromptSeqByConvo.set(convoId, frame.seq);
        } else if (typeof sender === 'string' && sender.startsWith('agent:')
          && isPickerFrame(payload)) {
          // Provenance guard, same stance as the queued_release branch just
          // below: option ids (model-*/effort-*/mode-*/timer-*/resume-*) are
          // bridge-controlled constants ONLY because this bridge is the only
          // publisher of them — a frame's option ids are just strings on the
          // wire, so without a sender check a client device could publish a
          // `type:'prompt'` frame shaped like a picker (e.g. id 'resume-x',
          // value 'resume:x') and have it register here, making a later
          // prompt_reply's `resume:x` choice pass isResumePickerTap's
          // frame-offered check even though no bridge-authored card ever
          // offered it. The registry bounds growth by insertion order (drops
          // the oldest frame past PICKER_FRAME_RETENTION) on set.
          pickerFrames.set(convoId, frame.seq, pickerFrameValues(payload));
        } else if (typeof sender === 'string' && sender.startsWith('agent:')
          && payload?.kind === 'queued_release') {
          queueRelease.annotateSeq(convoId, frame.seq, payload?.prompt_id);
        }
      } else if (type === 'permission_request' && Number.isInteger(frame.seq)) {
        const toolUseId = payload?.tool_use_id;
        if (typeof sender === 'string' && sender.startsWith('agent:')
          && typeof toolUseId === 'string' && toolUseId.trim() !== '') {
          const key = buildPermissionKey(convoId, toolUseId);
          if (typeof isLivePendingToolUse === 'function'
            && isLivePendingToolUse(key, convoId, payload?.nonce)
            && typeof notePermissionSeq === 'function'
            && notePermissionSeq(key, frame.seq, convoId)) {
            let frames = permissionFramesByConvo.get(convoId);
            if (!frames) {
              frames = new Map();
              permissionFramesByConvo.set(convoId, frames);
            }
            frames.set(frame.seq, key);
            while (frames.size > PERMISSION_MAX_PENDING_PER_CONVO) {
              frames.delete(frames.keys().next().value);
            }
            drainPermissionReplyBuffer(convoId, frame.seq);
          }
        }
      }

      // Agent-chat room carve-out (spec: agent chat phase 3). Frames in a
      // conversation this bridge participates in as a room are session input
      // even when agent-sent — that's the whole point of a room. Own echoes
      // are dropped by device id when both the frame and our identity carry
      // one (newer journals stamp sender_device_id on live frames), by
      // device name otherwise; unknown identity fails CLOSED (drop + warn
      // once) rather than risk a self-echo loop.
      const room = typeof roomFor === 'function' ? roomFor(convoId) : null;
      if (room) {
        if (!INPUT_TYPES.has(type) && !MEDIA_TYPES.has(type)) return;
        if (type === 'prompt_reply') return; // prompt flows never route through rooms
        if (typeof sender !== 'string') return;
        if (sender.startsWith('agent:')) {
          // Exact-id echo check (newer journals stamp sender_device_id on
          // LIVE frames only — hello-replay/history never carry it): when
          // both ids are known the id is authoritative — drop iff it is our
          // own, route otherwise, even from a peer sharing our device name
          // (no ambiguity, so no warning on this path).
          const sdid = Number.isInteger(frame.sender_device_id) ? frame.sender_device_id : null;
          if (frame.sender_device_id != null && sdid === null) warnOnceNonIntegerSenderId();
          const rawSelfId = typeof selfAgentDeviceId === 'function' ? selfAgentDeviceId() : null;
          const selfId = Number.isInteger(rawSelfId) ? rawSelfId : null;
          if (sdid !== null && selfId !== null) {
            if (sdid === selfId) return; // own echo, proven by device id
          } else {
            // Either id missing (old journal, replayed frame): name-based
            // fallback, fail closed as before.
            const self = typeof selfAgentName === 'function' ? selfAgentName() : null;
            if (!self) {
              warnOnceNoIdentity();
              return;
            }
            if (sender === `agent:${self}`) {
              // Own echo — unless the peer shares our device name, in which
              // case this "echo" may be the peer's real message (see
              // warnOnceAmbiguousPeerName). Still dropped (fail safe), but
              // flagged so the dead room is diagnosable.
              if (room.peerName === self) warnOnceAmbiguousPeerName();
              return;
            }
          }
        } else if (!sender.startsWith('user:')) {
          return;
        }
        if (typeof routeRoomFrame === 'function') {
          try { routeRoomFrame(room, frame); } catch (e) { warn(`[journal-input] routeRoomFrame threw: ${e.message}`); }
        }
        return;
      }

      // Queued-release universal echo-ack (loop #536, spec §3 step 5). The echo
      // of the bridge's OWN release — a `prompt_reply` carrying
      // kind:"queued_release" and a terminal `action` (send/cancel/expired) —
      // is the true commit signal: the journal ran append() and fanned it out,
      // so the release is durably committed. Flip the outbox record acked
      // (in memory, unconditionally), matched by (prompt_id, action). This
      // bookkeeping runs BEFORE the user:* input filter below because the echo
      // arrives with sender agent:* (the same reason the prompt-echo
      // bookkeeping above sits ahead of the filter).
      if (type === 'prompt_reply'
        && typeof sender === 'string' && sender.startsWith('agent:')
        && payload?.kind === 'queued_release'
        && typeof payload?.action === 'string'
        && typeof onReleaseEcho === 'function') {
        try { onReleaseEcho(convoId, { promptId: payload?.prompt_id, action: payload.action }); }
        catch (e) { warn(`[journal-input] onReleaseEcho threw: ${e?.message ?? String(e)}`); }
      }

      // Loop-prevention filter: only genuine client-origin events are input.
      // The bridge's own publishes (and every echo of them) come back with
      // sender `agent:<device>` and must never be treated as input, or a
      // bridge notice/echo would re-trigger itself.
      if (typeof sender !== 'string' || !sender.startsWith('user:')) return;
      // Media (file/image) is only an input type when the caller wired a
      // routeMediaToSession seam; otherwise it stays a pass-through publish,
      // exactly as before this feature existed.
      const isMedia = MEDIA_TYPES.has(type) && typeof routeMediaToSession === 'function';
      if (!INPUT_TYPES.has(type) && !isMedia) return;

      const username = sender.slice('user:'.length);
      const ctx = { username };

      if (isControlConvo(convoId)) {
        // The control convo only understands commands, which arrive as text.
        // A prompt_reply there has nothing to answer — ignore.
        if (type !== 'text') return;
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (!body) return;
        handleControlCommand(body, ctx);
        return;
      }

      // A media frame's blob_ref, resolved up front because it gates BOTH the
      // auto-resume below (a frame with nothing to fetch must not respawn a
      // session) and the media routing itself (falling back to a top-level
      // blob_ref if that's the shape the server delivers).
      const blobRef = !isMedia ? null
        : (typeof payload?.blob_ref === 'string' && payload.blob_ref)
          ? payload.blob_ref
          : (typeof frame.blob_ref === 'string' && frame.blob_ref ? frame.blob_ref : null);

      let session = findSessionByConvoId(convoId);
      if (!session && resumeSessionForConvo) {
        // Reaped-but-resumable convo: the idle reaper kills sessions on the
        // assumption that "the next user message auto-resumes" — give the
        // caller the same chance the Matrix room path gets before declaring
        // the convo dead. Text and media both qualify (delivery after the
        // wake is safe: print mode's stdin buffers, iv mode's resume hold
        // parks input until the TUI is ready), but only with something to
        // deliver — a blank message or a blob_ref-less media frame must not
        // respawn a session.
        //
        // A prompt_reply still never resumes IN GENERAL: its pending prompt
        // died with the process, so there's nothing valid to answer. The one
        // exception is a verified restart carry-on tap, whose whole purpose is
        // to act on a session that is dead by construction — the card is only
        // ever published at boot, into convos whose turn the restart killed
        // (docs/superpowers/specs/2026-08-11-restart-carry-on-design.md).
        // Provenance is what makes this safe: the choice must be a `resume:`
        // value the targeted frame itself offered, so a crafted reply or a
        // lookalike answer label cannot wake a session.
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        const resumeTap = type === 'prompt_reply' && payload?.target_seq != null
          && isResumePickerTap(pickerFrames.get(convoId, payload.target_seq), payload?.choice);
        const wakeable = type === 'text' ? !!body : (isMedia ? !!blobRef : resumeTap);
        if (wakeable) {
          try {
            session = resumeSessionForConvo(convoId, ctx) || null;
          } catch (e) {
            warn(`[journal-input] resumeSessionForConvo failed for convo=${convoId}: ${e.message}`);
          }
        }
      }
      if (!session) {
        // Replay after a restart, or the session died in the meantime —
        // tolerate it: log and notice, never crash.
        warn(`[journal-input] ${type} event for unknown/dead session convo=${convoId} — ignoring`);
        if (noticeUnknownConvo) {
          try { noticeUnknownConvo(convoId, { type, username }); } catch (e) { warn(`[journal-input] noticeUnknownConvo failed: ${e.message}`); }
        }
        return;
      }

      if (type === 'text') {
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (!body) {
          warn(`[journal-input] text event with no usable body, convo=${convoId} — skipping`);
          return;
        }
        routeTextToSession(session, body, ctx);
        return;
      }

      if (isMedia) {
        // A client-sent file/image/voice-note. The bytes aren't in the frame;
        // the payload names a blob_ref (resolved above) the caller fetches out
        // of the journal blob store. A frame with no usable blob_ref is
        // dropped — there's nothing to fetch, and (per the brief) an
        // unresolvable media event must never inject a placeholder into the
        // prompt.
        if (!blobRef) {
          warn(`[journal-input] ${type} event with no blob_ref, convo=${convoId} — skipping`);
          return;
        }
        const captionRaw = typeof payload?.caption === 'string' ? payload.caption.trim() : '';
        routeMediaToSession(session, {
          type,
          blobRef,
          contentType: typeof payload?.content_type === 'string' ? payload.content_type : null,
          name: typeof payload?.name === 'string' ? payload.name : null,
          size: payload?.size ?? null,
          dims: payload?.dims ?? null,
          // What the user typed alongside the attachment — a prompt that rides
          // with the upload, so claude sees the file and the sentence about it
          // as one turn instead of the file arriving alone and the explanation
          // following as a separate turn it may already have started answering.
          // Trim-to-omit (a blank composer must not put a stray blank line above
          // the annotation); NO length clamp — a prompt shouldn't be capped
          // (operator decision 2026-07-18; the web textarea maxLength is the
          // companion half to lift).
          caption: captionRaw || null,
        }, ctx);
        return;
      }

      // type === 'prompt_reply'.
      const targetSeq = payload?.target_seq;

      // Ghost-answer window: a reply whose target_seq predates this bridge
      // process targets a prompt published by a PREVIOUS process — its asking
      // session is gone. resolvePromptChoice matches options by case-insensitive
      // label, and this feature's queued-release wire values (send / cancel)
      // are common real-prompt labels, so routing such a reply to whatever
      // prompt is currently pending could silently answer the WRONG one. Refuse
      // it (with a notice, never a silent no-op). Cards this process published
      // always carry seq > processStartSeq, so a live tap is never caught here.
      if (Number.isInteger(processStartSeq)
        && Number.isInteger(targetSeq)
        && targetSeq <= processStartSeq) {
        warn(`[journal-input] ghost prompt_reply for convo=${convoId}: target_seq=${targetSeq} predates process start seq=${processStartSeq} — refusing`);
        if (noticeGhostPromptReply) {
          try { noticeGhostPromptReply(convoId, { username, targetSeq }); } catch (e) { warn(`[journal-input] noticeGhostPromptReply failed: ${e.message}`); }
        }
        return;
      }

      // A queued-release tap is proven by the target seq of the bridge-authored
      // card, never by the reply value: ordinary prompts are allowed to offer
      // choices literally named "send" or "cancel". Intercept before the
      // staleness guard because a queued-release card is deliberately
      // non-answerable and therefore never advances latestPromptSeqByConvo.
      const queuedRelease = queueRelease.classifyBySeq(convoId, targetSeq);
      if (queuedRelease.state !== 'unknown') {
        if (!QUEUED_RELEASE_ACTIONS.has(payload?.choice)) {
          // A tap the card can't action (unknown wire value). Never silently
          // no-op — mirror the staleness guard and tell the user, since they
          // pressed a button and expect a result.
          warn(`[journal-input] invalid queued_release action for convo=${convoId}: target_seq=${String(targetSeq)} — ignoring`);
          noticeQueuedReleaseIgnored?.(convoId, { reason: 'invalid-action', username });
          return;
        }
        // The tombstone outlives the live entry so duplicate and late taps
        // remain classified as queue actions instead of falling through to
        // the ordinary answer path. Surface it — a tap on an already-resolved
        // card should confirm "already handled", not vanish.
        if (queuedRelease.state === 'tombstoned') {
          noticeQueuedReleaseIgnored?.(convoId, { reason: 'tombstoned', username });
          return;
        }
        routePromptReply(session, {
          target_seq: targetSeq ?? null,
          choice: payload.choice,
          text: payload?.text ?? null,
        }, ctx);
        return;
      }

      // NOTE: value-shape classification of queue taps ("interrupt" / "cancel:N")
      // is retired (issue #165). A queue tap is proven ONLY by target_seq
      // membership above; a genuine prompt answer whose label merely looks like
      // a queue action ("interrupt", "cancel:2") therefore flows through the
      // ordinary staleness + answer path below like any other answer, and a
      // stale pre-deploy positional tap surfaces as a stale / nothing-to-answer
      // notice there rather than being silently swallowed.

      // Picker taps (/model, /effort, /mode): a picker frame never advances the
      // staleness guard (non-answerable, issue #98), so a genuine tap would be
      // wrongly refused as stale. Dispatch it as a command — with explicit
      // provenance (`picker: true`) — ONLY when target_seq names a picker frame
      // the bridge actually published AND the choice is one of THAT frame's own
      // offered values. This is the single source of truth for picker-vs-answer:
      // the receiver trusts the flag and never re-guesses by value shape, so a
      // genuine answer whose label merely looks like a picker value (an
      // AskUserQuestion option can be labeled literally `model:sonnet`) is never
      // dispatched as a command, and a verified picker tap is never swallowed as
      // a prompt answer.
      const offeredValues = payload?.target_seq != null
        ? pickerFrames.get(convoId, payload.target_seq)
        : null;
      if (offeredValues && offeredValues.has(payload?.choice)) {
        // Single-use: consume the frame before dispatch so a double-tap or
        // client retry (a second prompt_reply for the same target_seq) doesn't
        // fire the switch twice — which would restart a print session twice or
        // write effort into the PTY twice. Reopening the picker publishes a
        // fresh frame with a new seq.
        pickerFrames.delete(convoId, payload.target_seq);
        routePromptReply(session, {
          target_seq: payload.target_seq,
          choice: payload.choice,
          text: payload?.text ?? null,
          picker: true,
        }, ctx);
        return;
      }

      // Staleness check: a target_seq that
      // doesn't reference the latest prompt we published into this convo
      // means the prompt the user answered has been superseded — refuse
      // rather than mis-answer the newer one. No recorded seq (restart,
      // live-only reconnect) or no target_seq -> nothing to check, accept.
      const latestSeq = latestPromptSeqByConvo.get(convoId);
      if (resolvedPermissionSeqsByConvo.get(convoId)?.has(targetSeq)) {
        noticeNothingToAnswer(convoId, { username, targetSeq, latestSeq });
        return;
      }

      const permissionReplyIsCausal = Number.isInteger(frame.seq)
        && Number.isInteger(targetSeq)
        && targetSeq < frame.seq;
      const permFrames = permissionFramesByConvo.get(convoId);
      if (targetSeq != null && permFrames?.has(targetSeq)) {
        const key = permFrames.get(targetSeq);
        const decision = typeof payload?.choice === 'string'
          && payload.choice.trim().toLowerCase() === 'allow'
          ? 'allow'
          : 'deny';
        resolvePermissionDecision(key, decision, { username });
        return;
      }

      // A permission tap can beat the bridge's own permission_request echo,
      // including when that permission card is the convo's first card and no
      // ordinary prompt seq has ever been recorded. Hold a non-latest target
      // while a seq-null permission is live; the echo branch above drains it
      // only after establishing the target seq's provenance.
      let bufferRejected = false;
      if (targetSeq != null
        && (latestSeq === undefined || targetSeq !== latestSeq)
        && typeof hasLivePermissionPending === 'function'
        && hasLivePermissionPending(convoId)) {
        if (permissionReplyIsCausal) {
          let replies = permissionReplyBuffer.get(convoId);
          const existing = replies?.get(targetSeq);
          // The first causal reply owns this target until it drains or expires.
          // A duplicate must not change the decision or extend the TTL.
          if (existing) return;
          if ((replies?.size || 0) < PERMISSION_MAX_PENDING_PER_CONVO
            && permissionReplyBufferCount < PERMISSION_MAX_PENDING_GLOBAL) {
            if (!replies) {
              replies = new Map();
              permissionReplyBuffer.set(convoId, replies);
            }
            const buffered = {
              decision: typeof payload?.choice === 'string'
                && payload.choice.trim().toLowerCase() === 'allow'
                ? 'allow'
                : 'deny',
              username,
              timer: null,
            };
            buffered.timer = setTimeout(() => {
              if (replies.get(targetSeq) !== buffered) return;
              replies.delete(targetSeq);
              permissionReplyBufferCount -= 1;
              if (replies.size === 0) permissionReplyBuffer.delete(convoId);
              noticeNothingToAnswer(convoId, { username, targetSeq, latestSeq });
            }, PERMISSION_DECISION_TIMEOUT_MS);
            replies.set(targetSeq, buffered);
            permissionReplyBufferCount += 1;
            return;
          }
        }
        bufferRejected = true;
      }

      // Staleness check: a target_seq that doesn't reference the latest prompt
      // we published means the answered prompt was superseded. A reply refused
      // by the permission buffer's validation/caps also takes this same
      // nothing-to-answer path. No recorded seq (restart, live-only reconnect)
      // or no target_seq remains accepted when no seq-null permission is live.
      if (bufferRejected
        || (targetSeq != null && latestSeq !== undefined && targetSeq !== latestSeq)) {
        warn(`[journal-input] stale prompt_reply for convo=${convoId}: target_seq=${targetSeq} but latest prompt is seq=${latestSeq} — refusing`);
        noticeNothingToAnswer(convoId, { username, targetSeq, latestSeq });
        return;
      }
      routePromptReply(session, {
        target_seq: targetSeq,
        choice: payload?.choice ?? null,
        text: payload?.text ?? null,
      }, ctx);
    } catch (e) {
      warn(`[journal-input] consumer threw: ${e.message}`);
    }
  }

  // Session-teardown eviction for all per-convo input state. Resolve every
  // still-live queue card before its registry is removed, then let the caller
  // clear the session queue between that release commitment and eviction.
  // This ordering prevents terminal stop/exit/reap from leaving apparently
  // actionable cards behind. Repeated eviction is idempotent because the
  // first call removes the live registry entries.
  //
  // Fail-closed (F2): the cleanup that discards live state (clearQueue + the
  // registry evicts) runs ONLY when every cancel release durably committed.
  // Drop the live entry per-item on a successful emit; if ANY emit fail-closed
  // (write-ahead disk fault), keep its live entry AND skip the wholesale
  // cleanup so a later evictConvo retry (or boot reconcile) can still recover
  // the card — wiping the registry with nothing durably published would strand
  // a permanently dead card. Per-item drop keeps repeated eviction idempotent:
  // a retry re-lists only the still-unresolved entries.
  onJournalEvent.evictConvo = function evictConvo(convoId, { clearQueue } = {}) {
    let allEmitted = true;
    if (typeof emitRelease === 'function') {
      for (const { promptId, itemId } of queueRelease.listLive(convoId)) {
        if (emitRelease(convoId, {
          promptId,
          action: 'cancel',
          releasedIds: [itemId],
        })) {
          dropItem(convoId, itemId);
        } else {
          allEmitted = false;
        }
      }
    }
    if (!allEmitted) return; // fail-closed: keep live state for a later retry
    if (typeof clearQueue === 'function') clearQueue();
    latestPromptSeqByConvo.delete(convoId);
    pickerFrames.evict(convoId);
    // Permission-cards teardown (fork-local machinery; upstream's evictConvo
    // has no knowledge of it). Runs after the fail-closed guard, so a retry
    // path leaves it in place one cycle — bounded and independently swept by
    // evictPermissionSeq / decision timeouts.
    permissionFramesByConvo.delete(convoId);
    resolvedPermissionSeqsByConvo.delete(convoId);
    const bufferedReplies = permissionReplyBuffer.get(convoId);
    for (const buffered of bufferedReplies?.values() || []) {
      clearTimeout(buffered.timer);
    }
    permissionReplyBufferCount -= bufferedReplies?.size || 0;
    permissionReplyBuffer.delete(convoId);
    queuedReleaseSeqs.evict(convoId);
    queuedPrompts.evict(convoId);
  };
  // Seq-scoped reverse seam for timeout/disconnect/operator cleanup. Search
  // the bounded per-convo map by its tuple key and remove exactly one entry;
  // whole-convo prompt/picker/queue state is deliberately untouched.
  onJournalEvent.evictPermissionSeq = function evictPermissionSeq(key, convoId) {
    if (typeof key !== 'string' || !key
      || typeof convoId !== 'string' || !convoId) return;
    const frames = permissionState.framesByConvo.get(convoId);
    if (!frames) return;
    for (const [seq, frameKey] of frames) {
      if (frameKey !== key) continue;
      tombstonePermissionSeq(convoId, seq);
      frames.delete(seq);
      if (frames.size === 0) permissionState.framesByConvo.delete(convoId);
      return;
    }
  };
  // Read-only lookup for retention/teardown verification. The mutable frame
  // registry stays private to this consumer.
  onJournalEvent.permissionFrameKey = function permissionFrameKey(convoId, seq) {
    return permissionState.framesByConvo.get(convoId)?.get(seq) ?? null;
  };
  onJournalEvent.queueRelease = queueRelease;

  return onJournalEvent;
}
