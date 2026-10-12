import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startBridge } from './helpers/bridge-process.js';

const note = 'Continue checking the saved report.';
const users = (bridge, id) => bridge.transcript(id).filter(row => row.type === 'user')
  .map(row => row.message.content);

it.each(['ordinary', 'missing stamp', 'history crash'])('restarts quiet sessions and recovers %s', async variant => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const bridge = await startBridge({ planned: true, backgroundChild: true, crashBeforeHistory: variant === 'history crash', beforeRelaunch: () => paused });
  const wait = (read, timeout = 16000) => vi.waitFor(async () => { expect(await read(), read.toString()).toBeTruthy(); }, { timeout, interval: 50 });
  const file = name => path.join(bridge.home, `.matron-bridge-${name}`);
  const state = () => JSON.parse(fs.readFileSync(file('restart-state.json'), 'utf8'));
  const history = () => fs.existsSync(file('restart-history.jsonl'))
    ? fs.readFileSync(file('restart-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const restart = (route, body = {}) => bridge.post(route, body, { 'X-Matron-Restart-Token': bridge.token() });
  try {
    const alice = await bridge.startSession();
    await wait(() => fs.existsSync(path.join(bridge.home, `${alice.claudeSessionId}.env.json`)));
    const bob = await bridge.startSession();
    expect(fs.readFileSync(path.join(bridge.home, 'child-started'), 'utf8')).toBe(alice.claudeSessionId);
    const request = await restart('/restart', { reason: 'Reload configuration', request_key: 'alice' });
    expect(request.state).toBe('pending');
    for (const session of [alice, bob]) {
      await wait(() => users(bridge, session.claudeSessionId).some(content => content.some(part => part.text.includes('The bridge will restart'))));
      expect(users(bridge, session.claudeSessionId).filter(content => content.some(part => part.text.includes('The bridge will restart')))).toHaveLength(1);
    }
    const childEnv = JSON.parse(fs.readFileSync(path.join(bridge.home, `${alice.claudeSessionId}.env.json`), 'utf8'));
    expect(bridge.token(childEnv.tokenFile) === bridge.token()).toBe(true);
    const saved = await bridge.post('/reminders/create', { roomId: childEnv.roomId, restart_note: true, text: note });
    expect(saved.restart_note).toMatchObject({ id: request.id, convoId: alice.claudeSessionId, text: note });
    await wait(async () => (await restart('/restart/dry-run')).waiting_on.preflight === null);
    await wait(async () => !(await bridge.post('/sessions')).some(session => session.alive && session.busy));
    // Observe two complete gate ticks with only background work holding it.
    await new Promise(resolve => setTimeout(resolve, 6100));
    expect(bridge.supervisor.exits).toEqual([]);
    const dry = await restart('/restart/dry-run');
    expect(dry.waiting_on.quiet.holders).toContainEqual({ convoId: alice.claudeSessionId, why: 'children' });
    expect(dry.waiting_on.quiet.holders).toHaveLength(1);
    expect(dry.would_pass).toBe(false);
    expect(state().state).toBe('pending');
    expect(bridge.supervisor.exits).toEqual([]);
    fs.writeFileSync(path.join(bridge.home, 'child-release'), 'release');
    await wait(() => bridge.supervisor.exits.length === 1);
    expect(bridge.supervisor.exits).toEqual([{ code: 75, signal: null }]);
    expect(bridge.supervisor.launches).toBe(1);
    expect(state().state).toBe('restarting');
    const statuses = () => bridge.frames.filter(frame => frame.op === 'box_status' && frame.restart?.id === request.id)
      .map(frame => frame.restart.state);
    expect(statuses()).toContain('restarting');
    const exitFrameCount = bridge.frames.length;
    expect(state().participants).toEqual([alice.claudeSessionId]);
    expect(history()).toEqual([]);
    const stamp = file('self-restart.json');
    expect(fs.existsSync(stamp)).toBe(true);
    if (variant === 'missing stamp') fs.unlinkSync(stamp);
    release();
    await wait(() => bridge.supervisor.launches === 2);
    await wait(() => bridge.frames.filter(frame => frame.op === 'hello').length === 2);
    // No input after relaunch: the scheduled handoff must resume the cold PTY.
    await wait(() => state().state === 'back', 85000);
    if (variant === 'history crash') {
      await wait(() => bridge.supervisor.exits.length === 2);
      expect(bridge.supervisor.exits[1].signal === 'SIGKILL' || bridge.supervisor.exits[1].code === 137).toBe(true);
      const bootedAt = state().booted_at;
      expect(state().history_appended).toBe(false);
      expect(history()).toEqual([]);
      bridge.supervisor.restart();
      await wait(() => history().length === 1);
      expect(state().state).toBe('back');
      expect(state().booted_at).toBe(bootedAt);
      expect(bridge.supervisor.launches).toBe(3);
    } else {
      expect(bridge.supervisor.launches).toBe(2);
    }
    await wait(() => bridge.frames.slice(exitFrameCount).some(frame => frame.op === 'box_status'
      && frame.restart?.id === request.id && frame.restart.state === 'back'));
    expect(statuses().indexOf('back')).toBeGreaterThan(statuses().indexOf('restarting'));
    expect(state().verdicts[alice.claudeSessionId].outcome).toBe('resumed');
    expect(state().results.no_note).toEqual([bob.claudeSessionId]);
    await wait(() => users(bridge, alice.claudeSessionId).some(content => content.some(part => part.text === note)));
    await wait(async () => !(await bridge.post('/sessions')).some(session => session.alive && session.busy));
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(users(bridge, alice.claudeSessionId).filter(content => content.some(part => part.text === note))).toEqual([[{ type: 'text', text: note }]]);
    expect(users(bridge, bob.claudeSessionId).some(content => content.some(part => part.text === note))).toBe(false);
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({ id: request.id, state: 'back' });
  } finally {
    release();
    await bridge.close();
  }
}, 120000);
