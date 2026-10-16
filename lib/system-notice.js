// Structured tag for the notices the bridge publishes into a chat beside an
// injected turn (a consent nudge, a routine fire, a room relay, a spawn
// outcome, a reminder…). The notice keeps its full text in `body`; this adds
// `payload.notice = {kind, icon, summary}` so the apps can show it as one
// short row — icon and summary — and expand to the full text on tap, without
// parsing prose. An agent's own replies never carry it.
//
// Every string here can hold peer text, so the summary is one line and
// capped like any other peer field.
import { peerField } from './peer-text.js';

export const NOTICE_SUMMARY_MAX = 140;

// Leading emoji (with its variation selector / joiners) and the gap after it.
const LEADING_ICON = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}))*)\s*/u;

const DEFAULT_ICONS = {
  consent: '🤝',
  unseen: '👀',
  routine: '🔔',
  alert: '🔔',
  control: '🛠',
  room: '💬',
  invite: '🤝',
  spawn: '🚀',
  reminder: '⏰',
  handoff: '💤',
  queue: '⏳',
};

const oneLine = (s, max = NOTICE_SUMMARY_MAX) => peerField(String(s ?? ''), max);

// Split "🔔 Routine x: title" into its icon and the rest.
export function splitLeadingIcon(text) {
  const firstLine = String(text ?? '').split('\n').find((l) => l.trim()) || '';
  const m = firstLine.match(LEADING_ICON);
  if (!m) return { icon: null, rest: firstLine.trim() };
  return { icon: m[1], rest: firstLine.slice(m[0].length).trim() };
}

// The generic tag: the first line of the notice, its leading emoji lifted
// out as the icon. Right for the notices that are already one short line
// (control notices, reminders, spawn outcomes, the idle handoff).
export function noticeMeta(kind, text, { summary = null, icon = null } = {}) {
  const split = splitLeadingIcon(text);
  const line = oneLine(summary ?? split.rest);
  if (!line) return null;
  return { kind, icon: icon || split.icon || DEFAULT_ICONS[kind] || 'ℹ️', summary: line };
}

// "alice → box-b chat · topic · #12" / "alice → spawn on box-b · task · #12"
export function consentNoticeMeta(frame) {
  const ask = frame?.ask;
  if (!ask || typeof ask !== 'object') return null;
  const from = oneLine(ask.from_name, 40) || 'an agent';
  const item = Number.isInteger(ask.item_num) ? `#${ask.item_num}` : '';
  let parts;
  if (ask.kind === 'spawn') {
    const target = oneLine(ask.target_name, 40) || 'a box';
    parts = [`${from} → spawn on ${target}`, oneLine(ask.task, 60), item];
  } else if (ask.request === 'join') {
    const room = oneLine(ask.room_title, 60) || 'a room';
    parts = [`${from} → join ${room}`, item];
  } else {
    const to = oneLine(ask.to_name, 40) || 'an agent';
    parts = [`${from} → ${to} chat`, oneLine(ask.topic, 60) || oneLine(ask.to_convo_title, 60), item];
  }
  return noticeMeta('consent', '', { icon: DEFAULT_ICONS.consent, summary: parts.filter(Boolean).join(' · ') });
}

export function unseenNoticeMeta(frame) {
  const entries = Array.isArray(frame?.entries) ? frame.entries : [];
  if (!entries.length) return null;
  const count = Number.isInteger(frame?.count) && frame.count > 0 ? frame.count : entries.length;
  return noticeMeta('unseen', '', { summary: `${count} important thing${count === 1 ? '' : 's'} unseen for over 2 hours` });
}

// "alice: first line of the message" — the room title stays in the full text.
export function roomNoticeMeta({ from, body } = {}) {
  const who = oneLine(from, 40) || 'an agent';
  const first = String(body ?? '').split('\n').find((l) => l.trim()) || '';
  return noticeMeta('room', '', { summary: `${who}: ${oneLine(first, 100)}` });
}

// Which kind a session-control notice is, from the action that caused it.
export function controlNoticeKind(action) {
  if (action === 'routine') return 'routine';
  if (action === 'alert') return 'alert';
  return 'control';
}
