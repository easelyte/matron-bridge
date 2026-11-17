import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { startBridge } from './helpers/bridge-process.js';

// The real entry point, in a disposable checkout with a throwaway HOME and a
// random port: request-only mode (MATRON_CODE_UPDATE_AUTO=0), a request pinned
// to a commit that has not landed, the restart once it has, the state file the
// crash rollback reads, and the request key after the restart it caused.
const git = (bridge, ...args) => execFileSync('git', ['-c', 'user.name=alice', '-c', 'user.email=alice', '-c', 'commit.gpgsign=false', ...args], {
  cwd: bridge.checkout, encoding: 'utf8', env: { HOME: bridge.home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
const call = async (bridge, method, body) => {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/restart`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Matron-Restart-Token': bridge.token() },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
};
const wait = (read, timeout = 40000) => vi.waitFor(async () => { expect(await read(), String(read)).toBeTruthy(); }, { timeout, interval: 100 });

it('request-only bridge: a pinned request waits for its commit, restarts once, records it, and keeps its key', async () => {
  const bridge = await startBridge({
    confine: false, interactive: false, planned: true,
    env: { MATRON_CODE_UPDATE_RESTART: '1', MATRON_CODE_UPDATE_AUTO: '0', MATRON_CODE_UPDATE_POLL_MS: '300', MATRON_CODE_UPDATE_SETTLE_MS: '100' },
  });
  const state = () => JSON.parse(fs.readFileSync(path.join(bridge.home, '.matron-bridge-restart-state.json'), 'utf8'));
  const history = () => {
    const file = path.join(bridge.home, '.matron-bridge-restart-history.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  };
  try {
    const boot = git(bridge, 'rev-parse', 'HEAD');
    const branch = git(bridge, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(bridge, 'checkout', '-q', '-b', 'next');
    git(bridge, 'commit', '-q', '--allow-empty', '-m', 'next');
    const next = git(bridge, 'rev-parse', 'HEAD');
    git(bridge, 'checkout', '-q', branch);

    // Nothing requested: the boot state is on disk and nothing is pending.
    await wait(() => fs.existsSync(path.join(bridge.home, '.matron-bridge-restart-state.json')));
    expect(state()).toMatchObject({ boot_sha: boot, state: null });
    expect(await call(bridge, 'GET')).toMatchObject({ status: 200, body: { requested: null, requests: [] } });

    const asked = await call(bridge, 'POST', { reason: 'rehearsal', sha: next, request_key: 'rehearsal-1' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ request_key: 'rehearsal-1', requests: [{ reason: 'rehearsal', sha: next }], requested: { reason: 'rehearsal' } });
    expect(state()).toMatchObject({ id: asked.body.id, state: 'pending', boot_sha: boot, requests: [{ request_key: 'rehearsal-1', sha: next }] });
    // The same key is the same request.
    const again = await call(bridge, 'POST', { reason: 'again', sha: next, request_key: 'rehearsal-1' });
    expect(again).toMatchObject({ status: 200, body: { idempotent: true, id: asked.body.id, state: 'pending' } });

    // The commit has not landed: the request waits and says why.
    await wait(async () => (await call(bridge, 'GET')).body.gate?.startsWith('waiting for HEAD to contain'));
    expect((await call(bridge, 'GET')).body.waiting_on.code).toMatch(/waiting for HEAD to contain/);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(bridge.supervisor.exits).toEqual([]);

    // It lands: the restart goes ahead, once, and is recorded before the exit.
    git(bridge, 'merge', '-q', '--ff-only', 'next');
    await wait(() => bridge.supervisor.exits.length === 1);
    expect(bridge.supervisor.exits).toEqual([{ code: 75, signal: null }]);
    expect(state()).toMatchObject({ id: asked.body.id, state: 'restarting', previous_sha: boot, expected_sha: next, boot_id: expect.any(String) });
    expect(state().restarting_at).toEqual(expect.any(Number));

    // The new process marks it back, with a history line, and still knows the key.
    await wait(() => bridge.supervisor.launches === 2);
    await wait(() => state().state === 'back');
    expect(state()).toMatchObject({ boot_sha: next, results: { code_mismatch: false } });
    expect(state().booted_at).toEqual(expect.any(Number));
    await wait(() => history().length === 1);
    expect(history()[0]).toMatchObject({ id: asked.body.id, state: 'back', requests: [{ request_key: 'rehearsal-1' }], results: { resumed: [], failed: [] } });
    await wait(async () => (await call(bridge, 'POST', { reason: 'late retry', sha: next, request_key: 'rehearsal-1' }).catch(() => null))?.status === 200);
    expect((await call(bridge, 'POST', { reason: 'late retry', sha: next, request_key: 'rehearsal-1' })).body).toMatchObject({ idempotent: true, id: asked.body.id, state: 'back' });

    // Request-only: a HEAD move with no request restarts nothing.
    git(bridge, 'commit', '-q', '--allow-empty', '-m', 'unrequested');
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect(bridge.supervisor.exits).toHaveLength(1);
    expect(bridge.supervisor.launches).toBe(2);
  } finally {
    await bridge.close();
  }
}, 150000);

it('a resume note survives the restart, is delivered to its chat after it, and its outcome closes the record', async () => {
  const note = 'Continue checking the saved report.';
  const bridge = await startBridge({
    confine: false, planned: true,
    env: { MATRON_CODE_UPDATE_RESTART: '1', MATRON_CODE_UPDATE_AUTO: '0', MATRON_CODE_UPDATE_POLL_MS: '300', MATRON_CODE_UPDATE_SETTLE_MS: '100' },
  });
  const file = (name) => path.join(bridge.home, `.matron-bridge-${name}`);
  const state = () => JSON.parse(fs.readFileSync(file('restart-state.json'), 'utf8'));
  const users = (id) => bridge.transcript(id).filter(row => row.type === 'user').map(row => row.message.content);
  try {
    const alice = await bridge.startSession();
    const saved = await bridge.post('/reminders/create', { roomId: alice.roomId, restart_note: true, text: note });
    expect(saved.restart_note.text).toBe(note);
    // A config-only request while HEAD is where the process booted.
    const asked = await call(bridge, 'POST', { reason: 'rehearsal: reload config', request_key: 'note-1' });
    expect(asked.status).toBe(202);
    await wait(() => bridge.supervisor.exits.length === 1, 90000);
    expect(bridge.supervisor.exits).toEqual([{ code: 75, signal: null }]);
    await wait(() => bridge.supervisor.launches === 2);
    await wait(() => state().state === 'back');
    // The note reaches its chat once, and then the record is closed with what became of it.
    await wait(() => users(alice.claudeSessionId).some(content => content.some(part => part.text?.includes(note))), 120000);
    await wait(() => state().history_appended === true, 60000);
    expect(state().results).toMatchObject({ code_mismatch: false, resumed: [alice.claudeSessionId], failed: [], possibly_delivered: [] });
    expect(users(alice.claudeSessionId).filter(content => content.some(part => part.text?.includes(note)))).toHaveLength(1);
    const lines = fs.readFileSync(file('restart-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(1);
    expect(lines[0].results.verdicts[alice.claudeSessionId].outcome).toBe('resumed');
    expect(fs.existsSync(file('restart-pending.json')) ? JSON.parse(fs.readFileSync(file('restart-pending.json'), 'utf8')) : []).toEqual([]);
  } finally {
    await bridge.close();
  }
}, 240000);
