import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// index.js boots the bridge and cannot be imported, so the seams where each
// turn source hands its causes to sendToSession are pinned by source. The
// rules themselves are unit-tested in turn-cause, session-control,
// room-delivery, items-turn and journal-input-router.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fnBody = (sig) => {
  const start = index.indexOf(sig);
  expect(start, sig).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start));
};

describe('turn causes reach sendToSession from every turn source', () => {
  it('a user\'s message names itself by convo and seq, on the direct send and on the queue entry', () => {
    expect(fnBody('function journalOnText(')).toContain('const causes = seq != null && convoId ? [userMessageCause(convoId, seq)] : null;');
    expect(fnBody('function journalOnText(')).toContain('journalRouteTextToSession(session, body, { steerable: true, causes })');
    const route = fnBody('async function journalRouteTextToSession(');
    expect(route).toContain('{ keepRestartBudget = false, steerable = false, causes = null } = {}');
    expect(route).toContain('const entry = tagCauses(markJournalOrigin([{ type: \'text\', text: trimmed }]), causes);');
    expect(route.match(/sendTextToSession\(session, trimmed, \{ skipJournalMirror: true, causes \}\)/g)).toHaveLength(2);
  });

  it('a tap on a question card names the user\'s reply row, on every answer path', () => {
    const onReply = fnBody('function journalOnPromptReply(');
    expect(onReply).toContain('const causes = seq != null && replyConvoId ? [userMessageCause(replyConvoId, seq)] : null;');
    expect(onReply).toContain('journalRoutePromptReply(session, answer, { causes })');
    const route = fnBody('function journalRoutePromptReply(');
    expect(route).toContain('{ causes = null } = {}');
    // print mode: the raw tool_result answer takes the turn seam with them.
    expect(route).toContain('submitAnswer(session, `${header}${answerText}`, { causes });');
    // iv and Codex: the answer joins the turn that is waiting on it.
    expect(route.match(/joinHeldTurn\(session, causes\);/g)).toHaveLength(3);
    // A typed answer into an iv prompt (classified or not) or a Codex one joins it the same way.
    expect(fnBody('async function journalRouteTextToSession(').match(/joinHeldTurn\(session, causes\);/g)).toHaveLength(4);
  });

  it('a Codex async question\'s answer, sent as a message of its own, carries the replies\' causes', () => {
    expect(fnBody('function journalRoutePromptReply(')).toContain('session.codexPrompts.answer({ choice, text, causes });');
    expect(fnBody('async function journalRouteTextToSession(')).toContain('session.codexPrompts.answer({ text: trimmed, causes });');
    const submit = fnBody('function submitCodexAsyncAnswer(');
    expect(submit).toContain('function submitCodexAsyncAnswer(session, text, causes = null) {');
    expect(submit).toContain('const entry = tagCauses(markJournalOrigin([{ type: \'text\', text }]), causes);');
    const wiring = readFileSync(new URL('../lib/codex-app-wiring.js', import.meta.url), 'utf8');
    expect(wiring).toContain('submitAsync: (body, causes) => submitAsyncAnswer?.(session, body, causes),');
  });

  it('a spawned session\'s opening turn is sent with the causes the start handler names', () => {
    expect(index).toContain("injectTurn: (session, text, meta) => sendTextToSession(session, text, { skipJournalMirror: true, turnTier: 'autonomous', causes: meta?.causes ?? null }),");
    const rpc = readFileSync(new URL('../lib/journal-rpc.js', import.meta.url), 'utf8');
    expect(rpc).toContain('injectTurn(session, opening, { causes: [spawnedCause(params.spawn_id)] })');
  });

  it('queued and resume-held messages keep their causes, and the flush that sends them merges them', () => {
    expect(fnBody('function sendToSession(')).toContain('(session._resumeOutbox ||= []).push(tagCauses(skipJournalMirror ? markJournalOrigin(contentBlocks) : contentBlocks, causes));');
    expect(fnBody('function dispatchMergedFlush(')).toContain('sendToSession(session, blocks, { skipJournalMirror: true, causes: queueCauses(queued) })');
    expect(fnBody('async function journalQueueMedia(')).toContain('const entry = tagCauses([...blocks], cause);');
  });

  it('a user\'s media message forwards its causes to both send paths', () => {
    expect(index).toContain('injectText: (session, text, { causes = null } = {}) => sendTextToSession(session, text, { causes }),');
    expect(index).toContain('injectBlocks: (session, blocks, { causes = null } = {}) => sendToSession(session, blocks, { skipJournalMirror: true, causes }),\n  // A voice note sent with the typed draft');
  });

  it('an item reply\'s cause rides the inject and the queue', () => {
    expect(index).toContain("injectBlocks: (session, blocks, { causes = null } = {}) => sendToSession(session, blocks, { skipJournalMirror: true, causes }),");
    expect(index).toMatch(/queueText: \(session, \{ text, preview, source, cause = null \}\) => journalQueueMedia\(session, \{[\s\S]{0,160}?\n {4}cause,\n/);
  });

  it('room turns forward their causes; reminders and timers are reminder turns', () => {
    expect(index.match(/causes: meta\?\.causes \?\? null/g).length).toBeGreaterThanOrEqual(3);
    // Each delivered room message carries its seq, for the per-room span the
    // turn's cause names (lib/room-delivery.js), and a reply consumed inline
    // by a wait joins the running turn with its own.
    const deliverTo = fnBody('function deliverRoomFrameTo(');
    expect(deliverTo.match(/at: frame\.ts, seq: frame\.seq,/g)).toHaveLength(2);
    expect(deliverTo).toContain('joinHeldTurn(session, [roomMessageCause(frame.convo_id, frame.seq)]);');
    const fire = fnBody('async function fireTimer(');
    // The user's /timer is a reminder turn; the agent's own reminder names
    // the turn that set it beside it.
    expect(fire.match(/\{ causes: \[plainCause\('reminder'\)\] \}/g)).toHaveLength(1);
    expect(fire).toContain("{ causes: mergeCauses([plainCause('reminder'), record.causes]) }");
    // A self-restart's continuation names the restarting turn's causes beside `other`.
    expect(index).toContain("const entry = tagCauses([{ type: 'text', text }], mergeCauses([plainCause('other'), causesForAsk(session)]));");
  });
});

describe('a running turn only ever gains causes', () => {
  it('a send onto a turn already on the session merges into it; only a fresh turn begins one', () => {
    // The rule itself is lib/turn-cause.js beginOrJoinTurn (unit-tested
    // there); every send takes it before it marks the session busy.
    const send = fnBody('function sendToSession(');
    expect(send).toMatch(/const beganTurn = beginOrJoinTurn\(session, causes\);\n\s+session\.busy = true;/);
    expect(send.match(/beginOrJoinTurn\(/g)).toHaveLength(1);
    expect(send).not.toMatch(/\bbeginTurn\(/);
  });

  it('every write that makes a session busy takes the turn seam first', () => {
    // sendToSession plus the two raw tool_result writes (a question's answer,
    // a plan's approval); nothing else sets busy directly.
    expect(index.match(/^\s*session\.busy = true;/gm)).toHaveLength(3);
    expect(index.match(/beginOrJoinTurn\(session, causes\);\n\s*session\.busy = true;/g)).toHaveLength(3);
  });

  it('a send failure ends the turn only when that send began it', () => {
    const report = fnBody('function reportSessionSendFailure(');
    expect(report).toContain('{ restoreJournalState = false, beganTurn = false } = {}');
    expect(report).toContain('if (beganTurn) endTurn(session);');
    expect(report.match(/endTurn\(/g)).toHaveLength(1);
    const send = fnBody('function sendToSession(');
    // The three dispatch failures after the turn starts pass the flag; the
    // validation rejects before it pass nothing, so they never end a turn.
    expect(send.match(/\{ restoreJournalState: true, beganTurn \}/g)).toHaveLength(4);
    expect(send.match(/reportSessionSendFailure\(/g).length).toBeGreaterThanOrEqual(7);
  });

  it('agent output with no turn on the session begins one of unknown origin', () => {
    const handler = fnBody('function handleClaudeEvent(');
    const guard = handler.indexOf("if (!session.busy && !session.currentTurn && (event.type === 'assistant' || event.type === 'stream_event')) {\n    beginTurn(session, [plainCause('other')]);");
    expect(guard).toBeGreaterThan(handler.indexOf('if (isSidechainEvent(event)) return;'));
    expect(guard).toBeLessThan(handler.indexOf('switch (event.type)'));
  });

  it('a Codex steer merges its entries\' causes into the running turn before it dispatches', () => {
    const flush = readFileSync(new URL('../lib/queued-dispatch.js', import.meta.url), 'utf8');
    const merge = flush.indexOf('const steerCauses = queueCauses(queued);\n        if (steerCauses) mergeIntoTurn(session, steerCauses);');
    expect(merge).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(flush.indexOf('session.codex.steer(blocks)'));
  });

  it('Send now on a busy Claude session reaches sendToSession with the queue\'s causes (merged there)', () => {
    expect(fnBody('function dispatchMergedFlush(')).toContain('causes: queueCauses(queued)');
  });
});

describe('a user\'s answer or plan approval carries its causes', () => {
  it('a typed answer to a pending question forwards the message\'s causes to submitAnswer', () => {
    const route = fnBody('async function journalRouteTextToSession(');
    expect(route.match(/submitAnswer\(session, [^\n]*\{ causes \}\);/g)).toHaveLength(2);
  });

  it('submitAnswer: the text-reply path sends them, the tool_result path begins or joins the turn with them', () => {
    const answer = fnBody('function submitAnswer(');
    expect(answer).toContain('{ causes = null } = {}');
    expect(answer).toContain('sendTextToSession(session, answerText, { skipJournalMirror: true, causes });');
    const seam = answer.indexOf('const beganTurn = beginOrJoinTurn(session, causes);\n    session.busy = true;');
    expect(seam).toBeGreaterThan(answer.indexOf("if (mode === 'text-reply')"));
    expect(seam).toBeLessThan(answer.indexOf('writePromptAnswer(session, jsonMsg'));
    // A write stdin refuses ends the turn only when this answer began it.
    expect(answer).toContain('{ restoreJournalState: true, beganTurn },');
  });

  it('approvePlanBuild: both text paths send the causes, the tool_result path takes the seam, the iv hook merges them', () => {
    const build = fnBody('async function approvePlanBuild(');
    expect(build).toContain('async function approvePlanBuild(session, { sendHtml, causes = null }) {');
    expect(build.match(/just make the changes directly\.', \{ causes \}\);/g)).toHaveLength(2);
    expect(build.match(/sendTextToSession\(/g)).toHaveLength(2);
    const seam = build.indexOf('const beganTurn = beginOrJoinTurn(session, causes);\n    session.busy = true;');
    expect(seam).toBeGreaterThan(-1);
    const write = build.indexOf('writePromptAnswer(session, jsonMsg, {');
    expect(write).toBeGreaterThan(seam);
    // The raw write goes only through writePromptAnswer, whose onError
    // ends the turn this approval began (as submitAnswer's does).
    expect(build).not.toContain('stdin.write(');
    const failure = build.slice(write);
    expect(failure).toMatch(/onError: \(error\) => reportSessionSendFailure\(\n\s*session,\n\s*`Could not send the plan approval to Claude: \$\{error\.message\}`,\n\s*\{ restoreJournalState: true, beganTurn \},\n\s*\),/);
    expect(failure).toMatch(/onDelivered: \(\) => \{\n\s*if \(session\.resetTimeout\) session\.resetTimeout\(\);\n\s*\},/);
    // The Building notice still follows every path.
    expect(build.indexOf("notice('success', '▶️ Building...'")).toBeGreaterThan(write);
    // Only into a turn still on the session (lib/turn-cause.js joinHeldTurn):
    // a decision left from an interrupted turn must not create one.
    const merge = build.indexOf('joinHeldTurn(session, causes);');
    expect(merge).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(build.indexOf("pending.resolve({ decision: 'allow'"));
    expect(build).not.toMatch(/mergeIntoTurn\(/);
  });

  it('a build typed in the conversation or replied on the plan item reaches approvePlanBuild with its causes', () => {
    expect(fnBody('async function journalRouteTextToSession(')).toContain('return approvePlanBuild(session, { sendHtml: ctx.sendHtml, causes });');
    const onItem = fnBody('function journalOnItem(');
    expect(onItem).toContain('const buildCause = itemCause(item?.payload);');
    expect(onItem).toContain('approvePlanBuild(session, { sendHtml: cmdCtx.sendHtml, causes: buildCause ? [buildCause] : null })');
  });
});
