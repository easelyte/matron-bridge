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

// Model → context window. 1m-class models are matched by family name (or an
// explicit [1m] marker); everything else gets the standard 200k. A wrong
// guess only skews the header percentage, so a conservative default beats an
// exhaustive table that goes stale with every model launch.
const WINDOW_1M_RE = /fable|mythos|\[1m\]/i;

export function contextWindowFor(model) {
  return WINDOW_1M_RE.test(String(model ?? '')) ? 1_000_000 : 200_000;
}

// Context footprint of the last request: everything that was sent up,
// however it was billed. Output tokens are excluded — they aren't part of
// the next request's context accounting here (the next turn's usage will
// include them as input). Returns null when there's nothing usable so the
// caller can distinguish "no turn yet" from a genuine zero.
// A session launched with a [1m] window marker whose first assistant event
// reports the bare 200k-default id must NOT silently narrow the gauge to 200k
// on the very first turn (the live "x/200k in a 1m session" bug). Widen-only:
// keep whichever model implies the larger window, so a later bare id never
// shrinks a window an earlier launch marker established. A genuine model switch
// flows through the /model command path, so this never blocks a real downgrade.
export function reconcileModelForWindow(prev, next) {
  if (!next) return prev ?? null;
  if (!prev) return next;
  return contextWindowFor(next) >= contextWindowFor(prev) ? next : prev;
}

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

// Mid-turn header repaints ride the parent assistant events, which can fire
// dozens of times a minute in a tool-heavy turn — each one would be a WS
// frame fanned out to every viewing client. Throttle by wall clock instead
// of by event count: event cadence varies wildly (a burst of cheap tool
// calls vs one long think), while "the gauge is at most N seconds stale" is
// the actual user-facing promise. Turn-end/compact publishes stay
// unthrottled — they're the frames that must always land.
export const STATUS_REPAINT_MS = 5_000;

export function statusRepaintDue(lastPublishedAt, now, minIntervalMs = STATUS_REPAINT_MS) {
  return typeof lastPublishedAt !== 'number' || (now - lastPublishedAt) >= minIntervalMs;
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
//
// The composer's three argument fields are the deliberate EXCEPTION to that
// rule, because they are the only ones that can go BACKWARDS — to unknown, or
// to "nothing on offer". Sessions reset effort on start/restart/resume (see
// lib/effort-tracker.js) and a mid-session /switch swaps the whole agent under
// a live convo. Under a sticky merge, omission reads as "unchanged", so
// staying silent would leave the app rendering a pre-restart effort level, or
// Claude's seven levels offered on a Codex session whose /effort refuses them
// with a stale "· xhigh" beside the Codex model. Omission cannot express
// "forget what you had", so these three are tri-state on the wire:
//
//   model_options / effort_levels
//     absent      -> no opinion; keep what you last rendered. Reserved for old
//                    bridges and for frames about something other than a main
//                    session (subagent convos)
//     []          -> this agent offers NOTHING; drop what you last rendered
//     [ … ]       -> the offered {value,label} arguments
//
//   effort
//     absent      -> no opinion; keep what you last rendered (as above)
//     null        -> UNKNOWN / not applicable; clear what you last rendered
//     "<level>"   -> the tracked level
//
// A Claude session publishes the full lists and a string-or-null effort; a
// Codex session publishes [] / [] / null — it takes a free-text model id the
// bridge never validates and does not expose effort at all, which is an
// opinion ("nothing here"), not silence.
//
// The clearing values are re-published on EVERY frame rather than sent once,
// so a client that missed one still converges. That matters twice over: the
// journal's status replay cache is replace-not-merge, so the LAST frame is
// what a cold-starting client sees, verbatim. Every publisher must therefore
// emit a complete frame — see the publisher audit in test/session-status.js.
//
// `vitals`, when present, is the host CPU/RAM snapshot (see hostVitals). It
// lives at TOP LEVEL (status.vitals), NOT inside limits[]: limits[] is the
// Claude-account subscription-meter list clients render as "N% used" gauges,
// and host vitals are neither account-scoped nor subscription meters. Keeping
// them out of limits[] also means Codex frames (which carry no account limits)
// still surface vitals without repopulating a Claude-only array.
// `modelOptions` / `effortLevels` are the composer's argument offers for
// /model and /effort — {value,label} lists built by the modules that own the
// registries (modelOptions() in lib/model-aliases.js, effortOptions() in
// lib/effort-command.js). SESSION-SCOPED, not global. `effort` is the current
// level, optimistically tracked by lib/effort-tracker.js — the bridge cannot
// read it back, so unknown is a null, never a guess.
export function buildSessionStatus({ model, contextTokens, limits, email, vitals, workdir, modelOptions, effortLevels, effort } = {}) {
  const status = {};
  if (model) status.model = model;
  // Tri-state (see the exception documented above): a caller with no opinion
  // passes undefined and the field is omitted; ANY array publishes as-is, so
  // an empty one states "nothing on offer" rather than vanishing.
  if (Array.isArray(modelOptions)) status.model_options = modelOptions;
  if (Array.isArray(effortLevels)) status.effort_levels = effortLevels;
  // Likewise: `undefined` omits, anything else publishes — a non-empty string
  // as itself, unknown as an explicit null.
  if (effort !== undefined) status.effort = (typeof effort === 'string' && effort) ? effort : null;
  if (typeof email === 'string' && email) status.email = email;
  // The session's working directory, so clients can render the header's
  // workdir segment. Every session type sets workdir at creation, so it is
  // normally present; the field is still guarded and omitted (not nulled) when
  // a caller passes an empty/absent value, matching the other optional fields —
  // clients then keep whatever they last rendered.
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
  if (vitals) status.vitals = vitals;
  return status;
}

// --- Host vitals: CPU + RAM as a top-level status snapshot -------------------
// Emitted as a top-level `status.vitals` object { cpu_pct, ram_pct,
// sampled_at_ms }, NOT as entries in limits[]. limits[] is the Claude-account
// subscription-meter list (clients render each as an "N% used" gauge, red near
// exhaustion); host CPU/RAM are host-global machine metrics, not account
// meters, so putting them in limits[] made clients paint "RAM 85%" as a
// near-exhausted subscription. Top level is additive (old clients ignore the
// unknown key) and lets Codex frames — which carry no account limits — still
// surface vitals without repopulating a Claude-only array.

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
// a cached value; hostVitals() only READS the cache and never mutates.
//
// _priorCpuTicks is touched ONLY by sampleCpuOnce (the scheduled step + tests).
// _cachedCpuPct holds the last VALID busy %; a degenerate (zero-tick) window
// preserves it rather than overwriting with garbage. _cachedCpuSampledAtMs is
// stamped alongside _cachedCpuPct on every SUCCESSFUL sample so hostVitals()
// can publish the reading's age — the CPU cache is refreshed on a 15s cadence but
// only PUBLISHED at turn end (journalStatus replays the last status to new
// viewers), so without this stamp an idle convo shows an arbitrarily old reading
// as if it were current (stale-replay blocker).
let _priorCpuTicks = null;
let _cachedCpuPct = null;
let _cachedCpuSampledAtMs = null;
let _cpuSamplerHandle = null;

// One scheduled sampling step: diff fresh ticks against the prior scheduled
// snapshot and update the cache. First call only establishes the baseline
// (leaves the cache untouched). A zero-elapsed window preserves the prior
// cached value. Exported for deterministic testing; in production only the
// interval and startCpuSampler's priming call invoke it. `ticks` is injectable
// so tests can drive a precise zero-delta window instead of racing real jiffy
// accumulation between two os.cpus() reads (defaults to a live snapshot).
export function sampleCpuOnce(ticks = cpuTicks()) {
  const cur = ticks;
  const prev = _priorCpuTicks;
  _priorCpuTicks = cur;
  if (!prev) return;
  const idleDelta = cur.idle - prev.idle;
  const totalDelta = cur.total - prev.total;
  if (totalDelta <= 0) return; // preserve _cachedCpuPct, don't emit 0/100
  const busy = 1 - idleDelta / totalDelta;
  _cachedCpuPct = Math.max(0, Math.min(100, Math.round(busy * 100)));
  _cachedCpuSampledAtMs = Date.now(); // age of THIS valid reading
}

// Read-only accessor for the latest cached CPU busy % (integer 0-100), or null
// before the sampler has produced a first valid value. Never mutates state, so
// it is safe to call many times within one tick.
export function cpuPercent() {
  return _cachedCpuPct;
}

// Epoch-ms time of the last VALID CPU sample, or null before the sampler has
// produced one. Paired with cpuPercent() so a client can expire/hide a reading
// that was cached long before it was replayed to the viewer. Never mutates.
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

// Host CPU + RAM snapshot for the status frame's top-level `vitals` object.
// Shape: { cpu_pct, ram_pct, sampled_at_ms }.
//   - cpu_pct: cached busy % (integer 0-100), or null until the sampler has a
//     first valid reading. Read-only here — never samples.
//   - ram_pct: used-RAM % (integer 0-100) computed inline, or null if the OS
//     reports no total memory.
//   - sampled_at_ms: epoch ms of the CPU cache-stamp (its 15s cadence), or now
//     for a RAM-only reading before the sampler has warmed. Clients expire/hide
//     the whole vitals object off this: the publisher replays the last status
//     frame to new viewers, so an idle convo would otherwise render an
//     arbitrarily old reading as current. The CPU reading is the one with real
//     staleness (a cache); RAM is read inline so it is at least this fresh.
// Returns null when neither metric is available (keeps status.vitals absent
// rather than emitting an all-null object).
export function hostVitals() {
  const cpu = cpuPercent();
  const ram = ramPercent();
  if (cpu === null && ram === null) return null;
  return {
    cpu_pct: cpu,
    ram_pct: ram,
    sampled_at_ms: cpuSampledAtMs() ?? Date.now(),
  };
}
