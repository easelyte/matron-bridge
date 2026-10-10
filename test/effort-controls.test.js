// Effort controls: the --effort a session starts on (agent_session_start,
// the New Chat `start`, MATRON_DEFAULT_EFFORT) and the Coordinator's
// session_set_model effort, with or without a model change.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { isSpawnEffortArg, spawnEffortOptions, SPAWN_EFFORT_LEVELS } from '../lib/effort-command.js';
import { resolveEffort } from '../lib/session-mode.js';
import {
  noteEffortWrite,
  noteEffortConfirmationPrompt,
  noteEffortConfirmationAnswer,
  noteEffortIdle,
  armEffortAutoConfirm,
  effortAutoConfirmResponse,
  trackedEffort,
} from '../lib/effort-tracker.js';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';
import { createAgentSpawnHandlers } from '../lib/agent-spawn.js';
import { validateControlParams, planSessionControl, controlNotice } from '../lib/session-control.js';
import { createSessionControlHandlers } from '../lib/session-control-client.js';

const confirmPrompt = (level, kind = 'numbered') => ({
  kind,
  question: `Change effort level? This conversation is cached. Switching to ${level} re-reads history.`,
  options: [{ key: '1', label: `Yes, switch to ${level}` }, { key: '2', label: 'No, go back' }],
});

describe('spawn effort levels', () => {
  it('are the --effort flag levels; auto and ultracode are /effort-only', () => {
    expect(SPAWN_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(isSpawnEffortArg(' High ')).toBe(true);
    for (const bad of ['auto', 'ultracode', 'default', '', 'extreme', null]) expect(isSpawnEffortArg(bad)).toBe(false);
    expect(spawnEffortOptions()).toEqual([
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'X-High' }, { value: 'max', label: 'Max' },
    ]);
  });
});

describe('resolveEffort', () => {
  const r = (args) => resolveEffort({ isSpawnLevel: isSpawnEffortArg, ...args });
  it('explicit option, then the persisted level, then the box default on a fresh start', () => {
    expect(r({ option: 'max', persisted: 'low', fallback: 'medium' })).toBe('max');
    expect(r({ persisted: 'low', fallback: 'medium' })).toBe('low');
    expect(r({ fallback: 'medium' })).toBe('medium');
    expect(r({})).toBeUndefined();
  });
  it('a resume without a persisted level gains no flag', () => {
    expect(r({ fallback: 'medium', resumed: true })).toBeUndefined();
    expect(r({ persisted: 'high', fallback: 'medium', resumed: true })).toBe('high');
  });
  it("'default' is the box default, or no flag", () => {
    expect(r({ option: 'default', persisted: 'low', fallback: 'xhigh' })).toBe('xhigh');
    expect(r({ option: 'default', persisted: 'low' })).toBeUndefined();
  });
  it('a level the flag does not take means no flag rather than a fallback', () => {
    expect(r({ persisted: 'auto', fallback: 'high' })).toBeUndefined();
    expect(r({ option: 'ultracode' })).toBeUndefined();
  });
});

describe('effort tracker: commits report themselves, and the Coordinator auto-confirm', () => {
  it('noteEffortIdle and noteEffortConfirmationAnswer return whether a level was committed', () => {
    const s = {};
    expect(noteEffortIdle(s)).toBe(false);
    noteEffortWrite(s, 'high');
    expect(noteEffortIdle(s)).toBe(true);
    noteEffortWrite(s, 'low');
    noteEffortConfirmationPrompt(s, confirmPrompt('low'));
    expect(noteEffortConfirmationAnswer(s, confirmPrompt('low'), 'No, go back')).toBe(false);
    expect(trackedEffort(s)).toBe('high');
  });

  it('answers an armed confirmation with its Yes option, then settles on that answer', () => {
    const s = {};
    noteEffortWrite(s, 'max');
    armEffortAutoConfirm(s, 'max');
    noteEffortConfirmationPrompt(s, confirmPrompt('max'));
    const auto = effortAutoConfirmResponse(s, confirmPrompt('max'));
    expect(auto).toEqual({ response: { kind: 'numbered', key: '1' }, label: 'Yes, switch to max' });
    expect(noteEffortConfirmationAnswer(s, confirmPrompt('max'), auto.label)).toBe(true);
    expect(trackedEffort(s)).toBe('max');
    // Settled: the next confirmation is the user's again.
    noteEffortWrite(s, 'low');
    noteEffortConfirmationPrompt(s, confirmPrompt('low'));
    expect(effortAutoConfirmResponse(s, confirmPrompt('low'))).toBeNull();
  });

  it('an arrow menu is answered by index', () => {
    const s = {};
    noteEffortWrite(s, 'high');
    armEffortAutoConfirm(s, 'high');
    expect(effortAutoConfirmResponse(s, confirmPrompt('high', 'arrow-menu')).response).toEqual({ kind: 'arrow-menu', key: '0' });
  });

  it('never answers for the user: unarmed, a different pending level, or another prompt', () => {
    const s = {};
    noteEffortWrite(s, 'high');
    expect(effortAutoConfirmResponse(s, confirmPrompt('high'))).toBeNull();
    armEffortAutoConfirm(s, 'low'); // not the pending level
    expect(effortAutoConfirmResponse(s, confirmPrompt('high'))).toBeNull();
    armEffortAutoConfirm(s, 'high');
    expect(effortAutoConfirmResponse(s, { kind: 'numbered', question: 'Delete the file?', options: [{ key: '1', label: 'Yes' }] })).toBeNull();
    // The user types their own /effort over it: the arm goes with the old write.
    noteEffortWrite(s, 'medium');
    expect(effortAutoConfirmResponse(s, confirmPrompt('medium'))).toBeNull();
  });
});

describe('journal-rpc: start effort and the New Chat picker', () => {
  function harness(overrides = {}) {
    const responses = [];
    const calls = [];
    const handler = createRpcRequestHandler({
      respondRpc: (args) => responses.push(args),
      startSession: (args) => { calls.push(args); return { claudeSessionId: 'c1' }; },
      stopSession: () => {},
      listPersistedSessions: () => [],
      defaultWorkdir: '/home/alice',
      defaultAgent: 'claude',
      expandHome: (p) => p,
      statSync: () => ({ isDirectory: () => true }),
      log: { warn: () => {}, error: () => {} },
      ...overrides,
    });
    return { handler, responses, calls };
  }
  // Distinct request ids: the start RPC dedups on request_id (fork).
  let reqSeq = 0;
  const REQ = (method, params) => ({ request_id: `r${++reqSeq}`, from_device_id: 7, method, params });

  it('a valid level reaches startSession normalized; none leaves the key off', () => {
    const { handler, responses, calls } = harness();
    handler(REQ('start', { effort: 'XHigh' }));
    expect(calls[0].effort).toBe('xhigh');
    expect(responses[0].ok).toBe(true);
    handler(REQ('start', { effort: '' }));
    handler(REQ('start', { effort: null }));
    expect('effort' in calls[1]).toBe(false);
    expect('effort' in calls[2]).toBe(false);
    handler(REQ('start', { effort: 'default' }));
    expect(calls[3].effort).toBe('default');
  });

  it('bad_effort on an unknown level, a non-string, or a Codex start — nothing spawns', () => {
    const { handler, responses, calls } = harness({ codexAvailable: () => true });
    handler(REQ('start', { effort: 'ultracode' }));
    handler(REQ('start', { effort: 3 }));
    handler(REQ('start', { effort: 'max', agent: 'codex' }));
    expect(responses.map((r) => r.error)).toEqual([
      { code: 'bad_effort', detail: 'ultracode' },
      { code: 'bad_effort', detail: 'number' },
      { code: 'bad_effort', detail: 'this session would run Codex; its levels are minimal, low, medium, high, xhigh' },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('passes a Codex level through on a Codex start', () => {
    const { handler, responses, calls } = harness({ codexAvailable: () => true });
    handler(REQ('start', { effort: 'high', agent: 'codex' }));
    handler(REQ('start', { effort: 'minimal', agent: 'codex' }));
    expect(responses.every((r) => r.ok)).toBe(true);
    expect(calls.map((c) => [c.agent, c.effort])).toEqual([['codex', 'high'], ['codex', 'minimal']]);
  });

  it('offers effort_options and default_effort to the picker on a Claude box only', () => {
    const { handler, responses } = harness({ defaultEffort: 'high' });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.effort_options).toEqual(spawnEffortOptions());
    expect(responses[0].result.default_effort).toBe('high');
    for (const overrides of [{}, { defaultEffort: 'auto' }, { defaultEffort: 'high', defaultAgent: 'codex' }]) {
      const h = harness(overrides);
      h.handler(REQ('recent_folders', {}));
      expect(h.responses[0].result).not.toHaveProperty('default_effort');
      if (overrides.defaultAgent === 'codex') expect(h.responses[0].result).not.toHaveProperty('effort_options');
    }
  });
});

describe('agent_session_start effort (parent bridge)', () => {
  function mk() {
    const sent = [];
    const handlers = createAgentSpawnHandlers({
      sessions: new Map([['sess-1', { roomId: 'sess-1' }]]),
      publisher: { sendRoomOp: (f) => { sent.push(f); return true; } },
      rooms: { record: () => {}, isActive: () => true },
      journalConvoIdFor: () => 'convo-1',
      notifyParent: vi.fn(),
      pendingTimeoutMs: 20,
      sweepIntervalMs: 0,
      log: { warn: () => {} },
    });
    return { handlers, sent };
  }
  const good = { roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'do it' };

  it('carries a valid level in the spawn_request frame, normalized, and omits it when unset', () => {
    const { handlers, sent } = mk();
    handlers.sessionStart({ ...good, effort: 'Low' });
    handlers.sessionStart(good);
    expect(sent[0].effort).toBe('low');
    expect('effort' in sent[1]).toBe(false);
  });

  it('refuses an unknown level with a 400 before anything reaches the journal', async () => {
    const { handlers, sent } = mk();
    const res = await handlers.sessionStart({ ...good, effort: 'auto' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('effort must be one of: low, medium, high, xhigh, max');
    expect(sent).toHaveLength(0);
  });

  describe('agent', () => {
    it('carries a valid agent, normalized, and omits it when unset', () => {
      const { handlers, sent } = mk();
      handlers.sessionStart({ ...good, agent: 'Codex' });
      handlers.sessionStart(good);
      expect(sent[0].agent).toBe('codex');
      expect('agent' in sent[1]).toBe(false);
    });

    it('takes a Codex model and level only with agent codex', async () => {
      const { handlers, sent } = mk();
      handlers.sessionStart({ ...good, agent: 'codex', model: 'gpt-5.1-codex', effort: 'minimal' });
      expect(sent[0]).toMatchObject({ agent: 'codex', model: 'gpt-5.1-codex', effort: 'minimal' });
      const noAgent = await handlers.sessionStart({ ...good, model: 'gpt-5.1-codex' });
      expect(noAgent.status).toBe(400);
      expect(noAgent.body.error).toMatch(/pass agent: codex/);
      const claudeOnCodex = await handlers.sessionStart({ ...good, agent: 'codex', model: 'opus' });
      expect(claudeOnCodex.status).toBe(400);
      const maxOnCodex = await handlers.sessionStart({ ...good, agent: 'codex', effort: 'max' });
      expect(maxOnCodex.body.error).toBe('with agent codex, effort must be one of: minimal, low, medium, high, xhigh');
      expect(sent).toHaveLength(1);
    });

    it('refuses an unknown agent with a 400', async () => {
      const { handlers, sent } = mk();
      const res = await handlers.sessionStart({ ...good, agent: 'gemini' });
      expect(res).toEqual({ status: 400, body: { error: 'agent must be claude or codex' } });
      expect(sent).toHaveLength(0);
    });
  });
});

describe('session_set_model effort (Coordinator session control)', () => {
  const idle = (extra = {}) => ({ alive: true, agent: 'claude', busy: false, ...extra });
  const P = (extra = {}) => ({ convoId: 'c1', action: 'set_model', fromName: 'mac', ...extra });

  it('validates effort as one word and accepts it on its own', () => {
    expect(validateControlParams({ convo_id: 'c1', action: 'set_model', effort: ' High ' }).params).toEqual({ convoId: 'c1', action: 'set_model', effort: 'high' });
    expect(validateControlParams({ convo_id: 'c1', action: 'set_model', effort: 'two words' }).code).toBe('bad_effort');
    expect(validateControlParams({ convo_id: 'c1', action: 'set_model', effort: 7 }).code).toBe('bad_effort');
  });

  it('plans an effort-only change, and a model change before the effort', () => {
    expect(planSessionControl({ params: P({ effort: 'low' }), session: idle() })).toEqual({ kind: 'apply', steps: [{ op: 'set_effort', effort: 'low' }] });
    expect(planSessionControl({ params: P({ model: 'opus', effort: 'max' }), session: idle() })).toEqual({ kind: 'apply', steps: [{ op: 'set_model', model: 'opus' }, { op: 'set_effort', effort: 'max' }] });
  });

  it('parks it on a busy session like a model switch', () => {
    expect(planSessionControl({ params: P({ effort: 'low' }), session: idle({ busy: true }) })).toEqual({ kind: 'park', slot: { kind: 'set_model', params: P({ effort: 'low' }) } });
  });

  it('refuses a level Claude cannot start on, before anything parks', () => {
    expect(planSessionControl({ params: P({ effort: 'ultracode' }), session: idle({ busy: true }) })).toMatchObject({ kind: 'error', code: 'bad_effort' });
  });

  it('leaves Codex levels to the Codex session and carries the effort into an agent switch', () => {
    expect(planSessionControl({ params: P({ effort: 'minimal' }), session: idle({ agent: 'codex' }) })).toEqual({ kind: 'apply', steps: [{ op: 'set_effort', effort: 'minimal' }] });
    expect(planSessionControl({ params: P({ agent: 'claude', effort: 'high' }), session: idle({ agent: 'codex' }) }))
      .toEqual({ kind: 'apply', steps: [{ op: 'switch_agent', agent: 'claude', effort: 'high' }] });
  });

  it('names the effort in the session notice', () => {
    expect(controlNotice(P({ effort: 'xhigh' }), { phase: 'now' })).toBe('🛠 Coordinator (mac): setting effort to X-High');
    expect(controlNotice(P({ model: 'opus', effort: 'low' }), { phase: 'now' })).toContain('switching the model to');
    expect(controlNotice(P({ model: 'opus', effort: 'low' }), { phase: 'now' })).toContain(', then setting effort to Low');
  });

  it('the client sends effort without a model', async () => {
    const sent = [];
    const h = createSessionControlHandlers({
      sessions: new Map([['!coord', { alive: true, coordinator: true, journalConvoId: 'coord-convo' }]]),
      publisher: { sendRoomOp: (f) => { sent.push(f); return true; } },
      journalConvoIdFor: (s) => s.journalConvoId,
      pendingTimeoutMs: 20,
    });
    await h.setModel({ roomId: '!coord', target_convo_id: 'tgt', effort: 'Max' });
    expect(sent[0]).toMatchObject({ action: 'set_model', effort: 'max' });
    expect('model' in sent[0]).toBe(false);
  });
});

describe('MCP tool wiring (source inspection)', () => {
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  it('agent_session_start and session_set_model expose effort and forward it', () => {
    expect(askUser).toContain("effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()");
    expect(askUser).toContain('...(effort ? { effort } : {}), ...(link === true');
    expect(askUser).toContain("sessionControlCall('/session-set-model', { target_convo_id, ...(model ? { model } : {}), ...(effort ? { effort } : {})");
  });
  it('index.js validates MATRON_DEFAULT_EFFORT and reports it to the picker', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(src).toContain('const raw = process.env.MATRON_DEFAULT_EFFORT;');
    expect(src).toContain('if (!isSpawnEffortArg(raw)) {');
    expect(src).toContain('defaultEffort: () => defaultEffortNow(),');
    expect(src).toContain('?? effectiveDefaultEffort(userDefaults.snapshot().effort, DEFAULT_EFFORT);');
    expect(src).toContain('return boxEffortFor(AGENT_CLAUDE, { box: boxDefaults.snapshot(), defaultAgent: defaultAgentInfo().configured })');
  });
  it('a person\'s /effort <level> on a print session takes the /login route instead of refusing', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(src).toContain('if (!session.iv) applyPrintEffortSwitch(roomId, session, arg, { sendReply, sendHtml });');
    expect(src).toContain('session._deferredCommandText = `!effort ${decision.normalized}`;');
    // Borrow interactive mode and park the command, exactly as /login does.
    expect(src).toContain('const next = applyModeSwitch(roomId, session, true, { sendReply, sendHtml, announcement: decision.message });');
    expect(src).toContain('next._postReadySlashCommand = `/effort ${decision.normalized}`;');
    expect(src).toContain('next._effortFlowReturnToPrint = decision.normalized;');
    // The watcher records the typed write and accepts its confirmation.
    expect(src).toContain('noteEffortWrite(session, session._effortFlowReturnToPrint);');
    expect(src).toContain('armEffortAutoConfirm(session, session._effortFlowReturnToPrint);');
    expect(src.match(/armEffortFlowWrite\(session\);/g)?.length).toBe(2);
    // Held messages go first, but the effort switch re-parks behind them
    // instead of being dropped (Bugbot): replayed through the interactive path.
    expect(src).toContain('session._deferredCommandText = `!effort ${session._effortFlowReturnToPrint}`;');
    expect(src).toContain('&& session._effortFlowReturnToPrint === normalizeEffortArg(arg)) {');
    // A refused return retries instead of stranding the room interactive (Bugbot).
    expect(src).toContain('if (!planModeSwitch(current, false).ok && attempt < EFFORT_FLOW_RETRY_LIMIT) {');
    expect(src).toContain('scheduleEffortFlowReturn(current, EFFORT_FLOW_RETRY_MS, attempt + 1);');
    // A commit (or the timeout) switches back to print, carrying the level.
    expect(src).toContain('if (session._effortFlowReturnToPrint) scheduleEffortFlowReturn(session, LOGIN_RETURN_TO_PRINT_DELAY_MS);');
    expect(src).toContain('scheduleEffortFlowReturn(session, EFFORT_FLOW_RETURN_TIMEOUT_MS);');
    expect(src).toContain('const switched = applyModeSwitch(roomId, current, false, {');
    // The flag survives the iv auto-restart and is dropped with an abandoned parked command.
    expect(src).toContain('restarted._effortFlowReturnToPrint = session._effortFlowReturnToPrint;');
    expect(src.match(/session\._effortFlowReturnToPrint = null;/g)?.length).toBe(2);
    // New input waits while the typed /effort settles (Bugbot): user sends and room delivery.
    expect(src).toContain('if (session.busy || effortFlowHoldsInput(session)) {');
    expect(src).toContain('|| !!session.waitingForAnswer || !!session.pendingInteractivePrompt\n    || effortFlowHoldsInput(session);');
    // Bugbot on 799390a: slash input queues during the hold, the room inbox
    // drains after it, and a crash-restart replacement re-arms the return.
    expect(src).toContain('if (session.iv && !effortFlowHoldsInput(session) && isIvSlashPassthrough(trimmed)) {');
    expect(src).toContain('if (holder?.alive) maybeFlushRoomDelivery(holder);');
    expect(src).toContain("if (restarted._effortFlowReturnToPrint && !restarted._postReadySlashCommand) {\n          scheduleEffortFlowReturn(restarted, EFFORT_FLOW_RETURN_TIMEOUT_MS);");
    expect(src).not.toContain('Changing effort needs interactive mode. Options:');
  });

});
