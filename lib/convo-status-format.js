// One-line rendering of a conversation's persisted status header (journal
// GET /roster `status`, spec 2026-09-29 coordinator session control §1) for
// agent_roster and mission_get: model, context gauge, usage-limit stall and
// report age, joined with " · ". Pure; the callers place it.
import { contextGaugeText } from './session-status.js';

export function shortModel(model) {
  return typeof model === 'string' ? model.replace(/^claude-/, '') : '';
}

export function agoText(reportedAt, now = Date.now()) {
  if (!Number.isFinite(reportedAt)) return '';
  const s = Math.max(0, Math.round((now - reportedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function hhmmUtc(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function formatConvoStatus(status, now = Date.now()) {
  if (!status || typeof status !== 'object') return '';
  const parts = [];
  const model = shortModel(status.model);
  if (model) parts.push(model);
  const ctx = status.context;
  const gauge = ctx && Number.isFinite(ctx.tokens) && Number.isFinite(ctx.window) && ctx.window > 0
    ? contextGaugeText(ctx.tokens, status.model, ctx.window) : null;
  if (gauge) parts.push(`${gauge}${Number.isFinite(ctx.pct) ? ` ${ctx.pct}%` : ''}`);
  else parts.push('context unknown');
  if (status.stall?.kind === 'usage_limit') {
    const at = status.stall.resets_at ? hhmmUtc(status.stall.resets_at) : null;
    parts.push(`stalled: usage limit${at ? `, resets ${at}` : ''}`);
  }
  const ago = agoText(status.reported_at, now);
  if (ago) parts.push(`reported ${ago}`);
  // Nothing but "context unknown" for an empty object is noise, not a status.
  if (parts.length === 1 && parts[0] === 'context unknown') return '';
  return parts.join(' · ');
}
