// Coordinator session control, target-bridge side (spec
// docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md,
// "Decisions"): the pure planner behind the `session_control` RPC. Given
// the relayed params and the session they aim at, decide whether to apply
// now, park until the session is free, or refuse — and name the notice the
// target chat gets and the steps index.js runs. No I/O here; index.js owns
// the session objects, the model/agent switch paths and the turn injection.
import { AGENT_CLAUDE, AGENT_CODEX, normalizeAgent, agentLabel } from './agent-backend.js';
import { isValidModelArg, normalizeModelArg, aliasLabel } from './model-aliases.js';
import { peerField, PEER_NAME_MAX } from './peer-text.js';

export const CONTROL_ACTIONS = new Set(['set_model', 'compact', 'carry_on', 'alert', 'routine']);
// Drain order for parked slots: the compact first (it must shrink the
// context BEFORE the next turn runs on it), then an infrastructure alert
// (time-sensitive: a disk filling up does not wait behind a carry-on), then
// the carry-on turn, the model/agent switch last (a print-mode switch
// recreates the process, which carries the queue). A slot that starts a
// turn ends the drain; the rest wait for the next seam.
export const CONTROL_KINDS = ['compact', 'alert', 'routine', 'carry_on', 'set_model'];
// An alert is delivered through the same turn-injection op as a carry-on
// ({op:'carry_on', text}), so it needs no op of its own here.
export const TURN_STARTING_OPS = new Set(['compact', 'carry_on']);
export const MESSAGE_MAX_CHARS = 2000;
// `alert` (journal-originated, e.g. Prometheus Alertmanager via the
// journal's POST /alerts/alertmanager) is the one action no agent can send:
// the journal issues it itself, as an RPC with from_device_id 0 — no real
// device has id 0 (matron-journal src/rpc-broker.js). It may only land on
// the user's Coordinator.
export const JOURNAL_DEVICE_ID = 0;
export const ALERT_DEFAULT_FROM = 'Alertmanager';
// `routine` (spec 2026-10-01 coordinator routines): a Coordinator routine
// the journal's sweep (or POST /routines/:key/run) fires. Journal-only and
// Coordinator-only exactly like `alert`; its own slot kind so a parked
// routine neither replaces nor is replaced by a parked alert or carry-on.
export const ROUTINE_DEFAULT_FROM = 'Routines';
export const JOURNAL_ONLY_ACTIONS = new Set(['alert', 'routine']);
const ROUTINE_ID_MAX = 64;
const ROUTINE_TITLE_MAX = 200;
const ROUTINE_TZ_MAX = 64;
const ROUTINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Alerts that arrive while the Coordinator is mid-turn are merged into the
// one parked slot (see mergeParkedSlot) rather than latest-wins, so a
// second alert never silently drops the first. Capped so a flapping alert
// cannot grow the parked turn without bound; the oldest text goes first.
export const ALERT_PARKED_MAX_CHARS = 4 * MESSAGE_MAX_CHARS;
export const REASON_MAX_CHARS = 200;
export const MODEL_MAX_CHARS = 64;

// The same "is this session free" test room delivery uses: a turn running,
// a resume hold, an open AskUserQuestion, an open TUI prompt. Anything else
// (a queued message, a pending plan) only matters to an agent switch, which
// canSwitchAgent judges separately.
export function occupied(session) {
  return !!session?.busy || !!session?._awaitingInputReady
    || !!session?.waitingForAnswer || !!session?.pendingInteractivePrompt;
}

// Wire-contract re-check of what the journal relayed (it validates too,
// but the target must not trust the far end with the only copy of the rule).
export function validateControlParams(params) {
  if (!params || typeof params !== 'object') return { code: 'bad_request', detail: 'no params' };
  if (typeof params.convo_id !== 'string' || !params.convo_id) return { code: 'bad_request', detail: 'bad convo_id' };
  if (!CONTROL_ACTIONS.has(params.action)) return { code: 'bad_request', detail: 'bad action' };
  const out = { convoId: params.convo_id, action: params.action };
  // Relayed strings end up inside bridge-signed lines (the notice, the
  // turn's provenance frame): one line, de-controlled, capped.
  if (params.reason != null) {
    if (typeof params.reason !== 'string' || params.reason.length > REASON_MAX_CHARS) return { code: 'bad_request', detail: 'bad reason' };
    const reason = peerField(params.reason, REASON_MAX_CHARS);
    if (reason) out.reason = reason;
  }
  const fromName = peerField(params.from_name, PEER_NAME_MAX).replace(/[[\]()]/g, '').trim();
  if (fromName) out.fromName = fromName;
  if (params.action === 'set_model') {
    if (params.agent != null) {
      const agent = normalizeAgent(params.agent);
      if (!agent) return { code: 'bad_agent', detail: String(params.agent).slice(0, 40) };
      out.agent = agent;
    }
    if (params.model != null) {
      if (typeof params.model !== 'string' || !params.model.trim() || params.model.length > MODEL_MAX_CHARS || /\s/.test(params.model.trim())) {
        return { code: 'bad_model', detail: 'model must be one token of at most 64 characters' };
      }
      out.model = params.model.trim();
    }
    if (!out.agent && !out.model) return { code: 'bad_request', detail: 'set_model needs model or agent' };
  }
  if (params.action === 'alert') {
    // Multi-line is the point (an Alertmanager group lists several
    // alerts), so newlines survive; every other control character goes.
    const message = typeof params.message === 'string' && params.message.length <= MESSAGE_MAX_CHARS
      ? alertMessage(params.message) : '';
    if (!message) return { code: 'bad_request', detail: 'alert needs a message of at most 2000 characters' };
    out.message = message;
    if (!out.fromName) out.fromName = ALERT_DEFAULT_FROM;
  }
  if (params.action === 'routine') {
    if (typeof params.routine_id !== 'string' || !params.routine_id.trim() || params.routine_id.length > ROUTINE_ID_MAX) return { code: 'bad_request', detail: 'routine needs a routine_id' };
    out.routineId = params.routine_id.trim();
    if (typeof params.name !== 'string' || !ROUTINE_NAME_RE.test(params.name)) return { code: 'bad_request', detail: 'routine needs a slug name' };
    out.name = params.name;
    const title = typeof params.title === 'string' && params.title.length <= ROUTINE_TITLE_MAX ? peerField(params.title, ROUTINE_TITLE_MAX) : '';
    if (!title) return { code: 'bad_request', detail: 'routine needs a one-line title of at most 200 characters' };
    out.title = title;
    // Multi-line (a triggered routine lists its subjects under the
    // prompt), so newlines survive like an alert's; but no continuation
    // line may open a bracket frame of its own, so a prompt can never forge
    // a second provenance line inside the routine turn.
    const message = typeof params.message === 'string' && params.message.length <= MESSAGE_MAX_CHARS ? routineMessage(params.message) : '';
    if (!message) return { code: 'bad_request', detail: 'routine needs a message of at most 2000 characters' };
    out.message = message;
    if (typeof params.fired_at === 'string' && params.fired_at.length <= 40 && Number.isFinite(Date.parse(params.fired_at))) out.firedAt = params.fired_at;
    if (typeof params.tz === 'string' && params.tz.trim()) {
      if (params.tz.length > ROUTINE_TZ_MAX) return { code: 'bad_request', detail: 'bad tz' };
      out.tz = peerField(params.tz, ROUTINE_TZ_MAX);
    }
    if (!out.fromName) out.fromName = ROUTINE_DEFAULT_FROM;
  }
  if (params.action === 'carry_on') {
    if (typeof params.message !== 'string' || !params.message.trim() || params.message.length > MESSAGE_MAX_CHARS) {
      return { code: 'bad_request', detail: 'carry_on needs a message of at most 2000 characters' };
    }
    out.message = params.message.trim();
    out.when = params.when === 'after_limit_reset' ? 'after_limit_reset' : 'now';
  }
  return { ok: true, params: out };
}

// An alert body: line breaks of every flavour (CRLF, lone CR, NEL, U+2028/9)
// become '\n', tabs a space, any other C0 control or DEL is dropped, then
// trailing space per line and blank lines at either end are trimmed.
// eslint-disable-next-line no-control-regex
const ALERT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function alertMessage(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n').replace(/\t/g, ' ').replace(ALERT_CONTROL, '')
    .split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

// The name inside a bridge-signed frame: one line, no brackets or parens
// (either could close the frame early and forge a second one), capped.
// validateControlParams already does this; the frame builders repeat it so
// they stay safe on their own.
function frameName(name) {
  return peerField(name, PEER_NAME_MAX).replace(/[[\]()]/g, '').trim();
}

// The turn an alert injects into the Coordinator. Framed HERE, never by
// the caller: the journal (or whatever sits behind it) supplies only the
// sender's name and the body, and cannot choose the provenance line. The
// Coordinator's instructions (BRIDGE_COORDINATOR.md) key on this prefix.
export function alertTurnText(message, fromName) {
  const who = frameName(fromName) || ALERT_DEFAULT_FROM;
  return `[alert from ${who}, relayed by the journal] ${message}`;
}

// A routine body: alertMessage's normalisation, then every line after the
// first that starts with "[" is indented one space so it cannot read as a
// bridge-signed frame.
export function routineMessage(raw) {
  const text = alertMessage(raw);
  if (!text) return '';
  return text.split('\n').map((l, i) => (i > 0 && l.startsWith('[') ? ` ${l}` : l)).join('\n');
}

// The fire time as the routine's own zone shows it ("07:05 Europe/London"),
// or '' when the params carry none. A zone the runtime does not know falls
// back to UTC rather than losing the time.
function firedAtLabel(firedAt, tz) {
  const t = Date.parse(firedAt);
  if (!Number.isFinite(t)) return '';
  for (const zone of [tz, 'UTC']) {
    if (!zone) continue;
    try {
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
      return `${hhmm} ${zone}`;
    } catch { /* unknown zone: try the next */ }
  }
  return '';
}

// The turn a routine injects into the Coordinator — framed HERE like an
// alert, so the journal supplies the name, the fire time and the prompt and
// never the provenance line. A slot that merged several routines
// (mergeParkedSlot) renders each one's frame, oldest first. The
// Coordinator's playbook keys on the `[routine <name>, …]` prefix.
function oneRoutineFrame(p) {
  const name = frameName(p.name) || 'routine';
  const when = firedAtLabel(p.firedAt, p.tz);
  return `[routine ${name}, fired by the journal${when ? ` at ${when}` : ''}] ${p.message}`;
}
export function routineTurnText(params) {
  const earlier = Array.isArray(params?.earlier) ? params.earlier : [];
  return [...earlier, params].map(oneRoutineFrame).join('\n\n');
}

// Who may send what (checked by index.js BEFORE the target is resolved, so
// a refused alert never wakes a session). Only the journal-only actions
// (`alert`, `routine`) are gated here: the other actions are gated by the
// journal to the Coordinator as caller.
//   fromDeviceId        the RPC's from_device_id (0 = the journal itself)
//   coordinatorConvoId  the journal's current Coordinator (coordinatorLookup)
// -> null when allowed, else { code, detail }.
export function authorizeControl({ params, fromDeviceId, coordinatorConvoId }) {
  if (!JOURNAL_ONLY_ACTIONS.has(params?.action)) return null;
  if (fromDeviceId !== JOURNAL_DEVICE_ID) return { code: 'forbidden', detail: `${params.action} is journal-originated only` };
  if (typeof coordinatorConvoId !== 'string' || !coordinatorConvoId || params.convoId !== coordinatorConvoId) {
    return { code: 'not_coordinator', detail: `${params.action} may only target the Coordinator` };
  }
  return null;
}

// What to store when a slot is parked over one of the same kind. Latest
// wins for every kind except `alert`, whose bodies are appended (each alert
// is news; a newer one does not supersede an older one), oldest text
// trimmed first past ALERT_PARKED_MAX_CHARS. The caller gives the result a
// fresh id, so a drain that is applying the older slot does not settle this
// one — at worst that alert is repeated, never lost.
export function mergeParkedSlot(existing, slot) {
  if (slot?.kind === 'routine' && existing?.kind === 'routine' && existing?.params?.name) {
    // A newer fire of the SAME routine supersedes an unapplied one (a
    // 2-hourly check never piles up); other routines are kept, oldest
    // first, dropped oldest-first once the rendered turn passes the cap.
    const flat = ({ earlier: _e, ...p }) => p;
    const earlier = [...(Array.isArray(existing.params.earlier) ? existing.params.earlier : []), existing.params]
      .map(flat)
      .filter((p) => p.name !== slot.params?.name);
    const fits = (list) => routineTurnText({ ...slot.params, earlier: list }).length <= ALERT_PARKED_MAX_CHARS;
    while (earlier.length && !fits(earlier)) earlier.shift();
    if (!earlier.length) return slot;
    return { ...slot, params: { ...flat(slot.params), earlier } };
  }
  if (slot?.kind !== 'alert' || existing?.kind !== 'alert' || typeof existing?.params?.message !== 'string') return slot;
  let message = `${existing.params.message}\n\n${slot.params.message}`;
  if (message.length > ALERT_PARKED_MAX_CHARS) message = `…${message.slice(message.length - ALERT_PARKED_MAX_CHARS + 1)}`;
  return { ...slot, params: { ...slot.params, message } };
}

// The turn a carry-on injects. Framed HERE, on the target bridge, so the
// Coordinator can never dictate its own provenance line.
export function coordinatorTurnText(message, fromName) {
  const who = fromName ? `the Coordinator (${fromName})` : 'the Coordinator';
  return `[from ${who}] ${message}`;
}

function modelLabel(model, agent) {
  if (!model) return '';
  return agent === AGENT_CODEX ? model : aliasLabel(normalizeModelArg(model)) || model;
}

// The one-line notice the target session's chat gets (decision B). `phase`
// is 'now' (applied at once), 'deferred' (parked, will apply when the
// session is free), 'applied' (a parked action just applied), 'scheduled'
// (a carry-on waiting for the limit reset) or an error code.
export function controlNotice(params, { phase, agent, resetsAt, error } = {}) {
  const tail = phase === 'deferred' ? ' once this turn finishes'
    : phase === 'applied' ? ' (now that the session is free)'
      : '';
  if (params.action === 'alert') {
    // Not from the Coordinator: named after its sender, first line only.
    const who = frameName(params.fromName) || ALERT_DEFAULT_FROM;
    const first = peerField(String(params.message ?? '').split('\n').find((l) => l.trim()) || '', 160);
    if (error) return `⚠️ ${who} alert${first ? `: ${first}` : ''} — refused: ${error}`;
    return `🔔 ${who}: ${first}${tail}`;
  }
  if (params.action === 'routine') {
    // A slot that merged several routines names them all, oldest first, so
    // every fire that lands in the turn has its line in the chat.
    const all = [...(Array.isArray(params.earlier) ? params.earlier : []), params];
    const names = all.map((p) => frameName(p.name) || '?').join(', ');
    const label = all.length === 1 ? `Routine ${names}: ${peerField(params.title, 160)}` : `Routines ${names}`;
    if (error) return `⚠️ ${label} — refused: ${error}`;
    return `🔔 ${label}${tail}`;
  }
  const by = params.fromName ? `Coordinator (${params.fromName})` : 'Coordinator';
  const why = params.reason ? ` — ${params.reason}` : '';
  let what;
  switch (params.action) {
    case 'compact':
      what = 'compacting this session';
      break;
    case 'set_model': {
      const parts = [];
      if (params.agent && params.agent !== agent) parts.push(`switching this session to ${agentLabel(params.agent)}`);
      if (params.model) parts.push(`${parts.length ? 'then ' : ''}switching the model to ${modelLabel(params.model, params.agent || agent)}`);
      what = parts.join(', ') || 'switching this session';
      break;
    }
    case 'carry_on': {
      const flat = peerField(params.message, 160);
      const excerpt = flat ? `: “${flat}”` : '';
      what = params.when === 'after_limit_reset'
        ? `carry on once the usage limit resets${resetsAt ? ` at ${hhmmUtc(resetsAt)}` : ''}${excerpt}`
        : `carry on${excerpt}`;
      break;
    }
    default:
      what = params.action;
  }
  if (error) return `⚠️ ${by}: ${what} — refused: ${error}${why}`;
  return `🛠 ${by}: ${what}${tail}${why}`;
}

export function hhmmUtc(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// The decision. `canSwitch(session, agent)` is lib/agent-handoff.js's
// canSwitchAgent (injected so this stays pure).
//   -> { kind:'error', code, detail? }
//   -> { kind:'park',  slot: { kind, params } }       parked until free
//   -> { kind:'apply', steps: [...] }                  run now, in order
//   -> { kind:'schedule', at, text }                   carry_on after the limit reset
// steps: {op:'switch_agent', agent} | {op:'set_model', model} | {op:'compact'} | {op:'carry_on', text}
export function planSessionControl({ params, session, canSwitch = () => ({ ok: true }) }) {
  if (!session) return { kind: 'error', code: 'not_found' };
  if (!session.alive) return { kind: 'error', code: 'gone', detail: 'the session has ended' };
  const agent = session.agent === AGENT_CODEX ? AGENT_CODEX : AGENT_CLAUDE;
  switch (params.action) {
    case 'carry_on': {
      if (params.when === 'after_limit_reset') {
        if (!session._stall) return { kind: 'error', code: 'not_stalled', detail: 'the session is not stalled on a usage limit' };
        if (!session._stall.resets_at) return { kind: 'error', code: 'no_reset_time', detail: 'the stall has no known reset time — use when: now, or switch the model' };
        return { kind: 'schedule', at: session._stall.resets_at, text: coordinatorTurnText(params.message, params.fromName) };
      }
      const step = { op: 'carry_on', text: coordinatorTurnText(params.message, params.fromName) };
      if (occupied(session)) return { kind: 'park', slot: { kind: 'carry_on', params } };
      return { kind: 'apply', steps: [step] };
    }
    case 'alert':
      // Like carry_on `now`, in its own slot kind so it neither replaces
      // nor is replaced by a parked Coordinator carry-on.
      if (occupied(session)) return { kind: 'park', slot: { kind: 'alert', params } };
      return { kind: 'apply', steps: [{ op: 'carry_on', text: alertTurnText(params.message, params.fromName) }] };
    case 'routine':
      if (occupied(session)) return { kind: 'park', slot: { kind: 'routine', params } };
      return { kind: 'apply', steps: [{ op: 'carry_on', text: routineTurnText(params) }] };
    case 'compact':
      if (occupied(session)) return { kind: 'park', slot: { kind: 'compact', params } };
      return { kind: 'apply', steps: [{ op: 'compact' }] };
    case 'set_model': {
      const switching = !!params.agent && params.agent !== agent;
      const targetAgent = params.agent || agent;
      // Validate the model against the backend it will run on, before
      // anything is parked: a bad alias must never wait a turn to be refused.
      if (params.model && targetAgent === AGENT_CLAUDE && !isValidModelArg(params.model)) {
        return { kind: 'error', code: 'bad_model', detail: `unknown Claude model alias: ${params.model}` };
      }
      if (switching) {
        const verdict = canSwitch(session, params.agent);
        if (!verdict.ok) return { kind: 'park', slot: { kind: 'set_model', params } };
      } else if (occupied(session)) {
        return { kind: 'park', slot: { kind: 'set_model', params } };
      }
      // Switching backends carries the model INTO the switch (the new
      // session is created on it) rather than typing /model into a session
      // that is still starting up.
      if (switching) return { kind: 'apply', steps: [{ op: 'switch_agent', agent: params.agent, ...(params.model ? { model: params.model } : {}) }] };
      if (!params.model) return { kind: 'error', code: 'bad_request', detail: `the session already runs ${agentLabel(agent)} — name a model to change it` };
      return { kind: 'apply', steps: [{ op: 'set_model', model: params.model }] };
    }
    default:
      return { kind: 'error', code: 'bad_request', detail: 'bad action' };
  }
}

// What the Coordinator's own chat is told when the result frame lands.
export function describeControlResult(frame, { action, box } = {}) {
  const where = box ? ` on ${box}` : '';
  const verb = action === 'compact' ? 'compact' : action === 'set_model' ? 'model switch' : action === 'carry_on' ? 'carry-on' : action === 'alert' ? 'alert' : action === 'routine' ? 'routine' : 'session control';
  if (!frame || frame.ok !== true) {
    const code = frame?.error?.code || 'unknown';
    const detail = frame?.error?.detail ? ` — ${frame.error.detail}` : '';
    const hint = code === 'timeout' ? ' (the bridge did not answer; the box may be starting)'
      : code === 'agent_unreachable' ? ' (the box is offline and could not be woken)'
        : code === 'not_found' ? ' (that bridge does not run this conversation)'
          : '';
    return `⚠️ Session ${verb}${where} failed: ${code}${detail}${hint}`;
  }
  const r = frame.result || {};
  if (r.applied === 'deferred') return `⏳ Session ${verb}${where} parked: the session is busy; it applies at its next idle point.`;
  if (r.applied === 'scheduled') return `⏰ Session ${verb}${where} scheduled${r.at ? ` for ${hhmmUtc(r.at)}` : ''}.`;
  return `✅ Session ${verb}${where} applied${r.detail ? `: ${r.detail}` : ''}.`;
}
