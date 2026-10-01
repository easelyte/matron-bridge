import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the Coordinator session-control wiring is pinned by source
// inspection — same approach as test/coordinator-wiring.test.js. The
// planner (lib/session-control.js) and the calling side
// (lib/session-control-client.js) are unit-tested on their own.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('session control wiring (source inspection)', () => {
  it('registers the RPC method and the publisher hooks', () => {
    expect(index).toContain("controlSession: (params, meta) => journalControlSession(params, meta),");
    expect(index).toContain("onSessionControlFrame: (frame) => sessionControlHandlers?.onSessionControlFrame(frame),");
    expect(index).toMatch(/onOpError: \(e\) => \{ warnRejectedConvoUpsert\(e\); if \(sessionControlHandlers\?\.onOpError\?\.\(e\)\) return; if \(agentSpawnHandlers/);
  });
  it('resolves or resumes the target, then parks, schedules or applies', () => {
    const fn = body('async function journalControlSession(rawParams, { fromDeviceId } = {}) {', '\nasync function applyControlSteps(');
    expect(fn).toContain('let session = findSessionByClaudeSessionId(params.convoId);');
    expect(fn).toContain('if (!session || !session.alive) session = journalResumeConvo(params.convoId, JOURNAL_RESUME_NOTICE);');
    expect(fn).toContain("code: known ? 'gone' : 'not_found'");
    expect(fn).toContain('planSessionControl({ params, session, canSwitch: canSwitchAgent })');
    expect(fn).toContain("session._deferredControls = { ...(session._deferredControls || {}), [plan.slot.kind]: { ...mergeParkedSlot(session._deferredControls?.[plan.slot.kind], plan.slot), id: randomUUID() } };");
    expect(fn).toContain("session._autoResume = { at: plan.at, text: plan.text, kind: 'usage_limit', source: 'coordinator' };");
  });
  it('authorizes a journal-originated alert against the current Coordinator before resolving the target', () => {
    const fn = body('async function journalControlSession(rawParams, { fromDeviceId } = {}) {', '\nasync function applyControlSteps(');
    const auth = fn.indexOf('const denied = authorizeControl({ params, fromDeviceId, coordinatorConvoId: coordinator.convoId });');
    expect(auth).toBeGreaterThan(-1);
    // A cold or stale role cache gets one forced refresh before an alert is refused (Bugbot).
    const refresh = fn.indexOf("if (JOURNAL_ONLY_ACTIONS.has(params.action) && fromDeviceId === JOURNAL_DEVICE_ID && (!coordinator.known || coordinator.convoId !== params.convoId)) {\n    coordinator = await coordinatorLookup.refresh({ force: true });");
    expect(refresh).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(auth);
    expect(fn).toContain('if (denied) return { ok: false, error: denied };');
    expect(auth).toBeLessThan(fn.indexOf('findSessionByClaudeSessionId(params.convoId)'));
  });
  it('applies steps through the existing switch, model, compact and turn paths', () => {
    const fn = body('async function applyControlSteps(session, steps) {', '\nfunction drainDeferredControls(');
    expect(fn).toContain('await switchAgentSession(current.roomId, step.agent, { sendReply: ctx.sendReply });');
    expect(fn).toContain('if (!applyModelSwitch(current.roomId, current, step.model, { sendReply: ctx.sendReply, sendHtml: ctx.sendHtml, explicit: true })) {');
    // The model rides into an agent switch via agentSessions[target].model.
    expect(fn).toContain('{ agentSessions: mergeAgentStates(persisted.agentSessions, { [step.agent]: targetState }) });');
    expect(fn).toContain("await journalRouteTextToSession(current, '/compact');");
    expect(fn).toContain('sendTextToSession(current, step.text, { skipJournalMirror: true })');
  });
  it('drains parked slots from the shared free gate, before room delivery, and never on an occupied session', () => {
    const gate = body('function maybeFlushRoomDelivery(session) {', '\n}');
    const occ = gate.indexOf('if (sessionOccupiedForRoomDelivery(session)) return;');
    const drain = gate.indexOf('if (drainDeferredControls(session)) return;');
    const flush = gate.indexOf('flushRoomInbox(session);');
    expect(occ).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(occ);
    expect(flush).toBeGreaterThan(drain);
    const fn = body('function drainDeferredControls(session) {', '\nfunction maybeFlushRoomDelivery(');
    expect(fn).toContain('const kinds = CONTROL_KINDS.filter((k) => slots[k] && slots[k].params);');
    // A slot stays parked and persisted until it is settled (applied,
    // refused or scheduled); it is removed only if still the same object.
    // Settled by id (a recreate rebuilds the slot object from persisted JSON).
    expect(fn).toContain('if (held && (held === slots[kind] || (held.id && held.id === slots[kind].id))) {');
    const jcs = body('async function journalControlSession(rawParams, { fromDeviceId } = {}) {', '\nasync function applyControlSteps(');
    expect(jcs).toContain('[plan.slot.kind]: { ...mergeParkedSlot(session._deferredControls?.[plan.slot.kind], plan.slot), id: randomUUID() } };');
    expect(fn.indexOf('session._drainingControls = true;')).toBeLessThan(fn.indexOf('void (async () => {'));
    expect(fn.slice(0, fn.indexOf('void (async () => {'))).not.toContain('session._deferredControls = null;\n  session._drainingControls');
    // A slot that started a turn ends the drain; the rest wait for the next
    // seam. Nothing started -> room delivery gets its gate back.
    expect(fn).toContain('if (startedTurn) continue;');
    expect(fn).toContain('if (!startedTurn && !sessionOccupiedForRoomDelivery(current)) flushRoomInbox(current);');
    expect(index).toContain('function flushRoomInbox(session) {');
  });
  it('parked controls and the automatic carry-on persist and are restored on resume', () => {
    const ps = body('function persistSession(roomId, sessionId, workdir, originRoomId, extra, { failLoud = false } = {}) {', '\nfunction ');
    expect(ps).toContain('if (live) derived._deferredControls = live._deferredControls || null;');
    expect(ps).toContain('if (live) derived._autoResume = live._autoResume || null;');
    // Restored for the ROOM, resume or not, in all three builders (Codex too).
    expect(index).toContain('_deferredControls: persistedMode?._deferredControls || null,');
    expect(index).toContain('_deferredControls: persistedForRoom?._deferredControls || null,');
    expect(index).toContain('_deferredControls: persisted?._deferredControls || null,');
    expect(index).toContain('_autoResume: persistedMode?._autoResume || null,');
    expect(index).toContain('_autoResume: persistedForRoom?._autoResume || null,');
    expect(index).toContain('_autoResume: persisted?._autoResume || null,');
    expect(index.match(/_lastContextTokens: Number\.isFinite\(persisted(Mode|ForRoom)?\?\._lastContextTokens\)/g)).toHaveLength(3);
    expect(index).toContain('if (live && Number.isFinite(live._lastContextTokens)) derived._lastContextTokens = live._lastContextTokens;');
  });
  it('exposes the three routes to the MCP tools', () => {
    for (const r of ['/session-set-model', '/session-compact', '/session-carry-on']) {
      expect(index).toContain(`url.pathname === '${r}'`);
      expect(askUser).toContain(`'${r}'`);
    }
    for (const t of ['session_set_model', 'session_compact', 'session_carry_on']) expect(askUser).toContain(`'${t}'`);
  });
});

describe('automatic carry-on wiring (source inspection)', () => {
  it('arms the slot from a usage-limit stall, re-arms when the forced refresh lands, and clears it on a real answer', () => {
    const c = body("    case 'assistant': {", "    case 'result': {");
    expect(c).toContain("if (stall.kind === 'bad_model') {");
    expect(c).toContain('recoverBadModel(session);');
    expect(c.match(/session\._autoResume = armFromStall\(session\._stall, session\._autoResume, Date\.now\(\), session\._autoResumeRetries \|\| 0\);/g)).toHaveLength(2);
    expect(c.match(/if \(session\._autoResume\?\.retry\) session\._autoResumeRetries = session\._autoResume\.retry;/g)).toHaveLength(2);
    expect(c).toContain('session._autoResumeRetries = 0;');
    expect(c).toContain('session._autoResume = null;');
    expect(c).toContain('session._badModelRecovered = false;');
  });
  it('sweeps live and persisted sessions once a minute and fires due slots with a compact first when the gauge is high', () => {
    // Independent of the idle reaper: the sweep starts even when reaping is off.
    expect(index).toMatch(/\n {2}\} else \{\n {4}console\.log\('Session idle timeout: disabled'\);\n {2}\}\n[^\n]*\n {2}startAutoResumeSweep\(\);/);
    const fn = body('function runAutoResumeSweep(now = Date.now()) {', '\nfunction startAutoResumeSweep(');
    expect(fn).toContain('if (autoResumeDue(session._autoResume, now)) void fireAutoResume(roomId, journalConvoIdFor(session), session._autoResume);');
    expect(fn).toContain('for (const due of dueResumes(records, now)) {');
    const fire = body('async function fireAutoResume(roomId, convoId, slot) {', '\nfunction runAutoResumeSweep(');
    expect(fire).toContain('journalResumeConvo(convoId,');
    expect(fire).toContain('if (controlOccupied(session)) return;');
    expect(fire).toContain('session._autoResume = null;');
    expect(fire).toContain("if (shouldCompactBefore(session._lastContextTokens, contextWindowForSession(session))) {");
    expect(fire).toContain("await journalRouteTextToSession(session, '/compact');");
    expect(fire).toContain("await journalRouteTextToSession(sessions.get(roomId) || session, slot.text || (slot.kind === 'model_recovery' ? BAD_MODEL_RECOVERY_TEXT : AUTO_RESUME_TEXT));");
    expect(fire).toContain("slot.kind === 'model_recovery'");
    // A thrown delivery puts the slot back unless something newer was armed.
    expect(fire).toContain('if (!live._autoResume) { live._autoResume = slot; persistControlState(live); }');
  });
  it('recovers a bad model once with the default model, then carries on; a second failure is left for a person', () => {
    const fn = body('function recoverBadModel(session) {', '\n// --- Coordinator session control');
    expect(fn).toContain('if (session._badModelRecovered) {');
    expect(fn).toContain("&& applyModelSwitch(session.roomId, session, 'default', { sendReply: ctx.sendReply, sendHtml: ctx.sendHtml, explicit: false });");
    // Delivery goes through the sweep: nothing is typed on the heels of /model.
    expect(fn).toContain("next._autoResume = { at: new Date().toISOString(), kind: 'model_recovery', text: BAD_MODEL_RECOVERY_TEXT };");
    expect(fn).not.toContain('journalRouteTextToSession(');
    // The one recovery is spent only by an ACCEPTED switch; a refusal retries.
    expect(fn.indexOf('next._badModelRecovered = true;')).toBeGreaterThan(fn.indexOf("applyModelSwitch("));
    expect(fn).toContain("kind: 'bad_model', text: BAD_MODEL_RECOVERY_TEXT };");
  });
  it('an accepted model switch brings a pending automatic carry-on forward; a bad-model recovery replaces it', () => {
    const ams = body('function applyModelSwitch(', '\nfunction ');
    expect(ams.match(/bringAutoResumeForward\(session\);/g)).toHaveLength(2);
    const fn = body('function bringAutoResumeForward(session) {', '\n}');
    expect(fn).toContain('session._autoResume = { ...session._autoResume, at: new Date().toISOString() };');
    const rec = body('function recoverBadModel(session) {', '\n// --- Coordinator session control');
    // State lands on the REPLACEMENT session after a print-mode recreate.
    expect(rec).toContain('const next = sessions.get(session.roomId) || session;\n  next._badModelRecovered = true;');
    expect(rec.indexOf("kind: 'model_recovery'")).toBeGreaterThan(rec.indexOf('next._badModelRecovered = true;'));
    const fire = body('async function fireAutoResume(roomId, convoId, slot) {', '\nfunction runAutoResumeSweep(');
    expect(fire).toContain("if (slot.kind === 'bad_model') { recoverBadModel(session); return; }");
    expect(index).toContain('if (live) derived._autoResumeRetries = live._autoResumeRetries || 0;');
  });
  it('persists the recovery flag', () => {
    expect(index).toContain('if (live) derived._badModelRecovered = !!live._badModelRecovered;');
    expect(index).toContain('_badModelRecovered: !!persistedMode?._badModelRecovered,');
    expect(index).toContain('_badModelRecovered: !!persistedForRoom?._badModelRecovered,');
  });
});
