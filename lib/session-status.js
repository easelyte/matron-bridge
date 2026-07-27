// Pure helpers for the per-convo session-status frame ("header data"):
// model, context-window gauge, and account rate limits, published to the
// journal at turn end so Matron clients can render them without anyone
// having to run /context or /limits by hand.
//
// The context gauge is computed passively from the `usage` block on the
// turn's ASSISTANT events — input + cache read + cache creation of the last
// API request is the context footprint. NOT from the result event's usage:
// that one is cumulative across every API call in the turn (each call's
// input ≈ the full context, so a 20-tool-call turn "uses" 20× its actual
// context and the gauge reads 2m/1m). Also deliberately NOT sourced by
// sending /context into the session: a polled local command would append
// its own report to the transcript (eating the context it measures), bump
// lastActivityAt (defeating the idle reaper), and race real turns. The
// numbers here are an estimate — close enough for a header gauge, not
// /context's exact accounting.

import os from 'node:os';

// Model → SESSION context window. This is the window a Claude Code *session*
// actually gets by default — NOT the model's theoretical max from the API
// catalog (older models advertise a 1m ceiling but their CLI sessions still
// open at 200k). Measured empirically via `claude -p /context` (2026-07-23):
// current Opus (4.7, 4.8), Sonnet 5, and the Fable/Mythos families default
// their sessions to 1m; older models (Opus ≤4.6, Sonnet ≤4.6, every Haiku)
// stay at 200k unless the `[1m]` beta marker is appended. A model not yet
// listed conservatively defaults to 200k — under-reporting is the safe
// direction, and a new 1m-default model just needs one alternation added here.
const WINDOW_1M_RE = /fable|mythos|\[1m\]|opus-4-[78]|sonnet-5/i;

export function contextWindowFor(model) {
  return WINDOW_1M_RE.test(String(model ?? '')) ? 1_000_000 : 200_000;
}

// The context window is a LAUNCH property, not a per-turn one: a session
// started on a 1m model (via the `opus[1m]`/`sonnet[1m]` aliases, or a
// fable/mythos family) keeps that window for its whole life. But the stream's
// `message.model` reports the bare API id — `claude-opus-4-8`, no `[1m]`
// marker — so letting each assistant event overwrite the launch model would
// silently narrow the gauge to 200k on the very first turn (the live "x/200k
// in a 1m session" bug). Widen-only: keep whichever model implies the larger
// window, so a later bare id never shrinks a window an earlier launch marker
// established. A genuine model switch flows through a different path (the
// /model command), so this never blocks a real downgrade.
export function reconcileModelForWindow(prev, next) {
  if (!next) return prev ?? null;
  if (!prev) return next;
  return contextWindowFor(next) >= contextWindowFor(prev) ? next : prev;
}

// Context footprint of the last request: everything that was sent up,
// however it was billed. Output tokens are excluded — they aren't part of
// the next request's context accounting here (the next turn's usage will
// include them as input). Returns null when there's nothing usable so the
// caller can distinguish "no turn yet" from a genuine zero.
export function contextTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const tokens = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  return tokens > 0 ? tokens : null;
}

// A subagent's event riding the PARENT's stream: print-mode stdout tags them
// with parent_tool_use_id, older inline transcripts with isSidechain. The
// parent pipeline must skip these wholesale — their text/tool_use/tool_result
// belong to the child conversation (the subagent watcher routes them there
// from the agent-<id>.jsonl transcript), and letting them through published
// every subagent narration into the parent convo too (2026-07-15 live dupe).
export function isSidechainEvent(event) {
  if (!event || typeof event !== 'object') return false;
  return Boolean(event.parent_tool_use_id || event.isSidechain);
}

// Context footprint from a parent-stream assistant event. Subagent events
// are skipped — print mode tags them with parent_tool_use_id, older inline
// transcripts with isSidechain — because their usage measures the SUBAGENT's
// context, not the session's; letting one through would make the gauge dip
// to the subagent's fresh little window mid-turn. Returns null whenever this
// event says nothing about the parent's context, so callers keep the last
// good value.
export function contextTokensFromAssistantEvent(event) {
  if (!event || event.type !== 'assistant') return null;
  if (isSidechainEvent(event)) return null;
  return contextTokensFromUsage(event.message?.usage);
}

// Post-compact context size from a compact_boundary system event. The two
// event sources spell the metadata differently: transcript files (iv-mode's
// source) use camelCase compactMetadata.postTokens, stream-json stdout
// (print mode) snake_case compact_metadata.post_tokens. Returns null when
// absent/zero so callers skip the repaint instead of zeroing the gauge.
export function postCompactContextTokens(event) {
  const meta = event?.compactMetadata || event?.compact_metadata;
  const tokens = meta?.postTokens ?? meta?.post_tokens;
  return typeof tokens === 'number' && tokens > 0 ? tokens : null;
}

// Normalized trigger ('manual' | 'auto') from a compact_boundary event,
// reading both metadata spellings (see postCompactContextTokens). Returns
// null when absent so callers treat an unknown trigger conservatively.
export function compactTriggerFrom(event) {
  const meta = event?.compactMetadata || event?.compact_metadata;
  const trigger = meta?.trigger;
  return typeof trigger === 'string' && trigger ? trigger : null;
}

// Chat-facing context gauge, "24k/200k": tokens over the model's window.
// Counts under 10k keep one decimal ("2.4k") so a freshly compacted
// footprint doesn't flatten to "2k"; windows are round numbers and format
// clean ("200k", "1m"). Returns null without a usable token count so
// callers fall back to non-numeric wording.
export function contextGaugeText(tokens, model) {
  if (typeof tokens !== 'number' || tokens <= 0) return null;
  return `${formatTokenCount(tokens)}/${formatTokenCount(contextWindowFor(model))}`;
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${roundShort(n / 1_000_000)}m`;
  if (n >= 1_000) return `${roundShort(n / 1_000)}k`;
  return String(n);
}

function roundShort(x) {
  return String(x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
}

// Extract the logged-in account's email from a parsed ~/.claude.json.
// Returns null when logged out / malformed — the frame simply omits it.
// Pure (takes the parsed object); the file read + TTL cache live in
// index.js (getAccountEmail).
export function emailFromClaudeConfig(config) {
  const email = config?.oauthAccount?.emailAddress;
  return typeof email === 'string' && email ? email : null;
}

// Assemble the status frame payload. Every part is optional — a fresh
// session may know only its model, a resumed one may have limits before its
// first turn — and absent parts are omitted (not nulled) so clients can
// keep whatever they last rendered.
export function buildSessionStatus({ model, contextTokens, limits, email, workdir } = {}) {
  const status = {};
  if (model) status.model = model;
  if (typeof email === 'string' && email) status.email = email;
  // The session's working directory, so clients can render the header's
  // workdir segment (#521). Absent parts stay omitted, not nulled — a fresh
  // session may not know its workdir yet, and clients keep whatever they last
  // rendered.
  if (typeof workdir === 'string' && workdir) status.workdir = workdir;
  if (typeof contextTokens === 'number' && contextTokens > 0) {
    const window = contextWindowFor(model);
    status.context = {
      tokens: contextTokens,
      window,
      pct: Math.min(100, Math.round((contextTokens / window) * 100)),
    };
  }
  if (Array.isArray(limits) && limits.length > 0) status.limits = limits;
  return status;
}

// --- Host vitals (#526): CPU + RAM as two synthetic usage limits ------------
// These ride alongside the account rate limits so a single client component
// renders them the same way (id/label/percent). They are host-global (not
// session-specific) and never reset, so they carry no resets_at/resets.

// Sum idle + total CPU ticks across all cores from an os.cpus() snapshot.
function cpuTicks() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// CPU busy % is a SCHEDULED sample, not a per-call one. journalStatus fires
// multiple times in a single tick (several sessions sharing one limits-refresh
// promise, a compact-boundary repaint), so a sampler that mutated a shared
// baseline on every read would see a ~0 interval on the 2nd/3rd call and emit
// 0/100 garbage. Instead a fixed-cadence interval owns the baseline and writes
// a cached value; hostVitalLimits() only READS the cache and never mutates.
//
// _priorCpuTicks is touched ONLY by sampleCpuOnce (the scheduled step + tests).
// _cachedCpuPct holds the last VALID busy %; a degenerate (zero-tick) window
// preserves it rather than overwriting with garbage.
let _priorCpuTicks = null;
let _cachedCpuPct = null;
// Epoch-ms timestamp of the last VALID CPU sample. Lets consumers judge the age
// of the cached reading (the sampler refreshes on a fixed cadence but the value
// is only published on turn-end, so an idle conversation can replay a stale %).
let _cachedCpuSampledAtMs = null;
let _cpuSamplerHandle = null;

// One scheduled sampling step: diff fresh ticks against the prior scheduled
// snapshot and update the cache. First call only establishes the baseline
// (leaves the cache untouched). A zero-elapsed window preserves the prior
// cached value. Exported for deterministic testing; in production only the
// interval and startCpuSampler's priming call invoke it.
export function sampleCpuOnce() {
  const cur = cpuTicks();
  const prev = _priorCpuTicks;
  _priorCpuTicks = cur;
  if (!prev) return;
  const idleDelta = cur.idle - prev.idle;
  const totalDelta = cur.total - prev.total;
  if (totalDelta <= 0) return; // preserve _cachedCpuPct, don't emit 0/100
  const busy = 1 - idleDelta / totalDelta;
  _cachedCpuPct = Math.max(0, Math.min(100, Math.round(busy * 100)));
  _cachedCpuSampledAtMs = Date.now();
}

// Read-only accessor for the latest cached CPU busy % (integer 0-100), or null
// before the sampler has produced a first valid value. Never mutates state, so
// it is safe to call many times within one tick.
export function cpuPercent() {
  return _cachedCpuPct;
}

// Read-only accessor for the epoch-ms time of the latest valid CPU sample, or
// null before the sampler has produced a first valid value. Pairs with
// cpuPercent() so consumers can expire/hide a stale host_cpu reading.
export function cpuSampledAtMs() {
  return _cachedCpuSampledAtMs;
}

// Start the fixed-cadence CPU sampler. Idempotent. Establishes the baseline
// immediately, then refreshes the cache every intervalMs. .unref()'d so it
// never holds the process open. Wire startCpuSampler() once at boot and
// stopCpuSampler() from the shutdown hook.
export function startCpuSampler(intervalMs = 15000) {
  if (_cpuSamplerHandle) return;
  sampleCpuOnce(); // establish the baseline (no cached value yet)
  _cpuSamplerHandle = setInterval(sampleCpuOnce, intervalMs);
  if (typeof _cpuSamplerHandle.unref === 'function') _cpuSamplerHandle.unref();
}

export function stopCpuSampler() {
  if (_cpuSamplerHandle) {
    clearInterval(_cpuSamplerHandle);
    _cpuSamplerHandle = null;
  }
  _priorCpuTicks = null;
  _cachedCpuPct = null;
  _cachedCpuSampledAtMs = null;
}

// Used-RAM percent (0-100 integer) from instant syscalls, or null if the OS
// reports no total memory. Stateless, so it stays inline (no cache needed).
export function ramPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  if (!total) return null;
  return Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100)));
}

// Host CPU + RAM as synthetic limit entries for the status frame. Reads the
// cached CPU value (never samples here); host_cpu is omitted until the sampler
// has a first valid reading. host_ram is computed inline. Each entry carries
// sampled_at_ms (epoch ms) so consumers can expire/hide a stale reading —
// host_cpu uses the sampler's stamp; host_ram stamps inline at read time since
// it is computed from instant syscalls. Returns [] if neither is available.
export function hostVitalLimits() {
  const out = [];
  const cpu = cpuPercent();
  if (cpu !== null) {
    out.push({ id: 'host_cpu', label: 'CPU', percent: cpu, sampled_at_ms: cpuSampledAtMs() });
  }
  const ram = ramPercent();
  if (ram !== null) {
    out.push({ id: 'host_ram', label: 'RAM', percent: ram, sampled_at_ms: Date.now() });
  }
  return out;
}
