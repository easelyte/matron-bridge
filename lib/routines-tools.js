// Loopback handlers behind the routine_list / routine_update / routine_run
// MCP tools (spec: matron-journal
// docs/superpowers/specs/2026-10-01-coordinator-routines-design.md). A
// routine is a schedule and a prompt the journal owns and fires into the
// Coordinator conversation; these tools let the Coordinator see them,
// pause, resume or edit one, and fire one now. Creating and deleting stay
// in the apps. Same {status, body} contract as lib/consent-tools.js. The
// journal is the gate (the Coordinator only, naming its own conversation);
// this layer refuses a non-Coordinator first with the clearer sentence and
// validates with reasons so a bad call never costs a journal round trip.
import { peerField } from './peer-text.js';

const NOT_COORDINATOR = "only the Coordinator may read or change the user's routines — this conversation is not the Coordinator";
const NO_ROUTES = 'this journal deployment does not have the /routines routes yet — deploy the journal update (matron-journal coordinator routines)';
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TITLE_MAX = 200;
export const PROMPT_MAX = 2000;
export const TZ_MAX = 64;
const EDITABLE = ['title', 'schedule', 'tz', 'prompt', 'enabled', 'trigger'];
export const TRIGGER_KINDS = ['context_over', 'stalled', 'disk_under'];
const BAD_NAME = 'name must be the routine\'s slug as routine_list shows it: lowercase letters, digits and dashes, at most 64 characters';
// eslint-disable-next-line no-control-regex -- the control range is the point
const LINE_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const bad = (error) => ({ status: 400, body: { error } });

export function formatJournalRoutinesError(data, { name } = {}) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  const blockedBy = typeof data?.blocked_by === 'string' ? data.blocked_by : '';
  if (code === 'forbidden' && detail === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden') return 'the journal refused: an agent may pause or edit a routine, never delete one — the user does that in the apps';
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
  if (t.kind === 'stalled') {
    const m = Number.isInteger(t.reset_minutes) ? t.reset_minutes : 0;
    const span = m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`;
    return m > 0 ? `when a session stalls on a usage limit with no reset within ${span}` : 'when a session stalls on a usage limit';
  }
  return 'no trigger';
}

export function formatRoutineLine(r, now) {
  const name = typeof r?.name === 'string' && NAME_RE.test(r.name) ? r.name : '?';
  const when = r?.trigger && typeof r.trigger === 'object' ? describeTrigger(r.trigger) : describeSchedule(r?.schedule, r?.tz);
  const bits = [`${name} — ${peerField(r?.title, 80) || 'untitled'}`, when];
  if (r?.enabled === false) bits.push('paused');
  else if (!r?.trigger && Number.isFinite(Number(r?.next_at)) && r?.next_at != null) bits.push(`next ${rel(r.next_at, now)} (${clock(r.next_at, r?.tz)})`);
  if (r?.last_fired_at != null) bits.push(`last fired ${rel(r.last_fired_at, now)}${r?.last_outcome ? `: ${peerField(r.last_outcome, 60)}` : ''}`);
  else if (r?.last_outcome) bits.push(`last: ${peerField(r.last_outcome, 60)}`);
  return `- ${bits.join(' · ')}`;
}

export function formatRoutineList(data, { now = Date.now() } = {}) {
  const routines = Array.isArray(data?.routines) ? data.routines : [];
  if (!routines.length) return 'The user has no routines. The journal seeds the starter set when a Coordinator is first chosen; the user adds more in the apps (Settings ▸ Coordinator ▸ Routines).';
  return [
    `${routines.length} routine${routines.length === 1 ? '' : 's'} the journal fires into this conversation, on a schedule or when a trigger trips (nothing here re-arms itself — never set reminders for these). Pause, resume or edit one with routine_update; fire one now with routine_run; the user creates and deletes them in the apps.`,
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

export function validateUpdateFields(data) {
  const out = {};
  for (const k of Object.keys(data || {})) {
    if (['roomId', 'name'].includes(k) || data[k] === undefined) continue;
    if (!EDITABLE.includes(k)) return { ok: false, err: bad(`${k} is not editable — change title, schedule, tz, prompt or enabled`) };
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
  if ('trigger' in data) {
    const t = data.trigger;
    const okKind = t && typeof t === 'object' && !Array.isArray(t) && TRIGGER_KINDS.includes(t.kind);
    const okPct = t?.kind === 'stalled' ? t.pct === undefined : Number.isInteger(t?.pct) && t.pct >= 1 && t.pct <= 99;
    const okReset = t?.kind !== 'stalled' ? t?.reset_minutes === undefined : (t.reset_minutes === undefined || (Number.isInteger(t.reset_minutes) && t.reset_minutes >= 0));
    if (!okKind || !okPct || !okReset) return { ok: false, err: bad('trigger must be {kind: "context_over"|"disk_under", pct: 1–99} or {kind: "stalled", reset_minutes?: minutes}') };
    if ('schedule' in data) return { ok: false, err: bad('give schedule or trigger, not both — a routine is one or the other') };
    out.trigger = t.kind === 'stalled' ? { kind: 'stalled', ...(t.reset_minutes !== undefined ? { reset_minutes: t.reset_minutes } : {}) } : { kind: t.kind, pct: t.pct };
  }
  if (!Object.keys(out).length) return { ok: false, err: bad('nothing to change — give title, schedule, tz, prompt or enabled') };
  return { ok: true, value: out };
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

  return {
    async list(data) {
      const { err } = caller(data);
      if (err) return err;
      const r = passthrough(await client.list());
      if (r.status === 404) return { status: 404, body: { error: NO_ROUTES } };
      return r;
    },
    async update(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const name = nameOf(data);
      if (!name) return bad(BAD_NAME);
      const v = validateUpdateFields(data);
      if (!v.ok) return v.err;
      return passthrough(await client.update(name, { ...v.value, convo_id: convoId }), { name });
    },
    async run(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const name = nameOf(data);
      if (!name) return bad(BAD_NAME);
      return passthrough(await client.run(name, { convo_id: convoId }), { name });
    },
    _now: now,
  };
}
