import dotenv from 'dotenv';
dotenv.config({ override: true });
import { spawn } from 'child_process';
import { transcribeAudio } from './lib/transcribe.js';
import { prepareInlineImage, appendInlineImageBlocks } from './lib/inline-image.js';
import { createSendAttachmentHandler } from './lib/send-attachment.js';
import { createServer } from 'http';
import { createHmac, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import os from 'os';
import { createLiveOutputStore, sweepOrphanedLogs } from './lib/live-output.js';
import { createToolStreamPump, toolOutputSnippet, decodeByteExact } from './lib/tool-stream-pump.js';
import { computeEditDiff } from './lib/edit-diff.js';
import { resolveShareTarget } from './lib/share-target.js';
import { createInteractiveSession } from './lib/interactive-session.js';
import { projectDirFor, transcriptPathFor, findTranscriptBySessionId } from './lib/transcript-dir.js';
import { extractUrls, isIdleReadyScreen, extractPreamble, preambleMatchesText, compactScreenText, AUTO_ENTER_COMPACT_RE, LOGIN_SUCCESS_COMPACT_RE, loginSuccessNearAutoEnterCue } from './lib/prompt-detector.js';
import {
  buildMcpServers,
  effectiveExtras,
  extractMcpExtraFlags,
  extractPromptFlag,
  knownMcpExtras,
  resolveDefaultExtras,
} from './lib/mcp-config.js';
import { modelFromEvent, VALID_ALIAS_HINT } from './lib/model-aliases.js';
import { switchModelInSession, modelButtons, planPrintModelSwitch } from './lib/model-command.js';
import {
  resolveInteractive,
  resolveModel,
  normalizeModeArg,
  modeLabel,
  modeButtons,
  planModeSwitch,
  planSessionIdentity,
  eventConfirmsSession,
  shouldRunAccountFlowReturn,
} from './lib/session-mode.js';
import { switchEffortInSession, effortButtons, VALID_EFFORT_HINT } from './lib/effort-command.js';
// formatDuration aliased: index.js has its own uptime formatDuration (no
// day unit); timer feedback uses the lib's day-aware one so "/timer 7d"
// reads "7d", not "168h".
import { parseTimerCommand, formatDuration as formatTimerDuration, createTimerStore, timerCancelButton, timerSendNowButton } from './lib/timer-command.js';
import { promptButtons, promptResponseForButton } from './lib/prompt-buttons.js';
import { parseOptionReply } from './lib/prompt-reply.js';
import { sendDelayedPromptAnswer, writePromptAnswer } from './lib/prompt-answer-delivery.js';
import { SubagentWatcher } from './lib/subagent-watcher.js';
import {
  setupCodexWatcherForSession,
} from './lib/codex-watcher-setup.js';
import { launchWithCodexSinkEnv, pruneStaleCodexSinks, removeCodexSinkForSession } from './lib/codex-paths.js';
import { createSubagentConvoTracker } from './lib/subagent-convos.js';
import { createQueuedReleaseOutbox } from './lib/queued-release-outbox.js';
import { createSubagentRunningStore } from './lib/subagent-running-store.js';
import { selectStrandedChildren, strandedRepairFrames } from './lib/subagent-reconcile.js';
import { journalReemitCodexOutcomes } from './lib/codex-convos.js';
import { formatSubagentToolBody } from './lib/subagent-tool-format.js';
import { ivUploadDir, ivUploadAnnotation } from './lib/iv-uploads.js';
import { parseUsageLimits, formatLimits } from './lib/usage-limits.js';
import { resolveSpawnCwd, attachSpawnErrorHandler } from './lib/spawn-guard.js';
import { buildSessionSettings } from './lib/session-settings.js';
import { buildPermissionSnapshot, classifyPermission } from './lib/permission-eval.js';
import { readSessionSummary, listSessionSummaries, listSessionIdsByMtime, pathExists } from './lib/session-summary.js';
import {
  extractForceFlag,
  isIvSlashPassthrough,
  dispatchJournalBridgeCommand,
  dispatchJournalRescueKeystroke,
  dispatchPlanBuild,
  classifyJournalControlCommand,
  JOURNAL_CONTROL_HELP,
  JOURNAL_CONTROL_HELP_NOTE,
} from './lib/command-dispatch.js';
import { sendPrintInterrupt } from './lib/print-interrupt.js';
import {
  checkFileLink,
  validateAndOpen,
  FileLinkDenied,
  pinAllowedRootsSync,
} from './lib/file-link-guard.js';
import {
  denialToStatus,
  parseShowFileUploadTimeoutMs,
  shareAgentMedia,
} from './lib/show-file.js';
import { processShowFile } from './lib/show-file-handler.js';
import { createJournalPublisher, FLUSH_TIMEOUT_MS } from './lib/journal-publisher.js';
import { createRpcRequestHandler } from './lib/journal-rpc.js';
import { buildActivity, buildLimits } from './lib/spawn-capacity.js';
import { createAgentSpawnHandlers } from './lib/agent-spawn.js';
import { createRecentFolders } from './lib/recent-folders.js';
import { atomicWriteFileSync } from './lib/atomic-write.js';
import { createInflightMarker } from './lib/inflight-marker.js';
import { cancelQueuedItem, dispatchBusyQueueMagicWord, notifyQueuedMessage, resolveQueueReleaseTap } from './lib/busy-queue.js';
import { handlePickerValue, isResumeConvoId } from './lib/picker-dispatch.js';
import { createJournalInputConsumer, resolvePromptChoice } from './lib/journal-input-router.js';
import { createAgentRooms, INVITE_TTL_MS } from './lib/agent-rooms.js';
import { createAgentInvites, formatInviteRequestNotice } from './lib/agent-invites.js';
import { resolveInviteTarget } from './lib/invite-target.js';
import { createRoomDelivery, formatRoomMessageNotice, formatRoomDeliveredNotice, formatRoomDeliveryFailedNotice, ROOM_MESSAGE_QUEUED_NOTICE } from './lib/room-delivery.js';
import { createRoomReplyWaiters } from './lib/room-reply-waiters.js';
import { createAgentChatHandlers } from './lib/agent-chat.js';
import {
  auditPermissionDecision,
  createPermissionDecisionBodyCollector,
  createPermissionSeams,
  createRequestPermissionDecision,
  handlePermissionDecisionRoute,
  PERMISSION_DECISION_TIMEOUT_MS,
} from './lib/permission-registry.js';
import { createJournalMediaRouter } from './lib/journal-media.js';
import { markJournalOrigin, planQueueFlush } from './lib/queue-flush.js';
import { isCompactCommand, compactBatchSize, hasQueuedCompact } from './lib/compact-priority.js';
import { attachPendingMediaMirror, pendingMediaMirror } from './lib/media-mirror.js';
import { seedJournalTitle, applyFallbackTitle, formatRoomTitle } from './lib/journal-title-seed.js';
import { toolRepoSignals, commitRepoSignals, dominantRepo, emptyRepoScores, normalizeRepoScores } from './lib/repo-infer.js';
import { codexOneShot } from './lib/codex-oneshot.js';
import { updatePinnedSummary } from './lib/pinned-summary.js';
import { SUMMARY_MIN_NEW } from './lib/summary-pass.js';
import { activityStateChanged, truncateActivityDetail, shouldResumeThinkingAfterTool } from './lib/journal-activity.js';
import { streamRefFor } from './lib/journal-stream.js';
import { contextFullToNative, briefContextReport } from './lib/context-command.js';
import { buildSessionStatus, contextTokensFromAssistantEvent, postCompactContextTokens, compactTriggerFrom, contextGaugeText, emailFromClaudeConfig, isSidechainEvent, reconcileModelForWindow, hostVitalLimits, startCpuSampler, stopCpuSampler, cpuPercent, ramPercent, cpuSampledAtMs, statusRepaintDue } from './lib/session-status.js';
import {
  AGENT_CLAUDE,
  AGENT_CODEX,
  agentLabel,
  extractAgentFlag,
  normalizeAgent,
  resolveAgent,
} from './lib/agent-backend.js';
import {
  buildAgentHandoffPrompt,
  canSwitchAgent,
  getPersistedAgentState,
  matchSessionIdPrefix,
  mergeAgentStates,
  normalizeHistoryCursor,
  otherAgent,
  prependHandoffPrompt,
  resolveNativeSessionIdForPersistence,
  snapshotAgentState,
} from './lib/agent-handoff.js';
import { CodexExecSession, contentBlocksToCodexPrompt, normalizeCodexSandbox } from './lib/codex-session.js';

const DEFAULT_BRIDGE_CLAUDE_MD_PATH = path.join(__dirname, 'BRIDGE_CLAUDE.md');
const DEFAULT_BRIDGE_CODEX_MD_PATH = path.join(__dirname, 'BRIDGE_CODEX.md');
const FALLBACK_BRIDGE_PROMPT = 'You are running through a remote Matron bridge. The user interacts through chat, not a terminal.';
const FALLBACK_CODEX_BRIDGE_PROMPT = 'You are running through a remote chat bridge. Work autonomously within the configured sandbox; interactive approvals are unavailable.';

// --- Config ---

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const DEFAULT_WORKDIR = path.resolve(expandHome(process.env.DEFAULT_WORKDIR || process.cwd()));
// Cap on un-committed repo signals staged per session (tool_use blocks awaiting
// their tool_result). Bounds the rare residue from denied/orphaned tools; a
// normal tool always drains its entry on result. Oldest-evicted when exceeded.
const MAX_PENDING_REPO_SIGNALS = 256;
const DEFAULT_AGENT = resolveAgent({ fallback: process.env.MATRON_DEFAULT_AGENT || AGENT_CLAUDE });
if (process.env.MATRON_DEFAULT_AGENT && !normalizeAgent(process.env.MATRON_DEFAULT_AGENT)) {
  console.warn(`[agent] Unknown MATRON_DEFAULT_AGENT=${JSON.stringify(process.env.MATRON_DEFAULT_AGENT)}; defaulting to claude.`);
}
const CODEX_SANDBOX_MODE = normalizeCodexSandbox(process.env.CODEX_SANDBOX_MODE || 'workspace-write');
// Idle reaping: a session is killed if no activity (incoming user message OR
// outgoing assistant text posted to Matrix) is observed within this window.
// Sessions are resumable, so the next user message will respawn claude with
// --resume. Set to 0 to disable.
// Default 1h. Reaping is silent and the next user message auto-resumes the
// session via the existing path, so the only cost is a few-second resume on
// re-entry — well worth it on memory-constrained hosts where idle sessions
// previously piled up for a full day (~1G each with default extras). Override
// via SESSION_IDLE_TIMEOUT_MS (set to 86400000 to restore the old 24h
// behaviour, or 0 to disable the reaper entirely).
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '3600000', 10);
const SESSION_IDLE_CHECK_MS = parseInt(process.env.SESSION_IDLE_CHECK_MS || '300000', 10);
// Cadence of the host-wide vitals push (CPU/RAM) — a single convo-less gauge
// evaluated on a fast timer but published ON CHANGE: emit a frame only when CPU
// or RAM moves past a threshold (idle jitter is filtered), plus a slow heartbeat
// so the gauge stays fresh under steady load. Idle bridge -> ~no traffic; active
// work shows the full rise and fall. All env-overridable.
const HOST_VITALS_SAMPLE_MS = parseInt(process.env.HOST_VITALS_SAMPLE_MS || '2000', 10);
const HOST_VITALS_DELTA_PCT = parseInt(process.env.HOST_VITALS_DELTA_PCT || '4', 10);
const HOST_VITALS_HEARTBEAT_MS = parseInt(process.env.HOST_VITALS_HEARTBEAT_MS || '30000', 10);
let _hostVitalsPushHandle = null;
let _lastVitalsPublished = null; // { cpu, ram, at } of the last emitted frame

// Restart carry-on window. A turn interrupted by a bridge restart is offered
// a "Carry on" card at the next boot, but only if the conversation was active
// within this window — measured from the marker's last touch, so a long turn
// that was still working right before the crash still qualifies. Deliberately
// NOT reusing SESSION_IDLE_TIMEOUT_MS: that answers a different question (how
// long to hold memory for an idle session), and 1h would mean restarting the
// bridge before a long meeting silently loses the card.
const RESTART_CARRY_ON_MAX_AGE_MS = parseInt(process.env.MATRON_RESTART_CARRY_ON_MAX_AGE_MS || '21600000', 10);

// Resume-readiness gate (iv-mode). A freshly-spawned `claude --resume` takes
// several seconds to load the transcript — and longer if it auto-compacts —
// far longer than the 500ms paste→Enter window in sendText. Typing the first
// message in immediately drops it (the paste lands in a not-ready input box and
// the Enter is swallowed). So we HOLD post-resume messages and only flush them
// once the TUI goes idle-and-ready: PTY output quiesces for QUIET_MS AND the
// screen shows the idle input box (no "esc to interrupt"). HARDCAP_MS is the
// backstop so a message is never lost if readiness is never detected.
const RESUME_READY_QUIET_MS = parseInt(process.env.RESUME_READY_QUIET_MS || '800', 10);
const RESUME_READY_HARDCAP_MS = parseInt(process.env.RESUME_READY_HARDCAP_MS || '120000', 10);
const MAX_MSG_LENGTH = 32768;  // Matrix supports ~65KB, use 32K as practical limit
const DEBUG = process.env.DEBUG === '1';
const INTERACTIVE_MODE = process.env.MATRON_INTERACTIVE_MODE === '1';
const SESSIONS_FILE = path.join(os.homedir(), '.claude-matrix-sessions.json');
// Durable folder history for the picker (`recent_folders` RPC) — outlives
// the session records above, which stale-resume cleanup deletes.
const RECENT_FOLDERS_FILE = path.join(os.homedir(), '.matron-bridge-folders.json');
// /timer scheduled messages — persisted separately from the session store so
// a pending timer outlives the idle reaper, session restarts, and full
// bridge restarts (re-armed in main() via timerStore.init()).
const TIMERS_FILE = path.join(os.homedir(), '.matron-bridge-timers.json');
// In-flight turn markers for restart carry-on — written at turn start, removed
// at turn end, reconciled at the next boot (see lib/inflight-marker.js).
const INFLIGHT_FILE = path.join(os.homedir(), '.matron-bridge-inflight.json');

// Generate MCP config with resolved paths (--mcp-config requires a file, not inline JSON).
// The on-disk baseline assumes Linux (xvfb-run wraps the browser MCP); on macOS we
// strip that wrapper before writing the generated file so the server actually starts
// instead of failing with `spawn xvfb-run ENOENT`.
//
// mcp-config.json has two sections:
//   `mcpServers` — always-on (ask-user) — every session gets these
//   `mcpExtras`  — opt-in groups keyed by name (e.g. `browser`) — selected per
//                  session via flags on /start, /resume, /workdir
// Per opt-in combination we write a separate generated file (`.mcp-config-
// generated[.<extras>].json`) and pass its path to claude. Each browser stack
// is ~400M resident, so defaulting to none keeps lightweight sessions lean.
// `share` is likewise opt-in: OFF unless SHOW_FILE_DEFAULT_ON=1 is set in the
// bridge's environment (the operator launch path sets it so operator sessions
// keep show_file), or a session passes `--share`.
const RAW_MCP_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-config.json'), 'utf-8'));
const DEFAULT_MCP_EXTRAS = resolveDefaultExtras(process.env.SHOW_FILE_DEFAULT_ON);
const mcpConfigPathCache = new Map(); // sorted-extras-key -> generated file path

function mcpConfigPathFor(extras = []) {
  const { config, extras: sorted } = buildMcpServers({
    baseConfig: RAW_MCP_CONFIG,
    extras,
    askUserBaseDir: __dirname,
  });
  const key = sorted.join(',');
  const cached = mcpConfigPathCache.get(key);
  if (cached) return cached;
  const suffix = sorted.length ? '.' + sorted.join('-') : '';
  const p = path.join(__dirname, `.mcp-config-generated${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  mcpConfigPathCache.set(key, p);
  return p;
}

// Eagerly materialise the default (no-extras) config so the file exists on
// disk by the time any session spawns. Per-extras variants are generated
// lazily on first use.
mcpConfigPathFor([]);
// Sanity check: make sure the bridge's known extras stay in sync with what
// the config file declares.
for (const ex of knownMcpExtras()) {
  if (!RAW_MCP_CONFIG.mcpExtras?.[ex]) {
    console.warn(`[mcp-config] Flag --${ex} is recognised but no matching mcpExtras block exists; sessions opting in will get no extra servers.`);
  }
}
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || path.join(os.homedir(), '.local/share/whisper-cpp/models/ggml-small.bin');
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'en';

// Server label for room names: "dev-3" → "3", fallback to SERVER_LABEL env var
const SERVER_LABEL = process.env.SERVER_LABEL || (() => {
  const hostname = os.hostname();
  const match = hostname.match(/^(\w+)-(\d+)/);
  if (match) return match[2]; // Just the number
  return hostname.slice(0, 4).toUpperCase();
})();
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const VIEWER_BASE_URL = process.env.VIEWER_BASE_URL || '';
const LINK_EXPIRY_MS = parseInt(process.env.LINK_EXPIRY_MS || String(15 * 60 * 1000), 10);
const SHOW_FILE_MAX_BYTES = 50 * 1024 * 1024;
const SHOW_FILE_MAX_IN_FLIGHT = 2;
const SHOW_FILE_MAX_IN_FLIGHT_PER_SESSION = 1;
const SHOW_FILE_GLOBAL_BYTE_BUDGET = SHOW_FILE_MAX_IN_FLIGHT * SHOW_FILE_MAX_BYTES;
// Mutable global concurrency/byte budget, shared with processShowFile (which
// reserves before an upload and releases in its finally). An object so the
// extracted handler can mutate it by reference.
const showFileBudget = { inFlight: 0, reservedBytes: 0 };
const SHOW_FILE_UPLOAD_TIMEOUT_MS = parseShowFileUploadTimeoutMs(
  process.env.SHOW_FILE_UPLOAD_TIMEOUT_MS,
);
const SHOW_FILE_ARTIFACT_ROOTS = (process.env.SHOW_FILE_ARTIFACT_ROOTS || '')
  .split(':')
  .filter(Boolean);
for (const artifactRoot of SHOW_FILE_ARTIFACT_ROOTS) {
  // Must be an absolute path to an existing DIRECTORY. A regular file passes
  // isAbsolute+exists but is later rejected by session pinning, which would leave
  // show_file advertised with no token supplied (fail-loud config convention).
  let artifactRootStat;
  try {
    artifactRootStat = fs.statSync(artifactRoot);
  } catch {
    artifactRootStat = null;
  }
  if (!path.isAbsolute(artifactRoot) || !artifactRootStat || !artifactRootStat.isDirectory()) {
    throw new Error(
      `Invalid SHOW_FILE_ARTIFACT_ROOTS entry (must be an absolute path to an existing directory): ${JSON.stringify(artifactRoot)}`,
    );
  }
}
const SECRETS_DIR = path.join(os.homedir(), '.secrets');
const SECRET_TTL_MS = 3600000; // 1 hour
const BRIDGE_CLAUDE_MD_PATH = process.env.BRIDGE_CLAUDE_MD_PATH || DEFAULT_BRIDGE_CLAUDE_MD_PATH;
const BRIDGE_CODEX_MD_PATH = process.env.BRIDGE_CODEX_MD_PATH || DEFAULT_BRIDGE_CODEX_MD_PATH;

function loadBridgeSystemPrompt() {
  try {
    return fs.readFileSync(BRIDGE_CLAUDE_MD_PATH, 'utf-8').trim();
  } catch (e) {
    console.warn(`Could not read bridge Claude instructions from ${BRIDGE_CLAUDE_MD_PATH}: ${e.message}`);
    return FALLBACK_BRIDGE_PROMPT;
  }
}

const BRIDGE_SYSTEM_PROMPT = loadBridgeSystemPrompt();

function loadCodexBridgePrompt() {
  try {
    return fs.readFileSync(BRIDGE_CODEX_MD_PATH, 'utf-8').trim();
  } catch (e) {
    console.warn(`Could not read Codex bridge instructions from ${BRIDGE_CODEX_MD_PATH}: ${e.message}`);
    return FALLBACK_CODEX_BRIDGE_PROMPT;
  }
}

const CODEX_BRIDGE_PROMPT = loadCodexBridgePrompt();

// Live-bash-output store (per-process). Tracks active matron-tee'd Bash commands
// so that tool_result events can write the corresponding .done sentinel.
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '86400', 10);
const LIVE_OUTPUT_TTL = Number.isFinite(_rawLiveOutputTtl) && _rawLiveOutputTtl > 0 ? _rawLiveOutputTtl : 86400;
const liveOutputStore = createLiveOutputStore({ ttlSeconds: LIVE_OUTPUT_TTL });
sweepOrphanedLogs('/tmp', LIVE_OUTPUT_TTL);
setInterval(() => liveOutputStore.gcExpired(), 60_000).unref();
if (!HMAC_SECRET || !VIEWER_BASE_URL) {
  console.warn('[viewer] HMAC_SECRET or VIEWER_BASE_URL unset — file links and secure secret/sensitive-data links disabled');
}

// Journal dual-post (migration off Matrix — see matron-journal's protocol
// design doc). JOURNAL_TOKEN_FILE takes precedence over JOURNAL_TOKEN when
// both are set; the file is read once at boot. Disabled (safe no-op) unless
// both the URL and a token resolve to non-empty strings — see
// createJournalPublisher's own warning for the disabled case.
const JOURNAL_WS_URL = process.env.JOURNAL_WS_URL || '';
function resolveJournalToken() {
  const file = process.env.JOURNAL_TOKEN_FILE || '';
  if (file) {
    try {
      return fs.readFileSync(file, 'utf-8').trim();
    } catch (e) {
      console.warn(`[journal] Could not read JOURNAL_TOKEN_FILE ${file}: ${e.message}`);
      return '';
    }
  }
  return (process.env.JOURNAL_TOKEN || '').trim();
}
const _journalToken = resolveJournalToken();
// Return path (Matron -> bridge input, this PR): where the inbound cursor is
// persisted (survives a bridge restart — see lib/journal-publisher.js) and
// the stable conversation Matron sends session-start/list/help commands
// into. Both are wired regardless of JOURNAL_ENABLED; they're inert when the
// publisher is disabled (onEvent never fires on a noop publisher).
const JOURNAL_CURSOR_FILE = process.env.JOURNAL_CURSOR_FILE
  ? path.resolve(expandHome(process.env.JOURNAL_CURSOR_FILE))
  : path.join(__dirname, 'journal-cursor.json');
const JOURNAL_CONTROL_CONVO_ID = process.env.JOURNAL_CONTROL_CONVO_ID || `bridge-${os.hostname()}`;
// Bridge-side coalescing floor for in-progress assistant-text stream frames
// (per convo+message). Defaults to the server hub's own ~5/s fan-out window;
// a non-positive or unparseable value falls back to the publisher default.
const JOURNAL_STREAM_INTERVAL_MS = (() => {
  const raw = parseInt(process.env.JOURNAL_STREAM_INTERVAL_MS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
})();
// Active tool-output stream pumps, keyed `${convoId}\0${messageRef}` — the
// same key the server buffers under. Registered by the Bash tool_use seam,
// drained by stopAndFinalizeToolStream (tool_result) and killSession.
// Module-level rather than per-session so the single onStreamResync
// dispatcher below can route a server resync to its pump directly.
const toolStreamPumps = new Map();
function toolStreamKey(convoId, messageRef) {
  return `${convoId}\0${messageRef}`;
}
// Agent-chat invite manager (lib/agent-invites.js). Declared before the
// publisher so its options can reference it as thunks; constructed much
// later (next to the journal input consumer, where its own deps —
// journalPublisher, agentRooms, the inject glue — all exist). The thunks
// only ever fire once the socket is live, long after the assignment.
let agentInvites = null;
// Agent-spawn handlers (lib/agent-spawn.js) — same forward-declared-thunk
// pattern as agentInvites above; constructed next to agentChatHandlers, well
// after journalPublisher and agentRooms exist.
let agentSpawnHandlers = null;
// onEvent is wired to journalHandleInboundEvent, defined later in this file
// (function declarations are fully hoisted, so the forward reference is
// safe — onEvent is only ever CALLED once the socket is live, long after the
// whole module, including `sessions` and the routing functions below, has
// finished evaluating).
// Fires on every hello_ok — the FIRST connect (bridge startup, live sessions
// map still empty → all persisted running children reconcile) and every later
// reconnect (only children whose parent is no longer live). Named (not inlined
// into the createJournalPublisher options) so the reconcile + reemit block does
// not read as part of the publisher's option object. `journalPublisher` is
// referenced lazily — the handler only ever fires once the socket is live, long
// after the const below is assigned.
function handleJournalReconnect() {
  // Union of the two reconnect wirings (#207 + #536). Stranded-subagent reconcile
  // first, then journalOnReconnect — which reemits codex outcomes, republishes
  // overflow-evicted releases, and arms the deferred boot reconcile. The codex
  // reemit lives in journalOnReconnect, so it is NOT duplicated here.
  reconcileStrandedSubagents('reconnect');
  journalOnReconnect();
}

const journalPublisher = createJournalPublisher({
  url: JOURNAL_WS_URL,
  token: _journalToken,
  log: console,
  cursorFile: JOURNAL_CURSOR_FILE,
  onEvent: journalHandleInboundEvent,
  onStreamResync: (convoId, messageRef, have) => {
    toolStreamPumps.get(toolStreamKey(convoId, messageRef))?.pump.resync(have);
  },
  // Union of both reconnect wirings: handleJournalReconnect runs #207's stranded-
  // subagent reconcile AND (via journalOnReconnect) #536's release retry + deferred
  // boot reconcile. See handleJournalReconnect below.
  onReconnect: handleJournalReconnect,
  // Send-completion retry trigger (the mandatory one): re-publishes an
  // overflow-evicted release frame on a healthy socket that never reconnects.
  onSendCapacity: () => republishPendingReleases(),
  // Agent-RPC dispatch. Arrow + late-bound const (journalRpcHandler is
  // defined below): safe for the same reason onEvent's forward reference
  // is — the callback only ever fires once the socket is live, long after
  // module evaluation.
  onRpcRequest: (request) => journalRpcHandler(request),
  // Agent-chat invite lifecycle (kind:'invite' ephemerals and room-op error
  // frames) — thunked because agentInvites is constructed later (above).
  onInviteFrame: (frame) => agentInvites?.onInviteFrame(frame),
  // Agent-spawn ephemeral frames (kind:'spawn') — thunked for the same
  // reason as onInviteFrame: agentSpawnHandlers is constructed later.
  onSpawnFrame: (frame) => agentSpawnHandlers?.onSpawnFrame(frame),
  // Spawn correlation tries first (its waiters are request_id-keyed, same
  // style as agent-invites' own onOpError) — a `true` return means it owned
  // and consumed the ref, so the invite manager never sees it. Op-error refs
  // are never shared between the two managers, so this ordering is not a
  // race, just "ask the spawn side first."
  onOpError: (e) => { if (agentSpawnHandlers?.onOpError?.(e)) return; agentInvites?.onOpError(e); },
  ...(JOURNAL_STREAM_INTERVAL_MS ? { streamIntervalMs: JOURNAL_STREAM_INTERVAL_MS } : {}),
});
// Used to skip the per-session buffering/bookkeeping entirely when the
// publisher is a disabled no-op (its methods are already safe no-ops; this
// just avoids pointless buffers and spurious overflow warnings).
const JOURNAL_ENABLED = !!(JOURNAL_WS_URL && _journalToken);

if (JOURNAL_ENABLED) {
  // Boot the control convo eagerly — safe even before the WS is connected
  // (journalPublisher queues FIFO and flushes on connect, same as every
  // other publish here). No Matrix dependency: this convo has no Matrix
  // room, only a journal conversation.
  journalPublisher.upsertConvo(JOURNAL_CONTROL_CONVO_ID, { title: `${os.hostname()} bridge`, sessionState: 'running' });
  journalPublisher.publishText(JOURNAL_CONTROL_CONVO_ID, {
    body: 'Bridge online. Commands: "new [directory]" — start a session; "list" — active sessions; "help" — this text.',
    from: 'assistant',
  });
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function generateFileLink(filePath, workdir) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  // Normalize BEFORE gating and signing: a relative session.workdir (or
  // target) would otherwise resolve against the wrong process cwd in the
  // viewer, or trip the guard's relative-path check and kill the link.
  const absTarget = path.resolve(filePath);
  const absWorkdir = workdir ? path.resolve(workdir) : null;
  // Generation-time gate (UX — the viewer re-validates at serve time with
  // the fd-pinned checks): sensitive names and out-of-workdir targets never
  // get a link; callers render plain text on null.
  const gate = checkFileLink(absTarget, absWorkdir);
  if (!gate.ok) {
    console.log(`file-link denied (${gate.reason}): ${absTarget}`);
    return null;
  }
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ path: absTarget, exp, workdir: absWorkdir })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/view?token=${payload}.${sig}`;
}

function generateSecretLink(secretId, label, roomId) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ secretId, label, roomId, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/secret?token=${payload}.${sig}`;
}

function generateSensitiveLink(sensitiveId, label, ttl, { download = false, oneTime = true } = {}) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + ttl * 1000) / 1000);
  // dl discriminates the direct-download route (viewer /sensitive-download)
  // from the page route, mirroring the /view vs /download token scheme.
  const payloadObj = download
    ? { sensitiveId, label, dl: true, exp }
    : { sensitiveId, label, exp };
  // The shell page has to warn the user what kind of link they hold, and it
  // knows nothing but the token — so the token has to say. Present only for
  // multi-use shares: absent means one-time, matching both the creation
  // default and any token already in flight. Signed like everything else in
  // the payload, so it cannot be flipped by the holder.
  if (oneTime === false) payloadObj.ot = false;
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  const route = download ? 'sensitive-download' : 'sensitive';
  return `${VIEWER_BASE_URL}/${route}?token=${payload}.${sig}`;
}



function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

// --- Session Persistence ---

function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load sessions file:', e.message);
  }
  return {};
}

function savePersistedSessions(data) {
  try {
    // Atomic replace (PR #151 follow-up): this file is rewritten on every
    // message, and loadPersistedSessions treats a corrupt file as {} — so a
    // truncating in-place write that dies mid-rewrite silently drops every
    // persisted session, and the next persist overwrites the evidence.
    atomicWriteFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save sessions file:', e.message);
  }
}

// Folder history store, seeded once per boot from whatever the session
// store still knows — after that, folders survive on their own even when
// their session records are deleted.
const recentFolders = createRecentFolders({ file: RECENT_FOLDERS_FILE });
recentFolders.seedFrom(Object.values(loadPersistedSessions()).map((rec) => ({
  path: rec?.workdir,
  lastUsed: rec?.lastUsed,
})));

function persistSession(roomId, sessionId, workdir, originRoomId, extra) {
  recentFolders.touch(workdir, Date.now());
  const data = loadPersistedSessions();
  const existing = data[String(roomId)] || {};
  // Auto-carry session-scoped fields (mcpExtras) from the live session if the
  // caller didn't override them — most persistSession sites only know about
  // the field they're updating (chatHistory, pendingPlanDenialId, etc.) and
  // shouldn't have to remember to forward unrelated session state.
  const live = sessions.get(roomId);
  const derived = {};
  if (live && Array.isArray(live.mcpExtras)) derived.mcpExtras = live.mcpExtras;
  if (live?.agent) derived.agent = live.agent;
  if (live?.journalConvoId) derived.journalConvoId = live.journalConvoId;
  const activeAgent = normalizeAgent(extra?.agent || live?.agent || existing.agent);
  const existingAgent = normalizeAgent(existing.agent) || (existing.sessionId ? AGENT_CLAUDE : null);
  const historyLength = live?.chatHistory?.length || existing.chatHistory?.length || 0;
  const currentState = activeAgent
    ? getPersistedAgentState(existing, activeAgent, historyLength)
    : null;
  const sameAgent = !!activeAgent && activeAgent === existingAgent;
  // A null live ID normally means the CLI has not announced it yet, not that
  // an established same-provider ID should be erased. Agent switches are the
  // intentional reset case: activeAgent differs, so null remains null.
  const effectiveSessionId = resolveNativeSessionIdForPersistence({
    sessionId,
    currentStateId: currentState?.sessionId,
    existingSessionId: existing.sessionId,
    sameAgent,
  });
  // A newly created room (notably !resume) may inherit both providers from a
  // different persisted room. Carry that live inherited map automatically so
  // later narrow persistence calls cannot silently discard the inactive
  // provider, then apply any explicit caller update on top.
  let agentSessions = mergeAgentStates(existing.agentSessions, live?._agentSessions);
  agentSessions = mergeAgentStates(agentSessions, extra?.agentSessions);
  if (activeAgent) {
    let state = live?.agent === activeAgent
      ? snapshotAgentState(
        live,
        Number.isFinite(live._agentHistoryCursor)
          ? live._agentHistoryCursor
          : (live.chatHistory?.length || 0),
      )
      : {
        ...currentState,
        sessionId: sessionId || currentState.sessionId,
        model: extra?.model !== undefined ? extra.model : currentState.model,
        interactiveMode: extra?.interactiveMode !== undefined
          ? extra.interactiveMode
          : currentState.interactiveMode,
        mcpExtras: Array.isArray(extra?.mcpExtras) ? extra.mcpExtras : currentState.mcpExtras,
        lastUsed: Date.now(),
      };
    if (sameAgent && !state.sessionId && effectiveSessionId) {
      state = { ...state, sessionId: effectiveSessionId };
    }
    // An explicit caller override beats the live-session snapshot. The
    // snapshot branch reads interactiveMode from `!!live.iv` — but the two
    // callers that pass this field (applyModeSwitch, the /logout exit-0
    // handler) are announcing a mode CHANGE while the old-mode session is
    // still live/in the map, so the snapshot silently re-persisted the OLD
    // mode at the agent level (the level getPersistedAgentState prefers on
    // resume) and every auto-resume came back interactive: the stuck-mode
    // bug behind login-flow test rounds 1-4.
    if (extra?.interactiveMode !== undefined) {
      state = { ...state, interactiveMode: extra.interactiveMode };
    }
    agentSessions = mergeAgentStates(agentSessions, { [activeAgent]: state });
  }
  data[String(roomId)] = {
    ...existing,
    ...derived,
    sessionId: effectiveSessionId,
    workdir,
    lastUsed: Date.now(),
    originRoomId: originRoomId || null,
    ...(extra || {}),
    ...(activeAgent ? { agent: activeAgent } : {}),
    agentSessions,
  };
  savePersistedSessions(data);
}

function getPersistedSession(roomId) {
  const data = loadPersistedSessions();
  return data[String(roomId)] || null;
}

// Codex stores rollouts in a date-partitioned tree rather than Claude's
// per-workdir directory. For bridge-owned Codex conversations, the bridge's
// persistence file is the authoritative bounded index and also carries the
// workdir/summary needed by /sessions and /resume.
function listPersistedAgentSessions(agent, workdir = null) {
  const byId = new Map();
  for (const entry of Object.values(loadPersistedSessions())) {
    if (!entry) continue;
    if (workdir && entry.workdir !== workdir) continue;
    const historyLength = Array.isArray(entry.chatHistory) ? entry.chatHistory.length : 0;
    const state = getPersistedAgentState(entry, agent, historyLength);
    if (!state.sessionId) continue;
    const current = byId.get(state.sessionId);
    const modified = state.lastUsed || entry.lastUsed || 0;
    if (current && (current.lastUsed || 0) >= modified) continue;
    const firstUser = Array.isArray(entry.chatHistory)
      ? entry.chatHistory.find(item => item?.role === 'user' && item.text)?.text || ''
      : '';
    byId.set(state.sessionId, {
      ...entry,
      ...state,
      agent,
      sessionId: state.sessionId,
      modified,
      lastUsed: modified,
      summary: firstUser.slice(0, 80) + (firstUser.length > 80 ? '…' : ''),
    });
  }
  return [...byId.values()].sort((a, b) => b.modified - a.modified);
}

function findPersistedAgentSession(agent, sessionId) {
  if (!sessionId) return null;
  return listPersistedAgentSessions(agent)
    .find(entry => entry.sessionId === sessionId) || null;
}

// --- Session Manager ---

const sessions = new Map(); // roomId -> session

// Persistent, crash-safe write-ahead outbox for queued_release resolutions
// (loop #536). Constructed here so it loads + relabels any inherited on-disk
// `pending` records to `pending_inherited` synchronously at boot, before the
// publisher fires any hook. emitRelease writes-ahead into it; the router's
// echo-ack flips records `acked`; the retry driver + boot reconcile read it.
const releaseOutbox = createQueuedReleaseOutbox({ log: console });
// The one-shot boot-reconcile guard + its quiet-period deferral timer live in
// the emitRelease..journalUpsertConvo seam below (scheduleReleaseReconcile),
// next to reconcileReleaseOutbox itself.

// Persistent record of subagent child convos currently `running`.
// Written by each session's subagent tracker (add on mint, remove on finish);
// read at startup/reconnect by reconcileStrandedSubagents to mark ghosts done.
// A single shared store is safe — childConvoIds are globally unique.
const subagentRunningStore = createSubagentRunningStore({ log: console });

// RPC-start (lib/journal-rpc.js `start`): the !start command body minus the
// origin-room replies — an RPC start has no origin chat room. Returns the
// session; the RPC handler answers with its claudeSessionId (the journal
// convo id — NOT the room key, which is bridge-internal).
function journalStartSessionForRpc({ workdir, mcpExtras }) {
  const sessionRoomId = newSessionConvoId();
  const sessionSendReply = (reply) => sendToRoom(sessionRoomId, reply, markdownToHtml(reply));
  const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
  const sessionSendButtons = (prompt, buttons, mode, plainText, html, payload) =>
    sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html, payload);
  const session = createSession(sessionRoomId, workdir, undefined, { mcpExtras });
  session.originRoomId = null;
  session.sendCallback = sessionSendReply;
  session.sendHtml = sessionSendHtml;
  session.sendButtonMessage = sessionSendButtons;
  // Same persistence rule as !start: claudeSessionId is known immediately
  // (pre-assigned at spawn), so persist extras now rather than losing them
  // to a bridge restart before the first transcript-driven persist.
  if (mcpExtras.length > 0 && session.claudeSessionId) {
    persistSession(sessionRoomId, session.claudeSessionId, session.workdir, null);
  }
  return session;
}

const journalRpcHandler = createRpcRequestHandler({
  respondRpc: (args) => journalPublisher.respondRpc(args),
  startSession: journalStartSessionForRpc,
  // The !stop teardown for the unsupported_mode orphan: kill, drop from the
  // sessions map (keyed by room id — scan, this path is rare), evict input.
  stopSession: (session) => {
    killSession(session);
    for (const [key, value] of sessions) {
      if (value === session) { sessions.delete(key); break; }
    }
    journalEvictConvoInput(session);
  },
  listPersistedSessions: () => Object.values(loadPersistedSessions()),
  listRememberedFolders: () => recentFolders.list(),
  defaultWorkdir: DEFAULT_WORKDIR,
  expandHome,
  // Capacity thunks (2026-08-10 capacity spec): answered from cache, never
  // blocking a reply on a subprocess. getLimits kicks a background refresh
  // (throttled, see refreshUsageLimits) but always returns synchronously
  // from whatever usageLimitsCache holds right now.
  getActivity: () => buildActivity({ sessions, persisted: loadPersistedSessions() }),
  getLimits: () => { refreshUsageLimits(DEFAULT_WORKDIR); return buildLimits(usageLimitsCache); },
  // Which account a new session here would burn quota against, so the chooser
  // can tell boxes on different logins apart. Same cache as the status frames.
  getAccountEmail: () => getAccountEmail(),
  // Spawn-room wiring (2026-08-09 agent-spawn spec). agentRooms is declared
  // later in this file (~:7223) — these arrows only dereference it at call
  // time, long after module evaluation finishes, same late-binding as
  // onRpcRequest's forward reference to journalRpcHandler above.
  bindSpawnRoom: (roomId, session) => {
    agentRooms.record(roomId, { role: 'guest', state: 'joined', sessionRoomId: session.roomId });
  },
  unbindSpawnRoom: (roomId) => agentRooms.remove(roomId),
  injectTurn: (session, text) => sendTextToSession(session, text, { skipJournalMirror: true }),
  serverLabel: SERVER_LABEL,
  log: console,
});


function journalConvoIdFor(session) {
  return session?.journalConvoId || session?.claudeSessionId || null;
}

// Reverse lookup for the journal return path: a journal frame's convo_id is
// the stable bridge conversation ID (historically the first native Claude
// session ID), but `sessions` is keyed by roomId. The session
// count is small (a handful of concurrent rooms per box), so a linear scan
// on each inbound event is simpler than maintaining a second map in sync
// with every place a session is created/restarted/deleted.
function findSessionByClaudeSessionId(claudeSessionId) {
  if (!claudeSessionId) return null;
  for (const session of sessions.values()) {
    if (journalConvoIdFor(session) === claudeSessionId || session.claudeSessionId === claudeSessionId) return session;
  }
  return null;
}

// --- Journal dual-post mirroring ---
//
// A legacy conversation uses the first native session UUID as its journal
// convo_id. Agent-switching keeps that ID stable in session.journalConvoId
// while session.claudeSessionId changes between provider-native sessions.
// The ID is known immediately in interactive mode (assigned at spawn) but only
// after the first transcript event lands in fresh print mode. Until it's known,
// journal traffic for that session is buffered (bounded) and flushed —
// convo_upsert first, then the buffered frames in order — the moment the id
// shows up (see the session_id capture in handleClaudeEvent). Rooms that
// never get a session (control-room chatter) are never mirrored, matching v1
// scope.
const JOURNAL_BUFFER_LIMIT = 100;

function journalBufferPush(session, method, payload) {
  if (!session._journalBuffer) session._journalBuffer = [];
  if (session._journalBuffer.length >= JOURNAL_BUFFER_LIMIT) {
    session._journalBuffer.shift();
    if (!session._journalBufferOverflowWarned) {
      session._journalBufferOverflowWarned = true;
      console.warn(`[journal] pre-session-id buffer overflow for room ${session.roomId} — dropping oldest`);
    }
  }
  session._journalBuffer.push({ method, payload });
}

// Send now if the convo_id is known, otherwise buffer for the eventual flush.
function journalPublish(session, method, payload) {
  if (!JOURNAL_ENABLED) return;
  const convoId = journalConvoIdFor(session);
  if (convoId) {
    // Protocol requirement: a convo_upsert must reach the server before (or
    // with) the first publish to a convo — the server hard-rejects publishes
    // to conversations that don't exist yet. Sessions whose id arrives late
    // (codex thread_ids) get this via journalFlushForSession, but claude
    // sessions know their id at spawn and never buffer, so an assistant
    // notice posted before the first state-transition upsert would otherwise
    // be dropped server-side.
    if (!session._journalConvoEstablished) {
      session._journalConvoEstablished = true;
      if (method !== 'upsertConvo') {
        journalPublisher.upsertConvo(convoId, { title: session._journalTitleHint });
      }
    }
    journalPublisher[method](convoId, payload);
  } else {
    journalBufferPush(session, method, payload);
  }
}

// Transactional release seam (loop #536, spec §3). Order: write-ahead a durable
// `pending` outbox record → (if a mutate thunk is supplied) run the irreversible
// queue mutation → publish with a deterministic idem_key. FAIL-CLOSED: if the
// write-ahead can't durably persist, ABORT before the mutation and the publish
// (return false), leaving the card actionable — a failed durability prerequisite
// must never let the irreversible mutation proceed with no recoverable record.
// Returns true on a durable emit, false on a fail-closed abort.
// Reconnect handler (hoisted so the createJournalPublisher arg block stays free
// of a nested `});`). Re-emits Codex outcomes (upstream behavior) and drives the
// queued-release durability retry + one-shot boot reconcile (loop #536).
function journalOnReconnect() {
  journalReemitCodexOutcomes({ sessions, publisher: journalPublisher });
  // Queued-release durability (spec §3 step 6): reconnect is one of the two
  // retry triggers. Safe on the FIRST hello_ok of a fresh boot — inherited
  // records are already `pending_inherited` (relabelled at load), which the
  // driver skips (state gate, not timing).
  republishPendingReleases();
  // Boot reconciliation (spec §5): expire every `pending_inherited` orphan.
  // DEFERRED behind a quiet-period timer, re-armed by every inbound journal
  // frame (journalHandleInboundEvent), so it fires only AFTER the reconnect
  // replay stream goes quiet. (The re-arm is not replay-specific — any inbound
  // frame pushes the timer out; during the post-reconnect burst those frames
  // are the replay.) F1 timing fix: the replay carries the echo of a
  // release that a prior process committed (journal append ran) but died before
  // acking; that echo's markAcked flips pending_inherited -> acked BEFORE this
  // reconcile runs, so a durably-committed release is never wrongly stamped
  // `expired`. Running synchronously here (the old behavior) raced the replay
  // and produced two contradictory terminal releases for one prompt. One-shot:
  // only the first hello_ok's replay is reconciled; later reconnects re-arm
  // nothing (the timer is null after the single reconcile fires).
  scheduleReleaseReconcile();
}

function emitRelease(convoId, { promptId, action, releasedIds }, { mutate } = {}) {
  const itemId = (Array.isArray(releasedIds) && releasedIds.length)
    ? releasedIds[0]
    : `${promptId}::0`;
  const at = Date.now();
  const recordKey = `${promptId}\0${itemId}\0${action}`;
  const durable = releaseOutbox.put(recordKey, {
    convoId,
    promptId,
    itemId,
    action,
    releasedIds: Array.isArray(releasedIds) ? releasedIds : [itemId],
    status: 'pending',
    at,
  });
  if (!durable) {
    console.warn(`[queued-release-outbox] write-ahead failed for ${recordKey} — aborting release (card stays actionable)`);
    return false;
  }
  try { mutate?.(); }
  catch (e) { console.warn(`[emitRelease] mutate thunk threw for ${recordKey}: ${e?.message ?? String(e)}`); }
  journalPublisher.publishPromptReply(convoId, {
    kind: 'queued_release',
    prompt_id: promptId,
    action,
    released: releasedIds,
    at,
  }, { idemKey: `qr\0${promptId}\0${itemId}\0${action}` });
  return true;
}

// In-process retry driver (spec §3 step 6). Re-publishes every SAME-EPOCH
// `pending` outbox record whose frame is not already in the outbound queue,
// with its deterministic idem_key (so a re-publish of an already-journaled
// release is a server-side dedup no-op). SKIPS `pending_inherited` (the state
// gate — only boot reconcile touches those) and `acked`. Fired by two triggers
// (onSendCapacity + onReconnect); the in-progress flag coalesces overlapping
// fires into one pass.
let _republishingReleases = false;
function republishPendingReleases() {
  if (_republishingReleases) return;
  // O(1) fast path: this fires per confirmed frame on the hot output path
  // (onSendCapacity). With no retry-eligible records the pendingCount gate
  // avoids an O(all-releases-since-boot) list() allocation per streamed delta.
  if (releaseOutbox.pendingCount() === 0) return;
  _republishingReleases = true;
  try {
    for (const rec of releaseOutbox.list()) {
      if (rec.status !== 'pending') continue; // skip pending_inherited + acked
      const idemKey = `qr\0${rec.promptId}\0${rec.itemId}\0${rec.action}`;
      if (journalPublisher.hasQueuedIdem(idemKey)) continue; // frame still queued
      journalPublisher.publishPromptReply(rec.convoId, {
        kind: 'queued_release',
        prompt_id: rec.promptId,
        action: rec.action,
        released: rec.releasedIds,
        at: rec.at,
      }, { idemKey });
    }
  } finally {
    _republishingReleases = false;
  }
}

// Boot reconciliation (spec §5). The SOLE toucher of `pending_inherited`. For
// each inherited orphan (a release a prior process wrote but never got acked),
// emit a terminal `expired` release via the normal write-ahead path — never
// blind-re-publish the original send/cancel (device_id may differ post-restart,
// so a re-publish could double-ink; expired is the conservative honest state).
function reconcileReleaseOutbox() {
  for (const rec of releaseOutbox.list()) {
    if (rec.status !== 'pending_inherited') continue;
    const expiredKey = `${rec.promptId}\0${rec.itemId}\0expired`;
    // emitRelease write-aheads the expired-recovery record (key === expiredKey,
    // status `pending`) BEFORE publishing, then publishes the terminal `expired`
    // release. On a second boot where the inherited record IS the expired record
    // this relabels it back to `pending` in place under the same key. Returns
    // false (fail-closed) if the durable write-ahead can't persist.
    const emitted = emitRelease(rec.convoId, {
      promptId: rec.promptId,
      action: 'expired',
      releasedIds: [rec.itemId],
    });
    // F2: only remove the inherited original when the expired release was
    // durably emitted. If emitRelease fail-closed (disk fault), keep the
    // inherited record so a later boot retries — never delete with nothing
    // published, else `_releaseReconciled` would permanently orphan the card.
    // F1 self-delete guard: also require rec.key !== expiredKey — on an
    // expired-on-expired second boot the keys match, so we must NOT delete the
    // record we just re-wrote.
    if (emitted && rec.key !== expiredKey) releaseOutbox.remove(rec.key);
  }
  releaseOutbox.sweepAcked();
}

// --- Boot-reconcile deferral (F1 timing fix) ---
// reconcileReleaseOutbox must NOT run before the reconnect replay that carries
// the echo of a committed-but-unacked release (that echo flips the record
// pending_inherited -> acked, so reconcile then correctly skips it). We defer
// reconcile behind a quiet-period timer, re-armed by every replayed journal
// frame, so it fires only once the replay stream has been quiet for the window.
// One-shot: inherited records are a boot-only concern, so we reconcile exactly
// once (the first hello_ok's replay); after that the timer is null forever.
// Quiet window overridable via env (short by default — a boot replay burst is
// bounded and steady-state single-convo traffic isn't sub-window-continuous).
const RELEASE_RECONCILE_QUIET_MS = Number(process.env.MATRON_QUEUED_RELEASE_RECONCILE_QUIET_MS) || 750;
let _releaseReconciled = false;
let _releaseReconcileTimer = null;
function runReleaseReconcile() {
  _releaseReconcileTimer = null;
  if (_releaseReconciled) return;
  _releaseReconciled = true;
  reconcileReleaseOutbox();
}
function scheduleReleaseReconcile() {
  if (_releaseReconciled) return;
  if (_releaseReconcileTimer) clearTimeout(_releaseReconcileTimer);
  _releaseReconcileTimer = setTimeout(runReleaseReconcile, RELEASE_RECONCILE_QUIET_MS);
  if (_releaseReconcileTimer && typeof _releaseReconcileTimer.unref === 'function') {
    _releaseReconcileTimer.unref();
  }
}

function journalUpsertConvo(session, opts) {
  if (opts.title !== undefined && opts.title !== session._journalTitleHint) {
    session._journalTitleHint = opts.title;
    // Mirror the hint into the session record: the in-memory carry
    // (options.journalTitleHint on respawn) dies with the process, and a
    // session resumed after a full bridge restart with no hint re-applies
    // the first-user-message fallback title over the earned Gemini title.
    persistSession(session.roomId, session.claudeSessionId, session.workdir,
      session.originRoomId, { journalTitleHint: opts.title });
  }
  journalPublish(session, 'upsertConvo', opts);
}

// opts.incomingHint: the title carried across a restart/resume (see
// seedJournalTitle) so a respawn adopts the prior good title instead of
// re-seeding the repo basename over it. opts.reattaching: this convo already
// exists server-side (a journalConvoId was supplied), so suppress the workdir
// seed entirely — it could only clobber the earned title.
function journalSeedTitle(session, { incomingHint, persistedHint, reattaching = false } = {}) {
  return seedJournalTitle(session, {
    workdir: session.workdir,
    serverLabel: SERVER_LABEL,
    incomingHint,
    persistedHint,
    reattaching,
    upsertConvo: journalUpsertConvo,
    warn: (m) => DEBUG && console.warn(m),
  });
}

// Single choke point for mirroring anything USER-authored into the journal:
// publishes the item, then advances the user's read marker so mirrored user
// messages don't inflate unread badges on the user's other devices. Every
// seam that mirrors something the user said/did (text replies, prompt
// answers, media uploads) MUST route through this rather than calling
// journalPublish directly, so the markRead pairing can't be forgotten by a
// future seam. journalPublish already handles the pre-session-id buffering
// case (neither journalConvoId nor claudeSessionId known yet) for both calls, so a buffered
// markRead replays right after its paired publish, in order, once the
// session id shows up (see journalFlushForSession).
function journalPublishUserItem(session, method, payload) {
  journalPublish(session, method, payload);
  journalPublish(session, 'markRead', undefined);
}

// Mirror a session_state transition, but only on actual change — busy/prompt/
// turn-end events fire far more often than the state actually flips.
function journalSessionState(session, state) {
  if (session._journalState === state) return;
  session._journalState = state;
  journalUpsertConvo(session, { sessionState: state });
}

// Mirror the bridge's current activity into an ephemeral typing/activity
// indicator ('thinking' | 'tool' | 'idle') for viewing Matron clients. Wired
// at exactly the same call sites as journalSessionState above (busy/prompt/
// turn-end/exit) plus the sendLiveOutputEvent tool-start seam — see each
// call site's own comment for which transition it represents.
//
// Deliberately NOT journalPublish/journalPublisher directly: activity is
// EPHEMERAL (see publishActivity's contract in lib/journal-publisher.js),
// the opposite of journalPublish's buffer-until-session-id semantics — a
// session whose claudeSessionId isn't known yet is skipped outright here,
// never buffered for a later flush, because a late-replayed "thinking" would
// be stale by the time it could go out. Dedup state
// (session._journalActivityState) is its own field, separate from
// session._journalState, since the two mirror independent things (durable
// session_status vs. ephemeral activity) that don't always change together.
function journalActivity(session, state, detail) {
  if (!JOURNAL_ENABLED) return;
  const convoId = journalConvoIdFor(session);
  if (!convoId) return;
  if (!activityStateChanged(session._journalActivityState, state)) return;
  session._journalActivityState = state;
  journalPublisher.publishActivity(convoId, state, detail);
}

// Compute and publish a structured `diff` journal event for an
// Edit/Write/MultiEdit tool_use — the journal-only replacement for the old
// "✏️ Editing [path](link)" Matrix indicator (Dan, 2026-07-14; spec in
// matron-apple docs/superpowers/specs/2026-07-14-diff-cards-design.md).
// `label` is the subagent label, null for the parent agent. Published at
// tool_use time, same semantics as the old message (a denied edit still
// shows its card). Deliberately SYNCHRONOUS end to end: journalPublish
// delivers in call order, so an async diff compute would let later stream
// events publish first and reorder cards against their tool_use. The only
// I/O is Write's size-capped readFileSync of the old content inside
// computeEditDiff, which swallows every failure — journal problems never
// touch the Matrix hot path.
function buildEditDiffPayload(session, toolName, input, label) {
  const absPath = path.isAbsolute(input.file_path)
    ? input.file_path
    : path.join(session.workdir, input.file_path);
  const result = computeEditDiff(toolName, input, session.workdir);
  if (!result) return null;
  return {
    file_path: absPath,
    display_path: input.file_path,
    viewer_url: generateFileLink(absPath, session.workdir),
    tool: toolName,
    label: label || null,
    diff: result.diff,
    added: result.added,
    removed: result.removed,
    truncated: result.truncated,
    new_file: result.newFile,
    from: 'assistant',
  };
}

function publishEditDiff(session, toolName, input, label) {
  if (!JOURNAL_ENABLED || !input?.file_path) return;
  const payload = buildEditDiffPayload(session, toolName, input, label);
  if (!payload) return;
  journalPublish(session, 'publishDiff', payload);
}

// A subagent's Edit/Write/MultiEdit diff card, routed straight to the child
// convo (spec PR B) rather than into the parent. Children exist only after the
// parent session id is known, so this publishes directly (no pre-session-id
// buffering) — the child's convo_upsert was already enqueued at discovery, so
// it reaches the server before this diff (FIFO queue). label is null: the card
// is the child's own edit, and the child convo is already the subagent.
function publishEditDiffToConvo(session, convoId, toolName, input) {
  if (!JOURNAL_ENABLED || !convoId || !input?.file_path) return;
  const payload = buildEditDiffPayload(session, toolName, input, null);
  if (!payload) return;
  journalPublisher.publishDiff(convoId, payload);
}

// Account-wide rate limits for the status frame, shared across all sessions
// (they're a property of the account, not a session). Refreshed by shelling
// out to `claude -p "/usage"` — a local command that costs no API tokens but
// does boot a claude process, hence the throttle: at most one fetch per
// LIMITS_REFRESH_MS, refreshed only when turns are actually ending (nothing
// runs overnight). A failed fetch stamps fetchedAt too, so an outage can't
// turn every turn end into a spawn storm.
const LIMITS_REFRESH_MS = parseInt(process.env.LIMITS_REFRESH_MS || '300000', 10); // 5 min
const usageLimitsCache = { lines: null, fetchedAt: 0, inflight: null };

// Kick off a background limits refresh if the cache is stale. Returns the
// in-flight promise (resolving true when the cache gained fresh lines) when
// a fetch is running, or null when the cache is still fresh — callers use
// the promise to repaint the status frame once new numbers land.
function refreshUsageLimits(cwd) {
  // The cache exists solely to feed status frames — with the journal
  // disabled nothing consumes it, and each refresh boots a claude process.
  if (!JOURNAL_ENABLED) return null;
  if (usageLimitsCache.inflight) return usageLimitsCache.inflight;
  if (Date.now() - usageLimitsCache.fetchedAt < LIMITS_REFRESH_MS) return null;
  usageLimitsCache.inflight = fetchUsageLimitsText(cwd)
    .then((raw) => {
      const parsed = parseUsageLimits(raw);
      usageLimitsCache.fetchedAt = Date.now();
      if (parsed.ok) usageLimitsCache.lines = parsed.lines;
      return parsed.ok;
    })
    .catch((e) => {
      debug(`Usage limits refresh failed: ${e.message}`);
      usageLimitsCache.fetchedAt = Date.now();
      return false;
    })
    .finally(() => { usageLimitsCache.inflight = null; });
  return usageLimitsCache.inflight;
}

// Logged-in account email for the status frame, read from ~/.claude.json's
// oauthAccount (the same account every session on this bridge runs as). It
// only changes on re-login, so cache on the same cadence as the limits
// refresh — a ~45KB read+parse at most once per window. Read failures (file
// missing mid-login, torn write) just return the previous value; a stale
// email beats a flickering one.
const accountEmailCache = { email: null, fetchedAt: 0 };

function getAccountEmail() {
  if (Date.now() - accountEmailCache.fetchedAt < LIMITS_REFRESH_MS) return accountEmailCache.email;
  accountEmailCache.fetchedAt = Date.now();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
    accountEmailCache.email = emailFromClaudeConfig(config);
  } catch (e) {
    debug(`Could not read account email from ~/.claude.json: ${e.message}`);
  }
  return accountEmailCache.email;
}

// Publish the session's header data (model, context gauge, rate limits) as
// an ephemeral status frame for Matron clients. Same skip-if-no-session-id
// rule as journalActivity — never buffered, a late status would be stale.
// The context tokens (session._lastContextTokens) come from the turn's last
// parent assistant event's usage (set in case 'assistant'), or from the
// compact_boundary's post-compact size right after a compaction; limits come
// from the shared cache above. No dedup needed: this fires once per turn
// end, and the journal server's per-convo cache makes redelivery idempotent.
function journalStatus(session) {
  if (!JOURNAL_ENABLED) return;
  const convoId = journalConvoIdFor(session);
  if (!convoId) return;
  // Host CPU/RAM vitals (#526) are host-global, not account- or agent-specific,
  // so they ride on every frame (Claude and Codex). Sampled once per turn end
  // here so consecutive CPU samples bracket real wall-clock time (no blocking
  // sleep). The account rate limits, by contrast, are Claude-account-specific.
  const hostVitals = hostVitalLimits();
  const isCodex = session.agent === AGENT_CODEX;
  const status = buildSessionStatus({
    model: session.currentModel || session.initData?.model,
    contextTokens: session._lastContextTokens,
    // Codex frames carry only host vitals; Claude frames carry the account
    // rate limits followed by host vitals.
    limits: isCodex ? hostVitals : [...(usageLimitsCache.lines || []), ...hostVitals],
    email: getAccountEmail(),
    workdir: session.workdir,
  });
  // The shared account email cache is Claude-specific — strip it from Codex
  // frames. (Rate limits are already excluded from the Codex limits array
  // above; host vitals intentionally remain.)
  if (isCodex) {
    delete status.email;
  }
  if (Object.keys(status).length === 0) return;
  // Stamp only when the frame actually left the bridge — a publish dropped
  // by the socket layer (journal down, unserializable) must not eat the next
  // repaint window, or the header stays stale for a full throttle interval
  // after the socket comes back.
  if (journalPublisher.publishStatus(convoId, status)) {
    session._statusPublishedAt = Date.now();
  }
}

// Seed the Matron header at spawn instead of leaving it blank until the first
// turn ends (Dan, 2026-08-02: new chats showed no model/context/usage for
// their whole first turn). Publishes whatever is known pre-turn — model when
// one was chosen, workdir, account email, cached limits, host vitals; the
// context gauge genuinely needs a turn and joins later (buildSessionStatus
// omits absent parts, clients keep what they last rendered). Also kicks the
// throttled limits refresh so the usage bars land shortly after a fresh
// bridge boot instead of waiting for the first turn end — same
// repaint-when-it-lands pattern as the result-event site. Fails soft
// everywhere: journalStatus skips without a convo id, publishStatus drops
// frames while the journal socket is down.
function journalSpawnStatus(session) {
  journalStatus(session);
  const refresh = refreshUsageLimits(session.workdir || DEFAULT_WORKDIR);
  if (refresh) {
    refresh.then((updated) => {
      if (updated && session.alive) journalStatus(session);
    });
  }
}

// Stream in-progress assistant text to viewing Matron clients as an ephemeral
// overlay. Same skip-if-no-session rule as journalActivity — a session whose
// claudeSessionId isn't known yet is skipped outright, never buffered: an
// ephemeral stream frame replayed later would be stale. Mints a stable
// per-message ref (the message id, see lib/journal-stream.js) so all of one
// message's deltas coalesce under a single overlay; when Claude moves on to a
// new message, the previous overlay's pending frames are discarded before the
// new ref takes over. The current ref lives on the session so flushResponse can
// thread it into the durable publish (see sendToRoom) and the client retires
// the overlay by ref. replaceText is the full cumulative message text so far
// (latest-wins), never a delta — see the publisher's wire-contract comment.
function journalStream(session, messageId, replaceText) {
  if (!JOURNAL_ENABLED) return;
  const convoId = journalConvoIdFor(session);
  if (!convoId) return;
  const nextRef = streamRefFor(session._journalStreamRef, session._journalStreamMsgId, messageId);
  if (session._journalStreamRef && session._journalStreamRef !== nextRef) {
    // A new assistant message superseded the previous overlay WITHOUT its
    // durable publish having retired it. That durable is provably never
    // coming: on the normal path flushResponse -> sendCallback -> sendToRoom
    // consumes the armed ref (and nulls _journalStreamRef) synchronously
    // before control returns here, so reaching this branch means the old
    // buffer was discarded unflushed (waitingForAnswer) or there was no
    // sendCallback to publish it. Clear, don't just drop: collapse the
    // orphaned overlay with a final empty replace_text.
    journalPublisher.endStream(convoId, session._journalStreamRef, { clear: true });
  }
  session._journalStreamRef = nextRef;
  session._journalStreamMsgId = messageId;
  journalPublisher.stream(convoId, nextRef, replaceText);
}

// Retire a still-open streaming overlay that was NOT already retired by a
// durable publish. Called at every turn-end / session-exit seam alongside
// journalActivity(session, 'idle'): the normal path already cleared
// _journalStreamRef when the final message published (carrying the ref), so
// this only fires for a turn that streamed but produced no durable final
// message (interruption, /stop, session exit mid-stream) — the "no dangling
// overlay" case. Sends an empty replace_text so the client collapses the
// overlay (its finalized-message retire is never coming). Also clears any
// armed-but-unconsumed durable ref so it can't leak onto a later publish.
function journalStreamClear(session) {
  if (!JOURNAL_ENABLED) return;
  session._journalDurableRef = null;
  const convoId = journalConvoIdFor(session);
  if (!convoId) return;
  const ref = session._journalStreamRef;
  if (!ref) return;
  session._journalStreamRef = null;
  session._journalStreamMsgId = null;
  journalPublisher.endStream(convoId, ref, { clear: true });
}

// Mirror a user's accepted prompt answer (button tap, numbered/lettered
// quick-reply, yes-no confirm, free-text prompt reply, AskUserQuestion
// answer) into the journal as their side of the conversation. These paths
// answer via PTY keystrokes (iv.respondToPrompt / iv.sendText) or the
// tool_result stdin write and so bypass sendToSession's user-text mirror —
// without this the journal would record the prompt but never the choice.
// Each answering path calls this exactly once, at the point the answer is
// accepted and dispatched.
function journalMirrorUserAnswer(session, text) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return;
  journalPublishUserItem(session, 'publishText', { body, from: 'user' });
}

function recordUserAnswer(session, text, { mirrorToJournal = true } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return;
  recordConversationMessage(session, 'user', body);
  if (mirrorToJournal) journalMirrorUserAnswer(session, body);
}

function reportPromptAnswerDeliveryFailure(session, error) {
  const detail = error?.message || String(error || 'unknown error');
  const message = `Could not deliver the prompt answer to Claude: ${detail}`;
  debug(message);
  if (session.sendHtml) session.sendHtml(message, escapeHtml(message));
  else if (session.sendCallback) session.sendCallback(message);
}

// Mirror a media upload the user just sent into the journal, once it has been
// downloaded and materialized locally.
// Best-effort and fire-and-forget: the HTTP media upload is awaited inside
// this async IIFE, but the call site never awaits journalMirrorUserMedia
// itself, so a slow or dead journal server never delays the Matrix/Claude
// media flow. uploadMedia already fails open (null on any failure); a null
// here just means the file/image event is skipped — a journal event without
// a blob to point at is useless. image vs file is chosen by content-type
// prefix (not Matrix msgtype), since a PDF or a picture sent as a generic
// m.file still has an image/* or application/pdf mime either way.
function journalMirrorUserMedia(session, { buffer, mime, name, dims }) {
  if (!JOURNAL_ENABLED) return;
  (async () => {
    try {
      const media = await journalPublisher.uploadMedia({ bytes: buffer, contentType: mime, name });
      if (!media) return;
      const isImage = typeof mime === 'string' && mime.startsWith('image/');
      const payload = {
        blob_ref: media.media_id,
        content_type: media.content_type,
        name,
        size: media.size,
        from: 'user',
      };
      if (isImage && dims) payload.dims = dims;
      journalPublishUserItem(session, isImage ? 'publishImage' : 'publishFile', payload);
    } catch (e) {
      try { console.warn(`[journal] media mirror failed: ${e.message}`); } catch { /* logging must never throw */ }
    }
  })();
}

// Called once claudeSessionId becomes known: establishes the conversation
// (with whatever title we've learned so far, if any) and replays anything
// buffered while we didn't yet know the convo_id, in order.
function journalFlushForSession(session) {
  const convoId = journalConvoIdFor(session);
  if (!convoId) return;
  session._journalConvoEstablished = true;
  journalPublisher.upsertConvo(convoId, { title: session._journalTitleHint });
  const buffered = session._journalBuffer;
  session._journalBuffer = null;
  if (!buffered) return;
  for (const { method, payload } of buffered) {
    journalPublisher[method](convoId, payload);
  }
}

function createSession(roomId, workdir, resumeSessionId, options = {}) {
  // A persisted workdir can stop existing between spawns (repo renamed,
  // worktree pruned). Node reports a missing spawn cwd as `spawn claude
  // ENOENT`, so degrade to a fallback dir here — before any agent branch —
  // instead of letting every spawn path discover it the hard way.
  const guarded = resolveSpawnCwd(expandHome(workdir || DEFAULT_WORKDIR), [DEFAULT_WORKDIR, os.homedir()]);
  if (guarded.fellBack) {
    console.warn(`[spawn-guard] workdir ${guarded.missing} no longer exists for ${roomId}; using ${guarded.cwd}`);
    const wg = notice('warning', `Workdir ${guarded.missing} no longer exists — using ${guarded.cwd} instead. Use !workdir to move the session.`,
      `Workdir <code>${escapeHtml(String(guarded.missing))}</code> no longer exists — using <code>${escapeHtml(guarded.cwd)}</code> instead. Use <code>!workdir</code> to move the session.`);
    Promise.resolve(sendToRoom(roomId, wg.plain, wg.html)).catch(() => {});
  }
  workdir = guarded.cwd;
  const persistedMode = getPersistedSession(roomId);
  const agent = resolveAgent({ option: options.agent, persisted: persistedMode?.agent, fallback: DEFAULT_AGENT });
  // A Claude session that changes cwd mid-flight (EnterWorktree is the common
  // case) has its transcript relocated to the NEW cwd's project dir, while the
  // bridge's persisted workdir stays where the session was spawned. Resuming
  // with that stale workdir misses the transcript, and planSessionIdentity
  // demotes the resume to a fresh --session-id spawn on the same id — the room
  // keeps its identity but silently loses its whole conversation. Follow the
  // transcript instead: find it by session id and adopt the cwd recorded
  // inside it, before any branch spawns (both claude branches and their
  // transcriptExists checks read this workdir).
  if (agent === AGENT_CLAUDE && resumeSessionId
      && !fs.existsSync(transcriptPathFor(workdir, resumeSessionId))) {
    const shortId = resumeSessionId.slice(0, 8);
    const found = findTranscriptBySessionId(resumeSessionId);
    if (found?.workdir) {
      // Claude can only find the transcript when spawned from a cwd that
      // encodes to the project dir holding it. If the recorded workdir has
      // been deleted since (a pruned worktree), recreate it: an empty
      // directory and an intact conversation beats a fresh spawn with total
      // amnesia — the user can !workdir somewhere real afterwards. (Bugbot,
      // PR #216: without this, a found transcript was still demoted.)
      let usable = fs.existsSync(found.workdir);
      if (!usable) {
        try {
          fs.mkdirSync(found.workdir, { recursive: true });
          usable = true;
          console.warn(`[transcript-relocate] ${roomId}: recreated deleted workdir ${found.workdir} so session ${shortId}… can resume its transcript`);
        } catch (error) {
          console.warn(`[transcript-relocate] ${roomId}: transcript for ${shortId}… found at ${found.transcriptPath} but its workdir ${found.workdir} is gone and could not be recreated (${error.message}); the resume will start fresh on the same id`);
        }
      }
      if (usable && found.workdir !== workdir) {
        console.warn(`[transcript-relocate] ${roomId}: session ${shortId}… transcript lives under ${found.workdir}, not persisted workdir ${workdir}; resuming there`);
        const tr = notice('info', `Resuming in ${found.workdir} — the session had moved there.`,
          `Resuming in <code>${escapeHtml(found.workdir)}</code> — the session had moved there.`);
        Promise.resolve(sendToRoom(roomId, tr.plain, tr.html)).catch(() => {});
        workdir = found.workdir;
      }
    } else if (found) {
      // Transcript located but no entry records a cwd — with no directory to
      // spawn from that encodes to its project dir, a --resume would exit 1
      // and crash-loop, so the planSessionIdentity demotion below stands.
      console.warn(`[transcript-relocate] ${roomId}: transcript for ${shortId}… found at ${found.transcriptPath} but it records no cwd; the resume will start fresh on the same id`);
    }
  }
  if (agent === AGENT_CODEX) {
    const codexSession = createCodexSessionForRoom(roomId, workdir, resumeSessionId, options);
    journalSeedTitle(codexSession, { incomingHint: options.journalTitleHint, persistedHint: persistedMode?.journalTitleHint, reattaching: options.journalConvoId != null });
    journalSpawnStatus(codexSession);
    return codexSession;
  }
  const interactive = resolveInteractive({
    option: options.interactive,
    persisted: persistedMode?.interactiveMode,
    fallback: INTERACTIVE_MODE,
  });
  if (interactive) {
    const ivSession = createInteractiveSessionForRoom(roomId, workdir, resumeSessionId, options);
    journalSeedTitle(ivSession, { incomingHint: options.journalTitleHint, persistedHint: persistedMode?.journalTitleHint, reattaching: options.journalConvoId != null });
    journalSpawnStatus(ivSession);
    return ivSession;
  }
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  // Per-room live-bash-output gate. Defaults on; toggled via !show_bash.
  // showBashOutput is persisted via persistSession on toggle and re-read here at
  // spawn so the hook env stays in sync with the room's setting across restarts.
  // Unset (undefined) means "never toggled" → use the default (on).
  const persistedForRoom = getPersistedSession(roomId);
  const showBashOutputAtSpawn = persistedForRoom?.showBashOutput !== false;
  // mcpExtras: explicit caller-supplied value wins (used by /start, /resume,
  // /workdir handlers that parsed user flags); otherwise fall back to whatever
  // was persisted for this room so /restart and bridge restarts honour the
  // session's previous choice.
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
  const effectiveMcpExtras = effectiveExtras(mcpExtras, DEFAULT_MCP_EXTRAS);
  const shareEnabled = effectiveMcpExtras.includes('share');
  const permissionToken = randomUUID();
  let showFileToken;
  let showFilePinnedRoots = null;
  if (shareEnabled) {
    try {
      showFilePinnedRoots = pinAllowedRootsSync([cwd, ...SHOW_FILE_ARTIFACT_ROOTS]);
      showFileToken = randomUUID();
    } catch (error) {
      console.warn(`[show-file] disabled for ${roomId}: failed to pin allowed roots (${error.message})`);
    }
  }
  // Pre-assign the session id for fresh spawns (same trick as iv-mode below):
  // claudeSessionId is then known synchronously, so RPC start can answer with
  // a convo_id immediately and journal publishes never buffer for the init
  // event. Resumes keep --resume semantics (see planSessionIdentity).
  // presetSessionId is the pre-init-crash restart path (#136 / PR #151):
  // reuse the crashed session's minted id via --session-id, never --resume.
  // transcriptExists demotes a resume whose transcript was never written
  // (a zero-turn chat) to a fresh spawn on the same id — see
  // planSessionIdentity (/logout-crash-loop bug).
  const identity = planSessionIdentity({
    resumeSessionId, presetId: options.presetSessionId, mintId: randomUUID,
    transcriptExists: (id) => fs.existsSync(transcriptPathFor(cwd, id)),
  });
  const args = [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disallowed-tools', 'AskUserQuestion',
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    '--include-partial-messages',
    '--mcp-config', mcpConfigPathFor(effectiveMcpExtras),
    '--settings', JSON.stringify(buildSessionSettings('print')),
  ];
  const printModel = options.model === null
    ? undefined
    : resolveModel({ option: options.model, persisted: persistedMode?.model });
  if (printModel) {
    args.push('--model', printModel);
  }
  args.push(...identity.cliArgs);

  debug(`Spawning claude with args: ${args.join(' ')}`);
  debug(`Working directory: ${cwd}`);

  // Ensure the node binary running the bridge is reachable from the spawned
  // claude process. The ask-user MCP server and the matron-tee Bash hook both
  // resolve `node` via PATH; when the bridge is launched non-interactively
  // (e.g. launchd) nvm hasn't loaded and PATH lacks the node bin dir.
  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '';
  const pathWithNode = existingPath.split(':').includes(nodeBinDir)
    ? existingPath
    : `${nodeBinDir}:${existingPath}`;

  const spawnEnv = {
    ...process.env,
    PATH: pathWithNode,
    CLAUDECODE: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(API_PORT),
    // Env is fixed at spawn time; toggling the flag later requires
    // !restart to take effect.
    MATRON_PERMISSION_CARDS: process.env.MATRON_PERMISSION_CARDS || '',
  };
  delete spawnEnv.SHOW_FILE_TOKEN;
  if (showFileToken) spawnEnv.SHOW_FILE_TOKEN = showFileToken;
  delete spawnEnv.MATRON_PERMISSION_TOKEN;
  // CC hooks cannot receive isolated env: the whole claude process inherits this token, authenticating "a process in this print session"; emitted identifiers are parser-bounded.
  spawnEnv.MATRON_PERMISSION_TOKEN = permissionToken;

  const permissionSnapshot = process.env.MATRON_PERMISSION_CARDS
    ? buildPermissionSnapshot({ workdir: cwd })
    : null;

  const proc = launchWithCodexSinkEnv({
    spawnEnv,
    workdir: cwd,
    sessionId: identity.sessionId,
    configureOptions: { warn: message => console.warn(message) },
    launch: configuredEnv => spawn('claude', args, {
      cwd,
      env: configuredEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  });

  const session = {
    agent: AGENT_CLAUDE,
    proc,
    roomId,
    workdir: cwd,
    // The spawned session's effective env (shim prepended to PATH when
    // MATRON_CODEX_VIZ=1). The codex-viz activation guard must evaluate the
    // session's PATH, not the bridge's, to see the producer we just deployed.
    codexSpawnEnv: spawnEnv,
    ...(showFileToken ? { showFileToken } : {}),
    showFilePinnedRoots,
    permissionToken,
    _showFileInFlight: 0,
    mcpExtras,
    permissionSnapshot,
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: resumeSessionId ? (getPersistedSession(roomId)?.pendingPlanDenialId || null) : null,
    sendHtml: null,
    showWorking: false,
    showBashOutput: showBashOutputAtSpawn,
    alive: true,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    restartCount: 0,
    claudeSessionId: identity.sessionId,
    // A real resume targets a transcript that exists on disk (identity.resumed
    // — a resume whose transcript is missing was demoted to a fresh spawn), so
    // it is confirmed from birth; a fresh/preset/demoted spawn is not
    // resumable until a turn-bearing event proves the transcript was written
    // (see eventConfirmsSession in handleClaudeEvent). Without this, a resumed
    // session that crashes before its first event would wrongly restart via
    // --session-id on an already-persisted id (#136 / PR #151).
    _sessionConfirmed: identity.resumed,
    journalConvoId: options.journalConvoId || persistedMode?.journalConvoId || identity.sessionId,
    _agentSessions: mergeAgentStates({}, options.agentSessions || persistedMode?.agentSessions),
    _agentHistoryCursor: 0,
    busy: false,
    lineBuf: '',
    toolCalls: [], // collected tool indicators for this turn
    waitingForAnswer: null,
    // Per-session room tracking
    originRoomId: null,
    firstMessageCaptured: false,
    // Captured from system init event
    initData: null,
    currentModel: printModel || null,
    // Accumulated usage stats
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
    turnCount: 0,
    // Chat history for topic summarization
    chatHistory: [],         // { role, text } - full messages (code/tools stripped)
    pinnedSummaryEventId: null, // event ID of pinned summary message
    pinnedSummaryText: '',       // accumulated summary text (source of truth, not Matrix)
    lastSummaryMsgCount: 0, // chatHistory index the summary pass has consumed through (persisted)
    lastRosterText: '',     // last ROSTER paragraph — preamble for the next incremental pass (persisted)
  };

  session.requestPermissionDecision = createRequestPermissionDecision(session, {
    journalPublisher,
    pendingPermissionDecisions,
    journalConvoIdFor,
    timeoutMs: PERMISSION_DECISION_TIMEOUT_MS,
  });

  // A spawn 'error' with no listener is fatal to the whole bridge (crash-loop
  // of 2026-07-16). Cleanup and the 3-restart cap stay in proc.on('close'),
  // which still fires after a spawn error; this only reports.
  attachSpawnErrorHandler(proc, {
    notify: (msg) => { if (session.sendCallback) session.sendCallback(msg); },
    log: (msg) => console.error(`[spawn-guard] ${msg} (room ${roomId})`),
  });

  // Parse newline-delimited JSON from stdout
  proc.stdout.on('data', (chunk) => {
    session.lineBuf += chunk.toString();
    const lines = session.lineBuf.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
    session.lineBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (_e) {
        debug('Failed to parse JSON line:', trimmed);
        continue;
      }

      debug('Event:', JSON.stringify(event));
      handleClaudeEvent(session, event);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    debug('stderr:', text);
  });

  proc.on('close', (exitCode) => {
    session.alive = false;
    debug(`Claude process exited with code ${exitCode}`);

    teardownSubagentTracking(session);

    // Flush any remaining response
    flushResponse(session);
    // Process exited mid-stream: collapse any overlay the flush didn't retire
    // so a viewing client isn't left with a dangling in-progress indicator
    // (covers the auto-restart, idle-reaper, and clean-exit branches below —
    // the same convo id may be re-used by an auto-restart, so a stale overlay
    // must not carry across).
    journalStreamClear(session);
    // The process exited on its own (crash mid-Bash, or any other reason)
    // without the tool_result seam ever running, so sweep any still-open
    // tool-output streams too — otherwise their pumps (and fs.watch handles)
    // leak forever and a viewing client's live overlay dangles until the
    // server's 30-min idle sweep. Runs on every path below, including
    // auto-restart.
    sweepToolStreams(session);
    clearPendingInterrupt(session);

    if (sessions.get(roomId) === session) {
      if (session._autoStopped) {
        // Idle reaper already posted its own notice; just clean up.
        sessions.delete(roomId);
        journalSessionState(session, 'done');
        journalActivity(session, 'idle');
        journalEvictConvoInput(session);
      } else if (exitCode !== 0 && session.restartCount < 3 && !session._resumeFailed) {
        // Auto-restart is about to replace `session` outright (no
        // journalSessionState('done') — the convo isn't over, it's
        // respawning) — but viewers still need to stop seeing a stale
        // thinking/tool indicator while the process is down. The terminal
        // exit paths (_autoStopped above, and the final `else` below) both
        // already emit idle; this branch didn't (Bugbot finding #3).
        journalActivity(session, 'idle');
        // Pass mcpExtras explicitly: createSession can fall back to persisted
        // state, but a print-mode session that crashes before its session_id
        // is delivered hasn't been persisted yet, and would silently respawn
        // without the user's --browser opt-in.
        const restarted = createSession(
          roomId, cwd,
          // #136 / PR #151: --resume only a session Claude actually persisted
          // (confirmed on init, session._sessionConfirmed). A crash BEFORE init
          // never set that flag — the minted id was never written, so --resume
          // would fail and terminate the conversation. Reuse the same id via
          // --session-id (presetSessionId below) instead, keeping the convo/
          // journal identity for a clean fresh spawn.
          session._sessionConfirmed ? session.claudeSessionId : null,
          {
            agent: session.agent,
            model: session.currentModel || undefined,
            mcpExtras: session.mcpExtras,
            journalConvoId: session.journalConvoId,
            // Carry the prior title so the re-seed adopts the good Gemini title
            // instead of publishing the repo basename over it (title-revert bug).
            journalTitleHint: session._journalTitleHint,
            presetSessionId: session._sessionConfirmed ? undefined : session.claudeSessionId,
          },
        );
        restarted.restartCount = session.restartCount + 1;
        restarted.sendCallback = session.sendCallback;
        restarted.sendHtml = session.sendHtml;
        restarted.sendButtonMessage = session.sendButtonMessage;
        restarted.originRoomId = session.originRoomId;
        restarted.firstMessageCaptured = session.firstMessageCaptured;
        // Carry user-visible state across the restart so the user doesn't
        // silently lose queued messages or per-room toggles.
        restarted.queuedMessages = session.queuedMessages;
        restarted.queueNotifications = session.queueNotifications;
        journalInputConsumer.queueRelease.carryForward(
          journalConvoIdFor(session),
          journalConvoIdFor(restarted),
        );
        restarted.showWorking = session.showWorking;
        restarted.showBashOutput = session.showBashOutput;
        restarted.chatHistory = session.chatHistory;
        restarted.pinnedSummaryText = session.pinnedSummaryText;
        restarted.pinnedSummaryEventId = session.pinnedSummaryEventId;
        restarted.lastSummaryMsgCount = session.lastSummaryMsgCount || 0;
        restarted.lastRosterText = session.lastRosterText || '';
        restarted.repoScores = session.repoScores; // carry activity-inferred repo signal across restart
        restarted._agentHistoryCursor = session._agentHistoryCursor;
        restarted._pendingAgentHandoff = session._pendingAgentHandoff;
        restarted._agentSessions = session._agentSessions;
        restarted.totalUsage = session.totalUsage;
        restarted.turnCount = session.turnCount;
        // Carry journal-mirror state too: traffic buffered before the first
        // session_id arrived would otherwise be silently dropped, keeping
        // _journalState preserves the change-dedup across the restart, and
        // the restarted session resumes the same convo (same claudeSessionId)
        // so its established flag carries as well.
        restarted._journalBuffer = session._journalBuffer;
        restarted._journalTitleHint = session._journalTitleHint;
        restarted._journalState = session._journalState;
        restarted._journalConvoEstablished = session._journalConvoEstablished;
        sessions.set(roomId, restarted);
        if (restarted.sendHtml) {
          const n = notice('warning',
            `[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`,
            `Session crashed (exit ${exitCode}), restarted automatically — attempt <b>${restarted.restartCount}/3</b>`);
          restarted.sendHtml(n.plain, n.html);
        } else if (restarted.sendCallback) {
          restarted.sendCallback(
            `[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`
          );
        }
      } else {
        // Notice BEFORE teardown: sendToRoom's journal mirror looks the
        // session up in the map, so a notice sent after sessions.delete()
        // is silently dropped (same fix as the iv-mode close handler).
        if (session.sendHtml) {
          const n = notice('error', `[Session ended (exit ${exitCode})]`, `Session ended (exit <code>${exitCode}</code>)`);
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback(`[Session ended (exit ${exitCode})]`);
        }
        sessions.delete(roomId);
        journalSessionState(session, 'done');
        journalActivity(session, 'idle');
        journalEvictConvoInput(session);
      }
    }
  });

  session.resetTimeout = () => {}; // no-op, kept for call-site compatibility

  // Subagent activity is surfaced on demand: notifyTaskStarted() runs when
  // the parent's stream emits a Task tool_use. The watcher object is cheap
  // to construct; it doesn't poll until the first Task fires.
  sessions.set(roomId, session);
  if (session.claudeSessionId) {
    setupSubagentWatcher(session, cwd, session.claudeSessionId);
  }
  journalSeedTitle(session, { incomingHint: options.journalTitleHint, persistedHint: persistedMode?.journalTitleHint, reattaching: options.journalConvoId != null });
  journalSpawnStatus(session);
  return session;
}

// --- Codex programmatic sessions ---
//
// Codex's stable non-interactive contract is one `codex exec --json` process
// per turn. The CodexExecSession adapter retains the thread ID and starts a
// fresh child for each message; this wrapper presents the same logical session
// shape the rest of the bridge expects from Claude's long-lived process.
function createCodexSessionForRoom(roomId, workdir, resumeSessionId, options = {}) {
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  const persisted = getPersistedSession(roomId);
  const historyLength = Array.isArray(persisted?.chatHistory) ? persisted.chatHistory.length : 0;
  const persistedCodexState = getPersistedAgentState(persisted, AGENT_CODEX, historyLength);
  const model = options.model === null
    ? undefined
    : (options.model ?? persistedCodexState.model ?? undefined);
  const codex = new CodexExecSession({
    cwd,
    threadId: resumeSessionId || null,
    model,
    sandbox: CODEX_SANDBOX_MODE,
    developerInstructions: CODEX_BRIDGE_PROMPT,
    env: { ...process.env },
  });

  const session = {
    agent: AGENT_CODEX,
    codex,
    proc: null,
    roomId,
    workdir: cwd,
    mcpExtras: [],
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: null,
    sendHtml: null,
    sendButtonMessage: null,
    showWorking: false,
    showBashOutput: false,
    alive: true,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    restartCount: 0,
    // Kept under the historical property name for compatibility with the
    // journal protocol and existing persistence/routing code.
    claudeSessionId: resumeSessionId || null,
    journalConvoId: options.journalConvoId || persisted?.journalConvoId || resumeSessionId || null,
    _agentSessions: mergeAgentStates({}, options.agentSessions || persisted?.agentSessions),
    _agentHistoryCursor: 0,
    busy: false,
    lineBuf: '',
    toolCalls: [],
    waitingForAnswer: null,
    originRoomId: null,
    firstMessageCaptured: false,
    initData: null,
    currentModel: model || null,
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
    turnCount: 0,
    chatHistory: [],
    pinnedSummaryEventId: null,
    pinnedSummaryText: '',
    lastSummaryMsgCount: 0, // chatHistory index the summary pass has consumed through (persisted)
    lastRosterText: '',     // last ROSTER paragraph — preamble for the next incremental pass (persisted)
    _codexTurnFinished: true,
    _codexLastError: null,
  };

  codex.on('spawn', ({ child, args }) => {
    session.proc = child;
    session._codexTurnFinished = false;
    session._codexLastError = null;
    session._codexCompletedUsage = null;
    debug(`Spawning codex with args: ${args.join(' ')}`);
    debug(`Working directory: ${cwd}`);
  });
  codex.on('event', event => {
    debug('Codex event:', JSON.stringify(event));
    handleCodexEvent(session, event);
  });
  codex.on('parse-error', ({ line }) => debug('Failed to parse Codex JSON line:', line));
  codex.on('spawn-error', error => {
    session._codexLastError = error?.message || String(error);
  });
  codex.on('turn-exit', ({ code, signal, stderr, sawTurnCompleted }) => {
    session.proc = null;
    if (session._codexTurnFinished) return;
    if (!session.alive) {
      // killSession normally performs this synchronously so a replacement
      // session cannot inherit running/thinking state. Keep an exit-side
      // fallback for any future path that marks the session dead directly.
      finishCodexTurn(session, {
        usage: session._codexCompletedUsage,
        discardOutput: true,
      });
      return;
    }
    const interrupted = session._codexInterrupted;
    session._codexInterrupted = false;
    if (interrupted) {
      finishCodexTurn(session, { error: 'Codex turn interrupted.' });
      return;
    }
    if (!sawTurnCompleted || code !== 0) {
      const detail = session._codexLastError || stderr ||
        `Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
      finishCodexTurn(session, { error: detail, usage: session._codexCompletedUsage });
      return;
    }
    finishCodexTurn(session, { usage: session._codexCompletedUsage });
  });

  session.resetTimeout = () => {};
  sessions.set(roomId, session);
  return session;
}

function codexToolIndicator(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : JSON.stringify(item.command || 'command');
    return `🔧 ${command}`;
  }
  if (item.type === 'web_search') return `🌐 ${item.query || 'Web search'}`;
  if (item.type === 'mcp_tool_call') {
    const name = [item.server, item.tool].filter(Boolean).join('/') || item.name || 'MCP tool';
    return `🔌 ${name}`;
  }
  if (item.type === 'file_change') {
    const paths = Array.isArray(item.changes)
      ? item.changes.map(change => change?.path).filter(Boolean)
      : [];
    return `✏️ ${paths.length ? paths.join(', ') : 'Files changed'}`;
  }
  return null;
}

function handleCodexEvent(session, event) {
  // Progress touch for restart carry-on — the Codex-side counterpart of the
  // touch in handleClaudeEvent. Debounced and no-op without a marker.
  inflightMarker.touch(journalConvoIdFor(session));
  switch (event?.type) {
    case 'thread.started': {
      if (!event.thread_id) break;
      const nativeIdChanged = session.claudeSessionId !== event.thread_id;
      const journalIdMissing = !session.journalConvoId;
      if (nativeIdChanged || journalIdMissing) {
        session.claudeSessionId = event.thread_id;
        if (!session.journalConvoId) session.journalConvoId = event.thread_id;
        persistSession(session.roomId, event.thread_id, session.workdir, session.originRoomId, {
          chatHistory: session.chatHistory,
          model: session.currentModel || null,
        });
        if (nativeIdChanged) {
          console.log(`Updated Codex thread ID for room ${session.roomId}: ${event.thread_id}`);
        }
        if (journalIdMissing) {
          // Restart carry-on, first-turn repair. A FRESH Codex conversation has
          // NO convo id until this very line: createCodexSessionForRoom leaves
          // both claudeSessionId and journalConvoId null when there is nothing
          // to resume (index.js:1582-1583), so sendToSession's noteTurnStart —
          // the `session.busy = true` seam — ran with null and returned early.
          // The first turn is often the longest one, and it would silently get
          // no card. touch() cannot repair this: it no-ops when no record
          // exists. The conversation IS genuinely resumable by then, because
          // persistSession fired just above.
          //
          // Gated on journalIdMissing, NOT on the enclosing block: a later
          // thread-id change (nativeIdChanged alone) leaves journalConvoId
          // untouched, so that turn is already marked under this same id and
          // re-marking would reset startedAt/touchedAt on an in-flight turn.
          // This branch can therefore fire at most once per conversation.
          //
          // journalConvoIdFor(session) is now session.journalConvoId ===
          // event.thread_id — the identical id persistSession just wrote as
          // both sessionId and journalConvoId, that publishRestartCarryOnCards
          // keys the card on, and that journalResumeConvo matches. Claude
          // print/iv are unaffected: they mint the id at construction
          // (index.js:1337, 2024), so journalIdMissing is never true for them.
          if (session.busy) inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId);
          journalFlushForSession(session);
        }
      }
      break;
    }

    case 'item.started': {
      const indicator = codexToolIndicator(event.item);
      if (indicator) {
        session.toolCalls.push(indicator);
        journalActivity(session, 'tool', truncateActivityDetail(indicator));
      }
      break;
    }

    case 'item.completed': {
      const item = event.item || {};
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        session.responseBuffer += (session.responseBuffer ? '\n\n' : '') + item.text;
      }
      if (codexToolIndicator(item) && session._journalActivityState === 'tool') {
        journalActivity(session, 'thinking');
      }
      break;
    }

    case 'turn.completed': {
      // Wait for the child to close before clearing busy/flushing the queue.
      // codex exec has emitted its result but still owns the adapter's one
      // process slot until then; starting the next queued turn here races and
      // gets rejected as "busy".
      session._codexCompletedUsage = event.usage || null;
      break;
    }

    case 'turn.failed': {
      const detail = event.error?.message || event.error || event.message || 'Codex turn failed.';
      session._codexLastError = typeof detail === 'string' ? detail : JSON.stringify(detail);
      session._codexCompletedUsage = event.usage || null;
      break;
    }

    case 'error': {
      const detail = event.message || event.error?.message || event.error;
      if (detail) session._codexLastError = typeof detail === 'string' ? detail : JSON.stringify(detail);
      break;
    }

    default:
      break;
  }
}

function flushPendingSessionQueue(session) {
  if (!session.alive || !session.queuedMessages?.length) return false;
  const queue = session.queuedMessages;
  const notifications = session.queueNotifications || [];
  // A queued /compact is flushed ALONE, ahead of everything else
  // (lib/compact-priority.js). batchSize is the whole queue in every other
  // case, so the non-compact path is byte-for-byte what it always was.
  const batchSize = compactBatchSize(queue);
  const queued = queue.slice(0, batchSize);
  const deferred = queue.slice(batchSize);
  // Snapshot before detaching: snapshotQueuedReleaseBatch reads the batch's
  // notifications off session.queueNotifications as a prefix slice, which is
  // exactly what the batch is.
  const releaseSnapshot = snapshotQueuedReleaseBatch(session, queued);
  session.queuedMessages = deferred.length ? deferred : null;
  const summary = formatQueueSummary(queued);
  // Nothing deferred: the familiar "sending N queued messages" list. Deferred:
  // say WHY the rest didn't go, or the held messages read as swallowed. They
  // need no nudge to be delivered — the compaction run is its own print-mode
  // turn, and its `result` event lands right back here (see the result handler
  // and onTurnEnd, both of which call this function once busy clears).
  const plainMsg = deferred.length
    ? `📬 Sending /compact first — the other ${deferred.length} queued message${deferred.length > 1 ? 's' : ''} will be sent once compaction finishes.`
    : `📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:\n${summary.plain}`;
  const htmlMsg = deferred.length
    ? `<b>📬 Sending /compact first</b> — the other ${deferred.length} queued message${deferred.length > 1 ? 's' : ''} will be sent once compaction finishes.`
    : `<b>📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:</b>${summary.html}`;
  if (session.sendHtml) {
    session.sendHtml(plainMsg, htmlMsg);
  } else if (session.sendCallback) {
    session.sendCallback(plainMsg);
  }
  const sent = flushQueue(session, queued, releaseSnapshot);
  // Only the flushed batch's notifications retire; the deferred entries keep
  // theirs, in lockstep with the queue they still describe. A failed flush
  // keeps all of them, exactly as before — flushQueue's restoreQueuedBatch has
  // already prepended the batch back onto session.queuedMessages.
  if (sent === true) session.queueNotifications = notifications.slice(batchSize);
  return sent;
}

// A command issued mid-turn that can't run until the turn ends — an
// unforced /restart, or a print-mode /model switch — parks its replay text
// on the session (see the '!restart' case and applyModelSwitch); the
// turn-end seams call this to consume and replay it. One slot: a later
// parked command replaces the earlier one, with a notice at the park site.
// Returns true when a command was dispatched — the caller must then SKIP
// its queue flush: flushing would type queued messages into the process
// the command is about to kill, whereas recreateSession (both parked
// commands end in one) carries queuedMessages into the replacement session
// and flushes them there (and the room-delivery inbox is keyed by roomId,
// so it follows too). The stash clears before the liveness checks so a
// session that died mid-turn can never fire a command later, and the
// sessions-map identity check keeps a superseded session's late turn-end
// from acting on its replacement. The replay is fire-and-forget: this runs
// inside synchronous turn-end bookkeeping, and each command's case reports
// its own outcome.
function dispatchDeferredCommand(session) {
  const text = session._deferredCommandText;
  if (!text) return false;
  session._deferredCommandText = null;
  if (!session.alive || sessions.get(session.roomId) !== session) return false;
  const ctx = journalSessionCommandCtx(session);
  handleCommand(session.roomId, text, ctx.sendReply, ctx.sendHtml, ctx.sender).catch((err) => {
    try { ctx.sendReply(`Deferred ${text.split(' ')[0].replace(/^!/, '/')} failed: ${err?.message || err}`); } catch { /* reply sink gone */ }
  });
  return true;
}

function finishCodexTurn(session, {
  error = null,
  usage = null,
  discardOutput = false,
  preserveQueue = false,
} = {}) {
  if (session._codexTurnFinished) return;
  session._codexTurnFinished = true;
  session.turnCount++;

  if (usage) {
    session.totalUsage.input_tokens += usage.input_tokens || 0;
    session.totalUsage.output_tokens += usage.output_tokens || 0;
    session.totalUsage.cache_read += usage.cached_input_tokens || 0;
  }

  if (!discardOutput) {
    if (session.toolCalls.length > 0 && session.showWorking && session.sendCallback) {
      for (const chunk of splitMessage(session.toolCalls.join('\n'))) session.sendCallback(chunk);
    }
    flushResponse(session);
  } else {
    session.responseBuffer = '';
  }
  session.toolCalls = [];
  journalStreamClear(session);
  session.busy = false;
  // Authoritative Codex turn-end (idempotent via _codexTurnFinished above) —
  // but ONLY for a turn that actually ended on its own terms. discardOutput is
  // passed exclusively by the two teardown callers (killSession, and the
  // turn-exit fallback for an already-dead session), where the turn was
  // INTERRUPTED rather than completed. Clearing the marker there is what made
  // a SIGTERM restart erase its own evidence: restart.sh kills with SIGTERM,
  // the handler calls killSession for every live session, and a mid-turn Codex
  // session would delete the very record the next boot needs to offer a
  // carry-on card. Teardown leaves the marker standing; a genuine end clears
  // it. A deliberate !stop clears it explicitly at its own call site, before
  // killSession runs, so that case does not rely on this branch.
  if (!discardOutput) inflightMarker.noteTurnEnd(journalConvoIdFor(session));
  journalSessionState(session, 'waiting');
  journalActivity(session, 'idle');
  maybeSummarizeAtTurnEnd(session);
  journalStatus(session);
  if (!discardOutput && error && session.alive) {
    const message = `⚠️ ${error}`;
    if (session.sendHtml) session.sendHtml(message, escapeHtml(message));
    else if (session.sendCallback) session.sendCallback(message);
  }

  if (!preserveQueue) {
    // A /restart parked mid-turn fires now, INSTEAD of the queue flush —
    // the queue (and the roomId-keyed room-delivery inbox) carries into the
    // replacement session; see dispatchDeferredCommand. (killSession's
    // teardown call lands in the preserveQueue branch with alive already
    // false, so a stale stash can never fire from a dying session.)
    if (dispatchDeferredCommand(session)) return;
    // Coalesced room updates go out AFTER Dan's queued input (turn-end seam;
    // preserveQueue teardowns keep the inbox for the replacement session —
    // same roomId key) — but NEVER on top of a turn the queue flush just
    // dispatched (Task 6 review, C1): flushPendingSessionQueue returns true
    // exactly when a batch went out ('deferred' = codex interrupt in
    // flight; false = nothing to send / send refused). The new turn hits
    // this same seam at its own end, so nothing is lost by waiting.
    const dispatched = flushPendingSessionQueue(session) === true;
    if (!dispatched) maybeFlushRoomDelivery(session);
  }
}

// --- Interactive-mode session (MATRON_INTERACTIVE_MODE=1) ---
//
// Spawns claude in a PTY instead of --print. Events come from the on-disk
// JSONL transcript (via TranscriptTail), turn-end comes from the Stop hook,
// plan approval comes from the PreToolUse:ExitPlanMode hook. Returns a
// session object with the same shape as createSession() so downstream code
// (Matrix posting, queue management, restart) is unchanged.
function createInteractiveSessionForRoom(roomId, workdir, resumeSessionId, options = {}) {
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  const persistedForRoom = getPersistedSession(roomId);
  const showBashOutputAtSpawn = persistedForRoom?.showBashOutput !== false;
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
  const effectiveMcpExtras = effectiveExtras(mcpExtras, DEFAULT_MCP_EXTRAS);
  const shareEnabled = effectiveMcpExtras.includes('share');
  let showFileToken;
  let showFilePinnedRoots = null;
  if (shareEnabled) {
    try {
      showFilePinnedRoots = pinAllowedRootsSync([cwd, ...SHOW_FILE_ARTIFACT_ROOTS]);
      showFileToken = randomUUID();
    } catch (error) {
      console.warn(`[show-file] disabled for ${roomId}: failed to pin allowed roots (${error.message})`);
    }
  }
  // transcriptExists demotes a resume whose transcript was never written to a
  // fresh --session-id spawn on the same id (see planSessionIdentity). This is
  // what breaks the /logout crash loop's second half: the iv auto-restart and
  // journal auto-resume paths resume unconditionally, so a room persisted with
  // a zero-turn session id used to respawn `claude --resume <never-written>`
  // (exit 1) forever. Demotion spawns a fresh TUI on the same id instead —
  // nothing to resume means nothing to lose.
  // presetId matters here for the same reason it does in the print spawn: a
  // print->interactive switch on an unconfirmed session passes no resume id
  // (recreateSession's preInitPrint), so without it this would mint a fresh
  // uuid and the room would silently change claude session id mid-switch —
  // against the "keeping the convo/journal identity" the caller promises.
  const identity = planSessionIdentity({
    resumeSessionId, presetId: options.presetSessionId, mintId: randomUUID,
    transcriptExists: (id) => fs.existsSync(transcriptPathFor(cwd, id)),
  });
  const sessionId = identity.sessionId;
  const model = options.model === null
    ? undefined
    : resolveModel({ option: options.model, persisted: persistedForRoom?.model });

  // Fresh sessions pre-assign --session-id so the transcript path is known
  // before spawn; resumes pass --resume only. The exclusivity rule lives in
  // planSessionIdentity.
  const claudeArgs = [...identity.cliArgs];
  claudeArgs.push(
    // AskUserQuestion is allowed in iv-mode: the TUI prompt detector
    // (lib/prompt-detector.js) catches it and routes the question through
    // Matrix. Print-mode kept it disallowed because there was no way to
    // surface the TUI prompt; that constraint no longer applies.
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    '--mcp-config', mcpConfigPathFor(effectiveMcpExtras),
    '--settings', JSON.stringify(buildSessionSettings('iv')),
  );
  if (model) {
    claudeArgs.push('--model', model);
  }

  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '';
  const pathWithNode = existingPath.split(':').includes(nodeBinDir) ? existingPath : `${nodeBinDir}:${existingPath}`;

  const interactiveEnv = {
    ...process.env,
    PATH: pathWithNode,
    CLAUDECODE: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(API_PORT),
    MATRON_BASH_TEE_ENABLED: showBashOutputAtSpawn ? '1' : '0',
  };
  delete interactiveEnv.SHOW_FILE_TOKEN;
  if (showFileToken) interactiveEnv.SHOW_FILE_TOKEN = showFileToken;

  debug(`Spawning interactive claude session ${sessionId} in ${cwd}`);

  const iv = launchWithCodexSinkEnv({
    spawnEnv: interactiveEnv,
    workdir: cwd,
    sessionId,
    configureOptions: { warn: message => console.warn(message) },
    launch: configuredEnv => createInteractiveSession({
      roomId,
      workdir: cwd,
      sessionId,
      claudeArgs,
      env: configuredEnv,
    }),
  });

  // Same shape as the --print session object. `proc` is null in iv mode;
  // call sites that need raw input go via session.iv.sendText / sendKeystroke
  // (wired up in Task 4.2).
  const session = {
    agent: AGENT_CLAUDE,
    proc: null,
    iv,
    roomId,
    workdir: cwd,
    codexSpawnEnv: interactiveEnv,
    ...(showFileToken ? { showFileToken } : {}),
    showFilePinnedRoots,
    _showFileInFlight: 0,
    mcpExtras,
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: resumeSessionId ? (getPersistedSession(roomId)?.pendingPlanDenialId || null) : null,
    sendHtml: null,
    sendButtonMessage: null,
    showWorking: false,
    showBashOutput: showBashOutputAtSpawn,
    alive: true,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    restartCount: 0,
    claudeSessionId: sessionId,
    journalConvoId: options.journalConvoId || persistedForRoom?.journalConvoId || sessionId,
    _agentSessions: mergeAgentStates({}, options.agentSessions || persistedForRoom?.agentSessions),
    _agentHistoryCursor: 0,
    busy: false,
    lineBuf: '',
    toolCalls: [],
    waitingForAnswer: null,
    originRoomId: null,
    firstMessageCaptured: false,
    initData: null,
    currentModel: model || null,
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
    turnCount: 0,
    chatHistory: [],
    pinnedSummaryEventId: null,
    pinnedSummaryText: '',
    lastSummaryMsgCount: 0, // chatHistory index the summary pass has consumed through (persisted)
    lastRosterText: '',     // last ROSTER paragraph — preamble for the next incremental pass (persisted)
    pendingInteractivePrompt: null,
  };

  iv.on('event', event => {
    debug('IV event:', event.type);
    handleClaudeEvent(session, event);
  });

  iv.on('screen-update', update => {
    debug('IV screen-update:', update.urls.length, 'url(s)', 'cue=' + update.hasInputCue);
    handleInteractiveScreenUpdate(session, update);
  });

  iv.on('unclassified-prompt', update => {
    debug('IV unclassified-prompt: surfacing best-effort');
    handleUnclassifiedPrompt(session, update);
  });

  iv.on('prompt', prompt => {
    debug('IV prompt:', prompt.kind, prompt.question);
    session.pendingInteractivePrompt = prompt;
    // A real structured prompt supersedes any best-effort unclassified-prompt
    // notice we may have surfaced for an earlier render of this screen.
    session.pendingUnclassifiedPrompt = false;
    // A TUI prompt means claude has stopped processing and is awaiting
    // user input. The Stop hook is unreliable for these states (e.g.
    // first-run modals, /login, unauthenticated "please run /login"
    // pseudo-turns) — without this the bridge's `busy` flag gets stuck
    // and every subsequent user message hits the queue path.
    // Journal mirror is unconditional (journalSessionState dedupes on actual
    // change): a prompt can arrive while busy is already false, and the
    // journal must still show 'waiting'. Only the busy/typing cleanup below
    // stays gated.
    journalSessionState(session, 'waiting');
    journalActivity(session, 'idle');
    if (session.busy) {
      console.log(`[IV-DEBUG] Clearing busy=true on iv-prompt (kind=${prompt.kind})`);
      session.busy = false;
      // Deliberately NO inflightMarker.noteTurnEnd here: busy is cleared to
      // route the user's reply into the PTY, but the turn resumes once they
      // answer and onTurnEnd remains its authoritative end. A restart while
      // the prompt is open leaves a genuinely dangling turn — exactly what the
      // carry-on card is for.
    }
    handleInteractivePrompt(session, prompt);
  });

  iv.on('parseError', err => {
    debug('IV transcript parse error:', err.line?.slice(0, 80));
  });

  iv.on('exit', exitCode => {
    session.alive = false;
    debug(`Interactive claude session ${sessionId} exited code=${exitCode}`);
    teardownSubagentTracking(session);
    flushResponse(session);
    // Same exit-seam overlay clear as print-mode's proc.on('close'). iv-mode
    // reads complete messages from the transcript, so no overlay should ever
    // be open here today — this is symmetry/defense (and it deletes the
    // publisher's throttle entry) in case the transcript path ever grows
    // partials.
    journalStreamClear(session);
    // Same orphan-pump sweep as the print-mode close handler above: the
    // process exited on its own without the tool_result seam running.
    sweepToolStreams(session);
    if (sessions.get(roomId) === session) {
      if (session._autoStopped) {
        // Idle reaper already posted its own notice; just clean up.
        sessions.delete(roomId);
        journalSessionState(session, 'done');
        journalActivity(session, 'idle');
        journalEvictConvoInput(session);
      } else if (exitCode !== 0 && session.restartCount < 3 && !session._resumeFailed) {
        // See the matching print-mode branch's comment: the terminal exit
        // paths already emit idle on restart, this auto-restart branch
        // didn't (Bugbot finding #3).
        journalActivity(session, 'idle');
        // Pass mcpExtras explicitly (see the matching block in print-mode
        // createSession): the persistence-fallback in createSession can miss
        // a fresh session that crashed before its first persist.
        //
        // Interactive mode restarts pass --resume here unconditionally (iv
        // sessions never set _sessionConfirmed, so a flag gate would wrongly
        // force every iv restart onto --session-id and break
        // resume-after-persist). The never-written-transcript case is instead
        // caught inside the spawn: planSessionIdentity's transcriptExists
        // check demotes a resume with no transcript on disk to a fresh
        // --session-id spawn on the same id (/logout-crash-loop bug — this
        // exact path used to retry `claude --resume <never-written>` 3× and
        // die).
        const restarted = createSession(roomId, cwd, session.claudeSessionId, {
          agent: session.agent,
          model: session.currentModel || undefined,
          mcpExtras: session.mcpExtras,
          journalConvoId: session.journalConvoId,
          // Carry the prior title so the re-seed adopts the good Gemini title
          // instead of publishing the repo basename over it (title-revert bug).
          journalTitleHint: session._journalTitleHint,
        });
        restarted.restartCount = session.restartCount + 1;
        restarted.sendCallback = session.sendCallback;
        restarted.sendHtml = session.sendHtml;
        restarted.sendButtonMessage = session.sendButtonMessage;
        // Account-flow state must survive the TUI's own exit: /logout makes
        // claude quit, this branch respawns it (resumed, now logged out), and
        // the user's next /login should still auto-return to print mode.
        // A parked /login rides across too — the respawned session enters its
        // own resume hold, whose watcher types it once the (logged-out) TUI
        // is ready.
        restarted._accountFlowReturnToPrint = session._accountFlowReturnToPrint;
        restarted._accountLogoutPending = session._accountLogoutPending;
        restarted._postReadySlashCommand = session._postReadySlashCommand;
        restarted.originRoomId = session.originRoomId;
        restarted.firstMessageCaptured = session.firstMessageCaptured;
        // Carry user-visible state across the restart so the user doesn't
        // silently lose queued messages or per-room toggles.
        restarted.queuedMessages = session.queuedMessages;
        restarted.queueNotifications = session.queueNotifications;
        journalInputConsumer.queueRelease.carryForward(
          journalConvoIdFor(session),
          journalConvoIdFor(restarted),
        );
        restarted.showWorking = session.showWorking;
        restarted.showBashOutput = session.showBashOutput;
        restarted.chatHistory = session.chatHistory;
        restarted.pinnedSummaryText = session.pinnedSummaryText;
        restarted.pinnedSummaryEventId = session.pinnedSummaryEventId;
        restarted.lastSummaryMsgCount = session.lastSummaryMsgCount || 0;
        restarted.lastRosterText = session.lastRosterText || '';
        restarted.repoScores = session.repoScores; // carry activity-inferred repo signal across restart
        restarted._agentHistoryCursor = session._agentHistoryCursor;
        restarted._pendingAgentHandoff = session._pendingAgentHandoff;
        restarted._agentSessions = session._agentSessions;
        restarted.totalUsage = session.totalUsage;
        restarted.turnCount = session.turnCount;
        // Carry journal-mirror state (see the matching print-mode block).
        restarted._journalBuffer = session._journalBuffer;
        restarted._journalTitleHint = session._journalTitleHint;
        restarted._journalState = session._journalState;
        restarted._journalConvoEstablished = session._journalConvoEstablished;
        sessions.set(roomId, restarted);
        // Same hold recreateSession and the auto-resume path use: without it
        // the copied _postReadySlashCommand is never consumed (the readiness
        // watcher is what types parked commands), so a /login or /logout
        // interrupted by a crash silently never ran — and anything the user
        // sent right after the restart was typed into a still-loading TUI
        // and dropped (Bugbot, PR #162).
        enterResumeHold(restarted);
        if (restarted.sendHtml) {
          const n = notice('warning',
            `[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`,
            `Session crashed (exit ${exitCode}), restarted automatically — attempt <b>${restarted.restartCount}/3</b>`);
          restarted.sendHtml(n.plain, n.html);
        } else if (restarted.sendCallback) {
          restarted.sendCallback(`[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`);
        }
      } else {
        // Notices FIRST, teardown second: sendToRoom's journal mirror looks
        // the session up in the map, so anything sent after
        // sessions.delete() is silently dropped — which is exactly how the
        // post-/logout "[Session ended (exit 0)]" vanished in live testing
        // and the whole logout flow went dark.
        if (session._accountLogoutPending && exitCode === 0) {
          // /logout completed: claude logs out and exits cleanly. Persist
          // print mode ONLY when the bridge borrowed interactive mode for
          // this flow (_accountFlowReturnToPrint) — without that reset every
          // later auto-resume comes back as a TUI session and the room is
          // stuck interactive forever (the root cause of the silent /logout
          // in live-test round 2). A user who chose interactive mode keeps
          // their preference across the logout (Bugbot, PR #162).
          if (session._accountFlowReturnToPrint) {
            persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { interactiveMode: false });
          }
          const n = notice('info', '👋 Logged out. Send /login when you\'re ready to sign back in.', '👋 Logged out. Send <code>/login</code> when you\'re ready to sign back in.');
          if (session.sendHtml) session.sendHtml(n.plain, n.html);
          else if (session.sendCallback) session.sendCallback(n.plain);
        } else if (session.sendHtml) {
          const n = notice('error', `[Session ended (exit ${exitCode})]`, `Session ended (exit <code>${exitCode}</code>)`);
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback(`[Session ended (exit ${exitCode})]`);
        }
        sessions.delete(roomId);
        journalSessionState(session, 'done');
        journalActivity(session, 'idle');
        journalEvictConvoInput(session);
      }
    }
  });

  session.resetTimeout = () => {};

  // iv-mode turn-end handler. Print-mode does most of this work in
  // case 'result' inside handleClaudeEvent; the transcript file in iv-mode
  // has no result event, so the Stop hook (→ /turn-end → this) replaces it.
  session.onTurnEnd = () => {
    debug(`[IV] onTurnEnd called, room=${session.roomId}, bufLen=${session.responseBuffer.length}, sendCallback=${!!session.sendCallback}, sendHtml=${!!session.sendHtml}`);
    // Flush the accumulated assistant text to Matrix.
    if (session.responseBuffer.trim() && !session.waitingForAnswer) {
      flushResponse(session);
    }
    // No dangling overlay past turn-end (no-op unless this session streamed a
    // turn that produced no durable final message).
    journalStreamClear(session);
    // Emit collected tool-call summary if the user has !show_working on.
    if (session.toolCalls.length > 0 && session.showWorking && session.sendCallback) {
      const toolSummary = session.toolCalls.join('\n');
      const chunks = splitMessage(toolSummary);
      for (const chunk of chunks) session.sendCallback(chunk);
    }
    session.toolCalls = [];
    session.turnCount++;
    session.busy = false;
    // Authoritative iv-mode turn-end seam.
    inflightMarker.noteTurnEnd(journalConvoIdFor(session));
    journalSessionState(session, 'waiting');
    journalActivity(session, 'idle');
    maybeSummarizeAtTurnEnd(session);
    // The turn ended, so any best-effort unclassified-prompt notice is stale.
    session.pendingUnclassifiedPrompt = false;
    // A real turn-end supersedes any armed operator-compact fallback: disarm
    // it so a later (or stale) manual compact_boundary can't stand in as a
    // turn-end for a subsequent turn and clear busy out from under it.
    if (session._operatorCompactPending) {
      session._operatorCompactPending = false;
      if (session._operatorCompactTimer) {
        clearTimeout(session._operatorCompactTimer);
        session._operatorCompactTimer = null;
      }
    }
    // A /restart parked mid-turn fires now, INSTEAD of the queue flush —
    // the queue (and the roomId-keyed room-delivery inbox) carries into the
    // replacement session; see dispatchDeferredCommand. This seam also
    // covers a manual /compact: its compact_boundary handler routes here.
    if (dispatchDeferredCommand(session)) return;
    // Flush any queued messages now that claude is free.
    let queueDispatched = false;
    if (session.queuedMessages && session.queuedMessages.length > 0 && !session.waitingForAnswer) {
      queueDispatched = flushPendingSessionQueue(session) === true;
    }
    // Coalesced room updates go out AFTER Dan's queued input (turn-end
    // seam) — never on top of the turn that flush just dispatched (Task 6
    // review, C1), and never into an open prompt (maybeFlushRoomDelivery's
    // composite occupied gate covers waitingForAnswer AND
    // pendingInteractivePrompt, C2).
    if (!queueDispatched) maybeFlushRoomDelivery(session);
  };

  // /plan-decision HTTP handler calls this when claude's ExitPlanMode hook
  // fires. We post the plan to Matrix and stash the tool_use_id so that
  // the "build" handler in the message loop can call
  // pendingPlanDecisions.get(toolUseId).resolve(...) when the user replies.
  session.requestPlanDecision = (toolUseId, planText) => {
    session.ivPendingPlanToolUseId = toolUseId;
    session.pendingPlan = planText || '';
    const preview = (planText || '').length > 500
      ? (planText || '').slice(0, 500) + '…'
      : (planText || '');
    const plainPlan = `--- Plan Ready ---\n\n${preview}\n\nReply "build" to execute, or send feedback.`;
    if (session.sendHtml) {
      const htmlPlan =
        `<b>📋 Plan Ready</b><blockquote>${markdownToHtml(preview)}</blockquote>` +
        `Reply <code>build</code> to execute, or send feedback.`;
      session.sendHtml(plainPlan, htmlPlan);
    } else if (session.sendCallback) {
      session.sendCallback(plainPlan);
    } else {
      // No output channel yet — auto-deny so the hook unblocks.
      const pending = pendingPlanDecisions.get(toolUseId);
      if (pending) pending.resolve({ decision: 'deny', reason: 'no output channel for session' });
    }
  };

  sessions.set(roomId, session);
  // Subagent activity watcher — see createSession() for the rationale.
  setupSubagentWatcher(session, cwd, sessionId);
  return session;
}

// Surface a detected TUI prompt to Matrix as a multiple-choice question.
async function handleInteractivePrompt(session, prompt) {
  if (!session.sendHtml && !session.sendCallback) return;
  // Surface claude's explanatory prose (rendered above the menu) BEFORE the
  // question, so the user has the reasoning when choosing. In iv-mode that
  // prose only reaches the transcript after the answer, but it's on the live
  // screen now — recover it from the recent PTY output. Only when the capture
  // is complete: then we also remember it to suppress the duplicate that flushes
  // from the transcript post-answer (the user's "suppress only if full" choice).
  // A partial/empty capture is skipped here and left to the transcript.
  // Scope this to AskUserQuestion-style menus (option descriptions or a
  // free-text slot). Other prompts (permission confirms, simple pickers) carry
  // their own context in the question text and have no fresh prose above them —
  // attempting a preamble there risks surfacing a stale paragraph from an
  // earlier turn whose `●` marker sits above the menu.
  const auqLike = prompt.freeTextIdx != null ||
    (Array.isArray(prompt.options) && prompt.options.some(o => o && o.description));
  if (auqLike && session.iv && typeof session.iv.recentOutput === 'function' && session.pendingInteractivePrompt === prompt) {
    try {
      const { preamble, complete } = extractPreamble(session.iv.recentOutput(), prompt);
      if (complete && preamble) {
        session._suppressPreambleText = preamble;
        if (session.suppressPreambleTimer) clearTimeout(session.suppressPreambleTimer);
        // Self-clear so a stale capture can't suppress an unrelated later message.
        session.suppressPreambleTimer = setTimeout(() => { session._suppressPreambleText = null; }, 600_000);
        if (typeof session.suppressPreambleTimer.unref === 'function') session.suppressPreambleTimer.unref();
        if (session.sendHtml) session.sendHtml(preamble, markdownToHtml(preamble));
        else session.sendCallback(preamble);
      }
    } catch (e) { debug('extractPreamble failed:', e?.message); }
  }
  // Prefer native buttons when the prompt is a clean selection menu and a
  // button channel is wired. promptButtons returns null for free-text /
  // multi-select / unlabelable prompts, which fall through to the text
  // rendering below. pendingInteractivePrompt is set by the caller
  // (iv.on('prompt')) regardless, so a tap routes via the prompt-opt handler.
  if (session.sendButtonMessage) {
    const b = promptButtons(prompt);
    if (b) {
      const header = prompt.question || 'Claude is asking';
      // Include each option's description (when the detector captured one, e.g.
      // AskUserQuestion menus) so the user has the per-option detail before
      // choosing — the buttons themselves only carry the short label.
      const descOf = (i) => (prompt.options && prompt.options[i] && prompt.options[i].description) || '';
      const plain = ['Claude is asking:', prompt.question || '', '',
        ...b.buttons.map((bt, i) => {
          const d = descOf(i);
          return `${i + 1}. ${bt.label}${d ? `\n    ${d}` : ''}`;
        })].filter(Boolean).join('\n');
      const anyDesc = b.buttons.some((_, i) => descOf(i));
      const htmlOpts = b.buttons.map((bt, i) => {
        const d = descOf(i);
        return `<b>${i + 1}. ${escapeHtml(bt.label)}</b>${d ? `<br/><i>${escapeHtml(d)}</i>` : ''}`;
      }).join(anyDesc ? '<br/>' : ' · ');
      const html = `<b>🟡 Claude is asking:</b>` +
        (prompt.question ? `<br/><i>${escapeHtml(prompt.question)}</i>` : '') +
        `<br/><br/>${htmlOpts}`;
      // If a newer prompt superseded this one while we were composing, bail —
      // don't post buttons for a stale prompt against the current TUI menu.
      if (session.pendingInteractivePrompt !== prompt) return;
      // sendButtonMessage (index.js) returns true once it's published the
      // prompt to the journal, or null when there's no journal session for
      // this room to publish to (outbound Matrix sends are gone — Task 3).
      // Fall through to the text rendering below in the null case so the
      // prompt is never silently dropped while the TUI waits for an answer.
      const sent = await session.sendButtonMessage(header, b.buttons, b.mode, plain, html);
      if (sent != null) return;
    }
  }
  // Bail if this prompt is no longer current — a newer prompt superseded it
  // (e.g. arrived during the button send above) or it was already resolved.
  // Don't post a stale text prompt against the current TUI menu.
  if (session.pendingInteractivePrompt !== prompt) return;
  const optionLines = prompt.options.map((opt, i) =>
    `${i + 1}. ${opt.label}${opt.selected ? ' (current)' : ''}${opt.description ? `\n    ${opt.description}` : ''}`);
  // When the prompt has a detected free-text slot (e.g. "Tell Claude what
  // to change"), tell the user they can reply with text directly. We'll
  // route the reply to that option and pipe their text into the TUI.
  const ftIdx = prompt.freeTextIdx;
  const ftLabel = (typeof ftIdx === 'number') ? (prompt.options[ftIdx]?.label || '') : '';
  const helpPlain = [
    `Reply with the option number (1–${prompt.options.length})`,
    prompt.kind === 'yes-no' ? ' or "y" / "n"' : '',
    ftLabel ? `, or send any other text to ${JSON.stringify(ftLabel)}` : '',
    '.',
  ].join('');
  const plain = [
    'Claude is asking:',
    prompt.question || '',
    '',
    ...optionLines,
    '',
    helpPlain,
  ].filter(Boolean).join('\n');
  if (session.sendHtml) {
    const htmlOptions = prompt.options.map((opt, i) =>
      `<b>${i + 1}.</b> ${escapeHtml(opt.label)}${opt.selected ? ' <i>(current)</i>' : ''}` +
      (opt.description ? `<br/>&nbsp;&nbsp;&nbsp;&nbsp;<i>${escapeHtml(opt.description)}</i>` : '')
    ).join('<br/>');
    const helpHtml =
      `Reply with the option number (1–${prompt.options.length})` +
      (prompt.kind === 'yes-no' ? ' or <code>y</code> / <code>n</code>' : '') +
      (ftLabel ? `, or send any other text to <i>${escapeHtml(ftLabel)}</i>` : '') +
      '.';
    const html =
      `<b>🟡 Claude is asking:</b><br/>` +
      (prompt.question ? `<i>${escapeHtml(prompt.question)}</i><br/><br/>` : '') +
      htmlOptions +
      `<br/><br/>${helpHtml}`;
    session.sendHtml(plain, html);
  } else {
    session.sendCallback(plain);
  }
}

// If the session has a pending TUI prompt and the user's message looks like
// a valid response, send the keystroke and return true (so the message isn't
// also forwarded to claude as a regular user message).
//
// mirrorToJournal defaults true (the Matrix path — the journal has no other
// way of learning the user's answer). The journal input consumer passes
// false: an answer that arrived AS a journal event (a plain text reply
// routed here while a TUI prompt happened to be open) must not be
// re-published — the journal already has the user's own `send` row for it.
function maybeResolveInteractivePrompt(session, userText, { mirrorToJournal = true } = {}) {
  const p = session.pendingInteractivePrompt;
  if (!p) return false;
  const trimmed = (userText || '').trim().toLowerCase();
  const mirrorAnswer = (text) => recordUserAnswer(session, text, { mirrorToJournal });

  // Confirm to the Matrix user what we sent on their behalf (without this the
  // consumption is invisible) and start a typing indicator for the next render.
  const ack = (label, { numberPrefix = '', note = '' } = {}) => {
    const tail = note ? ` ${note}` : '';
    const plain = `→ Sent "${numberPrefix}${label}" to Claude${tail}`;
    const html = `<i>→ Sent <b>${escapeHtml(numberPrefix + label)}</b> to Claude${escapeHtml(tail)}</i>`;
    if (session.sendHtml) session.sendHtml(plain, html);
    else if (session.sendCallback) session.sendCallback(plain);
  };

  // Select the free-text slot ("Tell Claude what to change" / "Type something"),
  // then — after the TUI transitions from the menu into the text input — paste
  // the user's reply (sendText does the bracketed-paste + delayed Enter dance).
  const routeFreeText = (replyText) => {
    const idx = p.freeTextIdx;
    const opt = p.options[idx];
    const ftResponse = p.kind === 'arrow-menu'
      ? { kind: 'arrow-menu', key: String(idx) }
      : { kind: p.kind, key: opt.key };
    const dispatched = sendDelayedPromptAnswer(session, {
      response: ftResponse,
      text: replyText,
      // The reply goes in via iv.sendText (not sendToSession), so record it
      // only after that delayed PTY send accepts the text.
      onDelivered: () => mirrorAnswer(replyText),
      onError: (error) => reportPromptAnswerDeliveryFailure(session, error),
    });
    if (dispatched) session.pendingInteractivePrompt = null;
    return dispatched;
  };

  // yes-no: a binary confirm with no option list or free-text slot.
  if (p.kind === 'yes-no') {
    let response = null, label = null;
    if (/^(y|yes|1)$/.test(trimmed)) { response = { kind: 'yes-no', key: 'y' }; label = 'Yes'; }
    else if (/^(n|no|2)$/.test(trimmed)) { response = { kind: 'yes-no', key: 'n' }; label = 'No'; }
    if (!response) { session.pendingInteractivePrompt = null; return false; }
    console.log(`[IV-DEBUG] Resolving yes-no prompt reply="${userText}" → key=${response.key}`);
    if (session.iv.respondToPrompt(response) !== true) return false;
    session.pendingInteractivePrompt = null;
    mirrorAnswer(label);
    ack(label);
    return true;
  }

  // numbered / lettered / arrow-menu. Split the reply into a leading option
  // token and any appended remark ("1. also use compiled css …"). The old code
  // ran parseInt() and dropped everything after the number (#82).
  const hasFreeText = typeof p.freeTextIdx === 'number'
    && p.freeTextIdx >= 0 && p.freeTextIdx < p.options.length;
  const { token, extra } = parseOptionReply(userText);
  let optIdx = -1;
  if (token != null) {
    if (/^\d+$/.test(token)) {
      const n = parseInt(token, 10);
      if (n >= 1 && n <= p.options.length) optIdx = n - 1;
    } else if (p.kind === 'lettered') {
      optIdx = p.options.findIndex(o => (o.key || '').toLowerCase() === token.toLowerCase());
    }
  }

  if (optIdx >= 0) {
    const opt = p.options[optIdx];
    const numberPrefix = `${optIdx + 1}. `;
    if (extra) {
      // Option pick WITH an appended remark. Route through the free-text slot
      // so BOTH the choice and the remark reach claude — the user's literal
      // reply ("1. also use compiled css…") already names the option.
      if (hasFreeText) {
        console.log(`[IV-DEBUG] Resolving prompt reply="${userText}" → option ${optIdx + 1} + remark via free-text slot`);
        if (routeFreeText(userText)) {
          ack(opt.label, { numberPrefix, note: '(with your note)' });
          return true;
        }
        return false;
      }
      // No free-text channel on this menu — the choice goes through but the
      // remark can't ride along. Send the pick and tell the user.
      const response = p.kind === 'arrow-menu'
        ? { kind: 'arrow-menu', key: String(optIdx) }
        : { kind: p.kind, key: opt.key };
      console.log(`[IV-DEBUG] Resolving prompt reply="${userText}" → option ${optIdx + 1} (remark dropped: no free-text slot)`);
      if (session.iv.respondToPrompt(response) !== true) return false;
      session.pendingInteractivePrompt = null;
      mirrorAnswer(`${numberPrefix}${opt.label}`);
      ack(opt.label, { numberPrefix, note: "— couldn't attach your note to this menu; send it as a separate message" });
      return true;
    }
    // Bare option pick.
    const response = p.kind === 'arrow-menu'
      ? { kind: 'arrow-menu', key: String(optIdx) }
      : { kind: p.kind, key: opt.key };
    console.log(`[IV-DEBUG] Resolving prompt reply="${userText}" → kind=${response.kind} key=${response.key} label="${opt.label}"`);
    if (session.iv.respondToPrompt(response) !== true) return false;
    session.pendingInteractivePrompt = null;
    mirrorAnswer(`${numberPrefix}${opt.label}`);
    ack(opt.label, { numberPrefix });
    return true;
  }

  // No valid option named. Route to the free-text slot if present; otherwise
  // dismiss the prompt and let the message through to claude as a normal turn
  // (prevents false-positive detections from blocking free-form messages).
  if (hasFreeText) {
    console.log(`[IV-DEBUG] Routing unmatched reply="${userText}" to free-text slot`);
    return routeFreeText(userText);
  }
  session.pendingInteractivePrompt = null;
  return false;
}

// Iteratively rejoin URLs that claude wrapped at terminal width. We only
// merge a `\n` into a URL when the next line begins with characters that
// can only be URL continuation (no spaces, only URL-safe chars), so prose
// that happens to follow a URL stays on its own line.
function unwrapUrls(text) {
  const URL_HEAD = /(https?:\/\/[A-Za-z0-9=&/%+\-._~?#:@!*'(),;$]+)\n([A-Za-z0-9=&/%+\-._~?#]+)/g;
  let prev;
  let out = text;
  do {
    prev = out;
    out = out.replace(URL_HEAD, '$1$2');
  } while (out !== prev);
  return out;
}

// Build a clean, purpose-built Matrix message from a settled free-text
// TUI screen instead of dumping the raw PTY content. Each cue type
// (OAuth flow, press-enter ack, etc) gets its own formatter so the user
// sees a focused message — no separator bars, status chrome, OSC title
// leaks, spinner ticks, task lists, etc. Returns null when nothing
// useful can be extracted (caller should not send anything in that
// case rather than dumping the raw screen).
function formatTuiCueMessage(screen, urls, { hasNewUrls = true } = {}) {
  // All cue matching runs on the compact form (lowercased, whitespace and
  // apostrophes removed): the TUI shimmer-animates some of these lines with
  // per-character escapes, which stripAnsi renders letter-spaced ("P r e s s
  // E n t e r …") — word-spaced regexes never match those. See
  // compactScreenText in lib/prompt-detector.js.
  const compact = compactScreenText(screen);
  // Press-Enter acknowledgment (e.g. post-login "Login successful.
  // Press Enter to continue…") — checked BEFORE the OAuth branch: the
  // success screen still carries the wizard's "use the url below" text and
  // the OAuth URL in the scrollback above it, and oauth-first ordering
  // re-rendered a "sign in" card at the exact moment login succeeded
  // (live-test round 5's post-paste duplicate). The press-enter cue is the
  // actionable state; older wizard text above it is history.
  //
  // Result line: JUST ABOVE the cue line, and only on the strict
  // login-result tokens. The tail also contains the resumed session's
  // repainted chat transcript, and a whole-screen search with loose words
  // ("complete", "finished") kept matching the USER'S OWN old messages —
  // surfacing a random fragment of prior conversation as a "✅ …" card
  // (live-test rounds 1 and 2).
  if (AUTO_ENTER_COMPACT_RE.test(compact)) {
    const lines = screen.split('\n').map(l => l.trim()).filter(Boolean);
    const cueIdx = lines.findIndex(l => AUTO_ENTER_COMPACT_RE.test(compactScreenText(l)));
    const nearby = cueIdx >= 0 ? lines.slice(Math.max(0, cueIdx - 4), cueIdx + 1) : [];
    const resultLine =
      nearby.find(l => LOGIN_SUCCESS_COMPACT_RE.test(compactScreenText(l))) ||
      'Claude is continuing…';
    const display = despaceTuiLine(resultLine);
    const plain = `✅ ${display}`;
    const html = `<b>✅ ${escapeHtml(display)}</b>`;
    return { plain, html };
  }
  // OAuth / "open this URL to sign in" flow. Triggered by /login.
  // Screen layout: "Browser didn't open? Use the url below to sign in
  // (c to copy)" + URL + "Paste code here if prompted >".
  // Gated on hasNewUrls: the card's entire content is the URL, so a
  // re-render where every URL was already surfaced can only ever be a
  // duplicate of a card the user already has.
  const isOauth = /browserdidntopen|usetheurl|copytheurl|pastecodehere/.test(compact);
  if (isOauth && urls.length > 0 && hasNewUrls) {
    const url = urls[0];
    const plain =
      `🔗 Claude needs you to sign in.\n\n` +
      `Open this URL in your browser:\n${url}\n\n` +
      `After authorising, paste the code (the long string after \`#\` in the callback URL) back here.`;
    const html =
      `<b>🔗 Claude needs you to sign in.</b><br/><br/>` +
      `Open this URL in your browser:<br/>` +
      `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br/><br/>` +
      `After authorising, paste the code (the long string after <code>#</code> in the callback URL) back here.`;
    return { plain, html };
  }
  // Generic input cue we couldn't parse — surface a one-liner pointing
  // at the cue with any URLs, but don't dump the whole screen. Same
  // hasNewUrls gate as the OAuth card: all-stale URLs = duplicate.
  if (urls.length > 0 && hasNewUrls) {
    const plain = `Claude is asking you to act on this URL:\n${urls.join('\n')}`;
    const html =
      `<b>Claude is asking you to act on this URL:</b><br/>` +
      urls.map(u => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`).join('<br/>');
    return { plain, html };
  }
  return null;
}

// Surface free-text TUI output (e.g. the /login OAuth URL screen, "press
// enter to continue" notices) to Matrix. Triggered by the prompt-detector's
// `screen-update` event whenever the screen settles with URLs or input
// cues that don't classify as a structured menu — those are the only PTY
// states the user MUST see but that don't fire transcript events and
// aren't covered by the menu detector.
function handleInteractiveScreenUpdate(session, update) {
  const { screen, urls, hasInputCue } = update;
  if (!screen) return;
  if (urls.length === 0 && !hasInputCue) return;
  // Per-session URL dedup so the same OAuth URL isn't pushed twice if
  // claude redraws (e.g. spinner ticks). The detector also dedups but
  // only within one session run — we want lifetime dedup across restarts.
  session.surfacedUrls = session.surfacedUrls || new Set();
  const newUrls = urls.filter(u => !session.surfacedUrls.has(u));
  if (newUrls.length === 0 && !hasInputCue) return;
  for (const u of newUrls) session.surfacedUrls.add(u);
  // Un-wrap URLs that claude broke across lines at terminal width so
  // the parsed URL set is correct (`...redir\nect_uri=...` → joined).
  const unwrappedScreen = unwrapUrls(
    screen.split('\n').map(l => l.trim()).join('\n')
  );
  // Build a clean cue-specific message instead of dumping the raw
  // screen. If the formatter can't make sense of the cue, skip rather
  // than spam a screen-dump full of status chrome.
  const allUrls = extractUrls(unwrappedScreen);
  const message = formatTuiCueMessage(unwrappedScreen, allUrls, { hasNewUrls: newUrls.length > 0 });
  // Auto-Enter decision is independent of message formatting: an
  // acknowledgment screen the formatter can't summarise must STILL be
  // acknowledged, or claude sits blocked on a keystroke the user can't see.
  const compact = compactScreenText(unwrappedScreen);
  const autoEnter = AUTO_ENTER_COMPACT_RE.test(compact);
  if (!message && !autoEnter) {
    console.log(`[IV-DEBUG] Free-text TUI cue not parseable, skipping (urls=${newUrls.length}, inputCue=${hasInputCue})`);
    return;
  }
  if (message) {
    console.log(`[IV-DEBUG] Surfacing parsed free-text TUI cue (${newUrls.length} new URL(s), inputCue=${hasInputCue})`);
    if (session.sendHtml) session.sendHtml(message.plain, message.html);
    else if (session.sendCallback) session.sendCallback(message.plain);
  }
  // A free-text TUI cue means claude is waiting on the user just like a
  // structured prompt does — clear busy so the user's response (OAuth
  // code, "paste code here" content, etc.) gets typed straight into the
  // PTY instead of dropping into the queue. Mirrors the iv-prompt
  // handler at iv.on('prompt') in createInteractiveSessionForRoom.
  // Unconditional (dedupes internally) — see the matching iv-prompt handler.
  journalSessionState(session, 'waiting');
  journalActivity(session, 'idle');
  if (session.busy) {
    console.log(`[IV-DEBUG] Clearing busy=true on screen-update (hasInputCue=${hasInputCue})`);
    session.busy = false;
    // No noteTurnEnd — prompt surfacing, not turn end. See iv.on('prompt').
  }
  // Auto-press Enter for pure acknowledgment cues ("Press Enter to
  // continue…" after /login success, "Press Enter to dismiss" notices,
  // etc). These are just waiting for any keystroke before claude moves
  // on — without this the user has to send a dummy message to unblock
  // claude, which is confusing UX. We surface the screen content FIRST
  // (so the user sees "Login successful" etc) then send Enter and a
  // small confirmation note.
  if (autoEnter) {
    console.log('[IV-DEBUG] Auto-pressing Enter for "Press Enter to continue" cue');
    // Close the /login-from-print loop: the bridge forced this session into
    // interactive mode only so /login (or /logout → /login) could run.
    // Login success is the natural end of that flow — switch back to print
    // mode automatically instead of leaving the user to remember
    // "/mode print". Scheduled BEFORE the Enter keystroke is attempted: a
    // failed keystroke must not skip the return (Bugbot, PR #162) — the
    // switch recreates the session anyway, which also unsticks a TUI whose
    // Enter never landed. Delayed so the TUI paints its idle screen first
    // (planModeSwitch refuses while the screen is mid-transition). The
    // success match is scoped to the lines around the press-Enter cue
    // (loginSuccessNearAutoEnterCue) — stale "Login successful" text in the
    // repainted-transcript scrollback must not end the flow off a later
    // unrelated acknowledgment cue. The flag is consumed only on an ACTUAL
    // successful switch: applyModeSwitch can refuse (busy, pending prompt),
    // and clearing the flag at scheduling time would strand the session in
    // interactive mode after promising otherwise — a rare second
    // login-success screen retrying the switch is the better failure mode.
    // The scheduled guard prevents timer pile-up if the success screen ever
    // re-emits before the timer fires.
    if (session._accountFlowReturnToPrint && !session._accountFlowReturnScheduled
        && loginSuccessNearAutoEnterCue(unwrappedScreen)) {
      session._accountFlowReturnScheduled = true;
      const roomId = session.roomId;
      setTimeout(() => {
        session._accountFlowReturnScheduled = false;
        // Act on whatever session holds the room NOW, not just the object
        // that scheduled the timer: the iv auto-restart path copies
        // _accountFlowReturnToPrint onto its replacement session, and an
        // identity check here would strand that replacement in interactive
        // mode (Bugbot, PR #162).
        const current = sessions.get(roomId);
        if (!shouldRunAccountFlowReturn(current)) return;
        const sendReply = current.sendCallback || (() => {});
        const sendHtml = current.sendHtml || ((plain) => sendReply(plain));
        // applyModeSwitch announces the outcome either way — the switch on
        // success, refusalAnnouncement on refusal — and returns the
        // replacement session only when the switch actually happened.
        const switched = applyModeSwitch(roomId, current, false, {
          sendReply, sendHtml,
          announcement: '✅ Logged in successfully — back to normal mode.',
          refusalAnnouncement: 'Login finished, but I couldn\'t switch back to non-interactive mode automatically — type /mode print when ready.',
        });
        if (switched) current._accountFlowReturnToPrint = false;
      }, LOGIN_RETURN_TO_PRINT_DELAY_MS);
    }
    try {
      session.iv.sendKeystroke('enter');
    } catch (err) {
      console.error('[IV-DEBUG] Auto-Enter failed:', err.message);
      return;
    }
    const note = '↵ (auto-pressed Enter to continue)';
    if (session.sendHtml) session.sendHtml(note, `<i>${escapeHtml(note)}</i>`);
    else if (session.sendCallback) session.sendCallback(note);
  }
}

// Safety net for iv-mode: the detector emits `unclassified-prompt` when the
// settled screen looks like a selection menu it couldn't parse into buttons
// (e.g. option labels too long). Without this the user would be blind while the
// TUI waits. Surface a best-effort, cleaned screen dump so they can answer; a
// later bare number/letter reply is sent as raw keystrokes (see the message
// handler) to drive the open menu. Detector-side dedup prevents repeats.
function handleUnclassifiedPrompt(session, { screen }) {
  if (!session.sendHtml && !session.sendCallback) return;
  // Clean the raw screen: drop blank lines, keep the tail (the menu sits at the
  // bottom), and cap length so we don't dump the whole terminal.
  const cleaned = String(screen || '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim().length > 0)
    .slice(-20)
    .join('\n')
    .slice(0, 1500);
  if (!cleaned) return;
  const plain = `⚠️ Claude is waiting for input I couldn't turn into buttons. Reply with the option number shown (or send !esc to cancel):\n\n${cleaned}`;
  const html =
    `<b>⚠️ Claude is waiting for input I couldn't parse into buttons.</b><br/>` +
    `Reply with the option number shown (or send <code>!esc</code> to cancel):<br/><pre>${escapeHtml(cleaned)}</pre>`;
  if (session.sendHtml) session.sendHtml(plain, html);
  else session.sendCallback(plain);
  session.pendingUnclassifiedPrompt = true;
  // Unconditional (dedupes internally) — see the matching iv-prompt handler.
  journalSessionState(session, 'waiting');
  journalActivity(session, 'idle');
  // Like a structured prompt, this means claude is awaiting the user — clear
  // busy so the reply is typed into the PTY instead of dropping into the queue.
  if (session.busy) {
    session.busy = false;
    // No noteTurnEnd — prompt surfacing, not turn end. See iv.on('prompt').
  }
}

// AUTO_ENTER_COMPACT_RE / LOGIN_SUCCESS_COMPACT_RE and the cue-window
// matcher loginSuccessNearAutoEnterCue live in lib/prompt-detector.js
// (imported above) so their matching rules are unit-testable.

// How long after the auto-Enter to wait before switching a /login-initiated
// interactive session back to print mode — long enough for the TUI to paint
// its idle screen so planModeSwitch doesn't refuse the switch.
const LOGIN_RETURN_TO_PRINT_DELAY_MS = 2500;

// Undo the letter-spacing stripAnsi leaves on shimmer-animated TUI lines
// ("L o g i n   s u c c e s s f u l .") for display. Only rewrites lines that
// are mostly single-character tokens; normal prose is untouched. Runs of 2+
// spaces are word gaps, single spaces are letter gaps.
function despaceTuiLine(line) {
  const trimmed = String(line || '').trim();
  const toks = trimmed.split(/\s+/);
  if (toks.length < 6) return trimmed;
  const singles = toks.filter(t => t.length === 1).length;
  if (singles / toks.length <= 0.6) return trimmed;
  return trimmed.split(/ {2,}/).map(word => word.replace(/ /g, '')).join(' ');
}

// --- Structured Question Handling ---

function parseAskUserQuestion(input) {
  // Handle structured questions JSON
  if (input.questions && Array.isArray(input.questions)) {
    return { questions: input.questions };
  }

  // Try parsing the question field as JSON
  const questionText = input.question || input.text || '';
  try {
    const parsed = JSON.parse(questionText);
    if (parsed.questions && Array.isArray(parsed.questions)) {
      return { questions: parsed.questions };
    }
  } catch {}

  // Simple text question
  return {
    questions: [{
      question: questionText || JSON.stringify(input),
      header: null,
      options: [],
      multiSelect: false,
    }]
  };
}

function formatQuestion(q, index, total) {
  let msg = '';
  const prefix = total > 1 ? `--- Question ${index + 1}/${total} ---` : '--- Question ---';

  if (q.header) {
    msg += `${prefix} — ${q.header}\n\n`;
  } else {
    msg += `${prefix}\n\n`;
  }

  msg += q.question + '\n';

  if (q.options && q.options.length > 0) {
    // Blank line before each option for separation; ⭐ marks a "(Recommended)" label.
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i); // A, B, C...
      const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt.label ?? opt);
      const desc = opt.description || '';
      const marker = /\(recommended\)/i.test(label) ? '⭐ ' : '';
      msg += `\n${marker}${letter}. ${label}\n`;
      if (desc) {
        msg += `   ${desc}\n`;
      }
    });
    msg += `\nReply with a letter (A, B, C…) or number (1, 2, 3…), or type a custom answer.`;
  }

  return msg;
}

function formatQuestionHtml(q, index, total) {
  // Matrix custom HTML (org.matrix.custom.html) collapses raw "\n" to a single
  // space, so options separated only by newlines render as a run-on wall in
  // Element/matron-web. Use explicit <br> for line breaks and a blank line
  // (double <br>) between options so A/B/C are visually separated. An option
  // whose label is tagged "(Recommended)" gets a ⭐ marker.
  let msg = '';
  const prefix = total > 1 ? `❓ Question ${index + 1}/${total}` : '❓';

  if (q.header) {
    msg += `${prefix} — <b>${escapeHtml(q.header)}</b><br><br>`;
  } else {
    msg += `${prefix}<br><br>`;
  }

  msg += escapeHtml(q.question);

  if (q.options && q.options.length > 0) {
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt.label ?? opt);
      const desc = opt.description || '';
      const marker = /\(recommended\)/i.test(label) ? '⭐ ' : '';
      msg += `<br><br>${marker}<b>${letter}.</b> ${escapeHtml(label)}`;
      if (desc) {
        msg += `<br><i>${escapeHtml(desc)}</i>`;
      }
    });
    msg += `<br><br>Reply with a letter (A, B, C…) or number (1, 2, 3…), or type a custom answer.`;
  }

  return msg;
}

function sendAllQuestions(session) {
  const questions = session.pendingQuestions;
  if (!questions || questions.length === 0) return;

  const total = questions.length;

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    const plainText = formatQuestion(q, i, total);
    const html = formatQuestionHtml(q, i, total);

    if (q.options && q.options.length > 0 && session.sendButtonMessage) {
      // Build button array from options
      const buttons = q.options.map((opt, idx) => {
        const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt);
        const letter = String.fromCharCode(65 + idx);
        return {
          id: `opt_${letter.toLowerCase()}`,
          label: label,
          value: label,
        };
      });

      const prefix = total > 1 ? `Question ${i + 1}/${total}` : '';
      const prompt = prefix
        ? (q.header ? `${prefix} — ${q.header}\n\n${q.question}` : `${prefix}\n\n${q.question}`)
        : (q.header ? `${q.header}\n\n${q.question}` : q.question);

      const mode = q.multiSelect ? 'pick_many' : 'pick_one';
      console.log(`[BUTTONS] sendAllQuestions: q.multiSelect=${q.multiSelect}, mode=${mode}`);
      session.sendButtonMessage(prompt, buttons, mode, plainText, html);
    } else if (session.sendHtml) {
      session.sendHtml(plainText, html);
    } else if (session.sendCallback) {
      session.sendCallback(plainText);
    }
  }
}

// mirrorToJournal defaults true (Matrix path). The journal input consumer
// passes false when the answer arrived as a journal prompt_reply or plain
// text event — the journal already has the user's own row for it (the
// prompt_reply payload, or the text `send` row), so mirroring again here
// would duplicate it.
function submitAnswer(session, answerText, { mirrorToJournal = true } = {}) {
  const mode = session.waitingForAnswer;
  session.waitingForAnswer = null;
  session.pendingQuestions = null;
  session.currentQuestionIndex = 0;
  session.questionAnswers = [];

  if (mode === 'text-reply') {
    // AskUserQuestion was auto-rejected — send the answer as a regular user message
    sendTextToSession(session, answerText, { skipJournalMirror: !mirrorToJournal });
  } else {
    // Normal tool_result flow. This path only applies to print-mode stream-
    // json input. In iv-mode, user questions are surfaced and answered via the
    // PromptDetector → buttons/text path (handleInteractivePrompt +
    // respondToPrompt), so this tool_result branch is unreachable there. Log if
    // it ever fires under iv-mode so we notice an unexpected code path.
    if (session.iv) {
      debug('iv-mode: skipping legacy tool_result stdin.write (ask-user MCP should handle this).');
      return;
    }
    session.busy = true;
    inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId);
    journalSessionState(session, 'running');
    journalActivity(session, 'thinking');
    const jsonMsg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: mode,
          type: 'tool_result',
          content: answerText,
        }]
      }
    }) + '\n';
    debug('Sending answer to stdin:', jsonMsg.trim());
    writePromptAnswer(session, jsonMsg, {
      // This answer goes in via a raw tool_result stdin write (not
      // sendToSession), so record it only after stdin accepts the chunk.
      onDelivered: () => {
        recordUserAnswer(session, answerText, { mirrorToJournal });
        if (session.resetTimeout) session.resetTimeout();
      },
      onError: (error) => reportSessionSendFailure(
        session,
        `Could not send the prompt answer to Claude: ${error.message}`,
        { restoreJournalState: true },
      ),
    });
  }
}

function resolveQuestionAnswer(session, text) {
  const q = session.pendingQuestions[session.currentQuestionIndex];
  const trimmed = text.trim();

  if (q.options && q.options.length > 0) {
    // Try letter (A, B, C...)
    const upper = trimmed.toUpperCase();
    if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
      const idx = upper.charCodeAt(0) - 65;
      if (idx < q.options.length) {
        const opt = q.options[idx];
        return typeof opt.label === 'string' ? opt.label : String(opt);
      }
    }

    // Try number (1, 2, 3...)
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= q.options.length) {
      const opt = q.options[num - 1];
      return typeof opt.label === 'string' ? opt.label : String(opt);
    }
  }

  // Custom text answer
  return trimmed;
}

// --- Claude Event Handler ---

// Construct + wire a session's subagent watcher and its child-convo tracker.
// The tracker publishes each discovered subagent as its own child conversation
// (parent_convo_id = this session's convo) and routes the subagent's output
// there; getParentConvoId resolves lazily so agent-switching (which changes
// journalConvoId) is followed. Called from every spawn path (print eager,
// iv-mode, and the lazy print-mode construction in handleClaudeEvent).
function setupSubagentWatcher(session, workdir, sessionId) {
  setupCodexWatcherForSession(session, workdir, sessionId, {
    publisher: journalPublisher,
    liveSessions: sessions,
    // Evaluate the activation guard against the session's env (shim on PATH),
    // not the bridge's — the deployed producer lives on the session PATH.
    watcherDependencies: { env: session.codexSpawnEnv || process.env },
  });
  session.subagentConvos = createSubagentConvoTracker({
    publisher: journalPublisher,
    getParentConvoId: () => journalConvoIdFor(session),
    runningStore: subagentRunningStore,
    log: console,
  });
  session.subagentWatcher = new SubagentWatcher({ workdir, sessionId });
  session.subagentWatcher.on('subagent-start', payload => handleSubagentStart(session, payload));
  session.subagentWatcher.on('subagent-event', payload => handleSubagentEvent(session, payload));
  session.subagentWatcher.snapshot();
}

// Stop a session's subagent watcher and settle its children. finishAll marks
// any still-running child 'done' (the "transcript closes" completion signal and
// the catch-all for a subagent whose Task tool_result was never paired) before
// the tracker is dropped.
function teardownSubagentTracking(session) {
  if (session.codexWatcher) {
    session.codexWatcher.stop().catch(() => {});
    session.codexWatcher = null;
  }
  // #632: reclaim this session's codex-viz sink dir on teardown. The sink lives
  // outside Claude Code's pruned project tree, so without this it lingers until
  // the boot-time age-based sweep (pruneStaleCodexSinks, still the backstop).
  // Guard on the same viz env gate that created the sink + wired the watcher
  // (the watcher-dependency env source), so we never rm on a session that never
  // ran viz. Best-effort — removeCodexSinkForSession never throws.
  const vizEnv = session.codexSpawnEnv || process.env;
  if (vizEnv.MATRON_CODEX_VIZ === '1' && session.claudeSessionId) {
    removeCodexSinkForSession(session.claudeSessionId);
  }
  if (session.subagentConvos) {
    session.subagentConvos.finishAll();
    session.subagentConvos = null;
  }
  if (session.subagentWatcher) {
    session.subagentWatcher.stop().catch(() => {});
    session.subagentWatcher = null;
  }
}

// Reconcile stranded `running` subagent child convos. A child is a
// ghost when it is persisted `running` (subagentRunningStore) but no LIVE
// session currently owns its parent convo — i.e. the parent is TERMINAL: the
// bridge restarted and the parent's claude process died with the old bridge, or
// the parent stream was lost. At startup the live `sessions` map is empty, so
// every persisted running child reconciles; on a transient WS reconnect only
// genuinely orphaned children do (a still-live coordinator parent keeps its
// children running — see selectStrandedChildren).
//
// Reconciles purely from PERSISTED state, never from watcher re-discovery:
// subagent-watcher.snapshot() marks the already-complete agent-*.jsonl "seen",
// so completed children are never re-found and finish() never re-fires. The
// published frame (convo_upsert, session_state: done) is byte-identical to the
// live finish() transition, so web clients update the card the same way; here it
// rides upsertConvoBestEffort, the established reconnect-repair fan-out path.
function reconcileStrandedSubagents(reason = 'startup') {
  if (!JOURNAL_ENABLED) return;
  let entries;
  try {
    entries = subagentRunningStore.list();
  } catch (e) {
    console.warn(`[subagent-reconcile] list failed: ${e.message}`);
    return;
  }
  if (!entries.length) return;

  // Parent convo ids currently owned by a live session — do NOT retire their
  // children (a coordinator parent legitimately stays running).
  const liveParents = new Set();
  for (const session of sessions.values()) {
    if (!session?.alive) continue;
    const convoId = journalConvoIdFor(session);
    if (convoId) liveParents.add(convoId);
  }

  const { stranded, malformed } = selectStrandedChildren(entries, liveParents);
  // Join each stranded id back to its persisted entry so the repair frame can
  // carry the child's parentConvoId. Reconcile runs precisely when the original
  // `running` upsert may never have been delivered (SIGKILL before flush, socket
  // down at mint, queue-overflow eviction) — so the journal row may not exist
  // yet. `convo_upsert` on an unknown id INSERTs, and parent_convo_id is written
  // ONLY in the INSERT branch (immutable thereafter): omitting it here would mint
  // a permanent untitled ROOT orphan that loses the child push exemption and is
  // un-relinkable. selectStrandedChildren already validated provenance, so every
  // stranded id has a joinable entry with a parentConvoId. Safe in the normal
  // (row-exists) case too: the journal's UPDATE path never rewrites parentage.
  const repairFrames = strandedRepairFrames(entries, stranded);
  let published = 0;
  for (const { childConvoId, parentConvoId } of repairFrames) {
    try {
      // Publish `done` and drop the store record ONLY on confirmed delivery
      // a capacity-rejected best-effort send or a
      // crash before the socket flushes must leave the record in place so the
      // next startup/reconnect reconcile retries — never erase the write-ahead
      // record on an unconfirmed send. Re-publishing `done` is idempotent
      // server-side.
      journalPublisher.upsertConvoBestEffort(
        childConvoId,
        { sessionState: 'done', parentConvoId },
        { onDelivered: () => subagentRunningStore.remove(childConvoId) },
      );
      published += 1;
    } catch (e) {
      console.warn(`[subagent-reconcile] failed for ${childConvoId}: ${e.message}`);
    }
  }
  if (published) {
    console.log(`[subagent-reconcile] ${reason}: publishing done for ${published} stranded subagent child convo(s)`);
  }
  if (malformed.length) {
    // Fail-closed: records with no validated parent provenance are
    // left running rather than terminally mutated. Surface them — they only
    // arise from corruption / schema drift and warrant inspection.
    console.warn(`[subagent-reconcile] ${reason}: ${malformed.length} malformed running record(s) with no parent convo — left untouched: ${malformed.join(', ')}`);
  }
}

// Watcher discovery: publish the child convo (running, linked to the parent,
// titled from the sidecar meta) the instant the subagent's transcript appears,
// even before it emits any event.
function handleSubagentStart(session, { agentId, label, agentType }) {
  if (!session || !session.subagentConvos) return;
  session.subagentConvos.discover(agentId, { label, agentType });
}

function handleSubagentEvent(session, { agentId, label, agentType, event }) {
  if (!session || !session.alive) return;
  if (!event || !event.message) return;
  const content = event.message.content;
  if (!Array.isArray(content)) return;
  if (!session.subagentConvos) return;

  // Ensure the child convo exists, refresh its title, and publish the
  // per-subagent status (model/context from THIS subagent's own event). The
  // returned child carries the convo id every publish below routes to.
  const child = session.subagentConvos.onEvent(agentId, { label, agentType, event });
  if (!child) return;
  const convoId = child.convoId;

  if (event.type === 'assistant') {
    // Subagent transcripts write each reasoning message as its own event with
    // its own messageId; we post all of them (see the on-disk note in
    // lib/subagent-watcher.js) — short subagents sometimes never emit end_turn.
    const textParts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
    if (textParts.length > 0) {
      const text = textParts.join('').trim();
      const isFiller = textParts.length === 1 && /^\s*No response requested\.?\s*$/.test(textParts[0]);
      if (text && !isFiller) {
        // Route to the child convo, no 🔀[label] prefix (spec PR B: drop the
        // parent-prefixed path). splitMessage keeps a long dump under the cap.
        for (const chunk of splitMessage(text)) {
          journalPublisher.publishText(convoId, { body: chunk, from: 'assistant' });
        }
        session.lastActivityAt = Date.now();
      }
    }

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      // A subagent spawning its own subagent: trigger another discovery burst
      // so the nested agent-<id>.jsonl gets a tail. nested:true keeps this
      // Task's id OUT of the parent FIFO — its tool_result lands in this
      // subagent's transcript, never the parent stream, so pairing it would
      // only skew siblings' task_refs and done-marking (see subagent-convos).
      // One-level watcher architecture — the nested agent attaches as a
      // direct child of this parent session (see the PR notes on nesting).
      if ((block.name === 'Task' || block.name === 'Agent') && session.subagentWatcher) {
        session.subagentConvos.noteTaskStarted(block.id, { nested: true });
        session.subagentWatcher.notifyTaskStarted();
      }
      if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit')
          && block.input?.file_path) {
        publishEditDiffToConvo(session, convoId, block.name, block.input);
        session.lastActivityAt = Date.now();
        continue;
      }
      const body = formatSubagentToolBody(block.name, block.input || {});
      if (!body) continue;
      journalPublisher.publishText(convoId, { body, from: 'assistant' });
      session.lastActivityAt = Date.now();
    }
  }
}

function handleClaudeEvent(session, event) {
  // Progress touch for restart carry-on. This is the single per-event entry
  // point for BOTH print mode (stdout stream-json) and iv mode (iv.on('event')
  // → here), so it is where "the turn is still making progress" is known.
  // Before the sidechain guard on purpose: a subagent's events are still this
  // turn working. The store debounces to once a minute and no-ops when no
  // marker exists, so this is cheap on every event.
  inflightMarker.touch(journalConvoIdFor(session));

  // A subagent's event riding the parent's stdout (parent_tool_use_id /
  // isSidechain) is NOT the parent's: its text/tool_use/tool_result belong to
  // the child conversation, and the subagent watcher already routes them
  // there from the agent transcript (handleSubagentEvent). Letting them
  // through here published every subagent narration into the parent convo as
  // regular assistant text (2026-07-15 live dupe), pushed subagent tool
  // indicators/diffs at the parent, and let a subagent's own Task tool_use
  // pollute the parent FIFO. Skip them wholesale — the model/context guards
  // that used to be the only defense (modelFromEvent,
  // contextTokensFromAssistantEvent) stay as belt-and-braces.
  if (isSidechainEvent(event)) return;

  // Capture the current model from any event that carries message.model.
  // This is the reliable source in iv-mode, where the system/init event (and
  // thus session.initData.model) never arrives. Reconcile widen-only: the bare
  // API id (`claude-opus-4-8`) must not overwrite a launch model whose `[1m]`
  // marker set a 1m window, or the context gauge silently narrows to /200k.
  const capturedModel = modelFromEvent(event);
  if (capturedModel) session.currentModel = reconcileModelForWindow(session.currentModel, capturedModel);

  // Capture session ID from any event that carries it. Claude sessions
  // pre-assign their id at spawn (planSessionIdentity), so for them this is
  // a defensive fallback; it still does real work for sessions whose id is
  // only learned from the stream.
  if (event.session_id && !session.claudeSessionId) {
    session.claudeSessionId = event.session_id;
    if (!session.journalConvoId) session.journalConvoId = event.session_id;
    persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId);
    console.log(`Captured session ID for room ${session.roomId}: ${session.claudeSessionId}`);
    journalFlushForSession(session);
  }
  // #136 / PR #151: mark the native session confirmed the first time an event
  // proves the transcript exists on disk. NOT any session_id event: `system`
  // events (init, hook_started/hook_response) fire at spawn BEFORE Claude has
  // written anything — confirming off those let a zero-turn chat pass the
  // mode-switch gate and /logout crash-looped on `claude --resume` of a
  // transcript that was never written. Only turn-bearing events count (see
  // eventConfirmsSession). A session that never runs a turn stays
  // unconfirmed, so restarts respawn it with --session-id (same id, fresh)
  // instead of --resume.
  if (eventConfirmsSession(event)) session._sessionConfirmed = true;

  // Lazy-construct subagent watcher once we know the session id. All claude
  // spawn paths pre-assign the id and build the watcher eagerly now, so this
  // is a safety net for any session whose id arrived late. Decoupled from
  // the id-capture block above so future refactors can't silently lose the
  // watcher on either spawn path.
  if (session.claudeSessionId && !session.subagentWatcher) {
    setupSubagentWatcher(session, session.workdir, session.claudeSessionId);
  }

  // Re-home the subagent watcher when the session changes cwd mid-flight
  // (EnterWorktree). Claude relocates the subagents dir to the new cwd's
  // project-dir encoding, so a watcher frozen on the spawn cwd polls a stale
  // path and subagent cards stop rendering (loop #631). Stream events carry the
  // live per-entry cwd; track the last one seen so we only act on a real move,
  // then let the watcher re-point (a no-op when the encoded dir is unchanged).
  if (session.subagentWatcher && typeof event.cwd === 'string' && event.cwd
      && event.cwd !== session._lastWatcherCwd) {
    session._lastWatcherCwd = event.cwd;
    if (session.subagentWatcher.repoint(event.cwd)) {
      console.log(`[subagent-rehome] room ${session.roomId}: session ${String(session.claudeSessionId).slice(0, 8)}… moved to ${event.cwd}; re-pointed subagent watcher`);
    }
  }

  // Log all event types for plan mode debugging
  if (event.type) {
    const extras = [];
    if (event.permission_denials?.length) extras.push(`denials=${JSON.stringify(event.permission_denials)}`);
    if (event.subtype) extras.push(`subtype=${event.subtype}`);
    debug(`[PLAN-DEBUG] Event type=${event.type}${extras.length ? ' | ' + extras.join(' | ') : ''}`);
  }

  switch (event.type) {
    case 'assistant': {
      // Track the context gauge from each parent assistant event's usage —
      // the last one standing when the turn ends is the final request's
      // footprint, which is what the header should show. The result event's
      // own usage is deliberately NOT used: it's cumulative across all the
      // turn's API calls (see lib/session-status.js), which is how the gauge
      // once read 2m/1m.
      const assistantCtxTokens = contextTokensFromAssistantEvent(event);
      if (assistantCtxTokens) {
        session._lastContextTokens = assistantCtxTokens;
        // Live header: repaint mid-turn so a long tool-heavy turn doesn't
        // leave the gauge stale until its result event — wall-clock
        // throttled (see statusRepaintDue) because assistant events can
        // arrive in bursts. Serves BOTH modes: iv transcript events route
        // through this same handler.
        if (statusRepaintDue(session._statusPublishedAt, Date.now())) journalStatus(session);
      }

      const content = event.message?.content;
      if (!Array.isArray(content)) break;

      const isPartial = event.message?.stop_reason === null;
      const messageId = event.message?.id;

      const textParts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
      // Suppress claude's "No response requested." filler. It's emitted in
      // response to internal synthetic prompts (e.g. resume-time nudges)
      // and is just noise on Matrix. Suppress only the text — fall
      // through to the tool_use loop below so any concurrent tool calls
      // (Task/AskUserQuestion/etc.) still get handled.
      const isFiller = textParts.length === 1 && /^\s*No response requested\.?\s*$/.test(textParts[0]);
      if (isFiller) {
        debug('Suppressing "No response requested." filler');
      }

      if (!isFiller && textParts.length > 0) {
        if (isPartial && messageId && session._lastAssistantMsgId === messageId) {
          session.responseBuffer = textParts.join('');
        } else if (!isPartial && messageId && session._lastAssistantMsgId === messageId) {
          session.responseBuffer = textParts.join('');
        } else {
          if (session.responseBuffer.trim() && !session.waitingForAnswer) {
            flushResponse(session);
          }
          session.responseBuffer = session.waitingForAnswer ? '' : textParts.join('');
        }
        session._lastAssistantMsgId = messageId;

        // Stream in-progress assistant text to viewing Matron clients. Only on
        // isPartial (stop_reason === null): those are the growing-text deltas
        // print-mode emits under --include-partial-messages. iv-mode reads
        // complete messages from the on-disk transcript (no partials), so it
        // simply gets the durable final message with no overlay — the "they
        // differ" the brief notes, handled by this gate. Gated on a present
        // messageId so the overlay keys stably per message. responseBuffer is
        // the full cumulative text (replace_text, latest-wins). The final
        // message is retired by the durable publish carrying this ref (see
        // flushResponse -> sendToRoom), so no stream frame is sent on complete.
        if (isPartial && messageId) {
          journalStream(session, messageId, session.responseBuffer);
        }

        // iv-mode: flush this assistant chunk NOW rather than waiting for
        // /turn-end. Two reasons: (1) the Stop hook races the transcript
        // flush so onTurnEnd is unreliable as a flush trigger; (2) claude
        // emits intermediate commentary with stop_reason=tool_use while
        // chaining tool calls — those messages would otherwise sit in the
        // buffer forever, giving the user a stuck "typing…" indicator and
        // no visible progress. Print-mode keeps its existing accumulate-
        // and-flush-on-result flow.
        if (session.iv && !isPartial && session.responseBuffer.trim() && !session.waitingForAnswer) {
          // If this assistant text is the prose we already surfaced as a
          // preamble (before an AskUserQuestion), drop the post-answer
          // duplicate instead of flushing it again. Only fires for a complete
          // pre-answer capture (see handleInteractivePrompt).
          const matchesPreamble = session._suppressPreambleText &&
            preambleMatchesText(session._suppressPreambleText, session.responseBuffer);
          // Either way, retire the suppression flag after this first post-set
          // assistant flush — it's either the duplicate (drop it) or proof the
          // duplicate isn't coming (don't leave it armed into later turns).
          if (session._suppressPreambleText) {
            session._suppressPreambleText = null;
            if (session.suppressPreambleTimer) { clearTimeout(session.suppressPreambleTimer); session.suppressPreambleTimer = null; }
          }
          if (matchesPreamble) {
            debug('Suppressing post-answer duplicate of surfaced preamble');
            session.responseBuffer = '';
          } else {
            flushResponse(session);
          }
          // Clear the prompt detector buffer after flushing an assistant
          // response so numbered lists in the response text don't trigger
          // false-positive prompt detections during the post-response idle.
          session.iv.detector.reset();
        }
      }

      for (const block of content) {
        if (block.type !== 'tool_use') continue;

        if (session.responseBuffer.trim() && !session.waitingForAnswer) {
          flushResponse(session);
        }

        const toolName = block.name;
        const input = block.input || {};

        // Activity-based repo signal for journal titles: which repo this session
        // is actually working in (edits win over reads). The cwd is useless here
        // — cross-repo work is rooted in son-of-anton and reaches siblings by
        // path — so we infer from tool file paths. STAGE the signal here keyed
        // by tool_use id; it is committed only once the tool_result confirms
        // success (see the 'user' case), so a denied or failed Edit never counts
        // as activity (F2). Bounded so denials/orphans that never produce a
        // result cannot grow the map without limit.
        const repoSignals = toolRepoSignals(toolName, input, DEFAULT_WORKDIR);
        if (repoSignals.length && block.id) {
          if (!session._pendingRepoSignals) session._pendingRepoSignals = new Map();
          const pending = session._pendingRepoSignals;
          pending.set(block.id, repoSignals);
          while (pending.size > MAX_PENDING_REPO_SIGNALS) {
            pending.delete(pending.keys().next().value);
          }
        }

        if (toolName === 'ExitPlanMode' && !session.iv) {
          // Print-mode only: stash the tool_use_id so a "build" reply can
          // emit the matching tool_result later. iv-mode handles approval
          // through claude's own TUI confirmation prompt instead.
          debug(`[PLAN-DEBUG] Tool call: ExitPlanMode | block.id: ${block.id} | input keys: ${Object.keys(input).join(',')}`);
          session.pendingPlanDenialId = block.id;
          if (session.claudeSessionId) {
            persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: block.id });
          }
        }
        if (toolName === 'EnterPlanMode') {
          debug(`[PLAN-DEBUG] Tool call: EnterPlanMode | block.id: ${block.id}`);
        }

        if (toolName === 'AskUserQuestion') {
          debug(`AskUserQuestion tool_use block.id=${block.id}, waitingForAnswer=${session.waitingForAnswer}, input keys=${Object.keys(input).join(',')}`);
          // iv-mode: the AskUserQuestion menu renders in the TUI and is surfaced
          // + answered via the PromptDetector path (handleInteractivePrompt +
          // respondToPrompt keystrokes). Surfacing it again here as buttons
          // would duplicate the prompt, and the button answer would route via
          // sendTextToSession (a regular message), which can't drive the open
          // menu. So this transcript→buttons path is print-mode only — matching
          // the sibling tool_result flow (see resolveQuestionAnswer).
          if (session.iv) { debug('iv-mode: AskUserQuestion owned by PTY detector'); continue; }
          if (session.waitingForAnswer) { debug('Skipping AskUserQuestion — already waiting'); continue; }

          const parsed = parseAskUserQuestion(input);
          if (!parsed.questions.length || !parsed.questions[0].question) continue;

          session.responseBuffer = '';

          session.waitingForAnswer = 'text-reply';
          session.pendingQuestions = parsed.questions;
          session.currentQuestionIndex = 0;
          session.questionAnswers = [];

          if (session.sendCallback) {
            sendAllQuestions(session);
          }
        } else {
          // Collect tool indicator
          let indicator = `🔧 ${toolName}`;
          let indicatorHtml = null;
          let isKeyEvent = false;
          // Set when sendLiveOutputEvent has been invoked — the live-output
          // message already carries the command in its body/formatted_body
          // fallback, so we skip the duplicate `🔧 <cmd>` indicator below.
          let liveOutputSent = false;

          if (toolName === 'Bash' && input.command) {
            // Claude Code's `tool_use` event reports the ORIGINAL command, not
            // the matron-tee-rewritten one (the rewrite is visible only in the
            // later `system.task_started` event). So we don't try to parse the
            // marker out of input.command — instead we predict the log path
            // deterministically from `block.id`, which matches what the hook
            // writes (`/tmp/matron-cmd-<tool_use_id>.log`). If MATRON_BASH_TEE
            // was disabled at spawn, the file won't exist and the viewer will
            // show its "Output expired" / WS-failed state.
            const displayCommand = input.command;
            const liveToolUseId = block.id;
            const liveLogPath = `/tmp/matron-cmd-${liveToolUseId}.log`;

            const cmd = displayCommand.length > 100
              ? displayCommand.slice(0, 100) + '…'
              : displayCommand;
            indicator = `🔧 \`${cmd}\``;
            indicatorHtml = `🔧 <code>${escapeHtml(cmd)}</code>`;
            isKeyEvent = true;

            if (session.showBashOutput) {
              liveOutputStore.register(liveToolUseId, {
                logPath: liveLogPath,
                roomId: session.roomId,
              });
              // Live output rides the journal protocol: one pump per running
              // command tails the tee log and feeds stream_append ephemerals
              // (spec §9). Same skip-if-no-session-id rule as journalActivity:
              // ephemerals replayed late would be stale, so a session whose
              // claudeSessionId isn't known yet just doesn't stream.
              const journalConvoId = journalConvoIdFor(session);
              if (JOURNAL_ENABLED && journalConvoId) {
                // Cap once here so a pathological (~1 MiB) command can't blow
                // past the server's 1 MiB WS payload cap in the offset-0
                // frame's meta; the server truncates meta at 2000 chars
                // itself, so this changes nothing semantically. Matrix-event
                // and display uses keep the untruncated displayCommand.
                const streamCommand = String(displayCommand).slice(0, 2000);
                const pump = createToolStreamPump({
                  logPath: liveLogPath,
                  convoId: journalConvoId,
                  messageRef: liveToolUseId,
                  meta: { tool: 'Bash', command: streamCommand },
                  streamAppend: (c, r, off, chunk, meta) =>
                    journalPublisher.streamAppend(c, r, off, chunk, meta),
                });
                const streamRegKey = toolStreamKey(journalConvoId, liveToolUseId);
                // Stop (never finalize — same message_ref, a finalize would
                // collide) any prior pump still registered under this exact
                // key before overwriting the Map entry: Map.set silently
                // replaces without touching what was there before, so an
                // unstopped prior pump would leak its fs.watch handle
                // forever (never reachable again to stop() it).
                toolStreamPumps.get(streamRegKey)?.pump.stop();
                toolStreamPumps.set(streamRegKey, {
                  pump,
                  session,
                  convoId: journalConvoId,
                  command: streamCommand,
                  logPath: liveLogPath,
                  messageRef: liveToolUseId,
                });
                pump.start();
              }
              // Optimistically suppress the synchronous indicator post below;
              // sendLiveOutputEvent (journal-only now — Task 3) always
              // resolves true once it's published the tool activity, so this
              // fallback is effectively dead unless a future failure path is
              // added there, kept as the safety net it always was.
              const fallbackPlain = indicator;
              const fallbackHtml = indicatorHtml;
              sendLiveOutputEvent(session, {
                tool_use_id: liveToolUseId,
                command: displayCommand,
              }).then(ok => {
                if (ok) return;
                if (session.sendHtml && fallbackHtml) {
                  session.sendHtml(fallbackPlain, fallbackHtml);
                } else if (session.sendCallback) {
                  session.sendCallback(fallbackPlain);
                }
              });
              liveOutputSent = true;
            }
          } else if (toolName === 'Read' && input.file_path) {
            indicator = `📖 ${input.file_path}`;
            indicatorHtml = `📖 <code>${escapeHtml(input.file_path)}</code>`;
          } else if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit')
                     && input.file_path) {
            // Journal-only (Dan, 2026-07-14): a structured `diff` event
            // replaces the old "✏️ Editing [path](link)" room message —
            // isKeyEvent stays false, so nothing posts to Matrix and
            // nothing mirrors into the journal as text. session.toolCalls
            // below still gets this plain line for the turn summary.
            const verb = toolName === 'Write' ? 'Writing' : 'Editing';
            indicator = `✏️ ${verb} ${input.file_path}`;
            publishEditDiff(session, toolName, input, null);
          } else if ((toolName === 'Glob' || toolName === 'Grep') && input.pattern) {
            indicator = `🔍 ${input.pattern}`;
            indicatorHtml = `🔍 <code>${escapeHtml(input.pattern)}</code>`;
          } else if (toolName === 'WebSearch' && input.query) {
            indicator = `🌐 ${input.query}`;
            indicatorHtml = `🌐 <i>${escapeHtml(input.query)}</i>`;
            isKeyEvent = true;
          } else if (toolName === 'WebFetch' && input.url) {
            indicator = `🌐 ${input.url}`;
            indicatorHtml = `🌐 <a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a>`;
          } else if (toolName === 'Task' || toolName === 'Agent') {
            const desc = (input.description || input.prompt || '').slice(0, 80);
            indicator = `🔀 Subtask: ${desc}`;
            indicatorHtml = `🔀 Subtask: <i>${escapeHtml(desc)}</i>`;
            isKeyEvent = true;
            // Trigger the subagent watcher's discovery burst — the new
            // agent-<id>.jsonl file appears within ~100ms of this event — and
            // remember this Task's tool_use_id so the child it spawns can carry
            // it as task_ref (links the parent's Task card to the child convo).
            if (session.subagentWatcher) {
              session.subagentConvos?.noteTaskStarted(block.id);
              session.subagentWatcher.notifyTaskStarted();
            }
          } else if (toolName === 'TodoWrite') {
            const todos = (input.todos || []).map(t => {
              const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
              return `${icon} ${t.content || t.text || ''}`;
            }).join('\n');
            indicator = `📋 Todos:\n${todos}`;
            const todosHtml = (input.todos || []).map(t => {
              const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
              return `<li>${icon} ${escapeHtml(t.content || t.text || '')}</li>`;
            }).join('');
            indicatorHtml = `📋 <b>Todos:</b><ul>${todosHtml}</ul>`;
            isKeyEvent = true;
          }

          // When sendLiveOutputEvent already posted a Matrix message for
          // this Bash call, skip the regular `🔧 <command>` indicator —
          // the live-output message contains the same command in its
          // fallback body/formatted_body, so non-matron-web clients still
          // see it, and matron-web clients see the rendered viewer tile.
          if (!liveOutputSent) {
            session.toolCalls.push(indicator);
            if (isKeyEvent && session.sendHtml && indicatorHtml) {
              session.sendHtml(indicator, indicatorHtml);
            } else if (isKeyEvent && session.sendCallback) {
              session.sendCallback(indicator);
            }
          }
        }
      }
      break;
    }

    case 'result': {
      // Handle fatal errors (e.g. failed resume with invalid session ID)
      // first, regardless of mode — iv-mode resumes can also fail and need
      // the crash-restart loop short-circuited (otherwise the exit handler
      // would retry the same invalid session up to 3 times).
      if (event.is_error && event.errors?.length) {
        const noSession = event.errors.some(e => /no conversation found/i.test(e));
        if (noSession) {
          console.log(`Resume failed for room ${session.roomId}: session not found, clearing stale ID`);
          // Clear the marker BEFORE nulling claudeSessionId: journalConvoIdFor
          // falls back to claudeSessionId when journalConvoId is unset, so
          // doing this after the null below would resolve a different (or no)
          // convo id and strand the marker. Every resume path populates
          // journalConvoId today, so the ordering is currently belt-and-braces
          // — but it costs nothing to remove the dependency.
          // A failed resume produces no further agent output for this turn, and
          // the early break below skips the normal turn-end seam, so in print
          // mode nothing else would ever clear this. Leaving it would card a
          // conversation that is over, not interrupted.
          inflightMarker.noteTurnEnd(journalConvoIdFor(session));
          session.claudeSessionId = null;
          session._resumeFailed = true;
          // Clear only this provider's stale native ID. A switched
          // conversation may still have a valid session for the other
          // provider plus the shared transcript and stable journal ID.
          const data = loadPersistedSessions();
          const persisted = data[String(session.roomId)];
          if (persisted?.agentSessions) {
            persisted.sessionId = null;
            persisted.agentSessions = mergeAgentStates(persisted.agentSessions, {
              [session.agent]: { sessionId: null, historyCursor: 0, lastUsed: Date.now() },
            });
            data[String(session.roomId)] = persisted;
          } else {
            delete data[String(session.roomId)];
          }
          savePersistedSessions(data);
          if (session.sendCallback) {
            session.sendCallback('Previous native session not found (expired or deleted). The next message will start this agent fresh; /switch can still return to the other agent.');
          }
          // Reset busy/typing so the session isn't stuck if claude exits 0
          // without our normal result-handling path running. (The inflight
          // marker was already cleared above, before claudeSessionId was
          // nulled.)
          session.busy = false;
          clearPendingInterrupt(session);
          // This early break skips the normal turn-end seam below, so in
          // print mode a /restart parked mid-turn must fire here —
          // otherwise it would sit dormant (or fire surprisingly at the
          // end of some later turn) after the user was told it was
          // waiting. In iv mode, LEAVE the stash parked: this path can run
          // from the Stop hook's /turn-end transcript drain, and onTurnEnd
          // (the authoritative iv seam, which always follows) must find
          // the stash so it skips the queue flush — dispatching here would
          // clear it and let onTurnEnd type queued messages into the
          // session the in-flight restart is about to replace.
          if (!session.iv) dispatchDeferredCommand(session);
          break;
        }
      }
      // Past the error path: in iv-mode `onTurnEnd` is the authoritative
      // turn-end signal (fired by the Stop hook → /turn-end → onTurnEnd).
      // iv-mode transcripts don't emit result events in normal operation;
      // if one slips through it would double-count turnCount, re-flush
      // responseBuffer, re-post tool summaries, re-clear busy/typing, and
      // re-drain queued messages on top of what onTurnEnd already did.
      if (session.iv) {
        debug('Result event arrived for iv-mode session past error path — onTurnEnd handles turn-end; skipping duplicate work.');
        break;
      }

      // Accumulate usage stats
      session.turnCount++;
      const u = event.usage;
      if (u) {
        session.totalUsage.input_tokens += (u.input_tokens || 0);
        session.totalUsage.output_tokens += (u.output_tokens || 0);
        session.totalUsage.cache_read += (u.cache_read_input_tokens || 0);
        session.totalUsage.cache_create += (u.cache_creation_input_tokens || 0);
      }
      if (typeof event.total_cost_usd === 'number') {
        session.totalUsage.cost_usd = event.total_cost_usd;
      }

      // Header status for Matron clients: the context gauge was tracked from
      // this turn's assistant events (see case 'assistant' — result usage is
      // cumulative across the turn's API calls, so it must not feed the
      // gauge), limits from the shared cache. A stale cache also kicks off a
      // throttled background refresh; when it lands, repaint so the header
      // doesn't wait a whole turn for fresh numbers.
      journalStatus(session);
      const limitsRefresh = refreshUsageLimits(session.workdir || DEFAULT_WORKDIR);
      if (limitsRefresh) {
        limitsRefresh.then((updated) => {
          if (updated && session.alive) journalStatus(session);
        });
      }

      // Send collected tool calls as one message before the result (only if showWorking)
      if (session.toolCalls.length > 0 && session.showWorking && session.sendCallback) {
        const toolSummary = session.toolCalls.join('\n');
        const chunks = splitMessage(toolSummary);
        for (const chunk of chunks) {
          session.sendCallback(chunk);
        }
      }
      session.toolCalls = [];

      if (!session.waitingForAnswer) {
        const text = extractTextContent(event);
        if (text) {
          session.responseBuffer = text;
        }
        flushResponse(session);
      } else {
        session.responseBuffer = '';
      }
      // Retire any streaming overlay the flush above didn't (an interrupted or
      // text-less turn streamed partials but published no durable final
      // message) — no dangling overlay past turn-end. No-op on the normal path
      // (the durable publish already cleared the ref).
      journalStreamClear(session);
      session.busy = false;
      // Authoritative print-mode turn-end seam.
      inflightMarker.noteTurnEnd(journalConvoIdFor(session));
      clearPendingInterrupt(session);
      // Print-mode's turn-end (this `case 'result':` block is its equivalent
      // of iv-mode's session.onTurnEnd above) — same 'waiting' transition.
      journalSessionState(session, 'waiting');
      journalActivity(session, 'idle');
      maybeSummarizeAtTurnEnd(session);

      // Check for ExitPlanMode permission denial — present Build prompt
      const denials = event.permission_denials || [];
      debug(`[PLAN-DEBUG] Room ${session.roomId} | result event | denials: ${JSON.stringify(denials)} | pendingPlan: ${!!session.pendingPlan}`);
      const planDenial = denials.find(d => d.tool_name === 'ExitPlanMode');
      if (planDenial && session.sendCallback) {
        debug(`[PLAN-DEBUG] ExitPlanMode denial found! tool_use_id: ${planDenial.tool_use_id} | plan length: ${(planDenial.tool_input?.plan || '').length}`);
        const planText = planDenial.tool_input?.plan || '';
        session.pendingPlan = planText;
        session.pendingPlanDenialId = planDenial.tool_use_id;

        const planPreview = planText.length > 500
          ? planText.slice(0, 500) + '…'
          : planText;

        const plainPlan = `--- Plan Ready ---\n\n${planPreview}\n\nReply "build" to execute, or send feedback.`;
        if (session.sendHtml) {
          const htmlPlan =
            `<b>📋 Plan Ready</b><blockquote>${markdownToHtml(planPreview)}</blockquote>` +
            `Reply <code>build</code> to execute, or send feedback.`;
          session.sendHtml(plainPlan, htmlPlan);
        } else {
          session.sendCallback(plainPlan);
        }
      }

      // A /restart parked mid-turn fires now, INSTEAD of the queue flush —
      // the queue (and the roomId-keyed room-delivery inbox) carries into
      // the replacement session; see dispatchDeferredCommand.
      if (dispatchDeferredCommand(session)) break;
      // Send any queued messages now that Claude is free
      let queueDispatched = false;
      if (session.queuedMessages && session.queuedMessages.length > 0 && !session.waitingForAnswer) {
        queueDispatched = flushPendingSessionQueue(session) === true;
      }
      // Coalesced room updates go out AFTER Dan's queued input (turn-end
      // seam) — never on top of the turn that flush just dispatched (Task 6
      // review, C1), and never into an open prompt (the composite occupied
      // gate inside maybeFlushRoomDelivery, C2).
      if (!queueDispatched) maybeFlushRoomDelivery(session);

      break;
    }

    case 'system': {
      if (event.subtype === 'init') {
        session.initData = event;
        debug('Captured init data: model=%s, tools=%d, mcp=%d',
          event.model, event.tools?.length, event.mcp_servers?.length);
        // The spawn-time frame (journalSpawnStatus) omits the model when none
        // was explicitly chosen — init is the moment the CLI's actual model
        // becomes known, so repaint here rather than making the header wait
        // for the first turn end. Unthrottled: init fires once per spawn.
        journalStatus(session);
      } else if (event.subtype === 'compact' || event.subtype === 'context_compaction') {
        // Cooldown: don't send compaction messages more than once per 60s
        const now = Date.now();
        const COMPACT_COOLDOWN_MS = 60_000;
        if (!session.lastCompactCompleteNotify || (now - session.lastCompactCompleteNotify) > COMPACT_COOLDOWN_MS) {
          session.lastCompactCompleteNotify = now;
          if (session.sendHtml) {
            const n = notice('info', '🗜️ Context compacted — conversation history was summarized to free up space');
            session.sendHtml(n.plain, n.html);
          } else if (session.sendCallback) {
            session.sendCallback('🗜️ Context compacted — conversation history was summarized to free up space');
          }
        } else {
          debug('Suppressed compaction completion notice (cooldown, last=%dms ago)', now - session.lastCompactCompleteNotify);
        }
      } else if (event.subtype === 'task_started') {
        // Background spawn (Agent tool, run_in_background): the stream hands
        // us the explicit tool_use_id ↔ task_id pairing here — task_id is the
        // watcher's agentId (agent-<task_id>.jsonl). Register it so (a) the
        // FIFO ref can't mis-pair a sibling, (b) the instant launch
        // tool_result doesn't mark the child done, and (c) the child's
        // task_ref survives even when this event beats the watcher's
        // discovery. local_agent only — background Bash task_started events
        // carry no subagent and must not register phantom refs.
        if (event.task_type === 'local_agent' && event.tool_use_id && event.task_id) {
          session.subagentConvos?.noteBackgroundTaskStarted(event.tool_use_id, event.task_id);
          session.subagentWatcher?.notifyTaskStarted();
        }
      } else if (event.subtype === 'task_notification') {
        // A background task actually finished. For a subagent (Agent tool)
        // this — not the spawning tool_result, which fired at launch — is the
        // completion signal that flips the child convo to 'done'. finish() is
        // a no-op for task_ids that never had a child (background Bash).
        if (event.task_id) {
          session.subagentConvos?.noteTaskCompleted(event.task_id);
        }
        // Deliberately NOT surfaced in chat: the background task's tool_use
        // (Bash / Agent / Workflow) already renders as a tool-call panel in
        // every client, so a "✅ Task: <summary>" message is pure
        // duplication — and for background Bash the summary is the raw
        // matron-tee wrapper command, an enormous unreadable blob
        // (Dan, 2026-07-14). Claude narrates the outcome in its reply;
        // the transcript keeps the event for debugging.
        debug('task_notification suppressed (status=%s): %s',
          event.status, (event.summary || 'unknown').slice(0, 120));
      } else if (event.subtype === 'compact_boundary') {
        // Repaint the header gauge with the post-compact context size the
        // boundary carries — for both manual and auto triggers. Without
        // this, the status frame published at the compact turn's end reuses
        // _lastContextTokens from BEFORE the compaction (the compact run's
        // own result usage is all zeros), so the user compacts and still
        // sees the old near-full gauge.
        const postTokens = postCompactContextTokens(event);
        if (postTokens) {
          session._lastContextTokens = postTokens;
          journalStatus(session);
        }

        // Confirmation carries the fresh gauge when the boundary told us the
        // post-compact size — "compacted to what?" is the question the user
        // actually has (Dan, 2026-07-14).
        const gauge = contextGaugeText(postTokens, session.currentModel || session.initData?.model);
        const doneText = gauge
          ? `✅ Compacted — context now ${gauge}`
          : '✅ Done compacting — context summarized, ready for your next message.';

        // A manual `/compact` finishes here: the transcript writes a
        // compact_boundary marker but — unlike a normal turn — no Stop hook
        // fires, so onTurnEnd (the authoritative iv turn-end signal) never
        // runs and `busy` stays stuck true, wedging every later message into
        // the queue. When we know the operator kicked off this compaction
        // (flag set at /compact dispatch) and the boundary confirms a manual
        // trigger, treat it as the turn-end: clear busy and flush the queue
        // via onTurnEnd. Auto-compactions (trigger='auto') happen mid-turn
        // and MUST NOT clear busy here — their real Stop hook fires when the
        // interrupted turn completes.
        //
        // compactTriggerFrom reads both metadata spellings: print-mode
        // boundaries carry snake_case compact_metadata, and the previous
        // camelCase-only read left trigger undefined there (see
        // postCompactContextTokens).
        const trigger = compactTriggerFrom(event);
        if (session._operatorCompactPending && trigger === 'manual'
            && session.turnCount === session._operatorCompactPendingTurn) {
          session._operatorCompactPending = false;
          if (session._operatorCompactTimer) {
            clearTimeout(session._operatorCompactTimer);
            session._operatorCompactTimer = null;
          }
          const pendingNow = Date.now();
          session._lastManualCompactConfirm = pendingNow;
          session.lastCompactCompleteNotify = pendingNow;
          if (session.sendHtml) {
            const n = notice('success', doneText);
            session.sendHtml(n.plain, n.html);
          } else if (session.sendCallback) {
            session.sendCallback(doneText);
          }
          // onTurnEnd clears busy + typing and flushes any queued messages.
          // Print-mode sessions have no onTurnEnd (no PTY); clear busy directly.
          if (session.iv && typeof session.onTurnEnd === 'function') {
            session.onTurnEnd();
          } else {
            // Retire any still-open streaming overlay before clearing busy —
            // the same "no dangling overlay past turn-end" cleanup the normal
            // `result` turn-end (journalStreamClear above) and iv-mode's
            // onTurnEnd already do. A print-mode turn whose assistant text was
            // still streaming when a manual /compact landed would otherwise
            // leave the overlay open on viewing Matron clients until some later
            // unrelated event cleared it. No-op when nothing was streaming.
            journalStreamClear(session);
            session.busy = false;
            // This branch IS the turn-end for a print-mode session at a manual
            // compact boundary (the iv branch above delegates to onTurnEnd,
            // which clears the marker there).
            inflightMarker.noteTurnEnd(journalConvoIdFor(session));
            clearPendingInterrupt(session);
          }
        } else if (trigger === 'manual') {
          // Manual compact with no pending flag armed — the print-mode path
          // (the flag only arms behind isClaudeSlashCommand, which is
          // iv-only), or an iv /compact typed while busy, or a model-invoked
          // /compact mid-turn. No turn-end work needed: print mode's compact
          // run emits its own (all-zero) result event and busy clears there.
          // The only missing piece is the user-facing confirmation — before
          // this branch, a print-mode /compact finished in total chat
          // silence (Dan, 2026-07-14).
          //
          // Deliberately NOT gated on lastCompactCompleteNotify: that field
          // is stamped by the legacy 🗜️ notice and by earlier compactions,
          // and an explicit manual /compact must always confirm (bugbot,
          // PR #125). A short dedicated window absorbs duplicate/replayed
          // boundary events — distinct manual compacts are minutes apart —
          // and stamping the shared field afterwards keeps the generic
          // legacy notice from double-posting the same compaction.
          const now = Date.now();
          const DUP_BOUNDARY_MS = 5_000;
          if (!session._lastManualCompactConfirm || (now - session._lastManualCompactConfirm) > DUP_BOUNDARY_MS) {
            session._lastManualCompactConfirm = now;
            session.lastCompactCompleteNotify = now;
            if (session.sendHtml) {
              const n = notice('success', doneText);
              session.sendHtml(n.plain, n.html);
            } else if (session.sendCallback) {
              session.sendCallback(doneText);
            }
          }
        }
      }
      break;
    }

    case 'stream_event': {
      // Note: context_management.applied_edits in message_delta events fire on
      // routine context trimming (every turn in long sessions), NOT just full
      // compaction. The system event with subtype='compact' already handles
      // actual compaction notifications, so we intentionally skip these here
      // to avoid spamming the Matrix room.
      break;
    }

    case 'user': {
      const userContent = event.message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          // Commit a staged repo signal (see the 'assistant' tool_use case)
          // once its result lands. Only a NON-error result counts — a failed or
          // denied Edit/Write must not name the session for work that never
          // happened (F2). Either way the pending entry is drained.
          if (block.type === 'tool_result' && block.tool_use_id
              && session._pendingRepoSignals?.has(block.tool_use_id)) {
            const staged = session._pendingRepoSignals.get(block.tool_use_id);
            session._pendingRepoSignals.delete(block.tool_use_id);
            if (!block.is_error) {
              if (!session.repoScores) session.repoScores = emptyRepoScores();
              if (commitRepoSignals(session.repoScores, staged)) {
                // Upgrade a repo-less fallback title now that we know the repo
                // (F1r2). No-op unless the fallback was applied without a repo
                // and still owns the title — see applyFallbackTitle's guard.
                applyFallbackTitle(session, {
                  serverLabel: SERVER_LABEL,
                  updateRoomName,
                  workdir: session.workdir,
                  defaultWorkdir: DEFAULT_WORKDIR,
                  repo: dominantRepo(session.repoScores),
                });
                if (session.claudeSessionId) {
                  persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, {
                    repoScores: session.repoScores,
                  });
                }
              }
            }
          }
          // Mark live-output complete on tool_result for any tracked Bash command.
          if (block.type === 'tool_result' && block.tool_use_id) {
            // A Task tool_result means the subagent it spawned has completed —
            // finish that child convo (no-op for every non-Task tool_result).
            session.subagentConvos?.noteTaskResult(block.tool_use_id);
            const entry = liveOutputStore.get(block.tool_use_id);
            // Only pay for the blockText join + three regex scans below when
            // something will actually consume the result: either the
            // liveOutputStore entry (markComplete below) or a still-registered
            // tool-stream pump (stopAndFinalizeToolStream, which no-ops when
            // there's no pump). Otherwise this ran on EVERY tool_result of
            // every tool — O(content) string work discarded whenever both are
            // absent, which is the common case.
            const journalConvoId = journalConvoIdFor(session);
            const pumpRegistered = JOURNAL_ENABLED && journalConvoId
              && toolStreamPumps.has(toolStreamKey(journalConvoId, block.tool_use_id));
            let opts;
            if (entry || pumpRegistered) {
              const blockText = typeof block.content === 'string'
                ? block.content
                : (Array.isArray(block.content)
                    ? block.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('')
                    : '');
              const denied = /permission/i.test(blockText);
              const truncated = blockText.includes('[matron-tee: output truncated');
              const ecMatch = blockText.match(/exit code[: ]+(\d+)/i);
              const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : (block.is_error ? 1 : 0);
              opts = { exitCode, denied, truncated };
            }
            // Unconditional on every tool_result (fast-follow brief Item 4):
            // must NOT sit behind the liveOutputStore lookup below.
            // liveOutputStore entries are TTL-gc'd independently of the
            // toolStreamPumps registry a still-running pump lives in, so
            // gating this call behind `if (entry)` could orphan a pump whose
            // liveOutputStore entry aged out mid-command until the next
            // sweep runs. stopAndFinalizeToolStream itself already no-ops
            // when there's no toolStreamPumps entry for this key or the
            // journal is disabled, so calling it here for every tool_result
            // (Read/Write/Edit included, not just Bash) is safe and cheap.
            // When the derivation above was skipped, opts is undefined and
            // finalizeToolStreamEntry's own defaults (exitCode: null,
            // denied: false, truncated: false) apply — same as today's
            // absent-value defaults.
            stopAndFinalizeToolStream(session, block.tool_use_id, opts);
            if (entry) {
              liveOutputStore.markComplete(block.tool_use_id, opts);
              // The tracked tool that put us in 'tool' just completed and
              // Claude continues — back to 'thinking'. Gated on activity
              // state, NOT session.busy (Bugbot finding #2): iv-mode
              // prompt-answer dispatch (respondToPrompt, raw PTY keystrokes)
              // never sets busy=true, so a turn resumed by answering a
              // prompt would fail a `session.busy` gate here and the
              // indicator would stick on 'tool' — command already
              // finished — until the whole turn ended. Deriving the gate
              // from _journalActivityState instead means: only resurrect
              // 'thinking' if 'tool' is still the latest activity sent (a
              // tool_result arriving after 'result'/onTurnEnd already
              // flipped activity to 'idle' must not resurrect 'thinking'
              // behind that), and never while the session is actively
              // surfacing a prompt to the user.
              const waitingOnPrompt = !!session.pendingInteractivePrompt || !!session.waitingForAnswer;
              if (shouldResumeThinkingAfterTool(session._journalActivityState, waitingOnPrompt)) {
                journalActivity(session, 'thinking');
              }
            }
          }
          if (block.type === 'tool_result' && block.is_error) {
            debug(`Auto tool_result: tool_use_id=${block.tool_use_id}, content=${JSON.stringify(block.content).slice(0, 100)}`);
          }
        }
      }
      break;
    }

    default:
      break;
  }
}

// --- Text Helpers ---

function extractTextContent(event) {
  if (event.type === 'result' && typeof event.result === 'string') {
    return event.result;
  }

  const content = event.message?.content || event.content;
  if (!content) return '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  return '';
}

function recordConversationMessage(session, role, text) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized || (role !== 'user' && role !== 'assistant')) return;
  if (!session.chatHistory) session.chatHistory = [];
  session.chatHistory.push({
    role,
    text: normalized,
    ...(role === 'assistant' && session.agent ? { agent: session.agent } : {}),
  });
  // Once a message is dispatched to, or emitted by, the active native
  // session, that provider has seen the shared transcript through this item.
  session._agentHistoryCursor = session.chatHistory.length;
  debug(`Added ${role} message to chatHistory, length now: ${session.chatHistory.length}`);
  persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, {
    chatHistory: session.chatHistory,
  });
}

function applyPendingAgentHandoff(session, contentBlocks) {
  const pending = session._pendingAgentHandoff;
  if (!pending?.prompt) return { blocks: contentBlocks, pending: null };
  return {
    blocks: prependHandoffPrompt(contentBlocks, pending),
    pending,
  };
}

function commitDispatchedUserTurn(session, historyText, pendingHandoff) {
  if (historyText) recordConversationMessage(session, 'user', historyText);
  if (pendingHandoff && session._pendingAgentHandoff === pendingHandoff) {
    session._pendingAgentHandoff = null;
    session._agentHistoryCursor = session.chatHistory?.length || pendingHandoff.toIndex || 0;
    persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, {
      chatHistory: session.chatHistory || [],
    });
  }
}

function reportSessionSendFailure(session, message, { restoreJournalState = false } = {}) {
  session.busy = false;
  // Some callers (the Codex/iv/stdin dispatch failures in sendToSession) run
  // AFTER session.busy = true, so a marker for this turn already exists. The
  // dispatch failed, so no agent output is coming — clear it or the next boot
  // offers to carry on a turn that never started.
  inflightMarker.noteTurnEnd(journalConvoIdFor(session));
  if (restoreJournalState) {
    journalSessionState(session, 'waiting');
    journalActivity(session, 'idle');
  }
  // Callers use false to decide whether dispatch-dependent work (history,
  // media mirroring, naming) may run. Surface the specific failure here
  // because the journal-only input path has no transport-level fallback.
  if (session.sendHtml) session.sendHtml(message, escapeHtml(message));
  else if (session.sendCallback) session.sendCallback(message);
  return false;
}

function flushResponse(session) {
  let text = session.responseBuffer.trim();
  session.responseBuffer = '';

  if (!text) return;

  // /context reports get trimmed to their Model/Tokens headline — the full
  // table dump is noise on a phone-sized screen. /context-full (rewritten to
  // /context in sendToSession) arms a one-shot escape hatch, consumed by the
  // NEXT flush whether or not it turned out to be a report: a /context-full
  // whose report never arrived (error, interrupt) must not leave the flag
  // armed for a later, unrelated /context. Chat history and the journal
  // mirror get the same trimmed text the user sees.
  const wantFull = session._contextFullOnce;
  if (wantFull) session._contextFullOnce = false;
  const briefReport = briefContextReport(text);
  if (briefReport && !wantFull) text = briefReport;

  // Track assistant response for topic summarization (strip code blocks)
  const cleanText = text.replace(/```[\s\S]*?```/g, '').trim();
  if (cleanText) {
    recordConversationMessage(session, 'assistant', cleanText);
    // Fallback titling stays on the flush path (names short convos); the
    // LLM summary pass moved to turn-end (maybeSummarizeAtTurnEnd).
    applyFallbackTitle(session, { serverLabel: SERVER_LABEL, updateRoomName, workdir: session.workdir, defaultWorkdir: DEFAULT_WORKDIR, repo: dominantRepo(session.repoScores) });
  }

  // Arm the durable ref for the very next journal mirror (the first chunk's
  // sendToRoom) so the streamed overlay retires by ref. Only when an overlay is
  // actually open for this session (print-mode streamed this message) AND a
  // callback will drive sendToRoom synchronously — otherwise the arm would leak
  // onto a later, unrelated publish. journalStreamClear (at turn-end) clears
  // any overlay this flush didn't retire.
  if (session._journalStreamRef && session.sendCallback) {
    session._journalDurableRef = session._journalStreamRef;
  }

  if (session.sendCallback) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      session.sendCallback(chunk);
    }
  }
  // Bump idle clock whenever we have assistant text to flush, regardless
  // of whether a callback is wired. The guard above is about output
  // delivery; the activity timestamp is about session liveness.
  session.lastActivityAt = Date.now();
}

// skipJournalMirror: the journal input consumer's routed text has already
// been recorded in the journal (the client's own `send` row) — publishing it
// again here as an agent-sourced echo would duplicate it. Every other caller
// (Matrix messages, which have no other route into the journal) leaves this
// false, unchanged from before.
function sendToSession(session, contentBlocks, { skipJournalMirror = false } = {}) {
  if (!session.alive || session._autoStopped) return false;

  const historyText = contentBlocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const journalText = contentBlocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
    .trim();

  // Interactive PTY input cannot deliver non-text-only turns. Reject before
  // the resume outbox and, crucially, before prepending a pending provider
  // handoff; otherwise the synthetic handoff becomes the only sendable text,
  // is consumed as a standalone turn, and the user's attachment is dropped.
  if (session.iv && !historyText) {
    const nonTextCount = contentBlocks.filter(block => block?.type !== 'text').length;
    const message = nonTextCount > 0
      ? `Can't send ${nonTextCount} non-text attachment(s) in interactive mode yet — PTY input is text-only. Send a text message or switch the session out of iv-mode.`
      : 'Interactive mode needs a text prompt.';
    return reportSessionSendFailure(session, message);
  }

  // Reject unsupported Codex inputs before changing activity state or
  // journaling them. A false return is important: callers gate chat history,
  // media mirroring, and first-message naming on actual dispatch.
  if (session.agent === AGENT_CODEX && (!historyText || !contentBlocksToCodexPrompt(contentBlocks))) {
    return reportSessionSendFailure(
      session,
      'Codex programmatic mode needs a text prompt or a saved-file path.',
    );
  }

  // Resume-hold gate: while a just-resumed iv session isn't input-ready yet,
  // buffer outgoing messages instead of typing them into the still-loading
  // TUI. The readiness watcher (startResumeReadyWatcher) flushes them, merged
  // and in order, once claude is idle. See RESUME_READY_* above.
  if (session._awaitingInputReady) {
    // Carry the journal-origin marker WITH the held blocks: the flush in
    // startResumeReadyWatcher re-enters sendToSession long after this call
    // site's skipJournalMirror flag is gone, and journal-originated text must
    // not be re-mirrored on flush (the journal already has the client's own
    // send row for it).
    (session._resumeOutbox ||= []).push(skipJournalMirror ? markJournalOrigin(contentBlocks) : contentBlocks);
    session.lastActivityAt = Date.now();
    return true;
  }

  session.lastActivityAt = Date.now();
  session.responseBuffer = '';
  session.toolCalls = [];
  session.busy = true;
  inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId);
  journalSessionState(session, 'running');
  journalActivity(session, 'thinking');
  // Mirror Claude input here. Codex input is mirrored below only after its
  // one-process-per-turn adapter confirms that it accepted the dispatch.
  if (!skipJournalMirror && session.agent !== AGENT_CODEX && journalText) {
    journalPublishUserItem(session, 'publishText', { body: journalText, from: 'user' });
  }

  // /context-full is a bridge-only command — claude itself knows only
  // /context. Rewrite it here, the single choke point every transport
  // funnels through (Matrix messages, journal-routed text, queue flushes),
  // and arm the one-shot flag flushResponse consumes to let the resulting
  // report through untrimmed. Placed after the journal mirror above so the
  // journal records what the user actually typed. Plain /context needs no
  // marking: flushResponse trims any context report by default.
  if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
    const nativeContext = contextFullToNative(contentBlocks[0].text);
    if (nativeContext) {
      session._contextFullOnce = true;
      contentBlocks = [{ type: 'text', text: nativeContext }];
    }
  }

  const preparedHandoff = applyPendingAgentHandoff(session, contentBlocks);
  contentBlocks = preparedHandoff.blocks;

  if (session.agent === AGENT_CODEX) {
    // codex exec accepts one text prompt per process. Media builders always
    // include an absolute-path text annotation; binary/base64 blocks are
    // intentionally omitted here because Codex can inspect the saved file.
    const sent = session.codex?.send(contentBlocks) === true;
    if (sent) {
      commitDispatchedUserTurn(session, historyText, preparedHandoff.pending);
      if (!skipJournalMirror && journalText) {
        journalPublishUserItem(session, 'publishText', { body: journalText, from: 'user' });
      }
    }
    if (!sent) {
      const detail = session.codex?.lastError?.message || session._codexLastError;
      const message = detail
        ? `Could not start Codex: ${detail}`
        : 'Codex could not accept the message. Try again or restart the session.';
      return reportSessionSendFailure(session, message, { restoreJournalState: true });
    }
    return true;
  }

  if (session.iv) {
    // Interactive mode: type text blocks into the PTY. Non-text content
    // (images, encoded attachments) is not currently supportable via PTY
    // input — log and drop. Phase 6 (post-cutover) will add image handling
    // via a separate channel (probably writing the image bytes to a tmp
    // path and typing a /file reference).
    const nonText = contentBlocks.filter(b => b.type !== 'text');
    if (nonText.length > 0) {
      debug(`iv-mode: dropping ${nonText.length} non-text block(s): ${nonText.map(b => b.type).join(',')}`);
    }
    const text = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
    if (text) {
      session.iv.sendText(text);
      commitDispatchedUserTurn(session, historyText, preparedHandoff.pending);
      if (session.resetTimeout) session.resetTimeout();
      return true;
    }
    // Defensive fallback: validation above should make this unreachable, but
    // preserve false/handled semantics if a future content rewrite removes
    // all text after activity state has started.
    return reportSessionSendFailure(
      session,
      'Interactive mode needs a text prompt.',
      { restoreJournalState: true },
    );
  }

  const jsonMsg = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks
    }
  }) + '\n';
  debug('Sending to stdin:', jsonMsg.length > 1000
    ? jsonMsg.slice(0, 500) + `... [${jsonMsg.length} chars total]`
    : jsonMsg.trim());
  try {
    session.proc.stdin.write(jsonMsg);
  } catch (error) {
    debug(`Failed to write Claude turn: ${error.message}`);
    return reportSessionSendFailure(
      session,
      `Could not send the message to Claude: ${error.message}`,
      { restoreJournalState: true },
    );
  }
  commitDispatchedUserTurn(session, historyText, preparedHandoff.pending);
  if (session.resetTimeout) session.resetTimeout();
  return true;
}

function sendTextToSession(session, text, opts) {
  return sendToSession(session, [{ type: 'text', text }], opts);
}

// Begin holding outgoing messages for a freshly-resumed iv session and start
// watching for the moment claude is idle-and-ready to receive them. Called
// from the auto-resume branch right after the PTY is spawned. No-op for
// non-iv sessions (print mode feeds stdin JSON, which claude buffers fine).
function enterResumeHold(session) {
  if (!session.iv) return;
  session._awaitingInputReady = true;
  session._resumeOutbox = [];
  // No typing indicator here: a resume may surface the "Resume from summary"
  // picker, and showing "Claude is typing…" while we're actually asking the
  // user a question reads wrong. The "Auto-resuming…" notice already conveys
  // what's happening; the real send (on flush) starts typing normally.
  startResumeReadyWatcher(session);
}

// Watch a resuming iv session's PTY output; once it goes quiet AND the screen
// shows the idle input box, flush any held messages (merged, in order) via the
// normal send path. A hard cap guarantees the held message is eventually sent
// even if readiness is never cleanly detected — but it defers while a TUI
// prompt (e.g. the resume-summary picker) is awaiting the user's answer, so
// the held message is never typed into a menu.
function startResumeReadyWatcher(session) {
  const iv = session.iv;
  if (!iv) return;
  let buf = '';
  let quietTimer = null;
  let hardCap = null;
  let settled = false;

  const finish = (reason) => {
    if (settled) return;
    settled = true;
    if (quietTimer) clearTimeout(quietTimer);
    if (hardCap) clearTimeout(hardCap);
    iv.removeListener('pty-data', onData);
    session._awaitingInputReady = false;
    // The hold window accumulated the resume's full-screen transcript repaint
    // in the prompt detector's buffer. Old chat re-rendered there is a
    // minefield of phantom prompts — `> hi` user-message lines, numbered
    // lists inside assistant prose — that classify as menus on the next idle
    // check (the "hi / 1 agent type available" card). The screen is idle by
    // definition at release, so nothing real is lost by flushing it.
    if (iv.detector) iv.detector.reset();
    const outbox = session._resumeOutbox || [];
    session._resumeOutbox = null;
    // A queue carried across a restart (recreateSession and the crash-restart
    // paths copy queuedMessages; a parked /restart's turn-end seam skipped
    // its flush deliberately) has no later seam on this fresh session — it's
    // idle, so no turn-end will ever fire to flush it. This release IS its
    // seam. Merge the hold-window messages onto the queue's TAIL (queue
    // entries were sent earlier so they keep first place, and the
    // queueNotifications alignment is prefix-based, so appending preserves
    // it) and send everything as ONE flush below — back-to-back sends would
    // cancel each other's pending Enter (see lib/interactive-session.js).
    const carriedQueue = (session.queuedMessages?.length ?? 0) > 0;
    if (carriedQueue && outbox.length > 0) {
      session.queuedMessages.push(...outbox);
      outbox.length = 0;
    }
    debug(`iv resume-ready (${reason}); flushing ${outbox.length} held message(s)${carriedQueue ? ` + ${session.queuedMessages.length} carried queued` : ''}`);
    // A /login- or /logout-initiated mode switch parked its command here:
    // type it the moment the TUI is ready, via iv.sendText — no busy,
    // because no claude turn runs (see the '!login' case in handleCommand).
    // Only when nothing else is held: back-to-back sendText calls cancel
    // each other's pending Enter (see lib/interactive-session.js), and once
    // the login dialog opens, flushed text would be typed INTO it — there
    // is no safe interleave, so held user messages win and the user is
    // asked to re-run the command.
    const parkedSlash = session._postReadySlashCommand;
    session._postReadySlashCommand = null;
    // A resume that isn't about to type /logout has no logout in flight:
    // clear any stale mark copied across a crash-restart (a crash mid-logout
    // means the logout did NOT complete — a completed one exits 0), so a
    // later ordinary clean exit isn't misreported as "👋 Logged out"
    // (Bugbot, PR #162).
    if (parkedSlash !== '/logout') session._accountLogoutPending = false;
    // Set ONLY where sendText actually typed the parked command: the other
    // parked branches (held messages won, session died) typed nothing, so
    // there is no pending Enter for a room flush to garble — suppressing the
    // flush there would just strand the inbox (whole-branch review, M4).
    let parkedSlashTyped = false;
    if (parkedSlash) {
      if (outbox.length > 0 || carriedQueue) {
        debug(`dropping parked ${parkedSlash}: held/queued message(s) take priority`);
        // The account flow is abandoned along with the parked command —
        // don't leave the flags armed to hijack a later unrelated login or
        // to mislabel an ordinary exit as a logout.
        session._accountFlowReturnToPrint = false;
        session._accountLogoutPending = false;
        const note = `Your held message(s) were sent first — type ${parkedSlash} again to continue.`;
        if (session.sendCallback) session.sendCallback(note);
      } else if (session.alive && session.iv && typeof session.iv.sendText === 'function'
                 && session.iv.sendText(parkedSlash) !== false) {
        parkedSlashTyped = true;
        debug(`typed parked ${parkedSlash} into ready TUI`);
      } else {
        // The user was promised the command would run when the TUI was
        // ready; if the session died in the gap, say so instead of going
        // silent.
        session._accountFlowReturnToPrint = false;
        session._accountLogoutPending = false;
        const note = `Couldn't run ${parkedSlash} — the session went away before it was ready. Try ${parkedSlash} again.`;
        if (session.sendCallback) session.sendCallback(note);
      }
    }
    // Merge everything the user sent during the hold into ONE send — the
    // gate is now disarmed, so this reaches the real send path via the same
    // merged-send + out-of-band-mirror path flushQueue uses (see
    // dispatchMergedFlush / lib/queue-flush.js planQueueFlush): splitting a
    // mixed-origin hold into separate sendToSession calls is what garbled
    // iv-mode input in the first place (Bugbot finding #1).
    // Carried queue present: flush through the one true queue path
    // (summary tile, notification retire, compact priority — a queued
    // /compact still goes out alone, and its boundary routes back to
    // onTurnEnd which flushes the rest). Otherwise the plain hold flush.
    const sent = carriedQueue
      ? session.alive && flushPendingSessionQueue(session) === true
      : session.alive && outbox.length > 0 && dispatchMergedFlush(session, outbox);
    if (!sent) {
      // Nothing actually went out (session died, hold was empty, or the
      // send itself failed) — don't leave a typing indicator spinning with
      // no turn behind it.
      session.busy = false;
      // Same reasoning applies to the marker: this branch asserts there is no
      // turn behind the busy flag, so any marker left over is stale.
      inflightMarker.noteTurnEnd(journalConvoIdFor(session));
      // Room messages that arrived during the hold coalesced into the pending
      // inbox (isBusy counts _awaitingInputReady). With no held user message
      // there is no turn — and so no turn-end seam — to flush them, so flush
      // here; when something WAS sent, that turn's end seam flushes instead.
      // EXCEPT when a parked slash command was ACTUALLY typed into the ready
      // TUI just now: a back-to-back sendText would cancel its pending Enter
      // and submit `/login` and the room block as ONE garbled line (Task 6
      // review, I3). The couldn't-run branch typed nothing, so it flushes
      // like any other dead-end (whole-branch review, M4). The composite
      // gate inside maybeFlushRoomDelivery also skips if a TUI prompt opened
      // mid-hold.
      if (!parkedSlashTyped) maybeFlushRoomDelivery(session);
    }
  };

  const evaluate = () => {
    if (settled || !session.alive) return finish('dead');
    // A surfaced TUI prompt (e.g. the resume-summary picker) means claude
    // wants a structured answer, not a free message — let the prompt flow
    // handle it and keep holding; the user's answer produces more PTY data
    // that re-arms this check.
    if (session.pendingInteractivePrompt) return;
    if (isIdleReadyScreen(buf)) finish('idle');
  };

  const onData = (data) => {
    buf += data;
    if (buf.length > 32768) buf = buf.slice(-32768);
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(evaluate, RESUME_READY_QUIET_MS);
  };

  const onHardCap = () => {
    if (settled) return;
    // If the user still hasn't answered a surfaced prompt, don't dump the
    // held message into it — give them another window.
    if (session.pendingInteractivePrompt) {
      hardCap = setTimeout(onHardCap, RESUME_READY_HARDCAP_MS);
      if (typeof hardCap.unref === 'function') hardCap.unref();
      return;
    }
    finish('timeout');
  };

  hardCap = setTimeout(onHardCap, RESUME_READY_HARDCAP_MS);
  if (typeof hardCap.unref === 'function') hardCap.unref();
  iv.on('pty-data', onData);
}

function formatQueueSummary(queued) {
  const lines = [];
  for (let i = 0; i < queued.length; i++) {
    const blocks = queued[i];
    const isTextOnly = blocks.every(b => b.type === 'text');
    if (isTextOnly) {
      const text = blocks.map(b => b.text).join('\n');
      const preview = text.length > 200 ? text.slice(0, 197) + '…' : text;
      lines.push({ index: i + 1, text: preview });
    } else {
      const types = blocks.filter(b => b.type !== 'text').map(b => b.type === 'image' ? 'image' : b.type === 'audio' ? 'audio' : 'file');
      lines.push({ index: i + 1, text: `[${types.join(', ')}]` });
    }
  }
  const plain = lines.map(l => `  ${l.index}. ${l.text}`).join('\n');
  const html = lines.map(l =>
    `<li>${escapeHtml(l.text)}</li>`
  ).join('');
  return { plain, html: `<ol>${html}</ol>` };
}

// Merge/grouping rules live in lib/queue-flush.js (pure, unit-tested):
// ALWAYS one merged sendToSession call for the whole queue, regardless of
// origin (Bugbot finding #1 — splitting a mixed-origin queue into one send
// per origin run, as a prior version of this did, garbles iv-mode input:
// lib/interactive-session.js sendText's pending-Enter cancellation means two
// back-to-back sendToSession calls paste twice into the same input line and
// submit as one concatenated message). The send itself always carries
// skipJournalMirror: true; journal mirroring happens out-of-band afterward,
// once we know the send actually went out — the Matrix-origin text subset
// via journalPublishUserItem, and any media blocks' deferred journal mirror
// (Bugbot finding #4 — see lib/media-mirror.js) via journalMirrorUserMedia.
// A queue entry that never reaches here (cancelled, or the whole queue
// cleared) simply never has its pending media mirror read — no upload, no
// publish, no markRead.
function dispatchMergedFlush(session, queued) {
  const { blocks, mirrorText } = planQueueFlush(queued);
  if (blocks.length === 0) return false;
  if (!sendToSession(session, blocks, { skipJournalMirror: true })) return false;
  if (mirrorText) journalPublishUserItem(session, 'publishText', { body: mirrorText, from: 'user' });
  for (const entry of queued) {
    for (const payload of pendingMediaMirror(entry)) journalMirrorUserMedia(session, payload);
  }
  return true;
}

function queuedReleaseItemIds(session, queued) {
  const batchSize = Array.isArray(queued) ? queued.length : 0;
  return new Set(
    (session.queueNotifications || [])
      .slice(0, batchSize)
      .map(notification => notification?.id)
      .filter(Boolean),
  );
}

function liveQueuedReleaseEntries(convoId, itemIds) {
  return journalInputConsumer.queueRelease.listLive(convoId)
    .filter(entry => itemIds.has(entry.itemId));
}

function snapshotQueuedReleaseBatch(session, queued) {
  const convoId = journalConvoIdFor(session);
  return {
    convoId,
    entries: liveQueuedReleaseEntries(
      convoId,
      queuedReleaseItemIds(session, queued),
    ),
  };
}

// The prefix of session.queuedMessages the NEXT flush will actually send —
// the whole queue normally, or just a leading /compact when one is jumping
// (lib/compact-priority.js). Every release-registry seam has to be scoped to
// that batch: handed the whole queue instead, finalizeSentQueue would emit
// `send` releases for messages still sitting in the queue, retiring their
// cards while they wait for the compaction to finish.
function pendingFlushBatch(session) {
  const queue = session.queuedMessages || [];
  return queue.slice(0, compactBatchSize(queue));
}

function queueReleaseForBatch(session, queued) {
  const itemIds = queuedReleaseItemIds(session, queued);
  return {
    listLive: (convoId) => liveQueuedReleaseEntries(convoId, itemIds),
    dropItem: (convoId, itemId) => {
      journalInputConsumer.queueRelease.dropItem(convoId, itemId);
    },
  };
}

function finalizeSentQueue(convoId, flushedSnapshot) {
  const liveByItemId = new Map(
    journalInputConsumer.queueRelease.listLive(convoId)
      .map(entry => [entry.itemId, entry]),
  );
  for (const { itemId } of flushedSnapshot || []) {
    const liveEntry = liveByItemId.get(itemId);
    if (!liveEntry) continue;
    // Fail-closed (F2): retire the live entry ONLY when the durable write-ahead
    // committed. If emitRelease fail-closed (write-ahead disk fault, e.g.
    // ENOSPC), keep the live registry entry so a later release attempt / boot
    // reconcile can still recover the card — dropping it unconditionally here
    // would leave a permanently dead card with no durable record, silently.
    if (emitRelease(convoId, {
      promptId: liveEntry.promptId,
      action: 'send',
      releasedIds: [itemId],
    })) {
      journalInputConsumer.queueRelease.dropItem(convoId, itemId);
      liveByItemId.delete(itemId);
    }
  }
}

function restoreQueuedBatch(session, queued) {
  const pending = session.queuedMessages || [];
  if (pending === queued) return;
  session.queuedMessages = [...queued, ...pending];
}

function flushQueue(session, queued, releaseSnapshot = null) {
  const snapshot = releaseSnapshot || snapshotQueuedReleaseBatch(session, queued);
  if (session.agent === AGENT_CODEX && session.busy) {
    // Claude's stream-json stdin can accept a forced follow-up while the
    // current process is alive; codex exec cannot. Preserve the detached
    // batch, interrupt the active child, and let finishCodexTurn dispatch it
    // after that child has exited and released the adapter's process slot.
    restoreQueuedBatch(session, queued);
    session._codexInterrupted = true;
    if (session.codex?.interrupt('SIGINT')) return 'deferred';
    session._codexInterrupted = false;
    console.log(`[QUEUE] could not interrupt active Codex turn; kept ${queued.length} queued message(s)`);
    return false;
  }
  if (!dispatchMergedFlush(session, queued)) {
    // dispatchMergedFlush fails in two distinct situations that must NOT be
    // handled the same way:
    //   1. The session is gone (dead / auto-stopped). There is nothing to
    //      retry against, so retaining would strand the batch forever. Every
    //      entry was acknowledged with a success-style "📨 Queued" tile, so a
    //      silent server-side drop leaves the user believing it was delivered
    //      (the misleading-success bug PR #150 fixed for attachments, #161 for
    //      queued messages). Notify + drop — matching merged master.
    //   2. The session is ALIVE but refused this flush (iv non-text-only
    //      queue, Codex validation/spawn failure, stdin write error). Each of
    //      those already surfaced its specific reason via
    //      reportSessionSendFailure, and the session is still there to retry
    //      against, so retain the batch for a later flush rather than dropping.
    if (!session.alive || session._autoStopped) {
      console.log(`[QUEUE] dropped queued message(s) (room ${session.roomId})`);
      // journalPublishNotice already no-ops on a falsy convo id and fails
      // open like every journal call.
      const count = Array.isArray(queued) ? queued.length : 0;
      journalPublishNotice(journalConvoIdFor(session), count > 1
        ? `⚠️ Couldn't deliver ${count} queued messages — the session ended before they were sent.`
        : "⚠️ Couldn't deliver your queued message — the session ended before it was sent.");
      return false;
    }
    restoreQueuedBatch(session, queued);
    console.log(`[QUEUE] could not send queued message(s); kept ${queued.length} queued message(s) for retry (room ${session.roomId})`);
    return false;
  }
  finalizeSentQueue(snapshot.convoId, snapshot.entries);
  return true;
}

function splitMessage(text) {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
    if (splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_MSG_LENGTH);
    }
    if (splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = MAX_MSG_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// --- Markdown to HTML ---

function escapeHtml(text) {
  // &quot; matters because escapeHtml output is interpolated into HTML
  // attributes (href="...") as well as element content.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function color(text, hex) {
  return `<font color="${hex}">${text}</font>`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

const NOTICE_COLORS = {
  success: '#3fb950',
  error: '#f85149',
  warning: '#f0883e',
  info: '#58a6ff',
};

function notice(type, plainText, htmlContent) {
  const hex = NOTICE_COLORS[type] || NOTICE_COLORS.info;
  return {
    plain: plainText,
    html: `${color('▌', hex)} ${htmlContent || escapeHtml(plainText)}`,
  };
}

function markdownToHtml(text) {
  let processed = text.replace(/\*\*`([^`\n]+)`\*\*/g, '‹b›‹code›$1‹/code›‹/b›');

  // Convert list markers to placeholders BEFORE backtick split so inline code in list items works
  processed = processed.replace(/^([-*])\s+/gm, '‹li›');
  processed = processed.replace(/^(\d+)\.\s+/gm, '‹li›');

  const parts = processed.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  // Phase 1: Process each part (inline formatting for text, code wrapping for code)
  let html = parts.map((part, i) => {
    if (i % 2 === 1) {
      if (part.startsWith('```')) {
        const inner = part.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const lineCount = inner.split('\n').length;
        if (lineCount > 15) {
          return `<details><summary>Code (${lineCount} lines)</summary><pre><code>${escapeHtml(inner)}</code></pre></details>`;
        }
        return `<pre><code>${escapeHtml(inner)}</code></pre>`;
      }
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }

    let html = escapeHtml(part);

    html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/__(.+?)__/g, '<b>$1</b>');
    html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
    html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Markdown links: [text](url)
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

    // Linkify remaining bare URLs (not already inside tags). The text is
    // already escapeHtml'd, so a quote right after a URL appears as
    // &quot;/&#39; — stop the match at those entities or they get absorbed
    // into the href. (&lt;/&gt; are deliberately NOT terminators: a literal
    // > inside a URL has always been absorbed as &gt; and decodes back to >
    // when the client parses the attribute, so stopping there would change
    // currently-correct rendering.)
    html = html.replace(/(?<!href="|">)(https?:\/\/(?:(?!&quot;|&#39;)[^\s<>"'])+)/g, '<a href="$1">$1</a>');

    // Horizontal rules
    html = html.replace(/^-{3,}$/gm, '<hr/>');

    // Blockquotes: consecutive > lines
    html = html.replace(/(^&gt;\s?.+(\n|$))+/gm, (match) => {
      const inner = match.replace(/^&gt;\s?/gm, '').trim();
      return `<blockquote>${inner}</blockquote>`;
    });

    return html;
  }).join('');

  // Phase 2: Block-level processing on joined HTML (so inline code within lists/tables works)
  html = html.replace(/‹b›‹code›/g, '<b><code>');
  html = html.replace(/‹\/code›‹\/b›/g, '</code></b>');

  // List items (markers were converted to ‹li› before backtick split)
  html = html.replace(/^‹li›(.+)$/gm, '<li>$1</li>');

  // Tables: consecutive lines starting with | — render as <pre><code> for cross-client compatibility
  html = html.replace(/(?:^|\n)((?:\|[^\n]+\|\n?)+)/g, (match, tableBlock) => {
    return '<pre><code>' + padTable(tableBlock).replace(/\n/g, '&#10;') + '</code></pre>';
  });

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, (match) => {
    return `<ul>${match}</ul>`;
  });

  // Protect newlines inside <pre> blocks before converting to <br/>
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (match, inner) => {
    return '<pre><code>' + inner.replace(/\n/g, '&#10;') + '</code></pre>';
  });
  html = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (match, inner) => {
    return '<pre>' + inner.replace(/\n/g, '&#10;') + '</pre>';
  });

  // Convert newlines to <br/> (but not before/after block elements)
  html = html.replace(/\n/g, '<br/>');

  // Restore newlines in <pre> blocks
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (match, inner) => {
    return '<pre><code>' + inner.replace(/&#10;/g, '\n') + '</code></pre>';
  });
  html = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (match, inner) => {
    return '<pre>' + inner.replace(/&#10;/g, '\n') + '</pre>';
  });

  // Clean up excessive <br/> around block elements
  html = html.replace(/<br\/>(<\/?(?:hr|li|pre|ol|ul|table|thead|tbody|tr|th|td|blockquote|details|summary)(?:\s[^>]*)?>)/g, '$1');
  html = html.replace(/(<\/?(?:hr|li|pre|ol|ul|table|thead|tbody|tr|th|td|blockquote|details|summary)(?:\s[^>]*)?>)<br\/>/g, '$1');

  return html;
}

// Pad pipe table columns to equal widths
function padTable(tableText) {
  const rows = tableText.trim().split('\n');
  const parsed = rows.map(r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  const colCount = Math.max(...parsed.map(r => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of parsed) {
    // Skip separator rows for width calculation
    if (/^[\s\-:]+$/.test(row.join(''))) continue;
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], (row[i] || '').length);
    }
  }
  return rows.map(r => {
    const cells = r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (/^[\s\-:]+$/.test(cells.join(''))) {
      return '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
    }
    return '| ' + cells.map((c, i) => (c || '').padEnd(widths[i] || 0)).join(' | ') + ' |';
  }).join('\n');
}

// Journal bodies are raw markdown: Matron clients render GFM themselves
// (the Mac timeline lays out pipe tables natively as of matron-apple #134,
// iOS/Android via their markdown views), so nothing here may rewrite
// message text for presentation. The old plainTextFormat() Element X
// fallback — fence + pad pipe tables for monospace — lived here until
// 2026-08-12; it survived the Matrix exit and silently downgraded every
// table to a code block on all clients.

// --- File Helpers ---

function deduplicateFilename(dir, filename) {
  let target = path.join(dir, filename);
  if (!fs.existsSync(target)) return target;

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return target;
}

// --- Send to Session ---

// skipJournalMirror: set by the journal input consumer's Matrix echoes
// (e.g. "📱 dan (Matron): <body>") and resolved-answer notices — those exist
// only so the Matrix room shows what arrived via the journal; mirroring them
// BACK into the journal as a fresh from:'assistant' text event would be
// exactly the re-publish loop the return path must avoid (the journal
// already has the user's own row for that content).
async function sendToRoom(roomId, text, html, { skipJournalMirror = false } = {}) {
  // Journal mirror: every session reply and bridge notice that flows through
  // here is fine to mirror as-is (v1 doesn't distinguish the two). Rooms with
  // no active session (control-room chatter) are silently skipped.
  if (!skipJournalMirror) {
    const journalSession = sessions.get(roomId);
    if (journalSession) {
      const payload = { body: text, from: 'assistant' };
      // Thread the streaming overlay's ref into the durable message so a
      // viewing client retires its overlay by ref (payload.message_ref is the
      // only channel the server exposes to a client — the durable event shape
      // strips idem_key). Armed single-shot by flushResponse right before this
      // call, so the FIRST chunk of a streamed assistant turn carries the ref;
      // later chunks and unrelated notices publish without it. Consuming it
      // also discards any still-pending coalesced stream frame for that ref, so
      // a stale in-progress frame can't land after this finalized message and
      // resurrect the overlay.
      const ref = journalSession._journalDurableRef;
      if (ref) {
        payload.message_ref = ref;
        journalSession._journalDurableRef = null;
        const convoId = journalConvoIdFor(journalSession);
        if (convoId) {
          journalPublisher.endStream(convoId, ref);
        }
        journalSession._journalStreamRef = null;
        journalSession._journalStreamMsgId = null;
      }
      journalPublish(journalSession, 'publishText', payload);
      return ref || null;
    }
  }
  return null;
}

async function sendLiveOutputEvent(session, { command }) {
  // 'tool' activity, detail = the command — this is the one place index.js
  // knows the command string at tool-start time. The DURABLE tool_output
  // journal event is now published at COMPLETION (stopAndFinalizeToolStream),
  // not here: live viewers get the command from the stream meta frames, and
  // history gets it from the finalize payload (spec §5.3). No viewer_url /
  // expires_at anywhere — live output rides the journal protocol.
  journalActivity(session, 'tool', truncateActivityDetail(command));
  return true;
}

// Completion seam for a journal-streamed Bash command: stop the pump, flush
// whatever it hasn't caught up to yet, read only the tee log's TAIL via a
// positioned read (never the whole file — see finalizeToolStreamEntry),
// upload that tail as a media blob (with a truncation marker line prepended
// when the read was actually capped), and publish the durable tool_output
// completion (spec §5.3) whose payload.message_ref retires the live overlay
// on viewing clients and frees the server-side buffer. Called from the
// tool_result handler (normal end, denied included) and killSession
// (exit_code: null) — every stream ends in exactly one finalize; a second
// call for the same ref is a no-op (the registry entry is gone).
// Fire-and-forget async: the upload is HTTP, and journal problems must never
// touch the Matrix hot path (uploadMedia and finalizeToolOutput both already
// fail open).
const TOOL_LOG_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // well under the server's 50 MB media cap
const TOOL_SNIPPET_READ_BYTES = 64 * 1024; // decode only the tail we snippet from

// Guts of the completion seam, keyed off an already-looked-up registry entry
// rather than re-deriving anything from the (mutable) session. Synchronously
// retires the entry (delete + pump.stop()) so a concurrent caller sees it
// gone immediately, then fires the upload/finalize off async — every stream
// ends in exactly one finalize; the sync retirement is what makes a second
// call for the same key a no-op.
function finalizeToolStreamEntry(key, entry, { exitCode = null, denied = false, truncated = false } = {}) {
  toolStreamPumps.delete(key);
  entry.pump.stop();
  const toolUseId = entry.messageRef;
  (async () => {
    try {
      // Bounded final flush BEFORE the durable finalize publish below: bytes
      // written after stop()'s last pass (stop() is synchronous and never
      // flushes — see lib/tool-stream-pump.js) never streamed as live
      // appends. Must be awaited HERE, in this order: the server frees the
      // stream buffer on finalize, so a stream_append arriving after
      // finalize would recreate a zombie buffer. Code order — not timing —
      // is what guarantees flush-then-finalize. flushFinal never throws.
      await entry.pump.flushFinal();

      // Positioned tail read: stat first, then read only the last
      // min(size, TOOL_LOG_UPLOAD_MAX_BYTES) bytes at that offset, instead
      // of reading the whole log into heap just to keep the last 10 MiB — a
      // multi-GB log would otherwise be read fully every time a command
      // finishes. `logSize` is the true on-disk size (needed below to know
      // whether this tail read was actually capped).
      let logBuf = null;
      let logSize = 0;
      try {
        const st = await fs.promises.stat(entry.logPath);
        logSize = st.size;
        const readLen = Math.min(st.size, TOOL_LOG_UPLOAD_MAX_BYTES);
        if (readLen > 0) {
          const handle = await fs.promises.open(entry.logPath, 'r');
          try {
            const buf = Buffer.alloc(readLen);
            const { bytesRead } = await handle.read(buf, 0, readLen, st.size - readLen);
            logBuf = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        } else {
          logBuf = Buffer.alloc(0);
        }
      } catch { /* denied / tee disabled at spawn: no log file — finalize anyway */ }
      let blobRef = null;
      if (logBuf && logBuf.length > 0) {
        // logBuf is already the tail-capped read above: the end of a long
        // log (the failure, the summary) is worth more than its head. When
        // the true on-disk size exceeded the cap, prepend a marker line to
        // the UPLOADED bytes only — never the snippet (derived from logBuf
        // below, untouched by this), and never opts.truncated in the
        // payload (that field means something else entirely: matron-tee's
        // own per-command output cap) — so a blob reader knows it's looking
        // at a silent tail slice, not the whole log.
        const wasCapped = logSize > TOOL_LOG_UPLOAD_MAX_BYTES;
        const uploadBytes = wasCapped
          ? Buffer.concat([
              Buffer.from(`[log truncated: showing last ${TOOL_LOG_UPLOAD_MAX_BYTES} of ${logSize} bytes]\n`, 'utf-8'),
              logBuf,
            ])
          : logBuf;
        const media = await journalPublisher.uploadMedia({
          bytes: uploadBytes,
          contentType: 'text/plain; charset=utf-8',
          name: `tool-output-${toolUseId}.log`,
        });
        if (media) blobRef = media.media_id;
      }
      // Snippet from the decoded tail only. An arbitrary tail cut can start
      // mid-character; decodeByteExact turns those leading continuation
      // bytes into '?', which a snippet tolerates.
      const tail = logBuf && logBuf.length > 0
        ? logBuf.subarray(Math.max(0, logBuf.length - TOOL_SNIPPET_READ_BYTES))
        : null;
      const text = tail ? decodeByteExact(tail).text : '';
      journalPublisher.finalizeToolOutput(entry.convoId, toolUseId, {
        message_ref: toolUseId,
        command: entry.command,
        exit_code: exitCode,
        denied,
        truncated,
        snippet: toolOutputSnippet(text),
        blob_ref: blobRef,
        live_log: true,
      }, blobRef);
    } catch (e) {
      try { console.warn(`[journal] tool-output finalize failed: ${e.message}`); } catch { /* logging must never throw */ }
    }
  })();
}

function stopAndFinalizeToolStream(session, toolUseId, opts = {}) {
  const convoId = journalConvoIdFor(session);
  if (!JOURNAL_ENABLED || !convoId) return;
  const key = toolStreamKey(convoId, toolUseId);
  const entry = toolStreamPumps.get(key);
  if (!entry) return; // not a streamed command, or already finalized
  finalizeToolStreamEntry(key, entry, opts);
}

// Sweep every still-open tool-output stream belonging to `session` and
// finalize each with exit_code: null (the command's real exit will never be
// observed). Called from killSession and from both claude-process close
// handlers (proc.on('close') and the interactive-view 'exit' seam) so a
// process that exits on its own — crash mid-Bash — doesn't orphan a pump: no
// finalize would otherwise be sent (a viewing client's live overlay dangles
// until the server's 30-min idle sweep) and the Map entry + its fs.watch
// handle would leak forever, pinning the dead session object. Keyed off
// `entry.session === session` rather than session.claudeSessionId so it
// works even if the id was nulled by a failed resume. Deleting the current
// key during Map iteration is safe (Map iterators tolerate deletes).
function sweepToolStreams(session) {
  if (!JOURNAL_ENABLED) return;
  for (const [key, entry] of toolStreamPumps.entries()) {
    if (entry.session === session) {
      finalizeToolStreamEntry(key, entry, { exitCode: null });
    }
  }
}

// fallbackBody/fallbackHtml are the retired Matrix plain/HTML fallback text.
// Still accepted because ~11 call sites pass them positionally through the
// session.sendButtonMessage closures; the journal publishes structured
// prompts and ignores them. Retiring the whole fallback-text plumbing is a
// tracked follow-up.
async function sendButtonMessage(roomId, prompt, buttons, mode, _fallbackBody, _fallbackHtml, payload = null) {
  console.log(`[BUTTONS] Sending button message: mode=${mode}, buttons=${buttons.length}, prompt=${prompt.substring(0, 50)}`);
  const journalSession = sessions.get(roomId);
  if (journalSession) {
    journalPublish(journalSession, 'publishPrompt', payload || { question: prompt, options: buttons, mode });
    return true;
  }
  return null;
}

// --- Room Management ---

// Mint a globally-unique conversation id for a new session. Journal convention
// is a UUID (see matron-journal protocol.md: bridges MUST mint globally-unique
// convo ids). This id doubles as the in-memory session key (formerly the Matrix room id).
function newSessionConvoId() {
  return randomUUID();
}

async function updateRoomName(roomId, name) {
  // Single choke point for every title change (initial naming, media-file
  // naming, and the LLM-driven rename in maybeUpdatePinnedSummary all call
  // through here) — mirror it once, here, rather than at each call site.
  const journalSession = sessions.get(roomId);
  if (journalSession) journalUpsertConvo(journalSession, { title: name });
}

async function maybeUpdatePinnedSummary(session) {
  await updatePinnedSummary(session, {
    codexOneShot,
    formatRoomTitle,
    applyFallbackTitle,
    persistSession,
    updateRoomName,
    debug,
    warn: (...args) => console.warn(...args),
    serverLabel: SERVER_LABEL,
    defaultWorkdir: DEFAULT_WORKDIR,
    inferRepo: (s) => dominantRepo(s.repoScores),
  }).catch(e => console.warn('[summary] wrapper error', {
    error: String(e?.message || e),
    roomId: session.roomId,
  }));
}

// Turn-end gate for the summary pass. Fire-and-forget with an explicit catch
// (an un-awaited rejection would be fatal under Node 22 defaults) and a
// re-entrancy latch — turn-ends can arrive while a prior LLM call is pending.
// A trigger swallowed by the latch is coalesced into one rerun when the
// in-flight pass settles; otherwise messages recorded during a slow LLM call
// would wait for the NEXT turn-end, and a conversation that goes quiet right
// after would keep a stale summary indefinitely. Bounded: at most one rerun
// per dropped trigger, and the min-new gate re-checks before the rerun fires.
//
// This latch MUST use a distinct field from updatePinnedSummary's own
// `_summaryInFlight` guard (lib/pinned-summary.js). The fork-sync 2026-08-12
// merge blended this upstream turn-end gate with the fork's codex-titles inner
// pass, and both used `_summaryInFlight`: this caller set it, then the inner
// guard saw it already set and bailed on every run — codex never fired and
// titles stopped regenerating. Keep the two layers' latches separate.
function maybeSummarizeAtTurnEnd(session) {
  const count = session.chatHistory?.length || 0;
  if (count - (session.lastSummaryMsgCount || 0) < SUMMARY_MIN_NEW) return;
  if (session._summaryTurnInFlight) {
    session._summaryRerunQueued = true;
    return;
  }
  session._summaryTurnInFlight = true;
  maybeUpdatePinnedSummary(session)
    .catch((e) => console.warn(`[summary] turn-end pass failed for ${session.roomId}: ${e.message}`))
    .finally(() => {
      session._summaryTurnInFlight = false;
      if (session._summaryRerunQueued) {
        session._summaryRerunQueued = false;
        maybeSummarizeAtTurnEnd(session);
      }
    });
}

// Path of a session's on-disk transcript. Extraction + bounded reading live
// in lib/session-summary.js (see its header for why the old synchronous
// whole-file getSessionSummary was replaced); this stays here because it
// depends on DEFAULT_WORKDIR.
function sessionTranscriptPath(sessionId, workdir) {
  return transcriptPathFor(workdir || DEFAULT_WORKDIR, sessionId);
}

// Async, bounded replacement for the old sync getSessionSummary — same
// (sessionId, workdir) signature and same output, but reads only a bounded
// head chunk of the transcript via fs.promises. Callers await it (both call
// sites are inside handleCommand's async cases).
function getSessionSummary(sessionId, workdir) {
  return readSessionSummary(sessionTranscriptPath(sessionId, workdir));
}

/**
 * Check if the session's JSONL history already contains a tool_result for the given tool_use_id.
 * This prevents sending duplicate tool_results which cause API 400 errors.
 */
function hasToolResultInHistory(sessionId, workdir, toolUseId) {
  const filePath = transcriptPathFor(workdir || DEFAULT_WORKDIR, sessionId);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    // Scan from end (most recent) for efficiency
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // Quick string check before parsing JSON
      if (!line.includes(toolUseId)) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'user' && Array.isArray(record.message?.content)) {
        for (const block of record.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
            return true;
          }
        }
      }
    }
  } catch {}
  return false;
}

// --- Media Handling ---

// Basename-safe a media filename used as a path segment for workdir/upload
// saves: strips directory components a malicious/odd name might carry
// (mirrors resolveUploadMeta in lib/iv-uploads.js; '.'/'..' survive basename,
// so fold them — and the empty case — into the 'file' fallback).
function safeMediaFilename(name) {
  const base = path.basename(typeof name === 'string' && name ? name : 'file');
  return base === '' || base === '.' || base === '..' ? 'file' : base;
}

// Session-scoped uploads directory for SDK-mode media saves: <workdir>/uploads.
// Keeps user-sent files out of the workdir root, where they otherwise sit as
// untracked noise in the operator's git checkout (workspace root or worktree —
// uploads/ is gitignored there). Mirrors the Matrix bridge's uploadsDir helper.
function sessionUploadsDir(session) {
  const dir = path.join(session.workdir, 'uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Build the claude content blocks for an already-materialized (fetched from
// the journal blob store) NON-audio media buffer: saves the bytes to the right
// place (iv upload dir vs. session workdir) and produces the same save-path
// text + inline image/document blocks the media path has always produced.
// Called by the journal media path (journalOnMedia, whose bytes come from
// journalPublisher.fetchMedia) so a file sent from Matron feels identical to
// claude. Audio is NOT handled here — the caller surfaces transcription
// progress itself, so it runs transcribeAudio directly. `isImage` selects the
// image branch by msgtype rather than mime — an image-mime file still falls
// through the file branch's inline-image sub-case. `ivFilename` names the iv
// upload; `workdirName` names the SDK-mode save.
//
// `caption` is what the user typed alongside the attachment in the composer.
// BOTH modes fold it in, each in its own idiom: iv mode passes it to the
// upload annotation (caption above the path), SDK mode leads with it as its
// own text block. It used to be `ivCaption`, hardcoded `null` by the only
// caller — so a caption reached this function from nowhere and left for
// nowhere, and claude never saw one. `ivHandled` went the same way: it was
// returned to tell a caller not to double-append the caption, but no caller
// ever read it.
//
// `inline` is an optional prepareInlineImage decision governing the base64
// image block only (downscaled copy / skip); the buffer written to disk and
// the pending-media mirror always carry the full-resolution original.
function buildSavedMediaBlocks(session, { buffer, mime, dims, isImage, ivFilename, caption, workdirName, inline }) {
  const blocks = [];
  if (session.iv) {
    // iv-mode: the PTY is text-only. Save the file OUTSIDE the repo and type
    // only an absolute-path annotation; Claude reads it with its Read tool.
    // No base64 blocks and no inline content dump (SDK mode keeps those).
    const dir = ivUploadDir(session.roomId);
    const savePath = deduplicateFilename(dir, ivFilename);
    fs.writeFileSync(savePath, buffer);
    blocks.push({ type: 'text', text: ivUploadAnnotation({ msgtype: isImage ? 'm.image' : 'm.file', savePath, caption }) });
    // Journal mirror (upload + publish + markRead) is deferred to actual
    // dispatch time — see lib/media-mirror.js. Attaching it here (rather
    // than calling journalMirrorUserMedia now) is what stops a queued
    // attachment that later gets cancelled from leaving a phantom journal
    // entry / advanced read marker for something Claude never saw. (The
    // journal media path never reads these back — its blob is already in the
    // journal — so the tag is simply inert there.)
    attachPendingMediaMirror(blocks, { buffer, mime, name: ivFilename, dims });
    return { blocks, ivHandled: true };
  }
  // SDK mode: lead with the caption so claude reads the user's words before
  // the "Image saved to …" bookkeeping and the image itself — the order a
  // person would say it in. Everything below appends to the same `blocks`
  // array, i.e. the same single user turn.
  if (caption) blocks.push({ type: 'text', text: caption });
  if (isImage) {
    // Save image to the session uploads dir
    let imgPath;
    try { imgPath = deduplicateFilename(sessionUploadsDir(session), workdirName); }
    catch (err) { blocks.push({ type: 'text', text: `[Upload failed: ${err.message}]` }); return { blocks, ivHandled: false }; }
    fs.writeFileSync(imgPath, buffer);
    blocks.push({ type: 'text', text: `Image saved to ${imgPath}` });
    appendInlineImageBlocks(blocks, { buffer, mime, inline, savePath: imgPath });
    attachPendingMediaMirror(blocks, { buffer, mime, name: workdirName, dims });
  } else {
    // Save file to the session uploads dir
    let savePath;
    try { savePath = deduplicateFilename(sessionUploadsDir(session), workdirName); }
    catch (err) { blocks.push({ type: 'text', text: `[Upload failed: ${err.message}]` }); return { blocks, ivHandled: false }; }
    fs.writeFileSync(savePath, buffer);
    blocks.push({ type: 'text', text: `File saved to ${savePath}` });
    attachPendingMediaMirror(blocks, { buffer, mime, name: workdirName, dims });

    if (mime === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }
      });
    } else if (mime.startsWith('image/')) {
      appendInlineImageBlocks(blocks, { buffer, mime, inline, savePath });
    } else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/csv'].includes(mime)) {
      blocks.push({ type: 'text', text: `Contents of ${workdirName}:\n${buffer.toString('utf-8')}` });
    } else {
      blocks.push({ type: 'text', text: `Binary file (${mime}) saved to ${savePath}. Use the Read tool to inspect it if needed.` });
    }
  }
  return { blocks, ivHandled: false };
}

// --- Command Handler ---

// Run `claude -p "/usage"` as a one-shot and return its stdout. stdin is
// ignored (not a pipe) so Claude Code doesn't wait ~3s for stdin data. Rejects
// on spawn error, non-zero exit, or a 30s timeout. Used by the /limits command.
function fetchUsageLimitsText(cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '/usage', '--output-format', 'text'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Every other claude spawn in this file clears CLAUDECODE (Bugbot
      // finding #6) — without it, a `claude` child inherits CLAUDECODE from
      // this process's own environment and can behave as though it's
      // nested inside another Claude Code session. This is a global,
      // session-less one-shot (no roomId/workdir session to speak of), so
      // it doesn't replicate the rest of the session spawns' env shape
      // (BRIDGE_ROOM_ID, MATRON_BRIDGE_API_PORT, MATRON_BASH_TEE_ENABLED —
      // all meaningless here); it just needs the same CLAUDECODE treatment.
      env: { ...process.env, CLAUDECODE: '' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new Error('timed out'));
    }, 30000);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (e) => finish(reject, e));
    proc.on('close', (code) => {
      if (code === 0) finish(resolve, stdout);
      else finish(reject, new Error(stderr.trim() || `claude exited with code ${code}`));
    });
  });
}

async function handleCommand(roomId, text, sendReply, sendHtml, sender) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '!start': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      // Extract --prompt "<text>" from the RAW arg string FIRST (quote-aware),
      // before the whitespace-split flag extractors below consume tokens that
      // may legitimately appear inside the prompt (e.g. a workdir path, or a
      // flag-looking word). The prompt, if any, is injected as the session's
      // first user message after spawn so dispatch is a single message.
      const rawArgs = text.slice(text.indexOf(parts[0]) + parts[0].length);
      const promptFlag = extractPromptFlag(rawArgs);
      if (promptFlag.error) {
        await sendReply(promptFlag.error);
        return;
      }
      const initialPrompt = promptFlag.prompt;
      const afterPromptTokens = promptFlag.rest.split(/\s+/).filter(Boolean);

      const { extras: mcpExtras, rest: afterMcp } = extractMcpExtraFlags(afterPromptTokens);
      const agentFlags = extractAgentFlag(afterMcp);
      if (agentFlags.error) {
        await sendReply(agentFlags.error);
        return;
      }
      const selectedAgent = resolveAgent({ option: agentFlags.agent, fallback: DEFAULT_AGENT });
      if (selectedAgent === AGENT_CODEX && mcpExtras.length > 0) {
        await sendReply('--browser is a Claude-only session extra. Start Codex without --browser; Codex uses MCP servers from its own config.');
        return;
      }
      const arg = agentFlags.rest[0];
      const forceFresh = arg === 'now' || arg === 'fresh';
      const explicitWorkdir = arg && !forceFresh ? arg : null;
      let workdir = DEFAULT_WORKDIR;
      if (explicitWorkdir) {
        const resolved = path.resolve(expandHome(explicitWorkdir));
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            await sendReply(`Not a directory: ${resolved}`);
            return;
          }
        } catch {
          await sendReply(`Directory not accessible: ${resolved}`);
          return;
        }
        workdir = resolved;
      }

      // Mint a fresh conversation id for this session
      const sessionRoomId = newSessionConvoId();

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, reply, markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
      const sessionSendButtons = (prompt, buttons, mode, plainText, html, payload) =>
        sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html, payload);

      const session = createSession(sessionRoomId, workdir, undefined, { agent: selectedAgent, mcpExtras });
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;
      // claudeSessionId is known immediately (pre-assigned in both modes),
      // so persist mcpExtras now — otherwise a bridge restart before the
      // first transcript-driven persist would lose the user's opt-in.
      if (mcpExtras.length > 0 && session.claudeSessionId) {
        persistSession(sessionRoomId, session.claudeSessionId, session.workdir, roomId);
      }

      // Confirm in the origin room/convo. No matrix.to room link: Matron is
      // the only client now, and its new conversation appears on its own —
      // a Matrix room URL is just a dead link there.
      const extrasNote = mcpExtras.length > 0 ? ` (extras: ${mcpExtras.join(', ')})` : '';
      const promptNote = initialPrompt ? ' with your prompt' : '';
      await sendReply(`${agentLabel(selectedAgent)} session started in a new conversation${promptNote}${extrasNote}.`);

      // Deliver the initial prompt (from --prompt) as the session's first user
      // message. For iv sessions the TUI isn't input-ready at spawn, so arm the
      // resume-ready hold: sendToSession buffers the text in _resumeOutbox and
      // startResumeReadyWatcher flushes it once the TUI reaches its idle input
      // box. For print/codex sessions enterResumeHold is a no-op and the text is
      // written straight to stdin (the agent buffers it fine).
      if (initialPrompt) {
        enterResumeHold(session);
        sendTextToSession(session, initialPrompt);
      }
      break;
    }

    case '!stop': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session.');
        return;
      }
      // A deliberate !stop is a turn END, not an interruption — there is
      // nothing to carry on, so drop the marker. This is NOT done inside
      // killSession: /restart and /switch reuse it and their turns genuinely
      // WERE interrupted, so those must keep the marker and get a card.
      // Note this class of turn-end never clears session.busy at all (the kill
      // path has no busy = false for print/iv), so it is invisible to a
      // `session.busy = false` grep.
      inflightMarker.noteTurnEnd(journalConvoIdFor(session));
      killSession(session);
      sessions.delete(roomId);
      journalSessionState(session, 'done');
      journalActivity(session, 'idle');
      journalEvictConvoInput(session);
      await sendReply('Session stopped.');
      break;
    }

    case '!restart': {
      const existing = sessions.get(roomId);
      if (!existing || !existing.alive) {
        await sendReply('No active session. Use !start to begin.');
        return;
      }
      // /restart accepts the same MCP-extras flags as /start so you can
      // toggle browser tools on mid-conversation without losing the
      // session ID. Passing no flags preserves whatever extras the session
      // already has — set in-memory and falling back to the persisted
      // value if the bridge was restarted in between.
      const { force: restartForced, rest: restartArgs } = extractForceFlag(parts.slice(1));
      const { extras: restartFlagExtras, rest: restartAfterMcp } = extractMcpExtraFlags(restartArgs);
      const restartAgentFlags = extractAgentFlag(restartAfterMcp);
      if (restartAgentFlags.error) {
        await sendReply(restartAgentFlags.error);
        return;
      }
      if (restartAgentFlags.agent && restartAgentFlags.agent !== existing.agent) {
        await sendReply(`A ${agentLabel(existing.agent)} conversation can't be resumed by ${agentLabel(restartAgentFlags.agent)}. Use /start --${restartAgentFlags.agent} for a new conversation.`);
        return;
      }
      if (existing.agent === AGENT_CODEX && restartFlagExtras.length > 0) {
        await sendReply('--browser is a Claude-only session extra. Codex uses MCP servers from its own config.');
        return;
      }
      // Mid-turn without --force: park the restart instead of killing the
      // in-flight turn (a /restart right after /compact used to cancel the
      // compaction). The stash replays the ORIGINAL args — forced, so it
      // can't re-defer — through handleCommand at whichever turn-end seam
      // fires first (iv onTurnEnd, print-mode 'result', finishCodexTurn);
      // see dispatchDeferredCommand. Validation above already ran, so a bad
      // flag combination is refused now, not at turn end. A repeat /restart
      // while one is parked just refreshes the stash with the newer args.
      if (existing.busy && !restartForced) {
        // One deferred slot, shared with /model: replacing a different
        // parked command says so, mirroring the /login parked-slash notices.
        const previousParked = existing._deferredCommandText;
        existing._deferredCommandText = ['!restart', '--force', ...restartArgs].join(' ');
        const replacedNote = previousParked && !previousParked.startsWith('!restart')
          ? ` (replacing the queued /${previousParked.slice(1).split(' ')[0]})`
          : '';
        await sendReply(`Waiting for turn to finish before restarting${replacedNote}. Send again with --force to restart immediately.`);
        return;
      }
      // A forced restart discards any parked one along with `existing` —
      // recreateSession copies fields onto the replacement explicitly, and
      // _deferredCommandText is deliberately not among them.
      const carriedExtras = Array.isArray(existing.mcpExtras) ? existing.mcpExtras : null;
      const effectiveRestartExtras = restartFlagExtras.length > 0
        ? restartFlagExtras
        : (carriedExtras || []);
      const restartSessionId = existing.claudeSessionId;
      const restartWorkdir = existing.workdir;
      await sendReply(`🔄 Restarting ${agentLabel(existing.agent)} session...`);
      recreateSession(roomId, { mcpExtras: effectiveRestartExtras }, { sendReply, sendHtml });
      const extrasLine = effectiveRestartExtras.length > 0
        ? `\nExtras: ${effectiveRestartExtras.join(', ')}`
        : '';
      await sendReply(
        `${agentLabel(existing.agent)} session restarted.\nSession: ${restartSessionId ? restartSessionId.slice(0, 8) + '...' : '(new)'}\nWorkdir: ${restartWorkdir}${extrasLine}`
      );
      break;
    }

    case '!resume': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      const { extras: resumeExtras, rest: resumeAfterMcp } = extractMcpExtraFlags(parts.slice(1));
      const resumeAgentFlags = extractAgentFlag(resumeAfterMcp);
      if (resumeAgentFlags.error) {
        await sendReply(resumeAgentFlags.error);
        return;
      }
      const resumeArg = resumeAgentFlags.rest[0]?.replace(/\.+$/, '') || undefined;

      if (!resumeArg) {
        // No arg — show sessions list inline
        const flag = resumeAgentFlags.agent ? ` --${resumeAgentFlags.agent}` : '';
        await handleCommand(roomId, `!sessions${flag}`, sendReply, sendHtml, sender);
        return;
      }

      const currentSession = sessions.get(roomId);
      const prev = getPersistedSession(roomId);
      const resumeWorkdir = currentSession?.workdir || prev?.workdir || DEFAULT_WORKDIR;
      let resumeSessionId;
      let actualWorkdir = resumeWorkdir;
      let resumePersisted = null;
      let selectedAgent = resolveAgent({
        option: resumeAgentFlags.agent,
        persisted: currentSession?.agent || prev?.agent,
        fallback: DEFAULT_AGENT,
      });
      const num = /^\d+$/.test(resumeArg) ? parseInt(resumeArg, 10) : NaN;
      const rejectAmbiguousResume = async () => {
        await sendReply(
          `Session prefix ${resumeArg} matches multiple sessions. Use a longer ID and specify --claude or --codex.`,
        );
      };

      // An explicit ID prefix can identify a persisted Codex thread even
      // when the caller omitted --codex. Numeric selection remains scoped to
      // the selected/default agent because numbers are list-relative.
      if (!resumeAgentFlags.agent && isNaN(num)) {
        const codexMatches = matchSessionIdPrefix(
          listPersistedAgentSessions(AGENT_CODEX),
          resumeArg,
        ).matches;
        const persistedClaudeMatches = matchSessionIdPrefix(
          listPersistedAgentSessions(AGENT_CLAUDE),
          resumeArg,
        ).matches;
        const inferredClaudeDir = projectDirFor(resumeWorkdir);
        const localClaudeMatches = await pathExists(inferredClaudeDir)
          ? matchSessionIdPrefix(await listSessionIdsByMtime(inferredClaudeDir), resumeArg).matches
          : [];
        const claudeMatches = new Set([
          ...localClaudeMatches,
          ...persistedClaudeMatches.map(entry => entry.sessionId),
        ]);
        if (codexMatches.length + claudeMatches.size > 1) {
          await rejectAmbiguousResume();
          return;
        }
        if (codexMatches.length === 1) selectedAgent = AGENT_CODEX;
        else if (claudeMatches.size === 1) selectedAgent = AGENT_CLAUDE;
      }

      if (selectedAgent === AGENT_CODEX) {
        if (resumeExtras.length > 0) {
          await sendReply('--browser is a Claude-only session extra. Codex uses MCP servers from its own config.');
          return;
        }
        const localEntries = listPersistedAgentSessions(AGENT_CODEX, resumeWorkdir);
        if (!isNaN(num)) {
          if (num < 1 || num > localEntries.length) {
            await sendReply(`Codex session number not found: ${resumeArg}\nUse /sessions --codex to list bridge-owned Codex sessions.`);
            return;
          }
          resumePersisted = localEntries[num - 1];
        } else {
          const resolution = matchSessionIdPrefix(
            listPersistedAgentSessions(AGENT_CODEX),
            resumeArg,
          );
          if (resolution.ambiguous) {
            await rejectAmbiguousResume();
            return;
          }
          resumePersisted = resolution.match;
        }
        if (!resumePersisted) {
          await sendReply(`Codex session not found: ${resumeArg}\nUse /sessions --codex to list bridge-owned Codex sessions.`);
          return;
        }
        resumeSessionId = resumePersisted.sessionId;
        actualWorkdir = resumePersisted.workdir || resumeWorkdir;
      } else {
        const projectDir = projectDirFor(resumeWorkdir);

        // Async id resolution (issue #102): metadata is statted once per
        // transcript and sorted without synchronous work in the comparator.
        // A missing current-workdir directory is not terminal for an ID
        // lookup: bridge persistence may point to the transcript's original
        // workdir. Numeric selections remain scoped to the current workdir.
        const files = await pathExists(projectDir)
          ? await listSessionIdsByMtime(projectDir)
          : [];
        if (!isNaN(num)) {
          if (num < 1 || num > files.length) {
            await sendReply(`Claude session number not found: ${resumeArg}\nUse /sessions --claude to list available sessions.`);
            return;
          }
          resumeSessionId = files[num - 1];
        } else {
          const currentMatches = matchSessionIdPrefix(files, resumeArg).matches;
          const persistedMatches = matchSessionIdPrefix(
            listPersistedAgentSessions(AGENT_CLAUDE),
            resumeArg,
          ).matches;
          const candidateIds = new Set([
            ...currentMatches,
            ...persistedMatches.map(entry => entry.sessionId),
          ]);
          if (candidateIds.size > 1) {
            await rejectAmbiguousResume();
            return;
          }
          const matchId = [...candidateIds][0] || null;
          const foundEntry = persistedMatches.find(entry => entry.sessionId === matchId) || null;
          if (matchId && currentMatches.includes(matchId)) {
            resumeSessionId = matchId;
            resumePersisted = foundEntry;
          } else if (matchId && foundEntry?.workdir) {
            const altDir = projectDirFor(foundEntry.workdir);
            const altFile = path.join(altDir, `${foundEntry.sessionId}.jsonl`);
            if (await pathExists(altFile)) {
              resumeSessionId = foundEntry.sessionId;
              actualWorkdir = foundEntry.workdir;
              resumePersisted = foundEntry;
            }
          }
          if (!resumeSessionId) {
            await sendReply(`Claude session not found: ${resumeArg}\nUse /sessions --claude to list available sessions.`);
            return;
          }
        }
      }

      // Resolve the bridge-owned record by provider-specific state before
      // checking live rooms or creating a replacement room. The top-level
      // sessionId only names whichever provider was active when that record
      // was last written; the requested native ID may live in agentSessions.
      resumePersisted ||= findPersistedAgentSession(selectedAgent, resumeSessionId);
      const resumeConvoId = resumePersisted?.journalConvoId || null;

      // Check if there's already an active room for this agent session.
      for (const activeSession of sessions.values()) {
        if (activeSession.claudeSessionId === resumeSessionId && activeSession.alive) {
          await sendReply(`Session ${resumeSessionId.slice(0, 8)}… is already active in another conversation.`);
          return;
        }
        if (resumeConvoId && journalConvoIdFor(activeSession) === resumeConvoId && activeSession.alive) {
          await sendReply(`Conversation ${resumeConvoId.slice(0, 8)}… is already active in another room.`);
          return;
        }
      }

      // Mint a fresh conversation id for the resumed session
      const sessionRoomId = newSessionConvoId();

      const shortId = resumeSessionId.slice(0, 8);
      const summary = selectedAgent === AGENT_CODEX
        ? (resumePersisted?.summary || '')
        : await getSessionSummary(resumeSessionId, actualWorkdir);

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, reply, markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
      const sessionSendButtons = (prompt, buttons, mode, plainText, html, payload) =>
        sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html, payload);

      // Inherit the resumed session's previously persisted extras unless the
      // user is explicitly overriding via the command line; this lets a
      // resume "just work" if /start --browser was used originally.
      const resumeHistory = Array.isArray(resumePersisted?.chatHistory)
        ? resumePersisted.chatHistory
        : [];
      const resumeState = getPersistedAgentState(
        resumePersisted,
        selectedAgent,
        resumeHistory.length,
      );
      const inheritedAgentSessions = mergeAgentStates(resumePersisted?.agentSessions, {
        [selectedAgent]: {
          ...resumeState,
          sessionId: resumeSessionId,
        },
      });
      const effectiveResumeExtras = resumeExtras.length > 0
        ? resumeExtras
        : resumeState.mcpExtras;
      const session = createSession(sessionRoomId, actualWorkdir, resumeSessionId, {
        agent: selectedAgent,
        model: resumeState.model,
        mcpExtras: effectiveResumeExtras,
        journalConvoId: resumePersisted?.journalConvoId,
        agentSessions: inheritedAgentSessions,
        ...(selectedAgent === AGENT_CLAUDE
          ? { interactive: resumeState.interactiveMode }
          : {}),
      });
      // Restore + normalize the activity-inferred repo signal BEFORE titling so
      // a rehydrated session names its journal from prior activity, not a bare
      // basename (F1). normalizeRepoScores hardens against version-skewed
      // persisted state reaching the event path (F5).
      const resumeRepoScores = normalizeRepoScores(resumePersisted?.repoScores);
      const roomName = formatRoomTitle({
        serverLabel: SERVER_LABEL,
        workdir: session.workdir,
        text: summary || (`Resumed ${shortId}`),
        defaultWorkdir: DEFAULT_WORKDIR,
        repo: dominantRepo(resumeRepoScores),
      });
      session.originRoomId = roomId;
      session.firstMessageCaptured = true; // don't re-rename on first message
      session.chatHistory = resumeHistory;
      session.pinnedSummaryText = resumePersisted?.pinnedSummaryText || '';
      session.pinnedSummaryEventId = resumePersisted?.pinnedSummaryEventId || null;
      session.lastSummaryMsgCount = resumePersisted?.lastSummaryMsgCount || 0;
      session.lastRosterText = resumePersisted?.lastRosterText || '';
      session.repoScores = resumeRepoScores;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;
      session._agentSessions = inheritedAgentSessions;
      hydrateAgentState(session, {
        ...(resumePersisted || {}),
        agent: selectedAgent,
        agentSessions: inheritedAgentSessions,
      });
      // Rename after the session exists (not before) so updateRoomName's
      // roomId -> session lookup — used to journal-mirror the title — finds it.
      await updateRoomName(sessionRoomId, roomName);

      // Persist immediately — we already know the agent session ID.
      // session.workdir, not actualWorkdir: createSession may have degraded a
      // missing workdir to a fallback, and persisting the missing path would
      // re-trigger the fallback warning on the next spawn (every other
      // persistSession site already passes session.workdir).
      persistSession(sessionRoomId, resumeSessionId, session.workdir, roomId, {
        agent: selectedAgent,
        agentSessions: inheritedAgentSessions,
        journalConvoId: session.journalConvoId,
        chatHistory: session.chatHistory,
        pinnedSummaryText: session.pinnedSummaryText,
        pinnedSummaryEventId: session.pinnedSummaryEventId,
        lastSummaryMsgCount: session.lastSummaryMsgCount || 0,
        lastRosterText: session.lastRosterText || '',
        repoScores: session.repoScores,
        model: session.currentModel || null,
        interactiveMode: selectedAgent === AGENT_CLAUDE ? !!session.iv : undefined,
        mcpExtras: session.mcpExtras,
        totalUsage: session.totalUsage,
        turnCount: session.turnCount,
      });

      await sendReply(`Resuming ${agentLabel(selectedAgent)} session ${shortId}… in a new conversation.`);
      const resumePlain = `Resuming ${agentLabel(selectedAgent)} session ${shortId}…\nWorkdir: ${session.workdir}\n\nSend any message to continue.`;
      const resumeHtml =
        `<b>Resuming ${escapeHtml(agentLabel(selectedAgent))} session <code>${shortId}</code>…</b><br/>` +
        `Workdir: <code>${escapeHtml(session.workdir)}</code><br/><br/>` +
        `<i>Send any message to continue.</i>`;
      await sessionSendHtml(resumePlain, resumeHtml);
      break;
    }

    case '!workdir': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      const { extras: workdirExtras, rest: workdirAfterMcp } = extractMcpExtraFlags(parts.slice(1));
      const workdirAgentFlags = extractAgentFlag(workdirAfterMcp);
      if (workdirAgentFlags.error) {
        await sendReply(workdirAgentFlags.error);
        return;
      }
      const selectedAgent = resolveAgent({ option: workdirAgentFlags.agent, fallback: DEFAULT_AGENT });
      if (selectedAgent === AGENT_CODEX && workdirExtras.length > 0) {
        await sendReply('--browser is a Claude-only session extra. Start Codex without --browser; Codex uses MCP servers from its own config.');
        return;
      }
      const newDir = workdirAgentFlags.rest.join(' ');
      if (!newDir) {
        const session = sessions.get(roomId);
        const current = session?.workdir || DEFAULT_WORKDIR;
        await sendReply(`Current workdir: ${current}\n\nUsage: !workdir <path>`);
        return;
      }

      const resolved = path.resolve(expandHome(newDir));

      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          await sendReply(`Not a directory: ${resolved}`);
          return;
        }
      } catch {
        await sendReply(`Directory not accessible: ${resolved}`);
        return;
      }

      // Mint a fresh conversation id for this session
      const sessionRoomId = newSessionConvoId();

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, reply, markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
      const sessionSendButtons = (prompt, buttons, mode, plainText, html, payload) =>
        sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html, payload);

      const session = createSession(sessionRoomId, resolved, undefined, { agent: selectedAgent, mcpExtras: workdirExtras });
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;
      if (workdirExtras.length > 0 && session.claudeSessionId) {
        persistSession(sessionRoomId, session.claudeSessionId, session.workdir, roomId);
      }

      await sendReply(`${agentLabel(selectedAgent)} session started in a new conversation.\nWorkdir: ${resolved}`);
      const wdPlain = `${agentLabel(selectedAgent)} session started.\nWorkdir: ${resolved}\n\nSend any message to interact with ${agentLabel(selectedAgent)}.`;
      const wdHtml =
        `<b>${escapeHtml(agentLabel(selectedAgent))} session started</b><br/>` +
        `Workdir: <code>${escapeHtml(resolved)}</code><br/><br/>` +
        `<i>Send any message to interact with ${escapeHtml(agentLabel(selectedAgent))}.</i>`;
      await sessionSendHtml(wdPlain, wdHtml);
      break;
    }

    case '!status': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Send !start to begin.');
        return;
      }
      const uptimeMs = Date.now() - session.startedAt;
      const shortId = session.claudeSessionId ? session.claudeSessionId.slice(0, 8) + '…' : '(pending)';
      const busyText = session.busy ? 'yes' : 'no';

      const plainStatus =
        `Session active\nAgent: ${agentLabel(session.agent)}\nWorkdir: ${session.workdir}\nSession ID: ${shortId}\n` +
        `Uptime: ${formatDuration(uptimeMs)}\nRestarts: ${session.restartCount}/3\nBusy: ${busyText}`;

      const busyHtml = session.busy
        ? color('● busy', '#f0883e')
        : color('● idle', '#3fb950');
      const htmlStatus =
        `<b>Session Status</b><table>` +
        `<tr><td>State</td><td>${busyHtml}</td></tr>` +
        `<tr><td>Agent</td><td>${escapeHtml(agentLabel(session.agent))}</td></tr>` +
        `<tr><td>Workdir</td><td><code>${escapeHtml(session.workdir)}</code></td></tr>` +
        `<tr><td>Session</td><td><code>${shortId}</code></td></tr>` +
        `<tr><td>Uptime</td><td>${formatDuration(uptimeMs)}</td></tr>` +
        `<tr><td>Restarts</td><td>${session.restartCount}/3</td></tr>` +
        `<tr><td>Turns</td><td>${session.turnCount}</td></tr>` +
        (session.agent === AGENT_CODEX ? '' : `<tr><td>Cost</td><td>$${session.totalUsage.cost_usd.toFixed(4)}</td></tr>`) +
        `</table>`;

      await sendHtml(plainStatus, htmlStatus);
      break;
    }

    case '!show':
    case '!show_working':
    case '!working': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      session.showWorking = !session.showWorking;
      await sendReply(`Tool call visibility: ${session.showWorking ? 'ON — will show working' : 'OFF — hidden'}`);
      break;
    }

    case '!show_bash':
    case '!show_bash_output':
    case '!bash_output': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      if (session.agent === AGENT_CODEX) {
        await sendReply('Live Bash tee output is a Claude-hook feature and is not available in Codex programmatic mode.');
        break;
      }
      session.showBashOutput = !session.showBashOutput;
      // Persist so !restart re-reads the value at spawn. Gated like the
      // pendingPlanDenialId persist at the ExitPlanMode handler — passing a
      // null sessionId here would clobber an existing persisted sessionId.
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { showBashOutput: session.showBashOutput });
      }
      await sendReply(`showBashOutput: ${session.showBashOutput ? 'ON' : 'OFF'} — run !restart to apply`);
      break;
    }

    case '!sessions': {
      const currentSession = sessions.get(roomId);
      const prev = getPersistedSession(roomId);
      const workdir = currentSession?.workdir || prev?.workdir || DEFAULT_WORKDIR;
      const sessionAgentFlags = extractAgentFlag(parts.slice(1));
      if (sessionAgentFlags.error) {
        await sendReply(sessionAgentFlags.error);
        break;
      }
      if (sessionAgentFlags.rest.length > 0) {
        await sendReply('Usage: /sessions [--claude|--codex]');
        break;
      }
      const selectedAgent = resolveAgent({
        option: sessionAgentFlags.agent,
        persisted: currentSession?.agent || prev?.agent,
        fallback: DEFAULT_AGENT,
      });

      let items;
      if (selectedAgent === AGENT_CODEX) {
        items = listPersistedAgentSessions(AGENT_CODEX, workdir).slice(0, 15);
      } else {
        const projectDir = projectDirFor(workdir);
        if (!(await pathExists(projectDir))) {
          await sendReply('No Claude sessions found for this workdir.');
          break;
        }
        // Bounded listing (lib/session-summary.js): stat + sort by mtime
        // first, then read summaries for only the 15 newest transcripts.
        items = await listSessionSummaries(projectDir, { limit: 15 });
      }

      if (items.length === 0) {
        await sendReply(`No ${agentLabel(selectedAgent)} sessions found for this workdir.`);
        break;
      }

      const activeId = currentSession?.claudeSessionId;

      // Plain text fallback
      const plainList = items.map((s, i) => {
        const date = new Date(s.modified).toISOString().replace('T', ' ').slice(0, 16);
        const shortId = s.sessionId.slice(0, 8);
        const active = s.sessionId === activeId ? ' ⚡' : '';
        const desc = s.summary ? ` — ${s.summary}` : '';
        return `${i + 1}. ${shortId} ${date}${active}${desc}`;
      }).join('\n');

      // HTML formatted version
      const htmlRows = items.map((s, _i) => {
        const date = new Date(s.modified).toISOString().replace('T', ' ').slice(0, 16);
        const shortId = s.sessionId.slice(0, 8);
        const active = s.sessionId === activeId ? ' ⚡' : '';
        const desc = s.summary
          ? `<br/><span style="color:gray">${escapeHtml(s.summary)}</span>`
          : '';
        return `<li><b>${shortId}</b> <code>${date}</code>${active}${desc}</li>`;
      }).join('\n');

      const agentFlag = `--${selectedAgent}`;
      const plainText = `${agentLabel(selectedAgent)} sessions for ${workdir}:\n\n${plainList}\n\nUse /resume ${agentFlag} <number> or /resume ${agentFlag} <id> to resume.`;
      const html = `<b>${escapeHtml(agentLabel(selectedAgent))} sessions for ${escapeHtml(workdir)}:</b><ol>\n${htmlRows}\n</ol><i>Use <code>/resume ${agentFlag} &lt;number&gt;</code> or <code>/resume ${agentFlag} &lt;id&gt;</code> to resume.</i>`;

      await sendHtml(plainText, html);
      break;
    }

    case '!help': {
      const plainHelp =
        `Available commands:\n\n` +
        `/start [--claude|--codex] — Start a new session (creates a new room)\n` +
        `/start [--claude|--codex] <workdir> — Start in a specific directory\n` +
        `/start --browser [workdir] — Add the chrome-devtools MCP (browser tools); off by default to save ~400M\n` +
        `/stop — Stop the current session\n` +
        `/restart — Restart the session once the current turn finishes; --force restarts immediately (--browser also accepted)\n` +
        `/resume [--claude|--codex] <n|id> — Resume a session from that agent\n` +
        `/sessions [--claude|--codex] — List past sessions for an agent\n` +
        `/workdir [--claude|--codex] <path> — Start a session in a different directory\n` +
        `/status — Show current session info\n` +
        `/agent — Show the current agent\n` +
        `/switch <claude|codex> — Hand this conversation to the other agent\n` +
        `/working — Toggle tool call visibility\n` +
        `/mcp — Show MCP server status\n` +
        `/model — Show current model\n` +
        `/effort [level] — Show or set effort level\n` +
        `/mode [interactive|print] — Show or switch interactive vs non-interactive\n` +
        `/login — Log in to your Anthropic account (auto-switches to interactive mode)\n` +
        `/logout — Log out of your Anthropic account (auto-switches to interactive mode)\n` +
        `/cost — Show session cost\n` +
        `/usage — Show token usage\n` +
        `/limits — Show subscription usage limits (session & weekly)\n` +
        `/timer <duration> <message> — Send a message to this chat later (e.g. /timer 2h hey, /timer 30m /compact); /timer lists, /timer cancel <id|all> cancels\n` +
        `/tools — List available tools\n` +
        `/help — Show this help message\n\n` +
        `Each /start, /resume, and /workdir creates a new session.\n` +
        `Room names show ${SERVER_LABEL} · <repo> · <topic>.\n\n` +
        `While the agent is working:\n` +
        `  Messages are queued automatically\n` +
        `  Send "interrupt" to force interrupt\n` +
        `  !esc — cancel the current turn without killing the session\n\n` +
        `Send any other text to chat with the selected coding agent.\n` +
        `You can also send photos and documents (PDFs, images, text files).`;

      const cmdGroup = (title, cmds) => {
        const items = cmds.map(([c, d]) => `<li><code>${c}</code> — ${d}</li>`).join('');
        return `<b>${title}</b><ul>${items}</ul>`;
      };

      const htmlHelp =
        cmdGroup('Sessions', [
          ['/start [--claude|--codex]', 'Start a new session (creates a new room)'],
          ['/start [--claude|--codex] &lt;workdir&gt;', 'Start in a specific directory'],
          ['/start --browser [workdir]', 'Also enable chrome-devtools MCP (off by default to save ~400M)'],
          ['/stop', 'Stop the current session'],
          ['/restart', 'Restart the session once the current turn finishes; --force restarts immediately (--browser also accepted)'],
          ['/resume [--claude|--codex] &lt;n|id&gt;', 'Resume a session from that agent'],
          ['/sessions [--claude|--codex]', 'List past sessions for an agent'],
          ['/workdir [--claude|--codex] &lt;path&gt;', 'Start a session in a different directory'],
        ]) +
        cmdGroup('Info', [
          ['/status', 'Show current session info'],
          ['/agent', 'Show the current coding agent'],
          ['/switch &lt;claude|codex&gt;', 'Hand this conversation to the other coding agent'],
          ['/working', 'Toggle tool call visibility'],
          ['/mcp', 'Show MCP server status'],
          ['/model', 'Show current model'],
          ['/effort [level]', 'Show or set effort level (low, medium, high, xhigh, max, auto, ultracode)'],
          ['/mode [interactive|print]', 'Show or switch interactive vs non-interactive mode'],
          ['/login', 'Log in to your Anthropic account (auto-switches to interactive mode)'],
          ['/logout', 'Log out of your Anthropic account (auto-switches to interactive mode)'],
          ['/cost', 'Show session cost'],
          ['/usage', 'Show token usage'],
          ['/limits', 'Show subscription usage limits (session &amp; weekly)'],
          ['/timer &lt;duration&gt; &lt;message&gt;', 'Send a message to this chat later (e.g. /timer 2h hey, /timer 30m /compact); /timer lists, /timer cancel &lt;id|all&gt; cancels'],
          ['/tools', 'List available tools'],
          ['/help', 'Show this help message'],
        ]) +
        `<b>Tips</b><ul>` +
        `<li>Each <code>/start</code>, <code>/resume</code>, and <code>/workdir</code> creates a new session</li>` +
        `<li>Room names show <code>${SERVER_LABEL} · &lt;repo&gt; · &lt;topic&gt;</code></li>` +
        `<li>Messages are queued automatically while the agent is working</li>` +
        `<li>Send <code>interrupt</code> to force interrupt</li>` +
        `<li><code>!esc</code> — cancel the current turn without killing the session</li>` +
        `<li>You can send photos and documents (PDFs, images, text files)</li>` +
        `</ul>`;

      await sendHtml(plainHelp, htmlHelp);
      break;
    }

    case '!agent': {
      const session = sessions.get(roomId);
      const arg = normalizeAgent(parts[1]);
      if (!session || !session.alive) {
        await sendReply(`Default agent: ${agentLabel(DEFAULT_AGENT)}\n\nStart one with /start --codex or /start --claude.`);
        break;
      }
      if (!parts[1]) {
        await sendReply(`Agent: ${agentLabel(session.agent)}\n\nUse /switch ${otherAgent(session.agent)} to hand this conversation to ${agentLabel(otherAgent(session.agent))}.`);
        break;
      }
      if (!arg) {
        await sendReply('Usage: /agent [claude|codex]');
        break;
      }
      if (arg === session.agent) {
        await sendReply(`Already using ${agentLabel(session.agent)}.`);
        break;
      }
      await sendReply(`Use /switch ${arg} to hand this conversation from ${agentLabel(session.agent)} to ${agentLabel(arg)}.`);
      break;
    }

    case '!switch': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session first.');
        break;
      }
      if (!parts[1]) {
        await sendReply(
          `Currently using ${agentLabel(session.agent)}.\n\nUsage: /switch ${otherAgent(session.agent)}`,
        );
        break;
      }
      if (parts.length > 2) {
        await sendReply('Usage: /switch <claude|codex>');
        break;
      }
      const target = normalizeAgent(parts[1].replace(/^--/, ''));
      await switchAgentSession(roomId, target, { sendReply });
      break;
    }

    case '!mcp': {
      const session = sessions.get(roomId);
      if (session?.agent === AGENT_CODEX) {
        await sendReply('Codex programmatic sessions use MCP servers from the local Codex config. Live MCP status is not included in codex exec JSON events.');
        break;
      }
      if (session?.initData?.mcp_servers) {
        const servers = session.initData.mcp_servers;
        const plainList = servers.map(s => {
          const icon = s.status === 'connected' ? '🟢' :
                       s.status === 'failed' ? '🔴' :
                       s.status === 'needs-auth' ? '🟡' : '⚪';
          return `${icon} ${s.name} — ${s.status}`;
        }).join('\n');
        const statusDot = (st) => {
          const clr = st === 'connected' ? '#3fb950' :
                      st === 'failed' ? '#f85149' :
                      st === 'needs-auth' ? '#f0883e' : '#8b949e';
          return color('●', clr);
        };
        const htmlRows = servers.map(s =>
          `<tr><td>${statusDot(s.status)}</td><td><code>${escapeHtml(s.name)}</code></td><td>${escapeHtml(s.status)}</td></tr>`
        ).join('');
        const htmlMcp = `<b>MCP Servers</b><table>${htmlRows}</table>`;
        await sendHtml(`MCP Servers (live):\n\n${plainList}`, htmlMcp);
      } else {
        // No initData.mcp_servers. In iv-mode there is no system/init event, so
        // live server status is never exposed — fall back to the bridge's
        // configured servers, but don't claim "no active session" when one is
        // actually running. The live set may also include servers from the
        // user's own Claude config that the bridge can't enumerate here.
        const live = !!session?.alive;
        try {
          const configPath = path.join(__dirname, 'mcp-config.json');
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const names = Object.keys(config.mcpServers || {});
          if (names.length === 0) {
            await sendReply(live
              ? "Live MCP status isn't available in interactive mode, and the bridge configures no servers."
              : 'No MCP servers configured.');
          } else {
            const list = names.map(n => `⚪ ${n} — configured`).join('\n');
            await sendReply(live
              ? `Live MCP status isn't available in interactive mode.\nBridge-configured servers:\n\n${list}\n\n(Other servers from your Claude config may also be connected.)`
              : `MCP Servers (from config, no active session):\n\n${list}\n\nStart a session to see live status.`);
          }
        } catch {
          await sendReply(live
            ? "Live MCP status isn't available in interactive mode."
            : 'No MCP config found and no active session.');
        }
      }
      break;
    }

    case '!model': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session to see model info.');
        break;
      }
      const arg = parts[1];
      if (arg) {
        applyModelSwitch(roomId, session, arg, { sendReply, sendHtml });
        break;
      }
      const current = session.currentModel || session.initData?.model || null;
      const extra = session.initData
        ? `\nClaude Code: v${session.initData.claude_code_version || '(unknown)'}\nFast mode: ${session.initData.fast_mode_state || 'off'}`
        : '';
      const currentLine = current
        ? `Current model: ${current}`
        : (session.agent === AGENT_CODEX ? 'Current model: Codex config default' : 'Current model: (appears after the first reply)');
      if (session.agent === AGENT_CODEX) {
        await sendReply(`${currentLine}\n\nType /model <model-id> to set the model for future Codex turns, or /model default to return to your Codex config default.`);
      } else if (session.iv) {
        // A live TUI means switching works. Prefer buttons, but fall back to a
        // typed-command hint when no button channel is wired (e.g. some
        // auto-started sessions) — never claim "needs interactive mode" here.
        if (session.sendButtonMessage) {
          const buttons = modelButtons();
          const plain = `${currentLine}${extra}\n\nTap a model to switch, or type /model <name>.`;
          const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
          const html = `<b>🧠 ${escapeHtml(currentLine)}</b>${extra ? '<br/>' + escapeHtml(extra.trim()).replace(/\n/g, '<br/>') : ''}` +
            `<br/><br/>Tap a model to switch, or type <code>/model &lt;name&gt;</code>.<br/>${htmlButtons}`;
          session.sendButtonMessage(currentLine, buttons, 'pick_one', plain, html);
        } else {
          await sendReply(`${currentLine}${extra}\n\nType /model <name> to switch (e.g. /model sonnet). Options: ${VALID_ALIAS_HINT}.`);
        }
      } else if (session.sendButtonMessage) {
        const buttons = modelButtons();
        const plain = `${currentLine}${extra}\n\nTap a model to switch (restarts to apply), or type /model <name>.`;
        const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
        const html = `<b>🧠 ${escapeHtml(currentLine)}</b>${extra ? '<br/>' + escapeHtml(extra.trim()).replace(/\n/g, '<br/>') : ''}` +
          `<br/><br/>Tap a model to switch (restarts to apply), or type <code>/model &lt;name&gt;</code>.<br/>${htmlButtons}`;
        session.sendButtonMessage(currentLine, buttons, 'pick_one', plain, html);
      } else {
        await sendReply(`${currentLine}${extra}\n\nType /model <name> to switch (restarts to apply). Options: ${VALID_ALIAS_HINT}.`);
      }
      break;
    }

    case '!mode': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session first.');
        break;
      }
      if (session.agent === AGENT_CODEX) {
        await sendReply('Mode: programmatic (codex exec --json). Interactive Codex mode is not part of this first integration.');
        break;
      }
      const currentInteractive = !!session.iv;
      const arg = parts[1];
      if (!arg) {
        const line = `Mode: ${modeLabel(currentInteractive)}`;
        if (session.sendButtonMessage) {
          const buttons = modeButtons(currentInteractive);
          const plain = `${line}\n\nTap to switch, or type /mode interactive | /mode print.`;
          const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
          const html = `<b>🔀 ${escapeHtml(line)}</b><br/><br/>Tap to switch, or type <code>/mode interactive</code> | <code>/mode print</code>.<br/>${htmlButtons}`;
          session.sendButtonMessage(line, buttons, 'pick_one', plain, html);
        } else {
          await sendReply(`${line}\n\nType /mode interactive or /mode print to switch.`);
        }
        break;
      }
      const target = normalizeModeArg(arg);
      if (!target) {
        await sendReply('Usage: /mode interactive | /mode print');
        break;
      }
      const wantInteractive = target === 'interactive';
      applyModeSwitch(roomId, session, wantInteractive, { sendReply, sendHtml });
      break;
    }

    // /login and /logout are claude-native TUI commands — the bridge only
    // intercepts them because they're unusable from print mode (stream-json
    // input has no login dialog). An interactive session gets the command
    // typed straight into its PTY; a print session is switched to
    // interactive first and the command runs once the resumed TUI is
    // idle-ready (parked on _postReadySlashCommand, consumed by
    // startResumeReadyWatcher's finish). Typing uses iv.sendText directly,
    // NOT sendToSession: account commands run no claude turn, so no Stop
    // hook would ever clear `busy` — the same failure class /effort works
    // around (see lib/effort-command.js).
    case '!login':
    case '!logout': {
      const cmdWord = cmd.slice(1);
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply(`No active session. /${cmdWord} runs inside a session — start one first.`);
        break;
      }
      // Any session.iv — even a dead one — takes this branch: falling
      // through to the mode switch would hit planModeSwitch's "already
      // interactive" no-op (it only checks iv truthiness) and silently do
      // nothing. A dead PTY makes sendText return false, which produces the
      // explicit /restart hint instead.
      if (session.iv) {
        // Mid-resume hold: the TUI is still loading, so typing now would be
        // dropped (the same window planModeSwitch refuses /mode in). Park
        // the command instead — startResumeReadyWatcher types it the moment
        // the TUI is idle-ready.
        if (session.iv.alive && session._awaitingInputReady) {
          const previouslyParked = session._postReadySlashCommand;
          session._postReadySlashCommand = `/${cmdWord}`;
          // A parked /logout still exits claude when the watcher types it —
          // without this mark the exit-0 handler falls into the generic
          // "session ended" branch instead of confirming the logout
          // (Bugbot, PR #162). Same non-borrowing rule as the immediate
          // path: _accountFlowReturnToPrint stays whatever the flow that
          // created this iv session set it to.
          session._accountLogoutPending = cmdWord === 'logout';
          if (previouslyParked === `/${cmdWord}`) {
            await sendReply(`/${cmdWord} is already queued — it will run as soon as the session is ready.`);
          } else if (previouslyParked) {
            await sendReply(`Queued /${cmdWord} (replacing the queued ${previouslyParked}) — it will run as soon as the session is ready.`);
          } else {
            await sendReply(`The session is still resuming — /${cmdWord} will run as soon as it's ready.`);
          }
          break;
        }
        if (session.iv.sendText(`/${cmdWord}`) === false) {
          await sendReply(`Could not reach the session TUI — try /restart, then /${cmdWord} again.`);
          break;
        }
        // This branch used to be silent on success — the TUI shows the
        // command running, but a Matron/Matrix user can't see the TUI, so
        // /logout appeared to do nothing (live-test round 2). Acknowledge,
        // and mark the /logout so the exit-0 handler confirms it instead of
        // reporting a generic session end. Deliberately does NOT set
        // _accountFlowReturnToPrint (Bugbot, PR #162): that flag means the
        // bridge BORROWED interactive mode from a print session and owes a
        // switch back — a user who chose interactive mode keeps it after
        // /login//logout. If this iv session IS a borrowed one, the print
        // branch below already set the flag and it stays set.
        // Assignment, not a conditional set: /login must CLEAR a stale
        // logout mark left by an earlier /logout attempt that never
        // finished, or a later clean exit would be misreported as a logout.
        session._accountLogoutPending = cmdWord === 'logout';
        await sendReply(cmdWord === 'logout' ? 'Logging out…' : 'Logging in…');
        break;
      }
      // A zero-turn print chat used to be turned away here with "send any
      // message first": planModeSwitch refused to switch an unconfirmed session
      // to interactive, so the flow had nowhere to go. That refusal is gone —
      // recreateSession demotes the unresumable id to a fresh spawn on the same
      // id — and this guard has to go with it, because "say hi first" is worst
      // exactly when it bites hardest: a box whose Claude is not logged in
      // CANNOT complete a turn, so the one instruction we gave was one the user
      // could not follow. /login is now a legitimate first thing to say.
      //
      // Print mode: one concise announcement covering the whole flow — the
      // mode switch is an implementation detail, so don't narrate it in two
      // separate messages. On refusal (busy, mid-resume, no session id yet)
      // applyModeSwitch sends planModeSwitch's own message instead and
      // nothing is parked.
      const next = applyModeSwitch(roomId, session, true, {
        sendReply, sendHtml,
        announcement: cmdWord === 'logout'
          ? 'Logging out — switching to interactive mode to complete…'
          : 'Logging in — switching to interactive mode to complete…',
      });
      if (next) {
        next._postReadySlashCommand = `/${cmdWord}`;
        // The bridge (not the user) chose interactive mode here, so it also
        // owns switching back: when the login-success screen is detected the
        // session returns to print mode automatically (see the auto-Enter
        // branch in handleInteractiveScreenUpdate). Survives the TUI's own
        // exit-and-restart after /logout via the auto-restart copy block.
        next._accountFlowReturnToPrint = true;
        // Logout-specific: the parked /logout exits claude; the exit-0
        // handler uses this to confirm the logout (and, with the flag
        // above, persist print mode).
        next._accountLogoutPending = cmdWord === 'logout';
      }
      break;
    }

    case '!effort': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session to set the effort level.');
        break;
      }
      if (session.agent === AGENT_CODEX) {
        await sendReply('Codex effort switching is not exposed by this first programmatic integration. Set model_reasoning_effort in your Codex config if needed.');
        break;
      }
      const arg = parts[1];
      if (arg) {
        switchEffortInSession(session, arg, sendReply);
        break;
      }
      // No-arg: offer buttons. Bare /effort in the TUI opens a "Change effort
      // level?" arrow-menu the bridge can't drive (paste+Enter just opens it
      // and leaves it hanging), so present the levels as Matrix buttons and
      // dispatch the pick back through switchEffortInSession (which sends
      // `/effort <level>` inline — no picker).
      if (session.iv) {
        if (session.sendButtonMessage) {
          const buttons = effortButtons();
          const plain = `Effort level\n\nTap a level to set it, or type /effort <level>.`;
          const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
          const html = `<b>🎚️ Effort level</b><br/><br/>Tap a level to set it for this session, or type <code>/effort &lt;level&gt;</code>.<br/>${htmlButtons}`;
          session.sendButtonMessage('Effort level', buttons, 'pick_one', plain, html);
        } else {
          await sendReply(`Type /effort <level> to set the effort level. Options: ${VALID_EFFORT_HINT}.`);
        }
      } else {
        await sendReply(`Changing effort needs interactive mode. Options: ${VALID_EFFORT_HINT}.`);
      }
      break;
    }

    case '!cost': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      if (session.agent === AGENT_CODEX) {
        await sendReply(`Codex exec does not report monetary cost.\nTurns: ${session.turnCount}\nUse /usage for token counts.`);
        break;
      }
      const cost = session.totalUsage.cost_usd;
      const costClr = cost < 0.5 ? '#3fb950' : cost < 2 ? '#f0883e' : '#f85149';
      const plainCost = `Session cost: $${cost.toFixed(4)}\nTurns: ${session.turnCount}`;
      const htmlCost =
        `<b>Session Cost</b><table>` +
        `<tr><td>Cost</td><td>${color('$' + cost.toFixed(4), costClr)}</td></tr>` +
        `<tr><td>Turns</td><td>${session.turnCount}</td></tr>` +
        `</table>`;
      await sendHtml(plainCost, htmlCost);
      break;
    }

    case '!usage': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      const u = session.totalUsage;
      const uCostClr = u.cost_usd < 0.5 ? '#3fb950' : u.cost_usd < 2 ? '#f0883e' : '#f85149';
      const plainUsage =
        `Token usage (cumulative):\n\n` +
        `Input: ${u.input_tokens.toLocaleString()}\n` +
        `Output: ${u.output_tokens.toLocaleString()}\n` +
        `Cache read: ${u.cache_read.toLocaleString()}\n` +
        (session.agent === AGENT_CODEX ? '' : `Cache create: ${u.cache_create.toLocaleString()}\n`) +
        `Turns: ${session.turnCount}` +
        (session.agent === AGENT_CODEX ? '' : `\nCost: $${u.cost_usd.toFixed(4)}`);
      const htmlUsage =
        `<b>Token Usage</b><table>` +
        `<tr><td>Input</td><td>${u.input_tokens.toLocaleString()}</td></tr>` +
        `<tr><td>Output</td><td>${u.output_tokens.toLocaleString()}</td></tr>` +
        `<tr><td>Cache read</td><td>${u.cache_read.toLocaleString()}</td></tr>` +
        (session.agent === AGENT_CODEX ? '' : `<tr><td>Cache create</td><td>${u.cache_create.toLocaleString()}</td></tr>`) +
        `<tr><td>Turns</td><td>${session.turnCount}</td></tr>` +
        (session.agent === AGENT_CODEX ? '' : `<tr><td>Cost</td><td>${color('$' + u.cost_usd.toFixed(4), uCostClr)}</td></tr>`) +
        `</table>`;
      await sendHtml(plainUsage, htmlUsage);
      break;
    }

    case '!limits': {
      // Subscription rate limits (5-hour session + weekly) aren't in the
      // stream-json the bridge parses and there's no `claude usage` subcommand,
      // so shell out to `claude -p "/usage"` and let Claude Code report them.
      // This is a global query — no active session required.
      try {
        const active = sessions.get(roomId);
        if (active?.agent === AGENT_CODEX) {
          await sendReply('Codex subscription limits are not exposed by codex exec JSON output.');
          break;
        }
        const cwd = active?.workdir || DEFAULT_WORKDIR;
        const raw = await fetchUsageLimitsText(cwd);
        const parsed = parseUsageLimits(raw);
        const { plain, html } = formatLimits(parsed, raw);
        await sendHtml(plain, html);
      } catch (e) {
        await sendReply(`Couldn't fetch usage limits: ${e.message}`);
      }
      break;
    }

    case '!timer': {
      const session = sessions.get(roomId);
      // Deliberately NO session.alive gate (Bugbot, PR #171): timers are
      // persisted per-convo and outlive the session process, so every
      // subcommand only needs a resolvable convo id. In the window between
      // an idle reap and the process-close handler removing the map entry,
      // the session object is still here but dead — list/cancel must keep
      // working on it, and a timer SET on it is fine too (fireTimer
      // auto-resumes a dead session at delivery time anyway).
      if (!session) {
        await sendReply('No active session. Start a session to set a timer.');
        break;
      }
      const convoId = journalConvoIdFor(session);
      if (!convoId) {
        // Fresh print-mode sessions only learn their convo id from the first
        // transcript event — without one the timer would have no address to
        // fire into (or auto-resume) later.
        await sendReply("This session doesn't have a conversation id yet — send one message first, then set the timer.");
        break;
      }
      // Slice (don't rejoin parts): the scheduled message must keep the
      // user's original spacing.
      const parsed = parseTimerCommand(text.slice(parts[0].length));
      if (parsed.kind === 'error') {
        await sendReply(parsed.message);
        break;
      }
      if (parsed.kind === 'set') {
        const record = timerStore.add({ convoId, roomId, text: parsed.message, delayMs: parsed.delayMs });
        // Wall-clock rendering includes the timezone name ("12:26 AM UTC") —
        // the server's clock is rarely the user's, so a bare time is
        // ambiguous. Same-day timers show just the time; >=24h adds the date.
        const at = parsed.delayMs >= 24 * 3600 * 1000
          ? new Date(record.fireAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
          : new Date(record.fireAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
        const summary =
          `⏰ Timer #${record.id} set — will send "${parsed.message}" in ${formatTimerDuration(parsed.delayMs)} (at ${at}). ` +
          `It survives session restarts and idle reaping.`;
        if (session.sendButtonMessage) {
          // Confirmation card with Send-now + Cancel buttons. Taps round-trip
          // as seq-proven picker replies (timer:send:<id> / timer:cancel:<id>
          // -> lib/picker-dispatch.js -> sendTimerNowFromButton /
          // cancelTimerFromButton); /timer cancel <id> stays the typed path.
          await session.sendButtonMessage(
            summary,
            [timerSendNowButton(record.id), timerCancelButton(record.id)],
            'pick_one', summary, escapeHtml(summary));
        } else {
          await sendReply(`${summary} /timer lists, /timer cancel ${record.id} cancels.`);
        }
        break;
      }
      if (parsed.kind === 'cancel') {
        const cancelled = timerStore.cancel(convoId, parsed.which);
        if (!cancelled.length) {
          await sendReply(parsed.which === 'all'
            ? 'No timers set for this conversation.'
            : `No timer #${parsed.which} in this conversation. /timer lists the active ones.`);
          break;
        }
        await sendReply(cancelled.length === 1
          ? `🚫 Cancelled timer #${cancelled[0].id} ("${cancelled[0].text}").`
          : `🚫 Cancelled ${cancelled.length} timers.`);
        break;
      }
      // 'list'
      const active = timerStore.listForConvo(convoId);
      if (!active.length) {
        await sendReply('No timers set. Usage: /timer <duration> <message> — e.g. /timer 2h hey, or /timer 30m /compact.');
        break;
      }
      const lines = active.map(t => `#${t.id} — in ${formatTimerDuration(t.fireAt - Date.now())}: "${t.text}"`);
      await sendReply(`⏰ Timers for this conversation:\n${lines.join('\n')}\n\n/timer cancel <id|all> to cancel.`);
      break;
    }

    case '!tools': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session first.');
        break;
      }
      if (session.agent === AGENT_CODEX) {
        await sendReply('Codex exec does not include an authoritative tool inventory in its JSON event stream. Tools come from the installed Codex CLI, sandbox, skills, and local MCP configuration.');
        break;
      }
      if (!session.initData?.tools) {
        // iv-mode has no system/init event, so the authoritative tool list is
        // never exposed to the bridge. Be honest rather than implying there's
        // no session (the on-disk transcript only carries partial tool deltas).
        await sendReply("The tool list isn't available in interactive mode.");
        break;
      }
      const tools = session.initData.tools;
      const mcpTools = tools.filter(t => t.startsWith('mcp__'));
      const builtIn = tools.filter(t => !t.startsWith('mcp__'));

      // Plain text
      let plainMsg = `Built-in tools (${builtIn.length}):\n${builtIn.join(', ')}\n\n`;
      const grouped = {};
      for (const t of mcpTools) {
        const tParts = t.split('__');
        const server = tParts[1] || 'unknown';
        if (!grouped[server]) grouped[server] = [];
        grouped[server].push(tParts[2] || t);
      }
      if (mcpTools.length > 0) {
        plainMsg += `MCP tools:\n`;
        for (const [server, serverTools] of Object.entries(grouped)) {
          plainMsg += `  ${server} (${serverTools.length}): ${serverTools.join(', ')}\n`;
        }
      }

      // HTML
      let htmlMsg = `<b>Built-in tools (${builtIn.length})</b><br/>` +
        builtIn.map(t => `<code>${escapeHtml(t)}</code>`).join(', ');
      if (mcpTools.length > 0) {
        for (const [server, serverTools] of Object.entries(grouped)) {
          htmlMsg += `<details><summary><b>${escapeHtml(server)}</b> (${serverTools.length})</summary>` +
            serverTools.map(t => `<code>${escapeHtml(t)}</code>`).join(', ') +
            `</details>`;
        }
      }

      await sendHtml(plainMsg, htmlMsg);
      break;
    }

    default:
      break;
  }
}

// --- Journal Input Consumer (Matron -> bridge; the return path) ---
//
// lib/journal-input-router.js owns the filter/dispatch skeleton: the
// sender-based loop-prevention filter (only user:* is input — agent:*
// echoes of our own publishes, the common case, are ignored silently),
// control-convo-vs-session dispatch, and the liberal prompt-choice resolver.
// It's unit-tested in isolation against fakes; everything below is
// index.js-specific glue wired in as its injectable interfaces.

// Publish a short assistant-flavored notice directly into a journal convo,
// bypassing the session-keyed journalPublish buffering — used when there may
// be no live session object for the target convo (e.g. a reply for a
// session that no longer exists) or for control-convo replies (which have no
// Matrix room / session at all). Fails open like every other journal call.
function journalPublishNotice(convoId, body) {
  if (!JOURNAL_ENABLED || !convoId) return;
  try {
    journalPublisher.publishText(convoId, { body, from: 'assistant' });
  } catch (e) {
    try { console.warn(`[journal-input] notice publish failed: ${e.message}`); } catch { /* logging must never throw */ }
  }
}

// Publish a picker card into a convo that has NO live session — the restart
// carry-on case, where the session is dead by construction. journalPublish /
// sendButtonMessage both key off a live session object, so this goes straight
// to the publisher; the upsert first is the protocol requirement described at
// journalPublish (the server hard-rejects publishes to convos it doesn't know).
// The frame registers itself as a picker on the way back in via the router's
// onJournalEvent observer, so nothing here has to touch pickerFrames.
//
// Returns whether the prompt actually got enqueued for send — the caller
// (publishRestartCarryOnCards) uses this to log honestly instead of assuming
// success. Both upsertConvo and safePublish (which backs publishPrompt) only
// report enqueue-time acceptance, not that the journal server received or
// accepted the frame — that's the best signal available synchronously, and
// is what "succeeded" means here. An exception (caught below) or a queue
// eviction is reported as failure; the caller's marker is already cleared by
// then (see takeStale above), so a false here means that card's interruption
// is now permanently lost — accepted, documented fire-once behavior, not
// something this function tries to fix.
function journalPublishCardForConvo(convoId, { question, options, mode = 'pick_one' }) {
  if (!JOURNAL_ENABLED || !convoId) return false;
  try {
    const upserted = journalPublisher.upsertConvo(convoId, {});
    const published = journalPublisher.publishPrompt(convoId, { question, options, mode });
    return upserted !== false && published !== false;
  } catch (e) {
    try { console.warn(`[inflight] card publish failed for convo=${convoId}: ${e.message}`); } catch { /* logging must never throw */ }
    return false;
  }
}

// "about 4 minutes ago" — deliberately coarse. The card is telling the user
// roughly how stale the interrupted work is so they can judge whether carrying
// on still makes sense, not timing it.
function formatInterruptedAgo(ageMs) {
  const mins = Math.round(ageMs / 60_000);
  if (mins < 1) return 'less than a minute ago';
  if (mins === 1) return 'about a minute ago';
  if (mins < 60) return `about ${mins} minutes ago`;
  const hours = Math.round(ageMs / 3_600_000);
  return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
}

// Echo something into a session's Matrix room WITHOUT re-mirroring it into
// the journal (sendToRoom's default behavior publishes a from:'assistant'
// text event for everything it sends — see its own comment — which for an
// echo of content the journal already has would be exactly the re-publish
// loop this return path exists to avoid). Fire-and-forget: Matrix delivery
// failures here must never affect journal-side processing.
function journalEchoToRoom(session, plain, html) {
  if (!session || !session.roomId) return;
  sendToRoom(session.roomId, plain, html, { skipJournalMirror: true }).catch(() => {});
}

function journalEchoPromptAnswer(session, username, label) {
  journalEchoToRoom(session,
    `📱 ${username} answered: ${label}`,
    `📱 <b>${escapeHtml(username)} answered:</b> ${escapeHtml(label)}`);
}

// ctx for a session-scoped command dispatch (Deliverable 1/2, journal side):
// replies go through the NORMAL sendToRoom for the session's Matrix room —
// which already mirrors to the journal, so both surfaces see the command's
// output — and the command text itself was already echoed into the room by
// journalOnText (the "📱 dan (Matron): ..." line) before this ever runs, so
// the room reads as a complete transcript of what was asked. `sender` is who
// a command like !start/!resume/!workdir invites into any NEW room it
// creates; the bridge is single-user, so ALLOWED_USER_IDS[0] is the only
// sane choice — the same assumption journalHandleControlCommand's
// control-convo dispatch makes below.
function journalSessionCommandCtx(session) {
  return {
    sendReply: (reply) => sendToRoom(session.roomId, reply, markdownToHtml(reply)),
    sendHtml: (plainText, html) => sendToRoom(session.roomId, plainText, html),
    sender: ALLOWED_USER_IDS[0],
  };
}

// text -> session. Mirrors the ordering a Matrix reply goes through —
// bridge-intercepted !/ command dispatch (classifyBridgeCommand +
// handleCommand — Deliverable 1/2, see lib/command-dispatch.js),
// pending-TUI-prompt resolution (maybeResolveInteractivePrompt, same
// parseOptionReply-driven logic a typed Matrix reply uses), the
// detector-missed "unclassified prompt" menu guard, print-mode
// AskUserQuestion resolution, the plan-mode `build` keyword
// (dispatchPlanBuild + the shared approvePlanBuild), iv-mode PTY rescue
// keystrokes (classifyRescueKeystroke), THEN busy-queueing (with the same
// TUI-slash-passthrough bypass Matrix uses), THEN a normal turn — using the
// exact same session state (queuedMessages, pendingInteractivePrompt,
// pendingUnclassifiedPrompt) a Matrix message would, rather than a second
// parallel queue. Every downstream call passes the mirror-bypass flag: the
// journal already has this text as the client's own `send` row, so nothing
// here may publish a duplicate agent-sourced echo of it.
//
// Scope note: the busy-queue magic words (bare "send"/"interrupt"/"cancel")
// are reproduced below via the shared lib/busy-queue.js implementation the
// Matrix busy branch also uses — feedback is a fresh text, and the Matrix
// "📨 Queued" tiles are maintained exactly like their Matrix counterparts
// (cancel pops-and-edits the cancelled tile; send clears + strips the rest
// — cross-transport display parity). Everything a plain typed reply — or a
// bridge command — can do, a Matron text message can do too.

// Non-Matrix replacement for the deleted stripQueueNotificationLinks: its
// Matrix tile-edit loop is gone along with outbound Matrix sends (Task 3),
// but lib/busy-queue.js's 'send'/'interrupt' flush paths still rely on this
// seam to clear session.queueNotifications when the queue empties — skip it
// and a later re-queued message misaligns against stale notif entries (the
// PR #104 Bugbot finding this array exists to prevent). The 'cancel'/
// 'cancel:<n>' paths don't need this: their notif pop/splice already runs
// unconditionally, independent of the (now Matrix-only, now null) editMessage
// seam.
function clearQueueNotifications(session) {
  session.queueNotifications = [];
}

async function journalRouteTextToSession(session, body) {
  const trimmed = (body || '').trim();
  if (!trimmed) return;

  // Bridge-intercepted !/ commands run FIRST, before any prompt/menu
  // resolution below — exactly where Matrix's room.message handler checks
  // them (before the message is even routed to a session at all) — so e.g.
  // /stop always stops the session even while a TUI menu is open. Replay
  // guard: flushCursor synchronously before dispatch (inside
  // dispatchJournalBridgeCommand), so a crash inside the cursor's debounce
  // window can't replay an already-dispatched destructive command
  // (!restart, !stop) on bridge restart — same guard journalOnPromptReply
  // and the control-convo route already have.
  const dispatchedCommand = await dispatchJournalBridgeCommand(trimmed, {
    flushCursor: () => journalPublisher.flushCursor(),
    runBridgeCommand: (normalizedCommand) => {
      const ctx = journalSessionCommandCtx(session);
      return handleCommand(session.roomId, normalizedCommand, ctx.sendReply, ctx.sendHtml, ctx.sender);
    },
    // Safety net for JOURNAL_UNAVAILABLE_COMMANDS (currently empty — see
    // that constant's comment in lib/command-dispatch.js for the mapping):
    // never silently fall through to Claude as text, never crash.
    notAvailable: (cmdName) => {
      const ctx = journalSessionCommandCtx(session);
      return ctx.sendReply(`/${cmdName} isn't available from Matron.`);
    },
  });
  if (dispatchedCommand) return;

  if (session.iv && maybeResolveInteractivePrompt(session, trimmed, { mirrorToJournal: false })) {
    session.pendingUnclassifiedPrompt = false;
    return;
  }

  if (session.pendingUnclassifiedPrompt && session.iv && session.iv.alive && !trimmed.startsWith('!')) {
    if (/^\d{1,3}$/.test(trimmed)) {
      session.pendingUnclassifiedPrompt = false;
      session.iv.respondToPrompt({ kind: 'numbered', key: trimmed }, { resetDetector: false });
      return;
    }
    if (/^[a-zA-Z]$/.test(trimmed)) {
      session.pendingUnclassifiedPrompt = false;
      session.iv.respondToPrompt({ kind: 'lettered', key: trimmed }, { resetDetector: false });
      return;
    }
    // Not a valid selector — do NOT type it into the still-open menu (same
    // PTY-desync risk the Matrix path guards against). Notice instead of
    // silently dropping it.
    journalPublishNotice(journalConvoIdFor(session),
      "That doesn't look like one of the options. Reply with the option number shown, or send !esc to cancel the menu.");
    return;
  }

  if (session.waitingForAnswer) {
    const q = session.pendingQuestions?.[0];
    if (q?.options?.length > 0) {
      const answer = resolveQuestionAnswer(session, trimmed);
      const header = q.header ? `${q.header}: ` : '';
      submitAnswer(session, `${header}${answer}`, { mirrorToJournal: false });
    } else {
      submitAnswer(session, trimmed, { mirrorToJournal: false });
    }
    return;
  }

  // Plan-mode `build` keyword — the SAME decision gate and approval
  // implementation as the Matrix handler (dispatchPlanBuild +
  // approvePlanBuild), checked at the same position in the ordering: after
  // prompt/menu/question resolution, before rescue keystrokes and
  // busy-queueing. With no pending plan, `build` falls through and routes to
  // Claude as ordinary text, exactly like Matrix. The "▶️ Building..."
  // notice goes through the session ctx's sendHtml (sendToRoom), which
  // mirrors into the journal like every other bridge reply.
  const dispatchedBuild = await dispatchPlanBuild(
    trimmed,
    !!(session.pendingPlan || session.pendingPlanDenialId || session.ivPendingPlanToolUseId),
    {
      approvePlan: () => {
        const ctx = journalSessionCommandCtx(session);
        return approvePlanBuild(session, { sendHtml: ctx.sendHtml });
      },
    },
  );
  if (dispatchedBuild) return;

  // iv-mode PTY rescue keystrokes (!enter/!esc/!escape/!stop) — same
  // classifier and same session.iv.sendKeystroke calls the Matrix handler
  // uses, checked at the same point in the order (after prompt/menu/question
  // resolution, before busy-queueing), so e.g. the unclassified-menu
  // guidance to "send !esc to cancel" works identically from Matron. Same
  // replay guard as the bridge-command dispatch above (inside
  // dispatchJournalRescueKeystroke): !esc/!enter have real side effects
  // (keystrokes into the TUI, clearing busy state). Print-mode sessions
  // route !esc/!escape to printModeInterrupt via the printActive branch
  // instead.
  const dispatchedRescue = await dispatchJournalRescueKeystroke(trimmed, !!(session.iv && session.iv.alive), {
    flushCursor: () => journalPublisher.flushCursor(),
    sendRescueKeystroke: async (rescue) => {
      const ctx = journalSessionCommandCtx(session);
      if (rescue === 'enter') {
        try {
          session.iv.sendKeystroke('enter');
          ctx.sendReply('↵ Sent Enter to claude. If you had text queued in the input box, it should submit now.');
        } catch (err) {
          ctx.sendReply(`Could not send Enter: ${err.message}`);
        }
        return;
      }
      try {
        session.iv.sendKeystroke('esc');
        session.pendingUnclassifiedPrompt = false;
        if (session.busy) {
          session.busy = false;
          // Esc cancels the turn: the user deliberately ended it, so there is
          // nothing to carry on. (If the Stop hook still fires, onTurnEnd's
          // noteTurnEnd is a harmless no-op.)
          inflightMarker.noteTurnEnd(journalConvoIdFor(session));
        }
        ctx.sendReply('⎋ Sent Esc to claude (cancels the current turn / dismisses prompts).');
      } catch (err) {
        ctx.sendReply(`Could not send Esc: ${err.message}`);
      }
    },
    printActive: !!(session.proc && session.alive && !(session.iv && session.iv.alive)),
    sendPrintInterrupt: async () => {
      const ctx = journalSessionCommandCtx(session);
      await printModeInterrupt(session, (m) => ctx.sendReply(m));
    },
  });
  if (dispatchedRescue) return;

  if (session.busy) {
    // TUI-native slash commands bypass queueing exactly like Matrix's
    // isClaudeSlashCommand check: it's PTY input for claude's own command
    // palette, not a new chat turn, so it must reach claude immediately even
    // mid-turn. `//` escapes this (queues like ordinary text) — same rule
    // Matrix uses (isIvSlashPassthrough, lib/command-dispatch.js).
    if (session.iv && isIvSlashPassthrough(trimmed)) {
      sendTextToSession(session, trimmed, { skipJournalMirror: true });
      return;
    }
    // Busy-queue magic words — the SAME classifier and implementation the
    // old Matrix busy branch used (lib/busy-queue.js), checked at the same
    // point (busy, not a TUI slash passthrough). Feedback goes through
    // ctx.sendReply — a fresh sendToRoom text that also mirrors into the
    // journal, like every other command reply. The Matrix tile-edit half of
    // the PR #104 seams is gone (outbound Matrix sends retired, Task 3):
    // editMessage is null (lib/busy-queue.js no-ops it), and
    // stripQueueNotificationLinks is now clearQueueNotifications — same
    // array-clearing effect minus the Matrix edit loop, still needed so a
    // 'send'/'interrupt' flush doesn't leave stale notif entries to misalign
    // a later re-queue (see clearQueueNotifications above). Kept as named
    // keys (rather than omitted) so the wiring stays self-documenting and
    // the source-inspection pin in test/busy-queue.test.js still finds both
    // identifiers. Only sendHtml is omitted: journal feedback stays plain. A
    // flush still goes through the one true flushQueue (single merged send +
    // origin-aware mirroring, PR #100) — never a second flush path.
    const ctx = journalSessionCommandCtx(session);
    const handledMagicWord = await dispatchBusyQueueMagicWord(trimmed, session, {
      sendReply: ctx.sendReply,
      formatQueueSummary,
      flushQueue,
      stripQueueNotificationLinks: clearQueueNotifications,
      editMessage: null,
      queueRelease: queueReleaseForBatch(session, pendingFlushBatch(session)),
      convoId: journalConvoIdFor(session),
      emitRelease,
    });
    if (handledMagicWord) return;
    // Queue like a Matrix message would, but marked journal-origin so the
    // eventual flushQueue send skips the journal mirror — the journal
    // already has this text as the client's own send row, and re-mirroring
    // on flush would show a duplicate in Matron (see lib/queue-flush.js).
    if (!session.queuedMessages) session.queuedMessages = [];
    // /compact jumps the queue and travels alone (lib/compact-priority.js).
    // Unshifting is what makes the jump real, and it also gives the flush side
    // its invariant: a queued compact is always at index 0, so the batch stays
    // a PREFIX of the queue and queuedMessages/queueNotifications keep
    // splitting on the same slice. `//compact` escapes this and queues as
    // ordinary text, same as everywhere else.
    const compactJump = isCompactCommand(trimmed);
    // Only ONE /compact may wait: flushes send the front compact ALONE, so a
    // second queued compact wouldn't merge — it would run a second compaction
    // right after the first. Refuse the repeat before the entry, the "📨
    // Queued" tile, and the release registration exist for it.
    if (compactJump && hasQueuedCompact(session.queuedMessages)) {
      await ctx.sendReply('🗜️ /compact is already queued — it will run as soon as this turn finishes.');
      return;
    }
    const entry = markJournalOrigin([{ type: 'text', text: trimmed }]);
    if (compactJump) session.queuedMessages.unshift(entry);
    else session.queuedMessages.push(entry);
    // Post the SAME "📨 Queued" tile a Matrix-origin queue gets (shared
    // notifyQueuedMessage, lib/busy-queue.js). Until this call existed a
    // Matron send queued silently — session.sendButtonMessage both posts
    // the Matrix tile and journal-publishes the prompt, so the app renders
    // the notification card too. No signed-link fallback here: journal
    // feedback degrades to the plain ctx.sendReply text, which also
    // mirrors into the journal.
    const preview = trimmed.length > 40 ? trimmed.slice(0, 37) + '…' : trimmed;
    await notifyQueuedMessage(session, preview, {
      sendReply: ctx.sendReply,
      htmlEscape: escapeHtml,
      queueRelease: journalInputConsumer.queueRelease,
      convoId: journalConvoIdFor(session),
      fullText: trimmed,
      compactJump,
    });
    return;
  }

  sendTextToSession(session, trimmed, { skipJournalMirror: true });
}

// prompt_reply -> pending prompt. Resolves `choice`/`text` against whichever
// pending-prompt shape the session currently has, then answers through the
// SAME primitives a Matrix button tap or typed reply uses
// (session.iv.respondToPrompt / submitAnswer) — never journalMirrorUserAnswer
// or submitAnswer's own mirroring path: the prompt_reply journal row already
// records the user's answer, so mirroring it again would duplicate it.
// Returns the resolved answer's label (for the Matrix echo), or null if
// nothing could be resolved (no pending prompt, or an unmatched choice with
// no usable free text).
function journalRoutePromptReply(session, { choice, text }) {
  // iv-mode: a structured, button-shaped pending prompt. promptButtons(p)
  // reproduces the exact `options` shape journaled for the `prompt` event
  // (see lib/prompt-buttons.js) — matching against it is matching against
  // what Matron was actually shown.
  if (session.iv && session.pendingInteractivePrompt) {
    const p = session.pendingInteractivePrompt;
    const built = promptButtons(p);
    if (built) {
      const resolved = resolvePromptChoice(built.buttons, choice);
      if (resolved) {
        const resp = promptResponseForButton(p, resolved.index);
        if (resp) {
          if (session.iv.respondToPrompt(resp) !== true) return null;
          session.pendingInteractivePrompt = null;
          session.pendingUnclassifiedPrompt = false;
          recordUserAnswer(session, resolved.option.label, { mirrorToJournal: false });
          return resolved.option.label;
        }
      }
    }
    // No option match (or promptButtons() returned null — a free-text-only /
    // multi-select prompt that was never journaled as structured `prompt`
    // options in the first place). Fall back to the prompt's own free-text
    // slot when it has one and Matron sent usable free text.
    const hasFreeText = typeof p.freeTextIdx === 'number' && p.freeTextIdx >= 0 && p.freeTextIdx < p.options.length;
    if (hasFreeText && typeof text === 'string' && text.trim()) {
      const idx = p.freeTextIdx;
      const opt = p.options[idx];
      const ftResponse = p.kind === 'arrow-menu' ? { kind: 'arrow-menu', key: String(idx) } : { kind: p.kind, key: opt.key };
      const freeText = text.trim();
      const dispatched = sendDelayedPromptAnswer(session, {
        response: ftResponse,
        text: freeText,
        onDelivered: () => recordUserAnswer(session, freeText, { mirrorToJournal: false }),
        onError: (error) => reportPromptAnswerDeliveryFailure(session, error),
      });
      if (!dispatched) return null;
      session.pendingInteractivePrompt = null;
      return freeText;
    }
    return null;
  }

  // print-mode: AskUserQuestion pending. Same option-id convention
  // sendAllQuestions uses when building Matrix buttons (opt_a, opt_b, …) so a
  // choice sent by id round-trips correctly.
  if (session.waitingForAnswer && session.pendingQuestions?.length) {
    const q = session.pendingQuestions[session.currentQuestionIndex] || session.pendingQuestions[0];
    const options = (q.options || []).map((opt, idx) => ({
      id: `opt_${String.fromCharCode(97 + idx)}`,
      label: typeof opt.label === 'string' ? opt.label : String(opt),
    }));
    let answerText;
    if (options.length > 0) {
      const resolved = resolvePromptChoice(options, choice);
      answerText = resolved ? resolved.option.label : (typeof text === 'string' && text.trim() ? text.trim() : null);
    } else {
      answerText = typeof text === 'string' && text.trim() ? text.trim() : null;
    }
    if (!answerText) return null;
    const header = q.header ? `${q.header}: ` : '';
    submitAnswer(session, `${header}${answerText}`, { mirrorToJournal: false });
    return answerText;
  }

  return null;
}

// Adapts journalRouteTextToSession to the router's routeTextToSession(session,
// body, {username}) interface: echoes the incoming message into the
// session's Matrix room (so the room stays a complete transcript regardless
// of which client sent a given message), then routes it in.
function journalOnText(session, body, { username }) {
  journalEchoToRoom(session, `📱 ${username} (Matron): ${body}`, `📱 <b>${escapeHtml(username)} (Matron):</b> ${escapeHtml(body)}`);
  // journalRouteTextToSession is async (command dispatch awaits
  // handleCommand) — not awaited here, matching the router's fire-and-forget
  // contract for routeTextToSession, but errors must still be caught so a
  // thrown/rejected dispatch can never crash the consumer.
  journalRouteTextToSession(session, body).catch((e) => {
    console.warn(`[journal-input] routing text to session failed: ${e.message}`);
    journalPublishNotice(journalConvoIdFor(session), `⚠️ Could not deliver your message: ${e.message}`);
  });
}

// media (file/image/voice-note) -> session. Thin wiring around the injectable
// lib/journal-media.js orchestrator: the router hands us a resolved
// {type, blobRef, contentType, name, size, dims, caption}; the orchestrator
// fetches the blob back out of the journal blob store and feeds it to the
// session exactly the way the Matrix media path does — audio transcribed and
// injected as if the user typed it, images/files saved to the same per-session
// location and attached to the next prompt. buildSavedMediaBlocks handles the
// caption in both modes — iv folds it into the upload annotation (ivHandled),
// SDK leads with it as a text block — so the orchestrator must NOT append it
// again (an earlier easelyte design tail-appended in SDK mode; that was
// superseded on the 2026-07-20 upstream sync). Fire-and-forget: the
// orchestrator's returned function never throws/rejects (it swallows
// internally), matching the router's contract for routeMediaToSession.
// Nothing here re-mirrors the blob into the journal — the client's own
// file/image event is already there — so file/image injection passes
// skipJournalMirror; a voice note's transcript IS published (as the user's
// message, via sendTextToSession) so it's visible in the journal too,
// mirroring what the Matrix m.audio path records.
const journalMediaRouter = createJournalMediaRouter({
  fetchMedia: (blobRef) => journalPublisher.fetchMedia(blobRef),
  transcribe: (buffer, mime) => transcribeAudio(buffer, mime, { modelPath: WHISPER_MODEL_PATH, language: WHISPER_LANGUAGE }),
  buildSavedBlocks: async (session, { buffer, mime, isImage, name, dims, caption }) => {
    const safeName = safeMediaFilename(name);
    // Downscale/skip decision for the INLINE copy only (iv mode never inlines,
    // so don't burn a decode there). The original buffer still goes to disk.
    let inline = null;
    if (!session.iv && (isImage || (typeof mime === 'string' && mime.startsWith('image/')))) {
      inline = await prepareInlineImage(buffer, mime);
      if (inline.action === 'replace') {
        console.log(`[journal-media] inline image downscaled: ${buffer.length}B ${mime} -> ${inline.buffer.length}B ${inline.mediaType} ${inline.width}x${inline.height}`);
      } else if (inline.action === 'skip') {
        console.warn(`[journal-media] inline image skipped (${inline.reason}); full file still saved for Read`);
      }
    }
    return buildSavedMediaBlocks(session, {
      buffer, mime, dims: dims || undefined, isImage,
      ivFilename: safeName, caption, workdirName: safeName, inline,
    }).blocks;
  },
  injectText: (session, text) => sendTextToSession(session, text),
  injectBlocks: (session, blocks) => sendToSession(session, blocks, { skipJournalMirror: true }),
  queueMedia: (session, entry) => journalQueueMedia(session, entry),
  echoToRoom: journalEchoToRoom,
  publishNotice: journalPublishNotice,
  escapeHtml,
  log: console,
});

// Queue a prepared media injection while the session is busy — the media
// counterpart of the journal text busy-queue branch (journalRouteTextToSession)
// and the Matrix busy media branch (room.message handler). Pushes the
// already-fetched/built blocks onto the SAME session.queuedMessages a Matrix or
// journal-text message uses (never a second queue), so the shared flushQueue
// (one merged sendToSession at turn end) delivers them in arrival order with any
// interleaved queued text, and posts the SAME "📨 Queued" tile via the shared
// notifyQueuedMessage.
//
// The queued entry is a spread COPY of blocks: buildSavedMediaBlocks attaches a
// non-enumerable pending-media-mirror tag, and a spread drops it so the flush
// can't re-mirror a file the journal already recorded as the client's own
// event. mirrorToJournal picks the origin: a voice-note transcript stays
// Matrix-origin so flushQueue's mirrorText journal-publishes it (matching the
// immediate sendTextToSession); a saved file/image is marked journal-origin so
// it never re-mirrors. Async: notifyQueuedMessage awaits the tile send, exactly
// like the text path.
async function journalQueueMedia(session, { blocks, mirrorToJournal, preview, fullText }) {
  if (!session.queuedMessages) session.queuedMessages = [];
  const entry = [...blocks];
  if (!mirrorToJournal) markJournalOrigin(entry);
  session.queuedMessages.push(entry);
  const ctx = journalSessionCommandCtx(session);
  // The queued tile is cosmetic: the entry above IS queued and will flush at
  // turn end regardless, so a notify failure must not propagate — the
  // router's catch would otherwise publish a false "wasn't delivered" notice
  // for media that will in fact be delivered.
  try {
    await notifyQueuedMessage(session, preview, {
      sendReply: ctx.sendReply,
      htmlEscape: escapeHtml,
      queueRelease: journalInputConsumer.queueRelease,
      convoId: journalConvoIdFor(session),
      fullText,
    });
  } catch (e) {
    console.warn(`[journal-media] queued-tile notify failed (media is queued): ${e.message}`);
  }
}

function journalOnMedia(session, media, ctx) {
  journalMediaRouter(session, media, ctx);
}

// Adapts journalRoutePromptReply to the router's routePromptReply(session,
// {target_seq, choice, text}, {username}) interface.
function journalOnPromptReply(session, answer, { username }) {
  // Command-replay guard: a prompt answer has side effects (keystrokes into
  // the TUI / a tool_result write), so an ungraceful crash inside the
  // cursor's ~1s debounce window must not replay it on restart. The frame's
  // seq was recorded before onEvent fired; force it to disk now.
  journalPublisher.flushCursor();
  // The router proves queue-card provenance from target_seq membership before
  // calling us. Re-resolve the live registry entry here, where the session
  // arrays and queue mutation seams are available. An ordinary prompt choice
  // named "send" or "cancel" remains an ordinary answer because its seq is
  // unknown to this registry.
  const convoId = journalConvoIdFor(session);
  const queuedRelease = journalInputConsumer.queueRelease.classifyBySeq(
    convoId,
    answer?.target_seq,
  );
  if (queuedRelease.state === 'live') {
    resolveQueueReleaseTap(answer.choice, session, {
      flushQueue,
      stripQueueNotificationLinks: clearQueueNotifications,
      entry: queuedRelease.entry,
      convoId,
      queueRelease: queueReleaseForBatch(session, pendingFlushBatch(session)),
      emitRelease,
      // A tap has no reply text of its own — the durable queued_release
      // prompt_reply is the record. But the release retires the card (and
      // with it the only preview of what was queued), so the tap path also
      // echoes the batch content at the point of sending — same contract as
      // the turn-end "📬 Sending …" flush — and a compact split says the
      // other cards are still waiting rather than leaving them silently
      // un-actioned.
      notify: (message) => journalPublishNotice(convoId, message),
      formatQueueSummary,
    });
    return;
  }
  // Picker taps (/model, /effort, /mode): the router is the single source of
  // truth for picker-vs-answer. It sets `answer.picker` ONLY when the reply's
  // target_seq named a picker frame the bridge published AND the choice was one
  // of that frame's own offered values (lib/journal-input-router.js). We trust
  // that flag and dispatch to the SAME switch fns the explicit-arg !model /
  // !effort / !mode handlers call — never re-guessing by value shape, so a
  // genuine answer whose label merely looks like a picker value is never
  // hijacked, and a verified picker tap is never swallowed as a prompt answer.
  // A picker answers no pending prompt, so (like the queue-action block above)
  // it emits no "answered:" echo.
  if (answer?.picker) {
    // Timer-cancel taps skip the alive gate: like the !timer command itself
    // (PR #171), cancelling only needs the convo-scoped store, and the timer
    // may well outlive the session process it was set from.
    const isTimerTap = typeof answer.choice === 'string' && answer.choice.startsWith('timer:');
    // Restart carry-on taps skip the alive gate for the same reason timer taps
    // do, only more so: the card is published at boot into a convo whose
    // session is dead BY CONSTRUCTION, and reviving it is the entire point of
    // the button. The router normally auto-resumes before dispatch so `session`
    // is already live here, but it only does that when no session object was
    // found at all — a dead-but-present one (mid-teardown, or a Codex logical
    // session between turns) would otherwise be refused here with a message
    // about model/effort/mode switching and burn the single-use card.
    // carryOnConvo does its own lookup/resume for exactly that case. Matching
    // on value shape is safe inside this branch: `answer.picker` already proves
    // the router verified the choice against the offered values of a picker
    // frame this bridge published.
    const isCarryOnTap = typeof answer.choice === 'string' && answer.choice.startsWith('resume:');
    if (!session.alive && !isTimerTap && !isCarryOnTap) {
      journalPublishNotice(journalConvoIdFor(session), 'No active session — start one before switching model, effort, or mode.');
      return;
    }
    const ctx = journalSessionCommandCtx(session);
    handlePickerValue(answer.choice, session.roomId, session, {
      applyModelSwitch,
      switchEffortInSession,
      applyModeSwitch,
      cancelTimer: cancelTimerFromButton,
      sendTimerNow: sendTimerNowFromButton,
      carryOnConvo,
      sendReply: ctx.sendReply,
      sendHtml: ctx.sendHtml,
    });
    return;
  }
  // Not a picker command — resolve it as an answer to a pending prompt.
  let label;
  try {
    label = journalRoutePromptReply(session, answer);
  } catch (e) {
    console.warn(`[journal-input] routing prompt_reply failed: ${e.message}`);
    journalPublishNotice(journalConvoIdFor(session), `⚠️ Could not deliver your answer: ${e.message}`);
    return;
  }
  if (label == null) {
    console.warn(`[journal-input] prompt_reply with no resolvable pending prompt for convo=${journalConvoIdFor(session)}`);
    journalPublishNotice(journalConvoIdFor(session), "Nothing to answer right now — there's no open prompt in this session.");
    return;
  }
  journalEchoPromptAnswer(session, username, label);
}

function journalIsControlConvo(convoId) {
  return convoId === JOURNAL_CONTROL_CONVO_ID;
}

// Control-convo commands (Deliverable 3). Reuses the SAME shared dispatcher
// (handleCommand) and command surface (BRIDGE_COMMAND_NAMES,
// lib/command-dispatch.js) the Matrix control room's !start/!sessions/!help
// etc. use, via a synthetic "room" — JOURNAL_CONTROL_CONVO_ID, a string
// that can never collide with a real Matrix room ID (those are always
// `!opaque:server`). handleCommand's own `sessions.get(roomId)` naturally
// resolves to undefined for that synthetic ID, which reproduces exactly the
// behavior a fresh, session-less Matrix room already has: /start, /resume,
// and /workdir create a brand new session (same
// newSessionConvoId/createSession primitives, same argument handling
// including default workdir and --browser extras); every session-scoped
// command (/status, /stop, /mcp, /model, …) correctly reports "No active
// session" rather than doing something wrong; /limits (not session-scoped)
// works for real. This is what makes /resume and the rest "free" per the
// brief — nothing journal-specific had to be written for any of them.
async function journalHandleControlCommand(body) {
  const reply = (text) => journalPublishNotice(JOURNAL_CONTROL_CONVO_ID, text);
  const decision = classifyJournalControlCommand(body);

  if (decision.kind === 'help') {
    reply(JOURNAL_CONTROL_HELP);
    return;
  }

  // Same JOURNAL_UNAVAILABLE_COMMANDS safety net the session-command path
  // has (currently empty — see the constant's comment): a future
  // Matrix-only command must be refused from BOTH journal paths.
  if (decision.kind === 'unavailable') {
    reply(`/${decision.cmd} isn't available from Matron.`);
    return;
  }

  const { cmd, normalizedText } = decision;
  const sender = ALLOWED_USER_IDS[0];

  if (cmd === 'help') {
    // handleCommand's '!help' calls sendHtml(plain, html) — intercept so we
    // can append the Matron-specific note to the SAME real help text
    // instead of re-deriving/duplicating it.
    await handleCommand(JOURNAL_CONTROL_CONVO_ID, normalizedText, reply,
      (plainText) => reply(plainText + JOURNAL_CONTROL_HELP_NOTE), sender);
    return;
  }

  // Every other command: plain-text reply sink for both sendReply and
  // sendHtml (the control convo has no HTML rendering — same choice
  // journalPublishNotice/journalEchoToRoom's callers make elsewhere).
  await handleCommand(JOURNAL_CONTROL_CONVO_ID, normalizedText, reply,
    (plainText) => reply(plainText), sender);
}

// Journal-side auto-resume (the router's resumeSessionForConvo seam): the
// idle reaper kills sessions on the assumption that "the next user message
// auto-resumes" them — which the Matrix room path does, but the journal path
// used to dead-end with "no longer active". A convo id IS the persisted
// claude session id, so scan persisted sessions for it and respawn through
// the SAME helper the Matrix path uses (resumePersistedSession — hoisted,
// defined next to the Matrix handler below). Returns the new session for the
// router to route the triggering text or media into (delivery is safe:
// sendToSession holds input in _resumeOutbox until the resumed TUI is ready,
// and print mode's stdin buffers), or null to fall back to the unknown-convo
// notice.
function journalResumeConvo(convoId) {
  const data = loadPersistedSessions();
  for (const [roomId, prev] of Object.entries(data)) {
    if (!prev || (prev.journalConvoId !== convoId && prev.sessionId !== convoId)) continue;
    const existing = sessions.get(roomId);
    // A live session in this room under a DIFFERENT claude session id means
    // this convo is stale history (the room has moved on) — don't hijack it.
    if (existing && existing.alive) return null;
    if (existing) sessions.delete(roomId);
    console.log(`[journal-input] auto-resuming reaped session ${convoId} in ${roomId}`);
    journalPublishNotice(convoId, '⏳ Session was idle — auto-resuming it now. Your message will be delivered as soon as it\'s ready.');
    // This notice IS the journal's resume announcement — tell the shared
    // helper not to also mirror its room-facing "Auto-resuming session…"
    // notice into the journal, or Matron users see both.
    return resumePersistedSession(roomId, prev, { skipJournalMirror: true });
  }
  return null;
}

// Canonical HTTP-side permission registry. Keys are the full P56 tuple with
// a NUL separator (`convo_id + "\0" + tool_use_id`);
// journalConvoIdFor(session) and inbound
// frame.convo_id provide the same stable conversation identity without
// plumbing a transport-specific session_id through the router.
const pendingPermissionDecisions = new Map();
const permissionSeams = createPermissionSeams({ pendingPermissionDecisions });

function resolveJournalPermissionReply(key, decision, { username } = {}) {
  const pending = pendingPermissionDecisions.get(key);
  const finalized = permissionSeams.resolvePermissionReply(key, decision, { username });
  if (!finalized || finalized.source !== 'operator') return false;
  const label = finalized.decision === 'allow' ? 'Allow' : 'Deny';
  journalEchoPromptAnswer(findSessionByClaudeSessionId(pending.convoId), username, label);
  return true;
}

// Assembled once and invoked from journalHandleInboundEvent (the `function`
// declaration wired into createJournalPublisher near the top of this file —
// hoisted, so that forward reference is safe). Permission registry operations
// come from the same factory exercised by the router contract tests.

// A "Carry on" tap. The router has already auto-resumed the session for a
// verified resume tap (lib/journal-input-router.js), so `session` is live by
// the time this runs; the lookup is a fallback for the ordering-independent
// case. The injected text is the literal string `carry on` — a deliberate
// choice recorded in the design spec, along with its trade-off: a turn killed
// mid-tool-call can leave the agent unable to tell whether a side-effecting
// action completed, so a re-run is possible.
//
// Never rejects: handlePickerValue dispatches every seam fire-and-forget (it
// is a sync function and does not await this one), so an escaping rejection
// would surface as an unhandled rejection rather than as a message to the
// user. Same stance as journalRouteTextToSession's other non-awaiting caller,
// the router's routeTextToSession adapter.
async function carryOnConvo(convoId, session, _sendReply) {
  try {
    let target = session && session.alive ? session : findSessionByClaudeSessionId(convoId);
    if (!target || !target.alive) target = journalResumeConvo(convoId);
    if (!target) {
      // A carry-on tap always originates in a Matron journal chat (the card
      // is only ever published there — see publishRestartCarryOnCards), so
      // the failure has to land in that SAME journal convo, exactly like the
      // catch block three lines below. `_sendReply` (journalSessionCommandCtx's
      // sendReply, which routes to the session's MATRIX room) is the wrong
      // surface here and is left unused rather than called — kept in the
      // signature only because handlePickerValue (lib/picker-dispatch.js)
      // positionally calls carryOnConvo(convoId, session, sendReply) and
      // test/picker-dispatch.test.js pins that three-argument contract.
      journalPublishNotice(convoId, '⚠️ That conversation can no longer be found or resumed.');
      return;
    }
    await journalRouteTextToSession(target, 'carry on');
  } catch (e) {
    console.warn(`[inflight] carry-on delivery failed for convo=${convoId}: ${e.message}`);
    journalPublishNotice(convoId, `⚠️ Could not carry on: ${e.message}`);
  }
}

// --- /timer scheduled messages ---
//
// A timer coming due. The record was already removed + persisted by the
// store before this runs (see lib/timer-command.js — a crash mid-delivery
// must lose the fire, never replay it). Delivery routes through
// journalRouteTextToSession, so the scheduled text behaves exactly like a
// message the user typed at fire time: bridge commands (/status, /stop)
// dispatch, TUI slash commands (/compact) pass through, busy sessions
// queue. If the idle reaper (or a bridge restart) took the session down in
// the meantime, revive it through the SAME journalResumeConvo path an
// ordinary inbound Matron message uses — that's what lets a 2h timer
// outlive the 1h idle reap. The notice below is the chat's visible record
// of the send: journalRouteTextToSession's delivery paths all skip the
// journal mirror (they assume the client already has its own send row,
// which a timer-fired message never does).
async function fireTimer(record) {
  let session = findSessionByClaudeSessionId(record.convoId);
  if (!session || !session.alive) session = journalResumeConvo(record.convoId);
  if (!session) {
    journalPublishNotice(record.convoId,
      `⏰ Timer #${record.id} fired, but this conversation's session can't be found or resumed — "${record.text}" was not delivered.`);
    return;
  }
  journalPublishNotice(journalConvoIdFor(session), `⏰ Timer #${record.id}: sending "${record.text}"`);
  await journalRouteTextToSession(session, record.text);
}

// One boot identity per bridge process — the whole of restart-carry-on
// detection is "this marker carries a bootId that isn't mine, so the run that
// wrote it is gone" (see lib/inflight-marker.js).
const BRIDGE_BOOT_ID = randomUUID();

const inflightMarker = createInflightMarker({
  load: () => (fs.existsSync(INFLIGHT_FILE) ? JSON.parse(fs.readFileSync(INFLIGHT_FILE, 'utf-8')) : null),
  // Atomic replace, same rationale as savePersistedSessions: a truncating
  // in-place write that dies mid-rewrite would silently drop every marker.
  save: (data) => atomicWriteFileSync(INFLIGHT_FILE, JSON.stringify(data, null, 2)),
  now: Date.now,
  bootId: BRIDGE_BOOT_ID,
  log: (msg) => { try { console.warn(`[inflight] ${msg}`); } catch { /* logging must never throw */ } },
});

const timerStore = createTimerStore({
  load: () => (fs.existsSync(TIMERS_FILE) ? JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf-8')) : null),
  // Atomic replace, same rationale as savePersistedSessions: a truncating
  // in-place write that dies mid-rewrite would silently drop every timer.
  save: (data) => atomicWriteFileSync(TIMERS_FILE, JSON.stringify(data, null, 2)),
  now: Date.now,
  setTimer: (fn, delay) => setTimeout(fn, delay),
  clearTimer: (handle) => clearTimeout(handle),
  onFire: (record) => {
    fireTimer(record).catch((e) => {
      try { console.warn(`[timer] #${record.id} delivery failed: ${e.message}`); } catch { /* logging must never throw */ }
    });
  },
  log: (msg) => { try { console.warn(`[timer] ${msg}`); } catch { /* logging must never throw */ } },
});

// A tap on a set-confirmation card's Cancel button (value timer:cancel:<id>,
// dispatched via lib/picker-dispatch.js). Same convo scoping and feedback as
// the typed `/timer cancel <id>` path in handleCommand — a tap on a timer
// that already fired (or was cancelled by text in the meantime) gets the
// "no such timer" reply rather than a silent no-op.
function cancelTimerFromButton(session, timerId, sendReply) {
  const convoId = journalConvoIdFor(session);
  const cancelled = convoId ? timerStore.cancel(convoId, timerId) : [];
  if (!cancelled.length) {
    sendReply(`No timer #${timerId} in this conversation — it may have already fired or been cancelled. /timer lists the active ones.`);
    return;
  }
  sendReply(`🚫 Cancelled timer #${cancelled[0].id} ("${cancelled[0].text}").`);
}

// A tap on the same card's Send-now button (value timer:send:<id>): deliver
// the scheduled message immediately instead of waiting out the delay. The
// store's fireNow routes through the SAME fire path as a natural expiry, so
// delivery gets the "⏰ Timer #N: sending …" notice and the auto-resume
// behavior for free — no extra success reply needed here. Only the
// nothing-matched case (already fired / cancelled elsewhere) speaks.
function sendTimerNowFromButton(session, timerId, sendReply) {
  const convoId = journalConvoIdFor(session);
  const fired = convoId ? timerStore.fireNow(convoId, timerId) : null;
  if (!fired) {
    sendReply(`No timer #${timerId} in this conversation — it may have already fired or been cancelled. /timer lists the active ones.`);
  }
}

// --- Agent-chat rooms (spec: agent chat phase 3) ---
// Persisted room↔session registry: which journal convos this bridge
// participates in as agent-chat rooms, and which local session each is bound
// to. Same atomic-replace persistence rationale as the timer store above.
const AGENT_ROOMS_FILE = path.join(os.homedir(), '.matron-bridge-agent-rooms.json');
const agentRooms = createAgentRooms({
  load: () => (fs.existsSync(AGENT_ROOMS_FILE) ? JSON.parse(fs.readFileSync(AGENT_ROOMS_FILE, 'utf-8')) : null),
  save: (data) => atomicWriteFileSync(AGENT_ROOMS_FILE, JSON.stringify(data, null, 2)),
  log: console,
});

// Inbound join_requests for rooms this bridge OWNS, held OUTSIDE the rooms
// registry: agentRooms.record() merges, so recording a third party's request
// would clobber state 'pending' over an already-'joined' owned room and
// repoint peerDeviceId at the newcomer — refusing the newcomer then flips
// the SHARED record terminal and kills routing to the real peer forever
// (whole-branch review, C1). roomId -> { deviceId, at }; read by the
// agent-chat handlers via the pendingPeerFor seam; in-memory only (an
// unanswered request is re-issuable and lapses with the invite TTL anyway).
const pendingJoinRequests = new Map();
function pendingPeerFor(roomId) {
  const entry = pendingJoinRequests.get(roomId);
  if (!entry) return null;
  if (Date.now() - entry.at > INVITE_TTL_MS) { pendingJoinRequests.delete(roomId); return null; }
  return entry.deviceId;
}

// A session that can't act on new input RIGHT NOW. `busy` covers a running
// turn; `_awaitingInputReady` covers the post-resume input hold, whose
// sendToSession branch buffers into _resumeOutbox and returns true WITHOUT
// setting busy — without this second check every room message during a
// resume hold would take the idle branch and be injected individually,
// defeating coalescing (Task 5 review, finding 9). `waitingForAnswer` and
// `pendingInteractivePrompt` cover open prompts: the prompt-surfacing paths
// deliberately CLEAR busy so the user's answer types into the PTY, and an
// "idle-branch" room injection there would answer a permission or
// AskUserQuestion prompt with `[room …] peer: …` (Task 6 review, C2).
function sessionOccupiedForRoomDelivery(session) {
  return !!session.busy || !!session._awaitingInputReady
    || !!session.waitingForAnswer || !!session.pendingInteractivePrompt;
}

// The one shared room-flush gate used by every turn-end/idle seam (and the
// journalOnRoomFrame self-heal): flush the coalesced room inbox ONLY when
// the session is genuinely free, by the SAME composite predicate that routes
// deliver()'s busy/idle branches — so the two can never disagree.
function maybeFlushRoomDelivery(session) {
  if (sessionOccupiedForRoomDelivery(session)) return;
  // Counted BEFORE the flush, which clears the inbox either way — this is the
  // number the ⏳ line left outstanding, and the number Dan is owed an outcome
  // for. Zero means there was no queued batch, so there is nothing to close
  // and no notice to publish (the ordinary idle path never queued anything).
  const queued = roomDelivery.pendingCount(session.roomId);
  const flushed = roomDelivery.flush(session, session.roomId);
  if (!queued) return;
  journalPublishNotice(
    journalConvoIdFor(session),
    flushed ? formatRoomDeliveredNotice(queued) : formatRoomDeliveryFailedNotice(queued),
  );
}

// Hybrid idle/busy delivery of room messages into local sessions
// (lib/room-delivery.js): idle sessions get one injected turn per message,
// occupied sessions accumulate a pending inbox flushed as one coalesced
// turn at the turn-end seams (finishCodexTurn, iv onTurnEnd, print-mode
// `case 'result'`). skipJournalMirror: the message already lives in the
// room convo — mirroring it into the session convo would duplicate it.
const roomDelivery = createRoomDelivery({
  isBusy: sessionOccupiedForRoomDelivery,
  injectTurn: (session, text) => sendTextToSession(session, text, { skipJournalMirror: true }),
  log: console,
});

// Per-room once-listener registry backing agent_chat_send's optional short
// reply wait (the awaitRoomMessage dep of lib/agent-chat.js;
// lib/room-reply-waiters.js). Fed from journalOnRoomFrame below so the
// handler module stays free of journal frame knowledge. A CONSUMED reply is
// the tool result itself and is NOT also delivered as a turn (see the
// resolve() short-circuit in journalOnRoomFrame).
const roomReplyWaiters = createRoomReplyWaiters();
function awaitRoomMessage(chatRoomId, ms) {
  return roomReplyWaiters.await(chatRoomId, ms);
}

// Router seam: a journal frame in an active room convo lands here instead of
// the main-convo input path. Formats the peer's message as a `[room …]` line
// and hands it to roomDelivery against the room's bound session.
function journalOnRoomFrame(room, frame) {
  const session = sessions.get(room.sessionRoomId);
  if (!session || !session.alive) {
    debug(`room frame for ${frame.convo_id} but session ${room.sessionRoomId} not live — dropping (agent_chat_read recovers)`);
    return;
  }
  const sender = frame.sender || '';
  const from = sender.startsWith('agent:') ? `${sender.slice(6)} (agent)` : sender.startsWith('user:') ? sender.slice(5) : sender;
  const payload = frame.payload || {};
  let body;
  if (frame.type === 'text') {
    body = typeof payload.body === 'string' ? payload.body.trim() : '';
  } else {
    const kind = frame.type === 'image' ? 'image' : 'file';
    // Carry the blob_ref (whole-branch review, M1): the name alone gives the
    // receiving agent nothing to fetch. Same rendering as agent_chat_read's
    // attachment lines (lib/agent-chat.js shapeMessages).
    body = `[sent ${kind} "${payload.name || 'unnamed'}"${payload.blob_ref ? ` (blob ${payload.blob_ref})` : ''}${payload.caption ? `: ${payload.caption}` : ''}]`;
  }
  if (!body) return;
  // The user's copy of the peer's message. The agent-facing injection below
  // passes skipJournalMirror (the message is durable in the room convo), so
  // without this the session conversation shows the agent's REPLY to a peer
  // and never the message it was replying to — "it just looks like random
  // messages turning up" (Dan, 2026-08-08).
  //
  // Published BEFORE the waiter short-circuit and before delivery, so it
  // sits above whatever the agent does about it, and so a reply consumed
  // inline by agent_chat_send's wait — which never becomes a turn at all —
  // is still visible to the user.
  // Peer AGENTS only. A `user:` frame here is Dan typing into the room convo
  // himself — he can already see it there, and re-rendering his own words in
  // another conversation, in the bridge's assistant voice, would read as
  // something a remote agent said.
  // Self-heal for a stranded pending inbox (Task 6 review, I4): several
  // paths clear busy WITHOUT passing a turn-end flush seam (esc-cancel,
  // interrupt-wedge, resume-failed, the prompt paths). If the session is
  // free now, drain the older messages BEFORE this one so room messages
  // never overtake each other.
  //
  // Runs BEFORE this message's own notice so the journal reads in the order
  // things happened: any ⏳ from an earlier batch is closed by its 📨 above
  // the 💬 line for the message that arrived after it.
  maybeFlushRoomDelivery(session);
  const isPeerAgent = sender.startsWith('agent:');
  if (isPeerAgent) {
    journalPublishNotice(
      journalConvoIdFor(session),
      formatRoomMessageNotice({ from, body, roomTitle: room.title || room.topic || null, roomId: frame.convo_id }),
    );
  }
  // A reply consumed by an agent_chat_send wait already reached the agent
  // inline as the tool result — the session is busy for the whole tool call,
  // so deliver() would queue the SAME message and wake the agent with a
  // duplicate `[room …]` turn at turn end (Task 8 review, finding 1). The
  // journal keeps the durable copy; agent_chat_read recovers.
  if (roomReplyWaiters.resolve(frame.convo_id, { from, body })) return;
  // Queued-vs-injected is read off the inbox rather than deliver()'s boolean,
  // which reports "accepted" for both branches. Empty before and non-empty
  // after is precisely "this message opened a pending batch" — the one
  // message of the batch that gets a ⏳, closed later by maybeFlushRoomDelivery.
  //
  // This has to sit after the waiter short-circuit above, not beside the 💬
  // notice: during an agent_chat_send wait the session is busy, but the reply
  // is consumed inline as the tool result and never queued at all, so a
  // busy-means-queued line published earlier would be a lie in exactly the
  // case the agent responded fastest.
  const queuedBefore = roomDelivery.pendingCount(session.roomId);
  roomDelivery.deliver(session, session.roomId, {
    roomId: frame.convo_id, roomTitle: room.title || room.topic || null, from, body, at: frame.ts,
  });
  if (isPeerAgent && queuedBefore === 0 && roomDelivery.pendingCount(session.roomId) > 0) {
    journalPublishNotice(journalConvoIdFor(session), ROOM_MESSAGE_QUEUED_NOTICE);
  }
}

// Which local session an inbound invite/join request is FOR — see
// lib/invite-target.js for the rule and the incident behind it. Bound to
// this file's `sessions` map and the journal return path's own reverse
// lookup, so the routing rule stays pure and testable.
function resolveInviteTargetSession(frame, room) {
  return resolveInviteTarget(frame, room, {
    sessions,
    findSessionByConvoId: findSessionByClaudeSessionId,
  });
}

// Inbound invite/join request -> record the room as pending, ack with the
// target session's state, and surface the request to the agent as a turn
// (via roomDelivery, so a busy session sees it coalesced at turn end).
function journalInjectInviteRequest(frame) {
  // request  -> a peer wants THIS bridge's session to join frame.room_id
  // join_request -> a peer asks to join a room THIS bridge owns
  const isJoin = frame.event === 'join_request';
  const room = agentRooms.get(frame.room_id);
  const { session, addressed } = resolveInviteTargetSession(frame, room);
  if (!session) {
    debug(`invite ${frame.event} for ${frame.room_id} — no live session to ask`);
    // No session ⇒ nobody will ever answer. Refuse immediately instead of
    // letting the peer burn its full wait down to pending_quiet. An
    // ADDRESSED request that finds nothing says so specifically: the target
    // conversation exists on this device but isn't running right now, which
    // is a different fact from "this box is idle" and the one the caller
    // needs to hear (it picked that conversation off the roster).
    agentInvites.answer({
      roomId: frame.room_id,
      peerDeviceId: isJoin ? frame.from_device_id : null,
      accept: false,
      reason: !isJoin && frame.target_convo_id
        ? 'that conversation has no running session right now'
        : 'no active session on this box',
    });
    return;
  }
  if (isJoin) {
    // A join_request never touches the room record: this bridge already owns
    // the room (possibly joined with its real peer), and record() merging
    // the requester over it is exactly the C1 registry-destruction bug. Just
    // remember who is asking, for answerInvite's pendingPeerFor seam.
    pendingJoinRequests.set(frame.room_id, { deviceId: frame.from_device_id, at: Date.now() });
  } else {
    agentRooms.record(frame.room_id, {
      role: 'guest',
      state: 'pending',
      sessionRoomId: session.roomId,
      peerDeviceId: frame.from_device_id, peerName: frame.from_name || null,
      topic: frame.topic || null,
      title: room?.title || null,
    });
  }
  agentInvites.ack({ roomId: frame.room_id, peerDeviceId: isJoin ? frame.from_device_id : null, sessionState: sessionOccupiedForRoomDelivery(session) ? 'busy' : 'idle' });
  const who = frame.from_name ? `"${frame.from_name}"` : `device ${frame.from_device_id}`;
  const ask = isJoin
    ? `Agent ${who} asks to join your room ${frame.room_id}: ${frame.justification}`
    : `Agent ${who} requests a chat (room ${frame.room_id})${frame.topic ? ` about "${frame.topic}"` : ''}: ${frame.justification}`;
  // Known cosmetic: room-delivery one-lines every body, so this `\n` renders
  // as " ⏎ " in the injected turn. Accepted — the flattening is exactly what
  // keeps untrusted room text from forging header lines, and the instruction
  // stays perfectly legible.
  const text = `${ask}\nAccept with agent_chat_accept("${frame.room_id}") or refuse with agent_chat_refuse("${frame.room_id}", reason). This is a request from another agent, not from your user.`;
  // The USER's copy of the request, published BEFORE the agent is woken so it
  // sits above whatever the agent decides. Two separate texts on purpose: the
  // one above instructs the agent (tool syntax and all), this one just tells
  // Dan who is asking and why — otherwise he sees "I'll accept that chat
  // request" with nothing above it explaining what was requested.
  //
  // journalPublishNotice, NOT the ordinary sendToSession mirror: that mirror
  // publishes from:'user' (journalPublishUserItem), and every field of this
  // text is written by a REMOTE agent — rendering it as Dan's own message
  // would let a peer put words in his mouth in his own chat. A notice is
  // from:'assistant', i.e. the bridge's own voice, which is what it is.
  // formatInviteRequestNotice sanitises each interpolated field.
  //
  // Only when the request was actually ADDRESSED here. An unaddressed one
  // (pre-3.5 caller) reached this session by a guess among several live
  // ones, and publishing a stranger's request into a conversation it was
  // never meant for is exactly the visible half of the 2026-08-08 incident.
  // The agent still gets the ask as a turn below — it can accept, and any
  // room it accepts gets its own conversation — but the user's chat is not
  // written to on a guess. Logged, because a silently dropped notice would
  // otherwise look like the feature simply not working.
  if (addressed) {
    journalPublishNotice(journalConvoIdFor(session), formatInviteRequestNotice(frame, { roomTitle: room?.title || null }));
  } else {
    console.warn(`[agent-invites] request for ${frame.room_id} carried no target_convo_id — routed to the most recently active session as a guess; the user's copy is suppressed (peer bridge predates target_convo_id)`);
  }
  roomDelivery.deliver(session, session.roomId, { roomId: frame.room_id, roomTitle: room?.title || frame.topic || null, from: 'bridge', body: text, at: Date.now() });
}

// Room-lifecycle FYI (late answers, peer left) surfaced to the bound session
// as a turn. Fail-quiet when the room or its session is gone — the journal
// keeps the durable record.
function journalNotifyRoomEvent(roomId, text) {
  const room = agentRooms.get(roomId);
  if (!room) return;
  const session = sessions.get(room.sessionRoomId);
  if (!session || !session.alive) return;
  roomDelivery.deliver(session, session.roomId, { roomId, roomTitle: room.title || null, from: 'bridge', body: `Room ${roomId}: the peer ${text}.`, at: Date.now() });
}

// Constructed here (not at the `let` declaration next to the publisher) so
// every dependency — publisher, registry, the inject glue above — exists.
agentInvites = createAgentInvites({
  sendRoomOp: journalPublisher.sendRoomOp,
  rooms: agentRooms,
  injectRequestTurn: journalInjectInviteRequest,
  notifyRoom: journalNotifyRoomEvent,
  log: console,
});

// Assembled once, after every dependency above is defined, and invoked from
// journalHandleInboundEvent (the `function` declaration wired into
// createJournalPublisher near the top of this file — hoisted, so that
// forward reference is safe; only ACTUALLY called once the socket is live,
// long after this assignment has run).
const journalInputConsumer = createJournalInputConsumer({
  isControlConvo: journalIsControlConvo,
  handleControlCommand: (body) => {
    // Command-replay guard (same as journalOnPromptReply): flush the cursor
    // synchronously before dispatching, so a crash inside the debounce
    // window can't replay an already-dispatched `new` into a duplicate
    // session on restart.
    journalPublisher.flushCursor();
    journalHandleControlCommand(body).catch((e) => {
      try { console.warn(`[journal-input] control command failed: ${e.message}`); } catch { /* logging must never throw */ }
    });
  },
  findSessionByConvoId: findSessionByClaudeSessionId,
  routeTextToSession: journalOnText,
  routeMediaToSession: journalOnMedia,
  routePromptReply: journalOnPromptReply,
  ...permissionSeams,
  resolvePermissionReply: resolveJournalPermissionReply,
  resumeSessionForConvo: journalResumeConvo,
  noticeUnknownConvo: (convoId, { type }) => {
    // A user: frame in an INACTIVE room convo (TTL lapse / left) falls
    // through the room carve-out to here — but this notice would be
    // published INTO the shared room convo, spamming the peer's chat with
    // "no longer active". A known-but-inactive room just stops routing.
    if (agentRooms.get(convoId)) return;
    // The prompt_reply wording differs deliberately. A `text`/media frame only
    // reaches this notice AFTER the router already tried resumeSessionForConvo
    // and it returned null (lib/journal-input-router.js:470-499) — so for those,
    // "send a message" would be a lie. A prompt_reply does NOT get that attempt
    // in general (its pending prompt died with the process), so the convo may
    // well still be resumable by plain text.
    //
    // This is the honest-failure half of the restart carry-on dead-button case:
    // pickerFrames is in-memory (lib/journal-input-router.js:261) and takeStale
    // already consumed the marker, so if the bridge restarts AGAIN before the
    // user taps a published "Carry on" card, the tap lands here. Verified that
    // it does not self-heal: journal-publisher.js:583-591 drops any frame with
    // seq <= lastSeq before onEvent, and lastSeq is persisted across restarts
    // (journal-publisher.js:332, :496-497), so the card is never re-delivered
    // and never re-registers. Telling the user the very thing that WOULD work
    // is the cheap fix; rehydrating pickerFrames from the journal is not.
    journalPublishNotice(convoId, type === 'prompt_reply'
      ? "This session is no longer active on this bridge — your answer wasn't delivered. Send a message in this chat and I'll pick the conversation back up."
      : "This session is no longer active on this bridge — your message wasn't delivered.");
  },
  noticeStalePromptReply: (convoId) => {
    journalPublishNotice(convoId,
      "That prompt has been superseded by a newer one — your answer wasn't delivered. Check the latest prompt and answer that instead.");
  },
  noticeQueuedReleaseIgnored: (convoId, { reason } = {}) => {
    // A tap on a queued-message card the bridge couldn't action. Never a
    // silent no-op — the user pressed a button and expects a result.
    journalPublishNotice(convoId, reason === 'tombstoned'
      ? "That queued message was already sent or cancelled — nothing to do."
      : "That action isn't available for this queued message anymore.");
  },
  noticeGhostPromptReply: (convoId) => {
    // The tapped card is from before the bridge restarted; its session is
    // gone, so we refuse rather than risk answering a different open prompt.
    journalPublishNotice(convoId,
      "That prompt is from before this bridge restarted and can no longer be answered. Check the latest prompt and answer that instead.");
  },
  processStartSeq: journalPublisher.startSeq,
  emitRelease,
  // Agent-chat room carve-out seams: frames in an ACTIVE room convo become
  // session input (even agent-sent — that's the point of a room); own echoes
  // are dropped by device id (frame sender_device_id vs hello_ok identity)
  // when both are known, by device name otherwise.
  roomFor: (convoId) => (agentRooms.isActive(convoId) ? agentRooms.get(convoId) : null),
  routeRoomFrame: journalOnRoomFrame,
  selfAgentName: () => journalPublisher.identity()?.name || null,
  selfAgentDeviceId: () => journalPublisher.identity()?.deviceId ?? null,
  // Queued-release universal echo-ack (spec §3 step 5): the echo of our own
  // release is the true commit signal — flip the outbox record `acked` in
  // memory unconditionally. Matched by (promptId, action) across
  // send/cancel/expired.
  onReleaseEcho: (_convoId, { promptId, action }) => {
    if (typeof promptId === 'string' && typeof action === 'string') {
      releaseOutbox.markAcked(promptId, action);
    }
  },
  log: console,
});

// The actual function passed as createJournalPublisher's `onEvent` (wired
// near the top of this file, before journalInputConsumer exists — safe
// because `function` declarations are fully hoisted, and this is only ever
// CALLED once the socket is live, long after journalInputConsumer above has
// been assigned).
function journalHandleInboundEvent(frame) {
  journalInputConsumer(frame);
  // Re-arm the deferred boot reconcile (F1) while one is pending: every inbound
  // frame pushes the quiet-timer out (during the post-reconnect burst these are
  // the replay frames, which carry the release echoes), so reconcile runs only
  // once that stream has gone quiet. No-op after the one-shot reconcile has fired
  // (_releaseReconcileTimer is null), so steady-state traffic pays only a null check.
  if (_releaseReconcileTimer) scheduleReleaseReconcile();
}

// Finalize pending permission decisions and evict the reply-staleness guard
// record for a torn-down session's convo (the consumer's per-convo map is
// otherwise never pruned).
// Called from every TERMINAL session teardown (the exit handlers' non-restart
// branches and !stop), alongside the other journal state those sites already
// settle (journalSessionState 'done' / journalActivity 'idle'). Deliberately
// NOT called on auto-restart or recreateSession: the same convo (same
// claudeSessionId) lives on there and its guard record is still meaningful.
// Hoisted function declaration — the exit handlers are defined earlier in
// this file but only ever fire long after journalInputConsumer is assigned.
function journalEvictConvoInput(session) {
  // Terminal teardown leaves this session's joined rooms too: an orphaned
  // 'joined' entry stays bound to a dead session key forever — isActive
  // true, every peer frame dropped at debug level, noticeUnknownConvo
  // suppressed by the known-room guard: a permanent silent black hole
  // (whole-branch review, I4). Tell the peer (fire-and-forget — there is no
  // one left to report a failure to; an owner's leave is rejected
  // server-side, a journal gap noted in the PR) and mark the binding left.
  for (const r of agentRooms.forSession(session?.roomId)) {
    if (r.state === 'joined') {
      agentInvites.leave({ roomId: r.roomId }).catch(() => {});
      agentRooms.setState(r.roomId, 'left');
    }
  }
  // …and drops any pending room-message inbox with the session: there is no
  // live session left to coalesce into, and the room content is durable in
  // the journal (agent_chat_read recovers it). Auto-restart and
  // recreateSession never come through here AND keep the same session.roomId
  // key, so a surviving session's pending inbox rides across untouched.
  //
  // A dropped batch still owes Dan an outcome: those messages had a ⏳ line
  // published against them, and clearing the inbox silently would leave it
  // hanging forever with no delivered/failed line to close it — the exact
  // never-resolving indicator this feature exists to avoid (Bugbot, #197).
  // Counted before the drop, and reported through the same failed notice the
  // refused-inject path uses, because it is the same outcome: not delivered,
  // still durable in the room, recoverable with agent_chat_read.
  const strandedRoomMessages = roomDelivery.pendingCount(session?.roomId);
  roomDelivery.dropSession(session?.roomId);
  const convoId = journalConvoIdFor(session);
  if (strandedRoomMessages && convoId) {
    journalPublishNotice(convoId, formatRoomDeliveryFailedNotice(strandedRoomMessages));
  }
  if (convoId) {
    permissionSeams.finalizePendingPermissionsForConvo(convoId, 'session ended');
    journalInputConsumer.evictConvo(convoId, {
      clearQueue: () => {
        session.queuedMessages = null;
        session.queueNotifications = [];
      },
    });
  }
}

// Plan approval for the `build` keyword — the Matrix handler's original
// build block, extracted verbatim so the journal session-text route runs
// the SAME code path (PR #101 follow-up; decision gate: dispatchPlanBuild,
// lib/command-dispatch.js). iv-mode resolves the pending /plan-decision
// hook with allow; print-mode does the tool_result/denial dance (or falls
// back to a plain approval message when the denial was already answered).
// `sendHtml` is the transport's reply sink for the final "▶️ Building..."
// notice — Matrix passes its room sink, the journal passes the session
// ctx's sendToRoom sink, which also mirrors into the journal.
async function approvePlanBuild(session, { sendHtml }) {
  const toolUseId = session.pendingPlanDenialId;
  debug(`[PLAN-DEBUG] Build triggered! pendingPlan=${!!session.pendingPlan} denialId=${toolUseId}`);

  // Check if a tool_result already exists in the session history for this tool_use_id.
  // Claude CLI auto-generates a tool_result for permission denials, so sending another
  // one causes a duplicate tool_result API 400 error.
  const alreadyAnswered = toolUseId && session.claudeSessionId
    ? hasToolResultInHistory(session.claudeSessionId, session.workdir, toolUseId)
    : false;
  debug(`[PLAN-DEBUG] tool_result already in history: ${alreadyAnswered}`);

  if (session.iv) {
    // iv-mode: the ExitPlanMode hook is blocking on /plan-decision; resolve
    // it with allow so the hook returns and claude proceeds naturally.
    // No stdin.write or follow-up text needed — the hook's allow decision
    // unblocks the original tool call and claude continues its turn.
    const pending = session.ivPendingPlanToolUseId
      ? pendingPlanDecisions.get(session.ivPendingPlanToolUseId)
      : null;
    session.pendingPlan = null;
    session.pendingPlanDenialId = null;
    session.ivPendingPlanToolUseId = null;
    if (session.claudeSessionId) {
      persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
    }
    if (pending) {
      debug(`[PLAN-DEBUG] iv-mode: resolving pending plan decision with allow`);
      pending.resolve({ decision: 'allow', reason: 'approved by user' });
    } else {
      debug(`[PLAN-DEBUG] iv-mode: no pending plan decision found; sending build prompt as text`);
      sendTextToSession(session, 'The user has approved the plan. Go ahead and execute it now. Do not re-enter plan mode — just make the changes directly.');
    }
  } else if (!toolUseId || alreadyAnswered) {
    // No denial ID, or tool_result already exists — send as plain text to avoid duplicate
    session.pendingPlan = null;
    session.pendingPlanDenialId = null;
    if (session.claudeSessionId) {
      persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
    }
    debug(`[PLAN-DEBUG] Plan approved — sending as text message${alreadyAnswered ? ' (tool_result already in history)' : ''}`);
    sendTextToSession(session, 'The user has approved the plan. Go ahead and execute it now. Do not re-enter plan mode — just make the changes directly.');
  } else {
    // No existing tool_result — send tool_result to properly exit plan mode
    session.pendingPlan = null;
    session.pendingPlanDenialId = null;
    if (session.claudeSessionId) {
      persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
    }
    session.busy = true;
    inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId);
    const jsonMsg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: toolUseId,
            type: 'tool_result',
            content: 'Plan approved by user.',
          },
          {
            type: 'text',
            text: 'Go ahead and execute the plan now.',
          }
        ]
      }
    }) + '\n';
    debug(`[PLAN-DEBUG] Sending tool_result + text for ExitPlanMode: ${toolUseId}`);
    session.proc.stdin.write(jsonMsg);
    if (session.resetTimeout) session.resetTimeout();
  }
  const buildNotice = notice('success', '▶️ Building...', '▶️ <b>Building…</b>');
  await sendHtml(buildNotice.plain, buildNotice.html);
}

// Respawn a persisted session into its room: recreate the process with
// --resume, restore room-scoped state, announce to the room, and hold input
// until the resumed TUI is ready. Shared by the Matrix room.message
// auto-resume branch below and the journal input path's
// resumeSessionForConvo (journalResumeConvo), so the two transports can't
// drift apart on what a resume restores. Synchronous — the "Auto-resuming…"
// room notice is fire-and-forget, which is what lets the journal router's
// sync consumer call this directly.
//
// skipJournalMirror applies to that notice only (the session's own
// sendCallback/sendHtml stay mirrored as usual): the journal resume path
// posts its own richer "Session was idle" notice first, and without the
// skip Matron users would see both.
function resumePersistedSession(roomId, prev, { skipJournalMirror = false } = {}) {
  const sendReply = (reply) => sendToRoom(roomId, reply, markdownToHtml(reply));
  const sendHtmlFn = (plainText, html) => sendToRoom(roomId, plainText, html);
  const history = Array.isArray(prev.chatHistory) ? prev.chatHistory : [];
  const activeAgent = resolveAgent({ persisted: prev.agent, fallback: DEFAULT_AGENT });
  const activeState = getPersistedAgentState(prev, activeAgent, history.length);
  const resumeSessionId = activeState.sessionId;
  const newSession = createSession(roomId, prev.workdir || DEFAULT_WORKDIR, resumeSessionId, {
    agent: activeAgent,
    model: activeState.model,
    interactive: activeAgent === AGENT_CLAUDE
      ? activeState.interactiveMode
      : undefined,
    mcpExtras: activeState.mcpExtras,
    journalConvoId: prev.journalConvoId,
  });
  newSession.originRoomId = prev.originRoomId || null;
  newSession.firstMessageCaptured = true;
  newSession.chatHistory = history;
  newSession.pinnedSummaryText = prev.pinnedSummaryText || '';
  newSession.pinnedSummaryEventId = prev.pinnedSummaryEventId || null;
  newSession.lastSummaryMsgCount = prev.lastSummaryMsgCount || 0;
  newSession.lastRosterText = prev.lastRosterText || '';
  // Carry + harden the activity-inferred repo signal across auto-resume (F2r2):
  // this idle-reap/restart path is distinct from the explicit /resume path and
  // must not drop the durable signal either.
  newSession.repoScores = normalizeRepoScores(prev.repoScores);
  newSession.sendCallback = sendReply;
  newSession.sendHtml = sendHtmlFn;
  newSession.sendButtonMessage = (prompt, buttons, mode, plainText, html, payload) =>
    sendButtonMessage(roomId, prompt, buttons, mode, plainText, html, payload);
  hydrateAgentState(newSession, prev);

  const shortId = resumeSessionId ? resumeSessionId.slice(0, 8) : 'new';
  const verb = resumeSessionId ? 'Auto-resuming' : 'Restoring';
  const arNotice = notice('info', `${verb} ${agentLabel(newSession.agent)} session ${shortId}…`, `${verb} ${escapeHtml(agentLabel(newSession.agent))} session <code>${shortId}</code>…`);
  Promise.resolve(sendToRoom(roomId, arNotice.plain, arNotice.html, { skipJournalMirror })).catch(() => {});
  // Hold the triggering (and any further) message until the resumed TUI is
  // ready — claude --resume + auto-compaction can take seconds, far longer
  // than the paste→Enter window, so an immediate type-in is silently dropped.
  if (resumeSessionId) enterResumeHold(newSession);
  return newSession;
}

const pendingSecrets = new Map();
const pendingSensitiveData = new Map(); // Map<sensitiveId, { label, content, viewed, expiresAt }>

// Map<tool_use_id, { resolve(decision), plan }> — open ExitPlanMode hook
// requests waiting for a user decision in interactive mode. The hook script
// (hooks/exit-plan-decision.sh) holds an HTTP request open against
// /plan-decision; the bridge resolves it once the user replies on Matrix.
// Phase 4 wires the session-side handler that actually surfaces the plan.
const pendingPlanDecisions = new Map();

// --- Local HTTP API ---

const API_PORT = parseInt(process.env.MATRON_BRIDGE_API_PORT || '9802', 10);
function auditShowFile({ result, roomId, filePath, error, ...details }) {
  const record = {
    event: 'show_file',
    ...(roomId ? { roomId } : {}),
    ...(filePath ? { path: filePath } : {}),
    result,
    ...details,
  };
  if (error) {
    record.error = {
      name: typeof error.name === 'string' ? error.name : 'Error',
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  (result === 'ok' ? console.log : console.warn)(JSON.stringify(record));
}

function validateShowFileBody(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)
      || (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null)) {
    return { error: 'request body must be an object', reason: 'invalid-body' };
  }
  if (typeof data.path !== 'string' || data.path.trim() === '') {
    return { error: 'path must be a non-empty string', reason: 'invalid-path' };
  }
  if (typeof data.token !== 'string' || data.token.trim() === '') {
    return { error: 'token must be a non-empty string', reason: 'missing-token' };
  }
  if (data.caption !== undefined
      && (typeof data.caption !== 'string' || data.caption.length > 4096)) {
    return { error: 'caption must be a string of at most 4096 characters', reason: 'invalid-caption' };
  }
  return null;
}

const handleSendAttachment = createSendAttachmentHandler({
  sessions,
  publisher: journalPublisher,
  journalConvoIdFor,
  rooms: agentRooms,
});

// The eight agent-chat room tools (lib/agent-chat.js), mounted below as thin
// loopback routes in the /send-attachment pattern. awaitRoomMessage is the
// per-room once-listener seam defined next to journalOnRoomFrame.
const agentChatHandlers = createAgentChatHandlers({
  sessions,
  publisher: journalPublisher,
  rooms: agentRooms,
  invites: agentInvites,
  awaitRoomMessage,
  // Owner-side join_request seam (C1) — who is asking to join an owned room,
  // held outside the rooms registry (see pendingJoinRequests above).
  pendingPeerFor,
  clearPendingPeer: (roomId) => pendingJoinRequests.delete(roomId),
  // chatJoin's own-session-convo guard (I2).
  journalConvoIdFor,
  serverLabel: SERVER_LABEL,
  log: console,
});

// Parent-side agent-spawn handlers (lib/agent-spawn.js), backing the
// agent_boxes / agent_session_start MCP tools and the kind:'spawn' outcome
// frames. Constructed exactly once, here — the factory starts an unref'd
// hourly tombstone sweep with no dispose hook, so a second instantiation
// would leak a duplicate timer.
agentSpawnHandlers = createAgentSpawnHandlers({
  sessions,
  publisher: journalPublisher,
  rooms: agentRooms,
  journalConvoIdFor,
  // Surfaces a spawn outcome two ways: journalPublishNotice writes the
  // durable, user-facing copy into the parent session's journal
  // conversation; roomDelivery.deliver additionally wakes the live agent as
  // an injected turn (idle) or a coalesced one (busy), same mechanism
  // journalNotifyRoomEvent uses for room-lifecycle FYIs. No real agent-chat
  // room backs every outcome (declined/expired/failed never get one), so a
  // synthetic 'spawn' bucket stands in — same shape as a room key, none of
  // it forgeable (the text itself is bridge-composed, not peer input).
  //
  // ctx-null case (bridge restarted between the ack and the outcome frame):
  // agent-spawn.js calls this with BOTH session and convoId null — with no
  // fallback, neither branch below would fire and the outcome (started/
  // declined/expired/failed) would vanish with zero notices, contradicting
  // the "exactly-once surfacing" guarantee handleOutcome's tombstone exists
  // to provide (at-most-once, not zero). JOURNAL_CONTROL_CONVO_ID is the
  // same synthetic control conversation the bridge already replies into for
  // session-less commands (journalHandleControlCommand's `reply`); it
  // always exists (upserted at boot when JOURNAL_ENABLED), so the notice
  // lands somewhere the user can actually read it instead of being dropped
  // on the floor.
  notifyParent: ({ session, convoId, text }) => {
    if (convoId) journalPublishNotice(convoId, text);
    if (session) {
      roomDelivery.deliver(session, session.roomId, { roomId: 'spawn', roomTitle: 'spawn', from: 'bridge', body: text, at: Date.now() });
    } else if (!convoId) {
      journalPublishNotice(JOURNAL_CONTROL_CONVO_ID, text);
    }
  },
  log: console,
});

// Adapter wrapper for the eight agent-chat loopback routes: a throw inside a
// handler must surface as that route's own 500 with the real message — not
// bubble to the request body's outer catch and masquerade as
// "HTTP 400 Invalid JSON" (Task 8 review, finding 5).
async function respondAgentChatRoute(res, data, handler, describe) {
  let status, resBody;
  try { ({ status, body: resBody } = await handler(data)); }
  catch (e) { status = 500; resBody = { error: e?.message || 'internal error' }; }
  try { describe(status, resBody); } catch { /* debug lines must never break the response */ }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(resBody));
}

const apiServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);

  // GET /secret/:id — MCP server polls for secret submission
  if (req.method === 'GET' && url.pathname.startsWith('/secret/')) {
    const secretId = url.pathname.split('/')[2];
    const s = pendingSecrets.get(secretId);
    if (!s) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Secret request not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answered: s.answered, path: s.path || null }));
    if (s.answered) {
      pendingSecrets.delete(secretId);
    }
    return;
  }

  // GET /sensitive/:id — Viewer retrieves sensitive data (one-time view)
  if (req.method === 'GET' && url.pathname.startsWith('/sensitive/')) {
    const sensitiveId = url.pathname.split('/')[2];
    const s = pendingSensitiveData.get(sensitiveId);
    if (!s) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Sensitive data not found or already viewed' }));
      return;
    }
    if (Date.now() > s.expiresAt) {
      pendingSensitiveData.delete(sensitiveId);
      res.writeHead(410);
      res.end(JSON.stringify({ error: 'Sensitive data has expired' }));
      return;
    }
    // `!== false` rather than a truthy test, so this read side defaults the
    // same way the write side does (`oneTime: oneTime !== false`). An entry
    // that somehow reached the store without the field then fails closed —
    // consumed once — instead of silently becoming a multi-use share.
    if (s.oneTime !== false && s.viewed) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Sensitive data has already been viewed (one-time link)' }));
      return;
    }

    // Multi-use shares stay retrievable until expiresAt (cleanup is the
    // expiry timeout scheduled at creation); one-time shares are consumed.
    s.viewed = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ label: s.label, content: s.content, filename: s.filename }));

    if (s.oneTime !== false) {
      // Delete after 1 minute to allow time for the page to render, but prevent repeated access
      setTimeout(() => {
        pendingSensitiveData.delete(sensitiveId);
        debug(`Cleaned up viewed sensitive data: ${sensitiveId}`);
      }, 60000);
    }
    return;
  }

  if (req.method !== 'POST') {
    if (url.pathname === '/show-file') auditShowFile({ result: 'method-not-allowed' });
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  let bodyBytes = 0;
  let showFileBodyTooLarge = false;
  const permissionDecisionBody = url.pathname === '/permission-decision'
    ? createPermissionDecisionBodyCollector({ res, auditPermissionDecisionFn: auditPermissionDecision })
    : null;
  req.on('data', chunk => {
    if (showFileBodyTooLarge || permissionDecisionBody?.tooLarge) return;
    if (permissionDecisionBody) {
      permissionDecisionBody.append(chunk);
      return;
    }
    bodyBytes += chunk.length;
    if (url.pathname === '/show-file' && bodyBytes > 64 * 1024) {
      showFileBodyTooLarge = true;
      body = '';
      auditShowFile({ result: 'request-too-large' });
      // Connection: close tears the socket down after the 413 flushes, so the
      // client sees the status. Do NOT req.destroy() here: destroying the socket
      // can discard the just-written 413 before it's flushed, and the adapter
      // then reports a generic "internal error" instead of "too large". Pause the
      // request so we stop buffering the oversized body; the 'data'/'end'
      // handlers are already guarded by showFileBodyTooLarge.
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'request body too large' }));
      req.pause();
      return;
    }
    body += chunk;
  });
  req.on('end', async () => {
    if (showFileBodyTooLarge || permissionDecisionBody?.tooLarge) return;

    if (url.pathname === '/permission-decision') {
      handlePermissionDecisionRoute({
        body: permissionDecisionBody.body,
        res,
        sessions,
        pendingPermissionDecisions,
        classifyPermissionFn: classifyPermission,
        journalConvoIdForFn: journalConvoIdFor,
        evictPermissionSeq: (key, convoId) => journalInputConsumer.evictPermissionSeq(key, convoId),
        auditPermissionDecisionFn: auditPermissionDecision,
        timeoutMs: PERMISSION_DECISION_TIMEOUT_MS,
        permissionToken: req.headers['x-matron-permission-token'],
      });
      return;
    }

    if (url.pathname === '/show-file') {
      const { status, headers, body: resBody } = await processShowFile({
        body,
        sessions,
        budget: showFileBudget,
        limits: {
          maxInFlightPerSession: SHOW_FILE_MAX_IN_FLIGHT_PER_SESSION,
          maxInFlight: SHOW_FILE_MAX_IN_FLIGHT,
          maxBytes: SHOW_FILE_MAX_BYTES,
          globalByteBudget: SHOW_FILE_GLOBAL_BYTE_BUDGET,
          uploadTimeoutMs: SHOW_FILE_UPLOAD_TIMEOUT_MS,
        },
        deps: {
          validateShowFileBody,
          auditShowFile,
          shareAgentMedia,
          validateAndOpen,
          FileLinkDenied,
          uploadMedia: journalPublisher.uploadMedia,
          journalPublish,
          denialToStatus,
        },
      });
      res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
      res.end(JSON.stringify(resBody));
      return;
    }

    try {
      const data = JSON.parse(body);

      if (url.pathname === '/secret') {
        const { label, roomId } = data;
        if (!label || !roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'label and roomId are required' }));
          return;
        }

        const secretId = randomUUID();

        pendingSecrets.set(secretId, {
          label,
          answered: false,
          path: null,
        });

        const activeSession = sessions.get(roomId);

        if (activeSession) {
          const link = generateSecretLink(secretId, label, activeSession.roomId);
          if (link && activeSession.sendHtml) {
            const plain = `🔐 Secret requested: ${label} — Enter secret: ${link}`;
            const html = `🔐 Secret requested: <b>${escapeHtml(label)}</b> — <a href="${link}">Enter secret</a>`;
            activeSession.sendHtml(plain, html);
          } else if (activeSession.sendCallback) {
            activeSession.sendCallback(`🔐 Secret requested: ${label} (viewer not configured)`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secretId }));
        return;
      }

      if (url.pathname === '/send-attachment') {
        const { status, body: resBody } = await handleSendAttachment(data);
        debug(`send-attachment ${status} ${data?.path} ${resBody.kind || resBody.error || ''}`);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resBody));
        return;
      }

      if (url.pathname === '/agent-roster') {
        await respondAgentChatRoute(res, data, agentChatHandlers.roster,
          (status, b) => debug(`agent-roster ${status} ${b.error || `${(b.conversations || []).length} convos`}`));
        return;
      }

      if (url.pathname === '/agent-chat-start') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatStart,
          (status, b) => debug(`agent-chat-start ${status} ${b.room_id || ''} ${b.status || b.error || ''}`));
        return;
      }

      if (url.pathname === '/agent-chat-send') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatSend,
          (status, b) => debug(`agent-chat-send ${status} ${data?.room_id} ${b.error || (b.reply ? 'reply' : 'ok')}`));
        return;
      }

      if (url.pathname === '/agent-chat-accept') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatAccept,
          (status, b) => debug(`agent-chat-accept ${status} ${data?.room_id} ${b.error || 'ok'}`));
        return;
      }

      if (url.pathname === '/agent-chat-refuse') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatRefuse,
          (status, b) => debug(`agent-chat-refuse ${status} ${data?.room_id} ${b.error || 'ok'}`));
        return;
      }

      if (url.pathname === '/agent-chat-join') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatJoin,
          (status, b) => debug(`agent-chat-join ${status} ${data?.room_id} ${b.status || b.error || ''}`));
        return;
      }

      if (url.pathname === '/agent-chat-leave') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatLeave,
          (status, b) => debug(`agent-chat-leave ${status} ${data?.room_id} ${b.error || 'ok'}`));
        return;
      }

      if (url.pathname === '/agent-chat-read') {
        await respondAgentChatRoute(res, data, agentChatHandlers.chatRead,
          (status, b) => debug(`agent-chat-read ${status} ${data?.room_id} ${b.error || `${(b.messages || []).length} messages`}`));
        return;
      }

      if (url.pathname === '/agent-boxes') {
        await respondAgentChatRoute(res, data, agentSpawnHandlers.boxes,
          (status, b) => debug(`agent-boxes ${status} ${(b.boxes || []).length ?? ''} ${b.error || ''}`));
        return;
      }

      if (url.pathname === '/agent-session-start') {
        await respondAgentChatRoute(res, data, agentSpawnHandlers.sessionStart,
          (status, b) => debug(`agent-session-start ${status} ${b.spawn_id || ''} ${b.status || b.error || ''}`));
        return;
      }

      const secretSubmitMatch = url.pathname.match(/^\/secret\/([^/]+)\/submit$/);
      if (secretSubmitMatch) {
        const secretId = secretSubmitMatch[1];
        const s = pendingSecrets.get(secretId);
        if (!s) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Secret request not found or already submitted' }));
          return;
        }

        const { value } = data;
        if (!value) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'value is required' }));
          return;
        }

        // Write secret to file
        const filePath = path.join(SECRETS_DIR, `${secretId}.txt`);
        try {
          fs.writeFileSync(filePath, value, { mode: 0o600 });
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Failed to write secret: ${err.message}` }));
          return;
        }

        s.answered = true;
        s.path = filePath;

        // Schedule cleanup after 1 hour
        setTimeout(() => {
          fs.unlink(filePath, () => {});
        }, SECRET_TTL_MS);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, path: filePath }));
        return;
      }

      if (url.pathname === '/share-sensitive') {
        const { label, content, ttl, roomId, filename, oneTime, download } = data;
        if (!label || !content || !roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'label, content, and roomId are required' }));
          return;
        }

        // A stale/mistyped roomId would post the notification into another
        // chat (or nowhere) — refuse before storing anything.
        const target = resolveShareTarget(sessions, roomId);
        if (!target.ok) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: target.error }));
          return;
        }

        const sensitiveId = randomUUID();
        const ttlSeconds = Math.min(Math.max(ttl || 3600, 60), 86400); // Min 1 min, max 24 hours, default 1 hour
        const expiresAt = Date.now() + ttlSeconds * 1000;

        // Generate secure link before storing data — if viewer is misconfigured, don't leak sensitive content in memory
        const link = generateSensitiveLink(sensitiveId, label, ttlSeconds, {
          download: download === true,
          oneTime: oneTime !== false,
        });
        if (!link) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Viewer not configured (missing HMAC_SECRET or VIEWER_BASE_URL)' }));
          return;
        }

        pendingSensitiveData.set(sensitiveId, {
          label,
          content,
          // Suggested download filename; the viewer sanitizes it to a safe
          // basename before use.
          filename: typeof filename === 'string' ? filename.slice(0, 128) : undefined,
          // One-time (consumed on first fetch) unless explicitly opted out;
          // multi-use shares serve until expiresAt.
          oneTime: oneTime !== false,
          viewed: false,
          expiresAt,
        });

        // Send notification to user in Matrix chat. Use the session
        // resolveShareTarget already vetted — it guaranteed one of these two
        // channels exists, which is what makes the `notified` field below
        // true rather than merely hopeful.
        const activeSession = target.session;

        const verb = download === true ? 'Download' : 'View';
        const linkKind = oneTime !== false ? 'one-time link' : 'link';
        if (activeSession && activeSession.sendHtml) {
          const plain = `🔐 Secure data: ${label} — ${verb}: ${link}`;
          const html = `🔐 Secure data: <b>${escapeHtml(label)}</b> — <a href="${link}">${verb}</a> (${linkKind}, expires at ${new Date(expiresAt).toISOString()})`;
          activeSession.sendHtml(plain, html);
        } else if (activeSession && activeSession.sendCallback) {
          activeSession.sendCallback(`🔐 Secure data: ${label} — ${link} (${linkKind}, expires at ${new Date(expiresAt).toISOString()})`);
        }

        // Schedule cleanup after expiry
        setTimeout(() => {
          pendingSensitiveData.delete(sensitiveId);
          debug(`Cleaned up expired sensitive data: ${sensitiveId}`);
        }, ttlSeconds * 1000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: link,
          expiresAt: new Date(expiresAt).toISOString(),
          // Which chat the courtesy notification was posted in — callers
          // should surface this so a wrong-but-live room is caught at once.
          notified: target.description,
        }));
        return;
      }

      if (url.pathname === '/redact-message') {
        // Message redaction was a Matrix-only capability (redacting a room
        // event). The journal transport has no equivalent, so this endpoint
        // now reports unsupported instead of acting. The ask-user
        // redact_message MCP tool surfaces this text back to Claude; that MCP
        // tool lives in ask-user.js (out of scope for this task) and should
        // be retired in a follow-up.
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message redaction is not supported: the bridge is journal-only and has no message-redaction capability.' }));
        return;
      }

      if (url.pathname === '/send') {
        const { roomId, message } = data;
        if (!roomId || !message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and message required' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session || !session.alive) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active session for this room' }));
          return;
        }
        sendTextToSession(session, message);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/interrupt') {
        const { roomId } = data;
        if (!roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId required' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session || !session.alive) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active session for this room' }));
          return;
        }
        // Same compact-first split as every other flush path (see
        // flushPendingSessionQueue): a leading /compact goes out alone even
        // though this endpoint asked for the whole queue.
        const queue = session.queuedMessages || [];
        const notifications = session.queueNotifications || [];
        const batchSize = compactBatchSize(queue);
        const queued = queue.slice(0, batchSize);
        const deferred = queue.slice(batchSize);
        const releaseSnapshot = snapshotQueuedReleaseBatch(session, queued);
        session.queuedMessages = deferred.length ? deferred : null;
        let sent = true;
        if (queued.length > 0) {
          const summary = formatQueueSummary(queued);
          const plainMsg = deferred.length
            ? `⚡ Sending /compact now — the other ${deferred.length} message${deferred.length > 1 ? 's' : ''} will be sent once compaction finishes.`
            : `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
          if (session.sendHtml) {
            const htmlMsg = deferred.length
              ? `<b>⚡ Sending /compact now</b> — the other ${deferred.length} message${deferred.length > 1 ? 's' : ''} will be sent once compaction finishes.`
              : `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
            session.sendHtml(plainMsg, htmlMsg);
          } else if (session.sendCallback) {
            session.sendCallback(plainMsg);
          }
          sent = flushQueue(session, queued, releaseSnapshot);
          if (sent === true) session.queueNotifications = notifications.slice(batchSize);
        }
        if (sent === true) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, flushed: queued.length }));
        } else {
          const retained = Array.isArray(session.queuedMessages)
            ? session.queuedMessages.length
            : queued.length;
          res.writeHead(409);
          res.end(JSON.stringify({ ok: false, flushed: 0, retained }));
        }


      } else if (url.pathname === '/cancel-queued') {
        const { roomId, index } = data;
        if (!roomId || typeof index !== 'number') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and index required' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session || !session.alive) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active session for this room' }));
          return;
        }
        const queue = session.queuedMessages;
        if (!queue || index < 0 || index >= queue.length) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No queued message at that index' }));
          return;
        }
        // Preserve Array#splice's historical coercion for numeric indexes
        // while resolving the exact slot it will remove to a stable id.
        const queueIndex = Math.trunc(index);
        const notifs = session.queueNotifications || [];
        const itemId = notifs[queueIndex]?.id;
        const convoId = journalConvoIdFor(session);
        const releaseEntry = itemId
          ? journalInputConsumer.queueRelease.listLive(convoId)
            .find(entry => entry.itemId === itemId)
          : null;
        const cancelled = releaseEntry
          ? cancelQueuedItem(session, {
              itemId,
              promptId: releaseEntry.promptId,
              convoId,
              queueRelease: journalInputConsumer.queueRelease,
              emitRelease,
            })
          : false;
        if (!cancelled) {
          // Legacy queue entries have no durable item id. Preserve their
          // positional cancellation behavior while keeping both arrays in
          // lockstep.
          queue.splice(queueIndex, 1);
          if (queueIndex < notifs.length) notifs.splice(queueIndex, 1);
        }
        const remaining = queue.length;
        if (remaining === 0) session.queuedMessages = null;
        if (session.sendCallback) {
          const msg = remaining === 0
            ? '✕ Cancelled queued message (queue empty)'
            : `✕ Cancelled queued message (${remaining} remaining)`;
          session.sendCallback(msg);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, remaining }));

      } else if (url.pathname === '/message') {
        const { roomId, text } = data;
        if (!roomId || !text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and text required' }));
          return;
        }
        sendToRoom(roomId, text, markdownToHtml(text)).then(() => {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        }).catch(err => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        });

      } else if (url.pathname === '/compact-start') {
        // PreCompact hook notifies us that compaction is about to begin
        const { session_id } = data;
        let target = null;
        if (session_id) {
          for (const [, s] of sessions) {
            if (s.claudeSessionId === session_id && s.alive) { target = s; break; }
          }
        }
        if (target) {
          // Cooldown: don't send compaction messages more than once per 60s
          const now = Date.now();
          const COMPACT_COOLDOWN_MS = 60_000;
          if (!target.lastCompactStartNotify || (now - target.lastCompactStartNotify) > COMPACT_COOLDOWN_MS) {
            target.lastCompactStartNotify = now;
            if (target.sendHtml) {
              const n = notice('info', '🗜️ Compacting context — summarizing conversation history…');
              target.sendHtml(n.plain, n.html);
            } else if (target.sendCallback) {
              target.sendCallback('🗜️ Compacting context — summarizing conversation history…');
            }
          } else {
            debug('Suppressed compaction start notice (cooldown, last=%dms ago)', now - target.lastCompactStartNotify);
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/turn-end') {
        // Stop hook (hooks/stop-notify.sh) — fires when an assistant turn
        // completes. Used in interactive mode to clear typing indicators and
        // flush response state in lieu of the stream-json `result` event.
        const { session_id } = data;
        debug(`[IV] /turn-end hit, session_id=${session_id}`);
        let target = null;
        if (session_id) {
          for (const [, s] of sessions) {
            if (s.claudeSessionId === session_id && s.alive) { target = s; break; }
          }
        }
        debug(`[IV] /turn-end target found=${!!target} buf="${target?.responseBuffer?.slice(0,60) || ''}"`);
        if (target) {
          // Drain the transcript tail synchronously so any assistant event
          // written just before the Stop hook is processed (and the
          // response buffer populated) before onTurnEnd flushes.
          if (target.iv && typeof target.iv.drainTranscript === 'function') {
            try { target.iv.drainTranscript(); } catch (e) { debug('drainTranscript threw:', e?.message); }
          }
          if (typeof target.onTurnEnd === 'function') {
            try { target.onTurnEnd(); } catch (e) { debug('onTurnEnd handler threw:', e?.message); }
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/plan-decision') {
        // PreToolUse hook (hooks/exit-plan-decision.sh) — fires when claude
        // calls ExitPlanMode. Blocks until the user decides via Matrix.
        const { session_id, tool_use_id, plan } = data;
        if (!tool_use_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ decision: 'deny', reason: 'tool_use_id required' }));
          return;
        }
        let target = null;
        if (session_id) {
          for (const [, s] of sessions) {
            if (s.claudeSessionId === session_id && s.alive) { target = s; break; }
          }
        }
        if (!target) {
          res.writeHead(404);
          res.end(JSON.stringify({ decision: 'deny', reason: 'unknown session' }));
          return;
        }
        if (typeof target.requestPlanDecision !== 'function') {
          // Session has no plan-decision handler — this is the print-mode path
          // (Phase 4 adds the iv-mode handler). Deny so we never silently
          // execute an unreviewed plan.
          res.writeHead(503);
          res.end(JSON.stringify({ decision: 'deny', reason: 'no plan-decision handler for session' }));
          return;
        }
        // Hold the response. Timer caps the wait under curl's 1800s ceiling
        // in exit-plan-decision.sh so we always reply before curl times out.
        const PLAN_DECISION_TIMEOUT_MS = 1740 * 1000;
        const timer = setTimeout(() => {
          if (!pendingPlanDecisions.has(tool_use_id)) return;
          pendingPlanDecisions.delete(tool_use_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny', reason: 'timeout waiting for user' }));
        }, PLAN_DECISION_TIMEOUT_MS);
        pendingPlanDecisions.set(tool_use_id, {
          resolve: ({ decision, reason }) => {
            clearTimeout(timer);
            pendingPlanDecisions.delete(tool_use_id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: decision || 'deny', reason: reason || '' }));
          },
          plan,
        });
        try {
          target.requestPlanDecision(tool_use_id, plan);
        } catch (e) {
          // If the handler throws, resolve with deny so the hook unblocks.
          const pending = pendingPlanDecisions.get(tool_use_id);
          if (pending) pending.resolve({ decision: 'deny', reason: `session handler threw: ${e?.message || e}` });
        }

      } else if (url.pathname === '/sessions') {
        const list = [];
        for (const [roomId, session] of sessions) {
          list.push({
            roomId,
            alive: session.alive,
            busy: session.busy,
            workdir: session.workdir,
            claudeSessionId: session.claudeSessionId,
            uptime: Math.round((Date.now() - session.startedAt) / 1000),
          });
        }
        res.writeHead(200);
        res.end(JSON.stringify(list));

      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (_e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
});

apiServer.listen(API_PORT, '127.0.0.1', () => {
  console.log(`Local API listening on 127.0.0.1:${API_PORT}`);
});

function hydrateAgentState(session, persisted, fromAgent = otherAgent(session.agent)) {
  const history = Array.isArray(session.chatHistory) ? session.chatHistory : [];
  const state = getPersistedAgentState(persisted, session.agent, history.length);
  const cursor = normalizeHistoryCursor(state.historyCursor, history.length);
  session._agentHistoryCursor = cursor;
  session.totalUsage = { ...session.totalUsage, ...state.totalUsage };
  session.turnCount = state.turnCount;
  session._pendingAgentHandoff = null;
  if (cursor < history.length) {
    session._pendingAgentHandoff = buildAgentHandoffPrompt({
      fromAgent,
      toAgent: session.agent,
      history,
      startIndex: cursor,
      summary: session.pinnedSummaryText,
      workdir: session.workdir,
    });
  }
  return state;
}

async function switchAgentSession(roomId, targetAgent, { sendReply }) {
  const existing = sessions.get(roomId);
  const decision = canSwitchAgent(existing, targetAgent);
  if (!decision.ok) {
    await sendReply(decision.message);
    return null;
  }

  const target = decision.target;
  const persisted = getPersistedSession(roomId) || {};
  const history = Array.isArray(existing.chatHistory) ? existing.chatHistory : [];
  const sourceCursor = Number.isFinite(existing._agentHistoryCursor)
    ? existing._agentHistoryCursor
    : history.length;
  const sourceState = snapshotAgentState(existing, sourceCursor);
  const targetState = getPersistedAgentState(persisted, target, history.length);
  const agentSessions = mergeAgentStates(persisted.agentSessions, {
    [existing.agent]: sourceState,
    [target]: targetState,
  });

  if (targetState.sessionId) {
    const conflict = [...sessions.entries()].find(([otherRoomId, session]) =>
      otherRoomId !== roomId && session.alive && session.claudeSessionId === targetState.sessionId);
    if (conflict) {
      await sendReply(
        `${agentLabel(target)} session ${targetState.sessionId.slice(0, 8)}… is active in another conversation. Stop it there before switching.`,
      );
      return null;
    }
  }

  const stableConvoId = journalConvoIdFor(existing) || persisted.journalConvoId || randomUUID();
  const targetOptions = {
    agent: target,
    // null is an explicit provider-local default and prevents createSession
    // from falling back to the outgoing provider's legacy top-level model.
    model: targetState.model,
    mcpExtras: target === AGENT_CLAUDE ? targetState.mcpExtras : [],
    journalConvoId: stableConvoId,
    ...(target === AGENT_CLAUDE
      ? { interactive: targetState.interactiveMode ?? INTERACTIVE_MODE }
      : {}),
  };

  // Construct the incoming provider before tearing down the outgoing one so
  // a synchronous spawn/configuration failure leaves the current session
  // usable. The new process receives no prompt until the user sends again.
  let next;
  try {
    next = createSession(roomId, existing.workdir, targetState.sessionId, targetOptions);
  } catch (error) {
    sessions.set(roomId, existing);
    await sendReply(`Could not switch to ${agentLabel(target)}: ${error.message}`);
    return null;
  }

  journalStreamClear(existing);
  killSession(existing);

  next.originRoomId = existing.originRoomId;
  next.firstMessageCaptured = true;
  next.sendCallback = existing.sendCallback;
  next.sendHtml = existing.sendHtml;
  next.sendButtonMessage = existing.sendButtonMessage;
  next.showWorking = existing.showWorking;
  next.showBashOutput = existing.showBashOutput;
  next.chatHistory = history;
  next.pinnedSummaryText = existing.pinnedSummaryText;
  next.pinnedSummaryEventId = existing.pinnedSummaryEventId;
  next.lastSummaryMsgCount = existing.lastSummaryMsgCount || 0;
  next.lastRosterText = existing.lastRosterText || '';
  next.repoScores = existing.repoScores; // carry activity-inferred repo signal across replacement
  next.journalConvoId = stableConvoId;
  next._journalBuffer = existing._journalBuffer;
  next._journalTitleHint = existing._journalTitleHint;
  next._journalState = existing._journalState;
  next._journalActivityState = existing._journalActivityState;
  next._journalConvoEstablished = existing._journalConvoEstablished;
  next._agentSessions = agentSessions;
  hydrateAgentState(next, { ...persisted, agentSessions }, existing.agent);
  if (targetState.sessionId) enterResumeHold(next);

  persistSession(roomId, next.claudeSessionId, next.workdir, next.originRoomId, {
    agent: target,
    agentSessions,
    journalConvoId: stableConvoId,
    chatHistory: history,
    pinnedSummaryText: next.pinnedSummaryText || '',
    pinnedSummaryEventId: next.pinnedSummaryEventId || null,
    lastSummaryMsgCount: next.lastSummaryMsgCount || 0,
    lastRosterText: next.lastRosterText || '',
    model: next.currentModel || null,
    interactiveMode: target === AGENT_CLAUDE ? !!next.iv : undefined,
    mcpExtras: next.mcpExtras,
    totalUsage: next.totalUsage,
    turnCount: next.turnCount,
  });

  const nativeState = targetState.sessionId
    ? `Resumed its previous native session ${targetState.sessionId.slice(0, 8)}….`
    : 'A native session will be created with your next message.';
  const handoffState = next._pendingAgentHandoff
    ? ` ${next._pendingAgentHandoff.toIndex - next._pendingAgentHandoff.fromIndex} unseen transcript message${next._pendingAgentHandoff.toIndex - next._pendingAgentHandoff.fromIndex === 1 ? '' : 's'} will be handed over with that message.`
    : '';
  await sendReply(`Switched from ${agentLabel(existing.agent)} to ${agentLabel(target)}. ${nativeState}${handoffState}`);
  return next;
}

// Apply a /model switch for either mode. Interactive sessions type /model into
// the live TUI (immediate); print sessions restart the claude -p process with
// --model <alias> --resume (history preserved). Used by the !model command and
// the model: picker button.
function applyModelSwitch(roomId, session, arg, { sendReply, sendHtml }) {
  if (session.agent === AGENT_CODEX) {
    if (session.busy) {
      sendReply('Finish or interrupt the current Codex turn before switching models.');
      return;
    }
    const requested = String(arg || '').trim();
    if (!requested || /\s/.test(requested)) {
      sendReply('Usage: /model <model-id> (or /model default)');
      return;
    }
    const model = requested.toLowerCase() === 'default' ? null : requested;
    session.currentModel = model;
    session.codex.model = model;
    persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model });
    sendReply(model
      ? `Codex model set to ${model}; it will apply on the next turn.`
      : 'Codex model reset to the local config default; it will apply on the next turn.');
    return;
  }
  if (session.iv) {
    // Interactive: type /model into the live TUI. Not persisted by design —
    // the pick applies to the live session only (spec non-goal); a restart
    // falls back to the persisted/default model.
    switchModelInSession(session, arg, sendReply);
    return;
  }
  const decision = planPrintModelSwitch(session, arg);
  if (decision.defer) {
    // Mid-turn: park the switch on the shared deferred-command stash (see
    // dispatchDeferredCommand). The turn-end seam replays `!model <alias>`
    // BEFORE the queue flush; the replay lands back here with busy clear,
    // recreates the session with the new model, and the carried queue then
    // flushes on the replacement — compact still first — so the switch
    // applies ahead of every queued message. One slot: a parked /restart is
    // replaced with a notice, same as the /login parked-slash convention.
    const previousParked = session._deferredCommandText;
    session._deferredCommandText = `!model ${decision.normalized}`;
    if (previousParked === session._deferredCommandText) {
      sendReply(`🧠 /model ${decision.normalized} is already queued — it will apply as soon as this turn finishes.`);
    } else if (previousParked) {
      sendReply(`${decision.message.replace(/\.$/, '')} (replacing the queued /${previousParked.slice(1).split(' ')[0]}).`);
    } else {
      sendReply(decision.message);
    }
    return;
  }
  if (!decision.ok) {
    sendReply(decision.message);
    return;
  }
  sendReply(decision.message);
  persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model: decision.normalized });
  const next = recreateSession(roomId, { model: decision.normalized }, { sendReply, sendHtml });
  if (next) next.currentModel = decision.normalized;
}

// Apply a /mode switch (interactive <-> print) for a room: gate via
// planModeSwitch, then persist the choice and restart the session in the new
// mode (same session id, history preserved). Used by the !mode command and the
// mode: toggle button.
function applyModeSwitch(roomId, session, wantInteractive, { sendReply, sendHtml, announcement, refusalAnnouncement }) {
  if (session.agent === AGENT_CODEX) {
    sendReply('Interactive Codex mode is not part of this first integration.');
    return;
  }
  const decision = planModeSwitch(session, wantInteractive);
  if (!decision.ok) {
    // `refusalAnnouncement` replaces planModeSwitch's message for flows the
    // user didn't initiate as a mode switch (the /login auto-return): a bare
    // "finish the current turn before switching modes" is baffling there,
    // and sending both lines double-messaged the user (Bugbot, PR #162).
    sendReply(refusalAnnouncement || decision.message);
    return null;
  }
  // `announcement` replaces the generic "Switching to … mode" line on SUCCESS
  // only. Used by flows where the switch is an implementation detail the user
  // didn't ask for (/login//logout from print mode) to say what's actually
  // happening instead of narrating the mechanics.
  sendReply(announcement || decision.message);
  persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { interactiveMode: wantInteractive });
  // Return the replacement session so callers can park follow-up work on it
  // (the /login-from-print flow tags _postReadySlashCommand).
  return recreateSession(roomId, { interactive: wantInteractive }, { sendReply, sendHtml });
}

// Tear down a room's live session and re-spawn it resuming the SAME claude
// session id, applying `overrides` ({ model, interactive, mcpExtras }) to the
// new createSession options. Carries user-visible state (queue, per-room
// toggles, chat history) across the swap. Returns the new session, or null if
// the room has no live session. Shared by /restart, /model (print) and /mode.
function recreateSession(roomId, overrides, { sendReply, sendHtml }) {
  const existing = sessions.get(roomId);
  if (!existing) return null;
  const sessionId = existing.claudeSessionId;
  // PR #151's pre-init resume gate, extended to this shared teardown path:
  // --resume only a session Claude actually persisted (confirmed on init,
  // session._sessionConfirmed). !restart, and now /mode and /login too, can
  // all arrive here with an unconfirmed print session — planModeSwitch used to
  // refuse those, until refusing them turned out to be what made /login
  // impossible on a box that was not logged in. Resuming one would --resume an
  // id Claude never wrote, which fails ("No conversation found") and terminates
  // the conversation. Respawn with the SAME id via --session-id (presetSessionId
  // below) instead, keeping the convo/journal identity for a clean fresh
  // spawn. Print-mode Claude only: iv sessions confirm via camel-case
  // transcript records and Codex never sets the flag, so gating either would
  // wrongly force every recreate onto a fresh spawn and lose history.
  const preInitPrint = existing.agent === AGENT_CLAUDE && !existing.iv && !existing._sessionConfirmed;
  const workdir = existing.workdir;
  const originRoomId = existing.originRoomId;
  sessions.delete(roomId);
  // Retire any open streaming overlay on the outgoing session now — by its own
  // ref and claudeSessionId — before the swap. Otherwise a final buffered
  // `result` from the dying process arms the durable ref on THIS (old) session
  // while sendToRoom reads it back from sessions.get(roomId), which is already
  // the new session, so the durable publish drops message_ref and the overlay
  // retires only via the fallback path. journalStreamClear also nulls
  // _journalDurableRef, so a late flush on the old session can't carry a stale
  // ref onto the new session's journal. No-op when nothing was streaming.
  journalStreamClear(existing);
  killSession(existing, 'SIGTERM', { preserveQueue: true });
  const next = createSession(roomId, workdir, preInitPrint ? null : sessionId, {
    agent: existing.agent,
    mcpExtras: existing.mcpExtras,
    journalConvoId: existing.journalConvoId,
    // Carry the good title across the swap so the re-seed adopts it instead of
    // clobbering it with the repo basename (title-revert bug).
    journalTitleHint: existing._journalTitleHint,
    presetSessionId: preInitPrint ? sessionId : undefined,
    // Preserve the currently-active model across the swap. An in-TUI /model
    // pick updates currentModel but isn't persisted (by design), so without
    // this a /mode toggle or /restart would resume on the stale persisted/
    // default model. An explicit override (e.g. /model in print mode) still
    // wins via the spread below.
    // Codex null means "use its config default" and must remain explicit;
    // falling back to persisted.model can otherwise pick up Claude's model.
    // Claude keeps the historical undefined fallback for a not-yet-observed
    // live model so its persisted selection survives a TUI restart.
    model: existing.agent === AGENT_CODEX
      ? existing.currentModel
      : (existing.currentModel || undefined),
    ...overrides,
  });
  next.sendCallback = sendReply;
  next.sendHtml = sendHtml;
  next.sendButtonMessage = (prompt, buttons, mode, plainText, html, payload) =>
    sendButtonMessage(roomId, prompt, buttons, mode, plainText, html, payload);
  next.originRoomId = originRoomId;
  next.firstMessageCaptured = existing.firstMessageCaptured;
  next.queuedMessages = existing.queuedMessages;
  next.queueNotifications = existing.queueNotifications;
  journalInputConsumer.queueRelease.carryForward(
    journalConvoIdFor(existing),
    journalConvoIdFor(next),
  );
  next.showWorking = existing.showWorking;
  next.showBashOutput = existing.showBashOutput;
  next.chatHistory = existing.chatHistory;
  next.pinnedSummaryText = existing.pinnedSummaryText;
  next.pinnedSummaryEventId = existing.pinnedSummaryEventId;
  next.lastSummaryMsgCount = existing.lastSummaryMsgCount || 0;
  next.lastRosterText = existing.lastRosterText || '';
  next.repoScores = existing.repoScores; // carry activity-inferred repo signal across replacement
  next._agentHistoryCursor = existing._agentHistoryCursor;
  next._pendingAgentHandoff = existing._pendingAgentHandoff;
  next._agentSessions = existing._agentSessions;
  next.totalUsage = existing.totalUsage;
  next.turnCount = existing.turnCount;
  next._journalBuffer = existing._journalBuffer;
  next._journalTitleHint = existing._journalTitleHint;
  next._journalState = existing._journalState;
  next._journalActivityState = existing._journalActivityState;
  next._journalConvoEstablished = existing._journalConvoEstablished;
  if (sessionId) {
    persistSession(roomId, sessionId, workdir, originRoomId, {
      agentSessions: existing._agentSessions,
      journalConvoId: existing.journalConvoId,
    });
  }
  // A resumed interactive TUI isn't ready for input for a few seconds; hold
  // the first post-switch message until it is, so it isn't typed into a
  // still-loading TUI and dropped. No-op for print sessions (enterResumeHold
  // returns early when there's no PTY).
  enterResumeHold(next);
  // A restart may have interrupted a turn with user messages already queued
  // behind it (or a parked /restart's turn-end seam skipped its flush on
  // purpose). They belong to the logical conversation, not the killed child,
  // so dispatch them through the idle replacement now — for every session
  // that skips the resume hold (Codex, print-mode Claude). An iv session is
  // holding (_awaitingInputReady): its readiness watcher flushes the carried
  // queue once the TUI can actually take input.
  if (!next._awaitingInputReady && next.queuedMessages?.length) {
    flushPendingSessionQueue(next);
  }
  return next;
}

// Print-mode turn interrupt — the print-mode counterpart of iv-mode's Esc
// keystroke rescue, shared verbatim by the Matrix handler and the journal
// session-text route (same convention as approvePlanBuild). The turn's
// `result` event is the success signal: it clears busy and cancels the
// fallback timer via clearPendingInterrupt. The timer only fires if the CLI
// never delivers one (wedged process), so the bridge stops queueing
// messages behind a busy flag nothing will ever clear.
async function printModeInterrupt(session, sendReply) {
  if (session.agent === AGENT_CODEX) {
    if (!session.alive || !session.busy || !session.codex?.child) {
      await sendReply('Nothing to interrupt — Codex is idle.');
      return;
    }
    session._codexInterrupted = true;
    if (session.codex.interrupt('SIGINT')) {
      await sendReply('⏹ Interrupt sent — waiting for Codex to stop this turn.');
    } else {
      session._codexInterrupted = false;
      await sendReply('Could not interrupt the Codex turn.');
    }
    return;
  }
  if (!session.proc || !session.alive) {
    await sendReply('No claude process to interrupt.');
    return;
  }
  if (!session.busy) {
    await sendReply('Nothing to interrupt — claude is idle.');
    return;
  }
  if (session.pendingInterrupt) {
    await sendReply('Interrupt already sent — still waiting for claude to stop this turn.');
    return;
  }
  session.pendingInterrupt = sendPrintInterrupt({
    stdin: session.proc.stdin,
    onWedge: () => {
      session.pendingInterrupt = null;
      if (!session.busy) return;
      session.busy = false;
      // Deliberately NO noteTurnEnd: this is a defensive unstick after an
      // interrupt got no acknowledgement, and the reply below says so — "the
      // turn may still be running". Further agent output is still possible,
      // and the `result` seam will clear the marker if it arrives. Clearing
      // here would drop a card for a turn that really was interrupted.
      journalSessionState(session, 'waiting');
      journalActivity(session, 'idle');
      Promise.resolve(sendReply('⚠️ No response to the interrupt after 10s — cleared busy state. The turn may still be running; !stop kills the session if it stays stuck.')).catch(() => {});
    },
    onError: (err) => {
      Promise.resolve(sendReply(`Could not send interrupt: ${err.message}`)).catch(() => {});
    },
  });
  if (session.pendingInterrupt) {
    await sendReply('⏹ Interrupt sent — waiting for claude to stop this turn.');
  }
}

// Cancels a pending interrupt's wedge timer. Called wherever busy state
// resolves for real (result event, fatal-error result path, killSession) —
// a stale timer firing into a later turn would falsely clear its busy flag.
function clearPendingInterrupt(session) {
  if (session.pendingInterrupt) {
    session.pendingInterrupt.cancel();
    session.pendingInterrupt = null;
  }
}

function killSession(session, signal = 'SIGTERM', { preserveQueue = false } = {}) {
  if (!session) return;
  // Stop the subagent watcher up-front so its tails and burst timer don't
  // keep running if the child ignores SIGTERM. The close handler also
  // stops it, but belt-and-braces. Also settles child convos (finishAll).
  teardownSubagentTracking(session);

  // Stop and finalize any still-open tool-output streams for this session so
  // the server frees their buffers now; the idle sweep is the backstop, not
  // the mechanism (spec §9). Before the alive check, like the watcher above:
  // a process that died without delivering tool_result leaves pumps
  // dangling.
  sweepToolStreams(session);
  clearPendingInterrupt(session);

  if (!session.alive) return;
  try {
    session.alive = false;
    if (session.agent === AGENT_CODEX && session.codex) {
      // Codex's adapter has no long-lived idle process whose close handler can
      // normalize bridge state. Finish an active turn synchronously before a
      // restart copies state into its replacement; discard partial output and
      // never flush queued work into a session being killed.
      if (!session._codexTurnFinished) {
        finishCodexTurn(session, {
          usage: session._codexCompletedUsage,
          discardOutput: true,
          preserveQueue,
        });
      }
      session.codex.kill(signal);
    }
    else if (session.iv) session.iv.kill(signal);
    else if (session.proc) session.proc.kill(signal);
  } catch (e) {
    debug(`killSession error: ${e.message}`);
  }
}

function startIdleReaper() {
  setInterval(() => {
    const now = Date.now();
    for (const [roomId, session] of sessions) {
      if (!session.alive) continue;
      if (session._autoStopped) continue;
      const last = session.lastActivityAt || session.startedAt || 0;
      if (now - last < SESSION_IDLE_TIMEOUT_MS) continue;

      // Silent reap — posting a Matrix notice would bump the room to the top
      // of the user's room list, defeating the purpose. The session is
      // resumable on the next user message via the existing auto-resume path.
      const idleHours = Math.round((now - last) / 3600000);
      debug(`Reaping idle session in ${roomId} (idle ${idleHours}h)`);
      session._autoStopped = true;
      killSession(session, 'SIGTERM');
      // Claude's persistent child close handler performs this cleanup. An
      // idle Codex logical session normally has no child between turns, so
      // there will be no close event to remove it from the live map.
      if (session.agent === AGENT_CODEX) {
        sessions.delete(roomId);
        journalStreamClear(session);
        journalSessionState(session, 'done');
        journalActivity(session, 'idle');
        journalEvictConvoInput(session);
      }
    }
  }, SESSION_IDLE_CHECK_MS).unref();
}

// --- Startup ---

// Boot reconciliation for restart carry-on. Every marker still on disk from a
// previous bridge process is, by construction, a turn that never reached a
// turn-end seam — the restart killed it (index.js SIGTERM handler kills every
// live session). Markers inside the window get a card; the rest are dropped
// silently. takeStale clears ALL previous-boot markers either way, so a given
// interruption is offered exactly once and can never resurface on a later boot.
function publishRestartCarryOnCards() {
  if (!JOURNAL_ENABLED) return;
  let stale;
  try {
    // takeStale clears and PERSISTS before this returns, i.e. before a single
    // card below has been published. A crash — or a dropped publisher frame —
    // between here and the loop loses those interruptions permanently: the
    // marker is gone and the user never saw a card. Accepted, and inherent to
    // the fire-once guarantee (see lib/inflight-marker.js takeStale). Do not
    // "fix" it by deferring the clear until after publishing; that reintroduces
    // duplicate cards, which is the louder failure.
    stale = inflightMarker.takeStale(RESTART_CARRY_ON_MAX_AGE_MS);
  } catch (e) {
    console.warn(`[inflight] boot reconciliation failed: ${e.message}`);
    return;
  }
  if (!stale.length) return;
  const persisted = loadPersistedSessions();
  const resumable = new Set(Object.values(persisted)
    .flatMap(rec => [rec?.journalConvoId, rec?.sessionId])
    .filter(Boolean));
  for (const rec of stale) {
    // No persisted session record means there is nothing for a tap to resume,
    // so a card would be a dead button. Drop it.
    if (!resumable.has(rec.convoId)) {
      // Wrapped like every other log in this loop: a throw here would abort
      // every REMAINING card, so one bad record would cost other conversations
      // their card. Codebase convention — "logging must never throw".
      try { console.log(`[inflight] skipping carry-on card for convo=${rec.convoId} — no persisted session`); } catch { /* logging must never throw */ }
      continue;
    }
    // A convo id outside picker-dispatch's `resume:` shape produces the worst
    // failure available: the tap consumes the single-use picker frame, then
    // handlePickerValue returns false and its caller no-ops SILENTLY — no
    // resume, no error, nothing. Unreachable today (every convo id is a
    // randomUUID or a codex thread id), so this is belt-and-braces; the point
    // is that if it ever becomes reachable it fails loudly in the log instead
    // of silently in the user's chat.
    if (!isResumeConvoId(rec.convoId)) {
      try { console.warn(`[inflight] skipping carry-on card for convo=${rec.convoId} — id does not match the resume: picker value shape, so a tap would silently no-op`); } catch { /* logging must never throw */ }
      continue;
    }
    const question = `⚠️ The bridge restarted while this chat was mid-turn — interrupted ${formatInterruptedAgo(rec.ageMs)}. The work stopped where it was.`;
    const published = journalPublishCardForConvo(rec.convoId, {
      question,
      options: [{ id: `resume-${rec.convoId}`, label: '▶️ Carry on', value: `resume:${rec.convoId}` }],
    });
    // The marker for this convo was already cleared by takeStale above, so a
    // false here isn't just "log it wrong" — it means this interruption's
    // card is gone for good; there is no marker left to retry from on a
    // later boot (see the fire-once comment above this loop).
    if (published) {
      try { console.log(`[inflight] published carry-on card for convo=${rec.convoId} (age ${Math.round(rec.ageMs / 1000)}s)`); } catch { /* logging must never throw */ }
    } else {
      try { console.warn(`[inflight] carry-on card for convo=${rec.convoId} (age ${Math.round(rec.ageMs / 1000)}s) was NOT published — its marker is already cleared, so this interruption's card is lost`); } catch { /* logging must never throw */ }
    }
  }
}

async function main() {
  // Ensure secrets directory exists with restricted permissions
  try {
    await fs.promises.mkdir(SECRETS_DIR, { mode: 0o700, recursive: true });
  } catch {}

  if (!JOURNAL_WS_URL || !_journalToken) {
    console.error('JOURNAL_WS_URL and a journal agent token (JOURNAL_TOKEN_FILE or JOURNAL_TOKEN) are required.');
    process.exit(1);
  }

  console.log(`Allowed users: ${ALLOWED_USER_IDS.length ? ALLOWED_USER_IDS.join(', ') : 'any'}`);
  console.log(`Default workdir: ${DEFAULT_WORKDIR}`);
  if (SESSION_IDLE_TIMEOUT_MS > 0) {
    console.log(`Session idle timeout: ${SESSION_IDLE_TIMEOUT_MS}ms (check every ${SESSION_IDLE_CHECK_MS}ms)`);
    startIdleReaper();
  } else {
    console.log('Session idle timeout: disabled');
  }
  // Re-arm persisted /timer schedules (overdue ones fire after a short
  // grace — see lib/timer-command.js OVERDUE_GRACE_MS).
  const rearmed = timerStore.init();
  if (rearmed > 0) console.log(`Re-armed ${rearmed} persisted timer(s) from ${TIMERS_FILE}`);
  console.log(`Bridge Claude instructions: ${BRIDGE_CLAUDE_MD_PATH}`);
  console.log(`Debug mode: ${DEBUG ? 'ON' : 'OFF'}`);
  console.log(`Journal: connecting to ${JOURNAL_WS_URL}`);
  // Fixed-cadence host-CPU sampler. Owns the baseline so journalStatus's
  // many-per-tick reads never corrupt it; .unref()'d so it doesn't hold the
  // process open. host_cpu appears once the first interval has a valid diff.
  // Sample at the fast vitals cadence so a published CPU value is always fresh.
  startCpuSampler(HOST_VITALS_SAMPLE_MS);
  // Host-vitals gauge: a single convo-less frame, published ON CHANGE. The timer
  // only EVALUATES every HOST_VITALS_SAMPLE_MS; pushHostVitals emits a frame only
  // on a meaningful CPU/RAM delta or the heartbeat interval, so an idle bridge
  // stays quiet. Ephemeral/fail-open. .unref()'d; cleared in shutdown handlers.
  _hostVitalsPushHandle = setInterval(pushHostVitals, HOST_VITALS_SAMPLE_MS);
  if (typeof _hostVitalsPushHandle.unref === 'function') _hostVitalsPushHandle.unref();
  // Retention: the relocated codex-viz sink tree lives outside Claude Code's
  // pruned project dirs, so its unredacted JSONL would accumulate forever.
  // Best-effort age-based sweep at boot (never throws).
  if (process.env.MATRON_CODEX_VIZ === '1') {
    const pruned = pruneStaleCodexSinks();
    if (pruned > 0) console.log(`Pruned ${pruned} stale codex-viz sink dir(s)`);
  }
  // Last: turn any marker left behind by the previous process into a "Carry on"
  // card. After timerStore.init() so a re-armed timer's own resume can't race
  // the reconciliation for the same convo, and safe with respect to the journal
  // socket — the publisher is constructed (and connect()ed) at module load and
  // queues frames FIFO until hello_ok, exactly as the eager control-convo
  // upsert above relies on, so nothing is dropped by publishing here.
  publishRestartCarryOnCards();
}

// Read cached CPU + instant RAM and emit one host_vitals frame (no convo_id).
// cpu is omitted until the sampler has a first valid reading (matches the
// hostVitalLimits shape); ram is always present when the OS reports memory.
function pushHostVitals() {
  const cpu = cpuPercent();
  const ram = ramPercent();
  // Nothing to report until the sampler has at least one real reading.
  if (cpu === null && ram === null) return;
  const now = Date.now();
  const last = _lastVitalsPublished;
  const moved = !last
    || (cpu !== null && (last.cpu === null || Math.abs(cpu - last.cpu) >= HOST_VITALS_DELTA_PCT))
    || (ram !== null && (last.ram === null || Math.abs(ram - last.ram) >= HOST_VITALS_DELTA_PCT));
  const heartbeatDue = !last || (now - last.at) >= HOST_VITALS_HEARTBEAT_MS;
  // Steady load within the heartbeat window: stay quiet, cut idle traffic.
  if (!moved && !heartbeatDue) return;
  const vitals = { sampled_at_ms: cpu !== null ? cpuSampledAtMs() : now };
  if (cpu !== null) vitals.cpu = cpu;
  if (ram !== null) vitals.ram = ram;
  journalPublisher.publishHostVitals(vitals);
  _lastVitalsPublished = { cpu, ram, at: now };
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Async shutdown that SETTLES in-flight release frames before exit (loop #536,
// spec §4). Idempotent: a second signal short-circuits via `shuttingDown`. The
// outbound queue is drained (or the bounded flush timeout elapses — a dead
// socket can't hang shutdown), so a clean restart delivers pending releases
// inline; anything still unsettled is durable in the outbox and reconciled on
// next boot.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal === 'SIGINT') console.log('\nShutting down...');
  if (_hostVitalsPushHandle) { clearInterval(_hostVitalsPushHandle); _hostVitalsPushHandle = null; }
  // Everything is inside try/finally so a throw from ANY step (sampler, session
  // kill, or the flush) still reaches process.exit(0). Previously stopCpuSampler
  // / killSession ran outside the try, so a throw there rejected the promise the
  // signal handlers ignore, and the process never exited (unhandled rejection).
  try {
    stopCpuSampler();
    for (const [, session] of sessions) {
      killSession(session);
    }
    await journalPublisher.flush({ timeoutMs: FLUSH_TIMEOUT_MS });
  } catch (e) {
    try { console.warn(`[shutdown] failed: ${e?.message ?? String(e)}`); } catch { /* ignore */ }
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
