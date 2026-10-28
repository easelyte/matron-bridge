// Loopback handlers behind the routine_list / routine_update / routine_run
// / routine_create / routine_delete MCP tools (spec: matron-journal
// docs/superpowers/specs/2026-10-01-coordinator-routines-design.md). A
// routine is a schedule and a prompt the journal owns and fires into the
// Coordinator conversation; these tools let the Coordinator see them,
// pause, resume or edit one, fire one now, and create or delete one (the
// Coordinator makes routines itself). Same {status, body} contract as lib/consent-tools.js. The
// journal is the gate (the Coordinator only, naming its own conversation);
// this layer refuses a non-Coordinator first with the clearer sentence and
// validates with reasons so a bad call never costs a journal round trip.
import { peerField } from './peer-text.js';
import { causesForAsk } from './turn-cause.js';

const NOT_COORDINATOR = "only the Coordinator may read or change the user's routines — this conversation is not the Coordinator";
const NO_ROUTES = 'this journal deployment does not have the /routines routes yet — deploy the journal update (matron-journal coordinator routines)';
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TITLE_MAX = 200;
export const PROMPT_MAX = 2000;
export const TZ_MAX = 64;
const EDITABLE = ['title', 'schedule', 'tz', 'prompt', 'enabled', 'trigger', 'envelope'];
const CREATE_FIELDS = ['name', ...EDITABLE];
// The loopback adds roomId; cause/causes are the bridge's to send (the
// calling turn's, below), so any the model put in the body is dropped
// rather than forwarded or refused.
const IGNORED_KEYS = ['roomId', 'cause', 'causes'];
export const TRIGGER_KINDS = ['context_over', 'stalled', 'disk_under', 'allowance_expiring'];
export const ALLOWANCE_TIERS_MAX = 4;
// A routine's envelope: what a fire of it may start on its own — how many
// spawns per fire, whether chats, onto which boxes (null = any). The journal
// approves the Coordinator's own asks from a routine-born turn only within it.
export const ENVELOPE_SPAWNS_MAX = 50;
export const ENVELOPE_BOXES_MAX = 32;
export const ENVELOPE_BOX_MAX = 64;
const ENVELOPE_KEYS = ['spawns_per_fire', 'chats', 'boxes'];
const BAD_ENVELOPE = `envelope must be null (clears it) or {spawns_per_fire: 0–${ENVELOPE_SPAWNS_MAX}, chats: true|false, boxes: null for any box, or 1–${ENVELOPE_BOXES_MAX} box names of at most ${ENVELOPE_BOX_MAX} characters}`;
const BAD_NAME = 'name must be the routine\'s slug as routine_list shows it: lowercase letters, digits and dashes, at most 64 characters';
// eslint-disable-next-line no-control-regex -- the control range is the point
const LINE_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const bad = (error) => ({ status: 400, body: { error } });

export function formatJournalRoutinesError(data, { name } = {}) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  const blockedBy = typeof data?.blocked_by === 'string' ? data.blocked_by : '';
  if (code === 'forbidden' && detail === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  // The journal's provenance gate (its routines-http.js): a Coordinator's
  // create, run, or rewrite of what a routine does (prompt, schedule,
  // trigger, envelope) must trace back to the user's own ask — their words
  // in the Coordinator conversation, or their comment or tap on one of its
  // items. A turn another agent or a routine fire started cannot do it,
  // however reasonable the request reads.
  if (code === 'forbidden' && detail === 'routine_write_unverified') {
    const whyText = typeof data?.why === 'string' ? peerField(data.why, 160) : '';
    const why = whyText ? ` (${whyText})` : '';
    return `the journal refused: this change needs the user's own ask behind it${why} — it goes through only in a turn started by the user's message in this conversation or their reply or tap on one of this conversation's items; ask them to say or tap it, do not retry from here`;
  }
  if (code === 'forbidden') return 'the journal refused: this journal deployment does not let the Coordinator delete routines yet — deploy the journal update (Coordinator routine delete), or the user deletes it in the apps';
  if (code === 'not_found') return name ? `no routine named "${name}" (routine_list shows the user's routines) — or this journal deployment does not have the /routines routes yet` : 'no such routine';
  if (code === 'conflict' && blockedBy === 'cap') return 'the journal holds the maximum number of routines';
  if (code === 'conflict') return 'a routine with that name already exists';
  if (code === 'bad_request') return 'the journal rejected the change — the schedule must be five cron fields firing at least 15 minutes apart, the zone a valid IANA name, the title one line of at most 200 characters, the prompt at most 2000';
  if (code === 'journal unreachable') return 'journal unreachable';
  return code || 'unknown error';
}

// Five-field cron in words for the common shapes a routine takes; anything
// else is shown as the raw pattern. Never throws on junk.
const HHMM = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daysText(dow) {
  if (dow === '*') return '';
  if (dow === '1-5') return 'weekdays';
  if (dow === '0,6' || dow === '6,0') return 'weekends';
  const names = dow.split(',').map((d) => DAY_NAMES[Number(d)]).filter(Boolean);
  return names.length === dow.split(',').length ? names.join(', ') : '';
}
export function describeSchedule(schedule, tz) {
  const raw = typeof schedule === 'string' ? schedule.trim() : '';
  const zone = typeof tz === 'string' && tz ? ` ${tz}` : '';
  const f = raw.split(/\s+/);
  if (f.length !== 5) return raw ? `cron "${peerField(raw, 64)}"` : 'no schedule';
  const [min, hour, dom, mon, dow] = f;
  const m = /^\d{1,2}$/.test(min) ? Number(min) : null;
  if (m === null || dom !== '*' || mon !== '*') return `cron "${peerField(raw, 64)}"${zone}`;
  const days = daysText(dow);
  if (dow !== '*' && !days) return `cron "${peerField(raw, 64)}"${zone}`;
  const every = /^\*\/(\d{1,2})$/.exec(hour);
  if (every) return `every ${Number(every[1])} h at :${String(m).padStart(2, '0')}${days ? ` on ${days}` : ''}${zone}`;
  if (hour === '*') return `hourly at :${String(m).padStart(2, '0')}${days ? ` on ${days}` : ''}${zone}`;
  const hours = hour.split(',');
  if (!hours.every((h) => /^\d{1,2}$/.test(h))) return `cron "${peerField(raw, 64)}"${zone}`;
  const times = hours.map((h) => HHMM(Number(h), m));
  const at = times.length === 1 ? times[0] : `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
  return `${days || 'daily'} at ${at}${zone}`;
}

const rel = (ts, now) => {
  const ms = Number(ts) - now;
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const text = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : abs < 48 * 3600000 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
};
function clock(ts, tz) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return '';
  for (const zone of [tz, 'UTC']) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    } catch { /* unknown zone: try the next */ }
  }
  return '';
}

// A trigger in words (spec "Triggers"): the rule a triggered routine fires on.
export function describeTrigger(t) {
  if (!t || typeof t !== 'object') return 'no trigger';
  const pct = Number.isInteger(t.pct) ? t.pct : '?';
  if (t.kind === 'context_over') return `when a session passes ${pct}% of its context window`;
  if (t.kind === 'disk_under') return `when a box drops under ${pct}% free disk`;
  if (t.kind === 'allowance_expiring' && Array.isArray(t.tiers)) {
    return `when a weekly limit has ${t.tiers.map((x) => `${x?.unused_pct ?? '?'}% unused with ${x?.hours_left ?? '?'} h left`).join(' or ')}`;
  }
  if (t.kind === 'allowance_expiring') {
    const from = Number.isInteger(t.from_hours) ? t.from_hours : 6;
    const to = Number.isInteger(t.to_hours) ? t.to_hours : 12;
    return `when a weekly limit resets within ${from}–${to} h and is under ${pct}%`;
  }
  if (t.kind === 'stalled') {
    const m = Number.isInteger(t.reset_minutes) ? t.reset_minutes : 0;
    const span = m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`;
    return m > 0 ? `when a session stalls on a usage limit with no reset within ${span}` : 'when a session stalls on a usage limit';
  }
  return 'no trigger';
}

export function describeEnvelope(e) {
  const n = Number.isInteger(e?.spawns_per_fire) ? e.spawns_per_fire : '?';
  // Only null means any box; an empty or malformed list allows none.
  const boxes = Array.isArray(e?.boxes) ? e.boxes.filter((b) => typeof b === 'string').slice(0, ENVELOPE_BOXES_MAX).map((b) => peerField(b, ENVELOPE_BOX_MAX)).filter(Boolean) : [];
  const where = e?.boxes === null ? 'any' : boxes.length ? boxes.join(',') : 'none';
  return `envelope: ${n} spawns/fire, chats ${e?.chats === true ? 'yes' : 'no'}, boxes ${where}`;
}

export function formatRoutineLine(r, now) {
  const name = typeof r?.name === 'string' && NAME_RE.test(r.name) ? r.name : '?';
  const when = r?.trigger && typeof r.trigger === 'object' ? describeTrigger(r.trigger) : describeSchedule(r?.schedule, r?.tz);
  const bits = [`${name} — ${peerField(r?.title, 80) || 'untitled'}`, when];
  if (r?.enabled === false) bits.push('paused');
  else if (!r?.trigger && Number.isFinite(Number(r?.next_at)) && r?.next_at != null) bits.push(`next ${rel(r.next_at, now)} (${clock(r.next_at, r?.tz)})`);
  if (r?.last_fired_at != null) bits.push(`last fired ${rel(r.last_fired_at, now)}${r?.last_outcome ? `: ${peerField(r.last_outcome, 60)}` : ''}`);
  else if (r?.last_outcome) bits.push(`last: ${peerField(r.last_outcome, 60)}`);
  if (r?.envelope && typeof r.envelope === 'object' && !Array.isArray(r.envelope)) bits.push(describeEnvelope(r.envelope));
  return `- ${bits.join(' · ')}`;
}

export function formatRoutineList(data, { now = Date.now() } = {}) {
  const routines = Array.isArray(data?.routines) ? data.routines : [];
  if (!routines.length) return 'The user has no routines. The journal seeds the starter set when a Coordinator is first chosen; add more with routine_create when the user asks, or the user adds them in the apps (Settings ▸ Coordinator ▸ Routines).';
  return [
    `${routines.length} routine${routines.length === 1 ? '' : 's'} the journal fires into this conversation, on a schedule or when a trigger trips (nothing here re-arms itself — never set reminders for these). Pause, resume or edit one with routine_update; fire one now with routine_run; add or remove one with routine_create and routine_delete when the user asks.`,
    ...routines.map((r) => formatRoutineLine(r, now)),
  ].join('\n');
}

export function formatRoutineUpdateAck(data, args) {
  const r = data?.routine;
  const name = typeof r?.name === 'string' ? r.name : 'the routine';
  // Only the editable fields count: the tool call also carries name (and
  // the loopback adds roomId), which must not turn a resume into an edit.
  const fields = Object.fromEntries(Object.entries(args || {}).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined));
  if (fields.enabled === false) return `Paused ${name}: it will not fire until resumed (routine_update with enabled: true). ${formatRoutineLine(r, Date.now())}`;
  if (fields.enabled === true && Object.keys(fields).length === 1) return `Resumed ${name}. ${formatRoutineLine(r, Date.now())}`;
  return `Updated ${name}. ${formatRoutineLine(r, Date.now())}`;
}

export function formatRoutineRunAck(data, name) {
  if (data?.accepted === true) return `Firing ${name} now: the journal is delivering its prompt to this conversation as a turn (parked until this turn ends). Do not run it again — the turn arrives on its own.`;
  if (data?.reason === 'no_coordinator') return `Not fired: the journal has no Coordinator to fire ${name} into.`;
  if (data?.reason === 'busy') return `Not fired: the journal is already delivering several routines — try again in a minute.`;
  return `Not fired: ${peerField(data?.reason, 60) || 'unknown reason'}.`;
}

export function formatRoutineCreateAck(data) {
  const r = data?.routine;
  const name = typeof r?.name === 'string' ? r.name : 'the routine';
  if (r?.enabled === false) return `Created ${name}, paused: it will not fire until resumed (routine_update with enabled: true). ${formatRoutineLine(r, Date.now())}`;
  return `Created ${name}. ${formatRoutineLine(r, Date.now())}`;
}

export const formatRoutineDeleteAck = (name) => `Deleted ${name}: the journal will not fire it again. To bring it back, create it afresh with routine_create.`;

// Create: name, title and prompt required, exactly one of schedule and
// trigger; tz, enabled and envelope optional (the journal defaults
// Europe/London, enabled and no envelope; a null envelope is left out).
// The field checks are the update ones; the journal validates
// again (spacing, zone) and answers a bare 400 the error mapper explains.
export function validateCreateFields(data) {
  for (const k of Object.keys(data || {})) {
    if (IGNORED_KEYS.includes(k) || data[k] === undefined) continue;
    if (!CREATE_FIELDS.includes(k)) return { ok: false, err: bad(`${k} is not a routine field — give name, title, schedule or trigger, tz, prompt and optionally enabled and envelope`) };
  }
  if (typeof data?.name !== 'string' || !NAME_RE.test(data.name)) return { ok: false, err: bad('name must be a new slug: lowercase letters, digits and dashes, at most 64 characters, starting with a letter or digit') };
  if (data.title == null) return { ok: false, err: bad('title is required: one line saying what the routine is for') };
  if (data.prompt == null) return { ok: false, err: bad('prompt is required: the turn text the journal fires, ideally one line pointing at a playbook section or memory') };
  const hasSchedule = data.schedule !== undefined && data.schedule !== null;
  const hasTrigger = data.trigger !== undefined && data.trigger !== null;
  if (hasSchedule && hasTrigger) return { ok: false, err: bad('give schedule or trigger, not both — a routine is one or the other') };
  if (!hasSchedule && !hasTrigger) return { ok: false, err: bad('give a schedule or a trigger: five cron fields such as "30 8,16 * * *", or a trigger rule') };
  const fields = Object.fromEntries(Object.entries(data).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined && v !== null));
  const v = validateUpdateFields(fields);
  if (!v.ok) return v;
  return { ok: true, value: { name: data.name, ...v.value } };
}

export function validateUpdateFields(data) {
  const out = {};
  for (const k of Object.keys(data || {})) {
    if (IGNORED_KEYS.includes(k) || k === 'name' || data[k] === undefined) continue;
    if (!EDITABLE.includes(k)) return { ok: false, err: bad(`${k} is not editable — change title, schedule, tz, prompt, enabled, trigger or envelope`) };
  }
  if ('title' in data) {
    const t = typeof data.title === 'string' ? data.title.trim() : '';
    if (!t || t.length > TITLE_MAX || LINE_BAD_CHARS.test(t)) return { ok: false, err: bad(`title must be one non-empty line of at most ${TITLE_MAX} characters`) };
    out.title = t;
  }
  if ('schedule' in data) {
    const s = typeof data.schedule === 'string' ? data.schedule.trim() : '';
    if (!s || s.split(/\s+/).length !== 5 || s.length > 64) return { ok: false, err: bad('schedule must be five cron fields (minute hour day-of-month month day-of-week), e.g. "5 7 * * *" or "0 */2 * * *"') };
    out.schedule = s;
  }
  if ('tz' in data) {
    const z = typeof data.tz === 'string' ? data.tz.trim() : '';
    if (!z || z.length > TZ_MAX || /\s/.test(z)) return { ok: false, err: bad('tz must be an IANA zone name such as Europe/London') };
    out.tz = z;
  }
  if ('prompt' in data) {
    const p = typeof data.prompt === 'string' ? data.prompt.trim() : '';
    if (!p || p.length > PROMPT_MAX) return { ok: false, err: bad(`prompt must be a non-empty string of at most ${PROMPT_MAX} characters`) };
    out.prompt = p;
  }
  if ('enabled' in data) {
    if (typeof data.enabled !== 'boolean') return { ok: false, err: bad('enabled must be true or false') };
    out.enabled = data.enabled;
  }
  if ('trigger' in data && data.trigger?.kind === 'allowance_expiring' && data.trigger.tiers !== undefined) {
    const t = data.trigger;
    const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
    const okTier = (x) => x && typeof x === 'object' && !Array.isArray(x)
      && Object.keys(x).every((k) => k === 'unused_pct' || k === 'hours_left')
      && int(x.unused_pct, 1, 99) && int(x.hours_left, 1, 168);
    const others = Object.keys(t).filter((k) => k !== 'kind' && k !== 'tiers' && t[k] !== undefined);
    if (others.length || !Array.isArray(t.tiers) || t.tiers.length < 1 || t.tiers.length > ALLOWANCE_TIERS_MAX || !t.tiers.every(okTier)) {
      return { ok: false, err: bad(`allowance_expiring tiers must be 1–${ALLOWANCE_TIERS_MAX} of {unused_pct: 1–99, hours_left: 1–168}, with no pct, from_hours or to_hours beside them`) };
    }
    if ('schedule' in data) return { ok: false, err: bad('give schedule or trigger, not both — a routine is one or the other') };
    out.trigger = { kind: t.kind, tiers: t.tiers.map((x) => ({ unused_pct: x.unused_pct, hours_left: x.hours_left })) };
  } else if ('trigger' in data) {
    const t = data.trigger;
    const okKind = t && typeof t === 'object' && !Array.isArray(t) && TRIGGER_KINDS.includes(t.kind);
    const okPct = t?.kind === 'stalled' ? t.pct === undefined : Number.isInteger(t?.pct) && t.pct >= 1 && t.pct <= 99;
    const okReset = t?.kind !== 'stalled' ? t?.reset_minutes === undefined : (t.reset_minutes === undefined || (Number.isInteger(t.reset_minutes) && t.reset_minutes >= 0));
    const hours = (h) => h === undefined || (Number.isInteger(h) && h >= 0 && h <= 168);
    const okWindow = t?.kind !== 'allowance_expiring'
      ? t?.from_hours === undefined && t?.to_hours === undefined
      : hours(t.from_hours) && hours(t.to_hours) && (t.from_hours ?? 6) < (t.to_hours ?? 12);
    if (!okKind || !okPct || !okReset || !okWindow || t.tiers !== undefined) return { ok: false, err: bad('trigger must be {kind: "context_over"|"disk_under", pct: 1–99}, {kind: "stalled", reset_minutes?: minutes} or {kind: "allowance_expiring", pct: 1–99, from_hours?: 0–168, to_hours?: 0–168} with from_hours below to_hours (default 6–12), or {kind: "allowance_expiring", tiers: [{unused_pct, hours_left}, …]}') };
    if ('schedule' in data) return { ok: false, err: bad('give schedule or trigger, not both — a routine is one or the other') };
    if (t.kind === 'stalled') out.trigger = { kind: 'stalled', ...(t.reset_minutes !== undefined ? { reset_minutes: t.reset_minutes } : {}) };
    else if (t.kind === 'allowance_expiring') out.trigger = { kind: t.kind, pct: t.pct, ...(t.from_hours !== undefined ? { from_hours: t.from_hours } : {}), ...(t.to_hours !== undefined ? { to_hours: t.to_hours } : {}) };
    else out.trigger = { kind: t.kind, pct: t.pct };
  }
  if ('envelope' in data) {
    const v = validateEnvelope(data.envelope);
    if (!v.ok) return v;
    out.envelope = v.value;
  }
  if (!Object.keys(out).length) return { ok: false, err: bad('nothing to change — give title, schedule, tz, prompt, enabled, trigger or envelope') };
  return { ok: true, value: out };
}

// null clears the envelope; otherwise exactly the three fields, box names
// trimmed. The journal validates again.
export function validateEnvelope(e) {
  if (e === null) return { ok: true, value: null };
  const fail = { ok: false, err: bad(BAD_ENVELOPE) };
  if (!e || typeof e !== 'object' || Array.isArray(e)) return fail;
  if (Object.keys(e).some((k) => !ENVELOPE_KEYS.includes(k))) return fail;
  if (!Number.isInteger(e.spawns_per_fire) || e.spawns_per_fire < 0 || e.spawns_per_fire > ENVELOPE_SPAWNS_MAX) return fail;
  if (typeof e.chats !== 'boolean') return fail;
  let boxes = null;
  if (e.boxes !== null) {
    if (!Array.isArray(e.boxes) || e.boxes.length < 1 || e.boxes.length > ENVELOPE_BOXES_MAX) return fail;
    boxes = e.boxes.map((b) => (typeof b === 'string' ? b.trim() : ''));
    if (boxes.some((b) => !b || b.length > ENVELOPE_BOX_MAX || LINE_BAD_CHARS.test(b))) return fail;
  }
  return { ok: true, value: { spawns_per_fire: e.spawns_per_fire, chats: e.chats, boxes } };
}

// `isCoordinator(session, convoId)` decides the local refusal, as for the
// consent tools: index.js passes one that also asks the journal's current
// role holder, because the spawn-time flag stays false on a session that
// gained the role live. The journal is the real gate either way.
export function createRoutineHandlers({ sessions, journalConvoIdFor, client, isCoordinator = (session) => session?.coordinator === true, now = () => Date.now() }) {
  function caller(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!isCoordinator(session, convoId)) return { err: { status: 403, body: { error: NOT_COORDINATOR } } };
    if (!convoId) return { err: { status: 409, body: { error: 'this session has no journal conversation yet' } } };
    return { session, convoId };
  }
  const passthrough = (r, opts) => {
    if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
    if (r.status >= 400) return { status: r.status, body: { ...r.data, error: formatJournalRoutinesError(r.data, opts) } };
    return { status: r.status, body: r.data };
  };
  const nameOf = (data) => (typeof data?.name === 'string' && NAME_RE.test(data.name) ? data.name : null);
  // A routine write names what started the calling turn (lib/turn-cause.js),
  // like the spawn and chat asks: a routine made, changed or fired from a
  // turn the user did not start must not later let a routine-born turn
  // approve what that turn could not. From the session, never the request
  // body; omitted when the turn has none.
  const stamp = (session, body) => {
    const causes = causesForAsk(session);
    return { ...body, ...(causes ? { causes } : {}) };
  };

  return {
    async list(data) {
      const { err } = caller(data);
      if (err) return err;
      const r = passthrough(await client.list());
      if (r.status === 404) return { status: 404, body: { error: NO_ROUTES } };
      return r;
    },
    async update(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      const name = nameOf(data);
      if (!name) return bad(BAD_NAME);
      const v = validateUpdateFields(data);
      if (!v.ok) return v.err;
      return passthrough(await client.update(name, stamp(session, { ...v.value, convo_id: convoId })), { name });
    },
    async run(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      const name = nameOf(data);
      if (!name) return bad(BAD_NAME);
      return passthrough(await client.run(name, stamp(session, { convo_id: convoId })), { name });
    },
    async create(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      const v = validateCreateFields(data);
      if (!v.ok) return v.err;
      const r = passthrough(await client.create(stamp(session, { ...v.value, convo_id: convoId })));
      if (r.status === 404) return { status: 404, body: { error: NO_ROUTES } };
      return r;
    },
    async remove(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      const name = nameOf(data);
      if (!name) return bad(BAD_NAME);
      return passthrough(await client.remove(name, stamp(session, { convo_id: convoId })), { name });
    },
    _now: now,
  };
}
