// Journal return-path routing: turns inbound journal frames (client `send` /
// `prompt_reply` ops, fanned back to the bridge's agent socket by the
// journal server) into bridge input. Pure filter/dispatch logic, no I/O — the
// caller (index.js) supplies session lookup, pending-prompt resolution, and
// reply/notice delivery as small injectable functions, so this module is
// unit-testable without booting the Matrix client or a real Claude session.
// See lib/journal-publisher.js's `onEvent` for how frames arrive here: every
// kind:'journal' frame, undiscriminated by sender — the loop-prevention
// filter (sender must start with `user:`) lives HERE, not in the publisher.

import { isQueueReleaseTap } from './busy-queue.js';
import {
  buildPermissionKey,
  PERMISSION_MAX_PENDING_GLOBAL,
  PERMISSION_MAX_PENDING_PER_CONVO,
} from './permission-registry.js';

// Bound on how many recent picker frames stay dispatchable per convo. A long
// conversation that repeatedly opens pickers must not grow the record without
// limit (only the recent ones can plausibly be the frame a reply targets); the
// oldest are dropped past this window.
const PICKER_FRAME_RETENTION = 16;
const QUEUED_RELEASE_SEQ_RETENTION = 512;
const PERMISSION_REPLY_BUFFER_TTL_MS = 5_000;

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
// via Matrix button values like `model:<alias>`; queue-tile taps DO arrive
// as journal prompt_replies now, but are classified by value shape and
// routed around the guard in onJournalEvent below), so they must not
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
//                   cancel / interrupt           (queue-notification actions)
// Defaults to TRUE (guard stays active) for anything unrecognized, so a
// future answerable prompt kind fails safe — worst case a refusal notice —
// rather than silently unguarded.
const PICKER_OPTION_ID = /^(?:model|effort|mode)-/;
const QUEUE_ACTION_OPTION_IDS = new Set(['cancel', 'interrupt']);

export function promptExpectsReply(payload) {
  if (payload?.kind === 'queued_release') return false;
  const options = Array.isArray(payload?.options) ? payload.options : [];
  if (options.length === 0) return true;
  return !options.every(o => o && typeof o.id === 'string'
    && (PICKER_OPTION_ID.test(o.id) || QUEUE_ACTION_OPTION_IDS.has(o.id)));
}

// A /model, /effort or /mode picker frame: every option id is a picker id
// (model-* / effort-* / mode-*). Distinct from a queue-notification frame
// (cancel / interrupt ids). Used to record picker frames so a reply can be
// dispatched as a picker command ONLY when its target_seq names one of these
// frames AND its choice is one of THAT frame's own offered values — value shape
// alone can't prove picker origin (an AskUserQuestion option's value is its raw
// model-generated label), and a frame must not authorize a value it never
// offered (e.g. a mode picker must not honour a model: value).
export function isPickerFrame(payload) {
  if (payload?.kind === 'queued_release') return false;
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

// Resolve a prompt_reply's `choice` against a pending prompt's option list.
// `options` is the same `[{id, label, ...}]` shape journaled as a `prompt`
// event's `options` field (see lib/prompt-buttons.js promptButtons() and
// index.js's sendAllQuestions button-building — both already produce this
// shape). Liberal per the brief: accepts a 1-based number, an option id, or
// a case-insensitive label match, in that order. Returns
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
//   resolvePermissionReply(key, decision) -> void (consumed by T-2.4)
//   hasLivePermissionPending(convoId) -> bool (consumed by T-2.4)
//   isLivePendingToolUse(key, convoId) -> bool (consumed by T-2.3)
//   resumeSessionForConvo(convoId, {username}) -> session-like object | null (optional)
//   noticeUnknownConvo(convoId, {type, username}) -> void (optional)
//   noticeStalePromptReply(convoId, {username, targetSeq, latestSeq}) -> void (optional)
//   emitRelease(convoId, {promptId, action, releasedIds}) -> void (optional)
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
  emitRelease,
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
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
  const pickerFramesByConvo = new Map();
  // Permission cards are concurrent, so their echoed journal seqs need a
  // per-convo seq -> P56 tuple-key registry rather than the singleton latest
  // prompt seq. T-2.3/T-2.4 add the echo/reply consumers; this task establishes
  // canonical ownership and keeps their index.js operations in the same
  // closure without importing index.js back into this module.
  const permissionFramesByConvo = new Map();
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
    const rawDecision = buffered.decision ?? buffered.choice;
    const decision = typeof rawDecision === 'string'
      && rawDecision.trim().toLowerCase() === 'allow'
      ? 'allow'
      : 'deny';
    resolvePermissionReply(key, decision);
  }
  // Stable queue-card identity is owned here rather than on a session because
  // prompt echoes arrive before session lookup. queuedReleaseSeqs is a bounded
  // classification tombstone: resolving a card removes its live prompt entry,
  // but its echoed seq remains recognizable until retention eviction or
  // terminal convo eviction.
  const queuedReleaseSeqs = new Map();
  const queuedPrompts = new Map();

  function noteQueued(convoId, { promptId, itemId } = {}) {
    if (typeof convoId !== 'string' || !convoId
      || typeof promptId !== 'string' || !promptId
      || typeof itemId !== 'string' || !itemId) return;
    let prompts = queuedPrompts.get(convoId);
    if (!prompts) {
      prompts = new Map();
      queuedPrompts.set(convoId, prompts);
    }
    const existing = prompts.get(promptId);
    if (existing) {
      if (!existing.itemIds.includes(itemId)) existing.itemIds.push(itemId);
      return;
    }
    prompts.set(promptId, { prompt_id: promptId, itemIds: [itemId], seq: null });
  }

  function trimResolvedSeqs(convoId, seqs) {
    const liveSeqs = new Set();
    for (const entry of queuedPrompts.get(convoId)?.values() || []) {
      if (Number.isInteger(entry.seq)) liveSeqs.add(entry.seq);
    }
    let resolvedCount = 0;
    for (const seq of seqs) {
      if (!liveSeqs.has(seq)) resolvedCount++;
    }
    if (resolvedCount <= QUEUED_RELEASE_SEQ_RETENTION) return;
    for (const seq of seqs) {
      if (liveSeqs.has(seq)) continue;
      seqs.delete(seq);
      resolvedCount--;
      if (resolvedCount <= QUEUED_RELEASE_SEQ_RETENTION) return;
    }
  }

  function annotateSeq(convoId, seq, promptId) {
    if (typeof convoId !== 'string' || !convoId || !Number.isInteger(seq)) return;
    let seqs = queuedReleaseSeqs.get(convoId);
    if (!seqs) {
      seqs = new Set();
      queuedReleaseSeqs.set(convoId, seqs);
    }
    seqs.add(seq);

    const entry = queuedPrompts.get(convoId)?.get(promptId);
    if (entry) entry.seq = seq;
    trimResolvedSeqs(convoId, seqs);
  }

  function classifyBySeq(convoId, targetSeq) {
    if (!queuedReleaseSeqs.get(convoId)?.has(targetSeq)) {
      return { state: 'unknown' };
    }
    const prompts = queuedPrompts.get(convoId);
    if (prompts) {
      for (const entry of prompts.values()) {
        if (entry.seq === targetSeq) {
          return {
            state: 'live',
            entry: { ...entry, itemIds: [...entry.itemIds] },
          };
        }
      }
    }
    return { state: 'tombstoned' };
  }

  function dropItem(convoId, itemId) {
    const prompts = queuedPrompts.get(convoId);
    if (!prompts) return;
    for (const [promptId, entry] of prompts) {
      const index = entry.itemIds.indexOf(itemId);
      if (index === -1) continue;
      entry.itemIds.splice(index, 1);
      if (entry.itemIds.length === 0) prompts.delete(promptId);
      if (prompts.size === 0) queuedPrompts.delete(convoId);
      const seqs = queuedReleaseSeqs.get(convoId);
      if (seqs) trimResolvedSeqs(convoId, seqs);
      return;
    }
  }

  function listLive(convoId) {
    const live = [];
    for (const [promptId, entry] of queuedPrompts.get(convoId) || []) {
      for (const itemId of entry.itemIds) live.push({ promptId, itemId });
    }
    return live;
  }

  function carryForward(fromConvoId, toConvoId) {
    if (typeof fromConvoId !== 'string' || !fromConvoId
      || typeof toConvoId !== 'string' || !toConvoId
      || fromConvoId === toConvoId) return;

    const fromSeqs = queuedReleaseSeqs.get(fromConvoId);
    if (fromSeqs) {
      const movedSeqs = new Set([
        ...fromSeqs,
        ...(queuedReleaseSeqs.get(toConvoId) || []),
      ]);
      queuedReleaseSeqs.set(toConvoId, movedSeqs);
      queuedReleaseSeqs.delete(fromConvoId);
    }

    const fromPrompts = queuedPrompts.get(fromConvoId);
    if (fromPrompts) {
      const movedPrompts = new Map([
        ...(queuedPrompts.get(toConvoId) || []),
        ...fromPrompts,
      ]);
      queuedPrompts.set(toConvoId, movedPrompts);
      queuedPrompts.delete(fromConvoId);
    }
    const movedSeqs = queuedReleaseSeqs.get(toConvoId);
    if (movedSeqs) trimResolvedSeqs(toConvoId, movedSeqs);
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
        } else if (isPickerFrame(payload)) {
          let frames = pickerFramesByConvo.get(convoId);
          if (!frames) { frames = new Map(); pickerFramesByConvo.set(convoId, frames); }
          frames.set(frame.seq, pickerFrameValues(payload));
          // Bound growth: Map preserves insertion order, so drop the oldest
          // frames once the retention window is exceeded.
          while (frames.size > PICKER_FRAME_RETENTION) {
            frames.delete(frames.keys().next().value);
          }
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
            && isLivePendingToolUse(key, convoId)
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
      if (!session && (type === 'text' || isMedia) && resumeSessionForConvo) {
        // Reaped-but-resumable convo: the idle reaper kills sessions on the
        // assumption that "the next user message auto-resumes" — give the
        // caller the same chance the Matrix room path gets before declaring
        // the convo dead. Text and media both qualify (delivery after the
        // wake is safe: print mode's stdin buffers, iv mode's resume hold
        // parks input until the TUI is ready), but only with something to
        // deliver — a blank message or a blob_ref-less media frame must not
        // respawn a session. A prompt_reply never resumes: its pending
        // prompt died with the process, so there's nothing valid to answer.
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (type === 'text' ? body : blobRef) {
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

      // type === 'prompt_reply'. A queued-release tap is proven by the
      // target seq of the bridge-authored card, never by the reply value:
      // ordinary prompts are allowed to offer choices literally named
      // "send" or "cancel". Intercept before the staleness guard because a
      // queued-release card is deliberately non-answerable and therefore
      // never advances latestPromptSeqByConvo.
      const targetSeq = payload?.target_seq;
      const queuedRelease = queueRelease.classifyBySeq(convoId, targetSeq);
      if (queuedRelease.state !== 'unknown') {
        if (!QUEUED_RELEASE_ACTIONS.has(payload?.choice)) {
          warn(`[journal-input] invalid queued_release action for convo=${convoId}: target_seq=${String(targetSeq)} — ignoring`);
          return;
        }
        // The tombstone outlives the live entry so duplicate and late taps
        // remain classified as queue actions instead of falling through to
        // the ordinary answer path.
        if (queuedRelease.state === 'tombstoned') return;
        routePromptReply(session, {
          target_seq: targetSeq ?? null,
          choice: payload.choice,
          text: payload?.text ?? null,
        }, ctx);
        return;
      }

      // A stale pre-deploy client can still send the retired Matrix-shaped
      // values. Preserve its historical route-around-staleness behavior so
      // the receiver can silently no-op it; these values never resolve a
      // live structured card and never mutate the queue.
      if (isQueueReleaseTap(payload?.choice)) {
        routePromptReply(session, {
          target_seq: targetSeq ?? null,
          choice: payload.choice,
          text: payload?.text ?? null,
        }, ctx);
        return;
      }

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
      // a prompt answer (loop #461 / PR review B1 + M1 + M2).
      const pickerFrames = pickerFramesByConvo.get(convoId);
      const offeredValues = (payload?.target_seq != null && pickerFrames)
        ? pickerFrames.get(payload.target_seq)
        : null;
      if (offeredValues && offeredValues.has(payload?.choice)) {
        // Single-use: consume the frame before dispatch so a double-tap or
        // client retry (a second prompt_reply for the same target_seq) doesn't
        // fire the switch twice — which would restart a print session twice or
        // write effort into the PTY twice. Reopening the picker publishes a
        // fresh frame with a new seq.
        pickerFrames.delete(payload.target_seq);
        routePromptReply(session, {
          target_seq: payload.target_seq,
          choice: payload.choice,
          text: payload?.text ?? null,
          picker: true,
        }, ctx);
        return;
      }

      const permFrames = permissionFramesByConvo.get(convoId);
      if (targetSeq != null && permFrames?.has(targetSeq)) {
        const key = permFrames.get(targetSeq);
        const decision = typeof payload?.choice === 'string'
          && payload.choice.trim().toLowerCase() === 'allow'
          ? 'allow'
          : 'deny';
        if (typeof resolvePermissionReply === 'function') {
          resolvePermissionReply(key, decision);
        }
        return;
      }

      // A permission tap can beat the bridge's own permission_request echo,
      // including when that permission card is the convo's first card and no
      // ordinary prompt seq has ever been recorded. Hold a non-latest target
      // while a seq-null permission is live; the echo branch above drains it
      // only after establishing the target seq's provenance.
      const latestSeq = latestPromptSeqByConvo.get(convoId);
      let bufferRejected = false;
      if (targetSeq != null
        && (latestSeq === undefined || targetSeq !== latestSeq)
        && typeof hasLivePermissionPending === 'function'
        && hasLivePermissionPending(convoId)) {
        if (Number.isInteger(targetSeq)) {
          let replies = permissionReplyBuffer.get(convoId);
          const existing = replies?.get(targetSeq);
          if (existing || ((replies?.size || 0) < PERMISSION_MAX_PENDING_PER_CONVO
            && permissionReplyBufferCount < PERMISSION_MAX_PENDING_GLOBAL)) {
            if (!replies) {
              replies = new Map();
              permissionReplyBuffer.set(convoId, replies);
            }
            if (existing) clearTimeout(existing.timer);
            const buffered = {
              choice: payload?.choice ?? null,
              text: payload?.text ?? null,
              timer: null,
            };
            buffered.timer = setTimeout(() => {
              if (replies.get(targetSeq) !== buffered) return;
              replies.delete(targetSeq);
              permissionReplyBufferCount -= 1;
              if (replies.size === 0) permissionReplyBuffer.delete(convoId);
              noticeNothingToAnswer(convoId, { username, targetSeq, latestSeq });
            }, PERMISSION_REPLY_BUFFER_TTL_MS);
            replies.set(targetSeq, buffered);
            if (!existing) permissionReplyBufferCount += 1;
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
  onJournalEvent.evictConvo = function evictConvo(convoId, { clearQueue } = {}) {
    if (typeof emitRelease === 'function') {
      for (const { promptId, itemId } of queueRelease.listLive(convoId)) {
        emitRelease(convoId, {
          promptId,
          action: 'cancel',
          releasedIds: [itemId],
        });
      }
    }
    if (typeof clearQueue === 'function') clearQueue();
    latestPromptSeqByConvo.delete(convoId);
    pickerFramesByConvo.delete(convoId);
    permissionFramesByConvo.delete(convoId);
    const bufferedReplies = permissionReplyBuffer.get(convoId);
    for (const buffered of bufferedReplies?.values() || []) {
      clearTimeout(buffered.timer);
    }
    permissionReplyBufferCount -= bufferedReplies?.size || 0;
    permissionReplyBuffer.delete(convoId);
    queuedReleaseSeqs.delete(convoId);
    queuedPrompts.delete(convoId);
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
