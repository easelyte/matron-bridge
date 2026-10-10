import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the stall wiring is pinned by source inspection — same
// approach as test/coordinator-wiring.test.js. The detector itself is
// unit-tested in test/stall-detector.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('usage-limit stall wiring (source inspection)', () => {
  it('imports the detector', () => {
    expect(index).toContain("import { stallFromAssistantEvent, stallResetsAt } from './lib/stall-detector.js';");
  });
  it('the assistant case sets or clears session._stall from every parent assistant record and publishes a stall at once', () => {
    const c = body("    case 'assistant': {", "    case 'result': {");
    expect(c).toContain('const stall = stallFromAssistantEvent(event);');
    expect(c).toContain('model: stall.model || session.currentModel || undefined,');
    expect(c).toContain('since: session._stall?.since ?? Date.now(),');
    expect(c).toContain('resets_at: stallResetsAt(usageLimitsCache.lines),');
    expect(c).toContain('const refresh = refreshUsageLimits(session.workdir || DEFAULT_WORKDIR, { force: true });');
    // Cleared only by a record with real usage (the API answered), never by
    // a zero-usage or synthetic record — so a restored stall survives resume.
    expect(c).toContain('} else if (assistantCtxTokens) {');
    expect(c.slice(c.indexOf('} else if (assistantCtxTokens) {'))).toContain('session._stall = null;');
    expect(c).not.toMatch(/} else \{\s*session\._stall = null;/);
    const rul = body('function refreshUsageLimits(cwd, { force = false } = {}) {', '\nfunction ');
    expect(rul).toContain('if (!force && Date.now() - usageLimitsCache.attemptedAt < LIMITS_REFRESH_MS) return null;');
  });
  it('sidechain (subagent) records never reach the assistant case, so they cannot clear a parent stall', () => {
    const fn = body('function handleClaudeEvent(session, event) {', "    case 'assistant': {");
    expect(fn).toContain('if (isSidechainEvent(event)) return;');
  });
  it('journalStatus publishes the stall and applyModelSwitch clears it', () => {
    const js = body('function journalStatus(session) {', '\nfunction ');
    expect(js).toContain('stall: session._stall || undefined,');
    const ams = body('function applyModelSwitch(', '\nfunction ');
    // Cleared only on an ACCEPTED switch: after switchModelInSession returns
    // true (interactive) and in the print branch past defer/refusal — never
    // before validation, where a refused switch would erase a real stall.
    expect(ams.match(/session\._stall = null;/g)).toHaveLength(2);
    const iv = ams.slice(ams.indexOf('if (switched) {'), ams.indexOf('const decision = planPrintModelSwitch'));
    expect(iv).toContain('session._stall = null;');
    expect(iv).toContain('journalStatus(session);');
    const accepted = ams.slice(ams.indexOf('if (!decision.ok) {'));
    expect(accepted).toContain('session._stall = null;');
    expect(ams.slice(0, ams.indexOf('if (switched) {'))).not.toContain('session._stall = null;');
  });
  it('Claude sessions restore a persisted stall on resume; Codex starts unstalled; persistSession carries it', () => {
    const cs = body('function createSession(roomId, workdir, resumeSessionId, options = {}) {', '\nfunction createCodexSessionForRoom(');
    expect(cs).toContain('_stall: resumeSessionId ? (persistedMode?._stall || null) : null,');
    const codex = body('function createCodexSessionForRoom(', '\nfunction ');
    expect(codex).toContain('_stall: null,');
    const iv = body('function createInteractiveSessionForRoom(', '\nfunction ');
    expect(iv).toContain('_stall: resumeSessionId ? (persistedForRoom?._stall || null) : null,');
    const ps = body('function persistSession(roomId, sessionId, workdir, originRoomId, extra, { failLoud = false } = {}) {', '\nfunction ');
    expect(ps).toContain('if (live) derived._stall = live._stall || null;');
  });
});
