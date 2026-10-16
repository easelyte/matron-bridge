import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadCoordinatorBlock } from '../lib/coordinator.js';
import { missionIdemKey } from '../lib/missions-idem.js';
import { createBriefingHandlers, formatBriefingPublishAck } from '../lib/briefings-tools.js';

describe('briefings wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('mounts exactly the /briefing/publish route through the handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/briefing\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /briefing route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|')).toEqual(['publish']);
    expect(index).toContain('briefingHandlers[name]');
  });

  it('builds the client and handlers with the same Coordinator test as the routine tools', () => {
    expect(index).toMatch(/import \{ createBriefingsClient \} from '\.\/lib\/briefings-client\.js';/);
    expect(index).toMatch(/import \{ createBriefingHandlers \} from '\.\/lib\/briefings-tools\.js';/);
    expect(index).toMatch(/const briefingsClient = createBriefingsClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    const start = index.indexOf('const briefingHandlers = createBriefingHandlers({');
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, index.indexOf('});', start));
    expect(block).toContain('client: briefingsClient,');
    expect(block).toContain('isCoordinator: (session, convoId) => session?.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId),');
  });

  it("index.js's isCoordinator admits the journal's live Coordinator whose spawn-time flag is false, and nobody else", async () => {
    const start = index.indexOf('const briefingHandlers = createBriefingHandlers({');
    const block = index.slice(start, index.indexOf('});', start));
    const src = block.match(/isCoordinator: (\(session, convoId\) => .+),\n/)[1];
    let liveConvoId = null;
    const coordinatorLookup = { snapshot: () => ({ convoId: liveConvoId }) };
    const isCoordinator = new Function('coordinatorLookup', `return ${src};`)(coordinatorLookup);
    const session = { roomId: '!r:s', journalConvoId: 'c1', coordinator: false };
    const publishBriefing = vi.fn(async () => ({ status: 201, data: { briefing: { id: 'br_1', convo_id: 'c1', seq: 3 } } }));
    const h = createBriefingHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s?.journalConvoId ?? null, client: { publishBriefing }, isCoordinator });
    const args = { roomId: '!r:s', body: 'hello' };
    expect((await h.publish(args)).status).toBe(403);
    liveConvoId = 'other';
    expect((await h.publish(args)).status).toBe(403);
    expect(publishBriefing).not.toHaveBeenCalled();
    liveConvoId = 'c1';
    expect((await h.publish(args)).status).toBe(201);
    liveConvoId = null;
    session.coordinator = true;
    expect((await h.publish(args)).status).toBe(201);
    expect(publishBriefing).toHaveBeenCalledTimes(2);
  });

  it('registers briefing_publish through callBriefing with its ack renderer and a Coordinator-only description', () => {
    const slice = askUser.slice(askUser.indexOf("'briefing_publish',"), askUser.indexOf('async function sessionControlCall'));
    expect(slice).toContain("callBriefing('publish', args, formatBriefingPublishAck)");
    expect(slice).toMatch(/Coordinator only/);
    expect(slice).toMatch(/Latest briefing/);
    expect(slice).toMatch(/linked the way your instructions say/);
    expect(slice).toMatch(/do not also type it/);
    expect(slice).toMatch(/body: z\.string\(\)\.max\(32768\)/);
    expect(askUser).toMatch(/import \{ formatBriefingPublishAck \} from '\.\/lib\/briefings-tools\.js';/);
  });

  // Runs the REAL callBriefing source from ask-user.js against the REAL
  // handler: the idempotency key is derived from the call (the same body
  // retried is the same key), and every error is "briefing_publish failed: <sentence>".
  it('callBriefing sends a call-derived idempotency key and renders errors as one text line', async () => {
    const start = askUser.indexOf('async function callBriefing');
    const src = askUser.slice(start, askUser.indexOf('\n}\n', start) + 2);
    const makeCall = (handlers) => {
      const posts = [];
      const fetch = async (url, init) => {
        const op = url.split('/briefing/')[1];
        const body = JSON.parse(init.body);
        posts.push(body);
        const r = await handlers[op](body);
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
      };
      return { posts, call: new Function('fetch', 'BRIDGE_API', 'ROOM_ID', 'missionIdemKey', `${src}\nreturn callBriefing;`)(fetch, 'http://bridge', '!r:s', missionIdemKey) };
    };
    const publishBriefing = vi.fn(async () => ({ status: 201, data: { briefing: { id: 'br_1', convo_id: 'c1', seq: 9 } } }));
    const h = createBriefingHandlers({ sessions: new Map([['!r:s', { roomId: '!r:s', journalConvoId: 'c1', coordinator: true }]]), journalConvoIdFor: (s) => s.journalConvoId, client: { publishBriefing } });
    const { posts, call } = makeCall(h);
    const out = await call('publish', { body: 'All quiet.' }, formatBriefingPublishAck);
    expect(out).toEqual({ content: [{ type: 'text', text: 'Briefing published (matron://convo/c1, seq 9). It is already in the chat — do not repeat it.' }] });
    await call('publish', { body: 'All quiet.' }, formatBriefingPublishAck);
    await call('publish', { body: 'Something new.' }, formatBriefingPublishAck);
    expect(posts[0].idem_key).toMatch(/^[0-9a-f]{64}$/);
    expect(posts[1].idem_key).toBe(posts[0].idem_key);
    expect(posts[2].idem_key).not.toBe(posts[0].idem_key);
    expect(publishBriefing.mock.calls[0][1]).toEqual({ idemKey: posts[0].idem_key });

    const refusing = createBriefingHandlers({ sessions: new Map([['!r:s', { roomId: '!r:s', journalConvoId: 'c1', coordinator: true }]]), journalConvoIdFor: (s) => s.journalConvoId, client: { publishBriefing: async () => ({ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }) } });
    const err = await makeCall(refusing).call('publish', { body: 'x' }, formatBriefingPublishAck);
    expect(err).toEqual({ content: [{ type: 'text', text: 'briefing_publish failed: the journal does not list this conversation as the Coordinator' }] });
  });

  it('npm run check covers the two new files', () => {
    for (const f of ['lib/briefings-client.js', 'lib/briefings-tools.js']) expect(pkg.scripts.check).toContain(`node --check ${f}`);
  });

  it('the playbook publishes reports and status updates with briefing_publish, and has the on-demand briefing routine', () => {
    const coord = loadCoordinatorBlock({
      readFile: (p) => readFileSync(p, 'utf8'),
      path: fileURLToPath(new URL('../BRIDGE_COORDINATOR.md', import.meta.url)),
      dir: fileURLToPath(new URL('../coordinator', import.meta.url)),
      readDir: (d) => readdirSync(d),
    });
    expect(coord).toContain('## Routine: briefing — Briefing on request');
    const routine = coord.slice(coord.indexOf('## Routine: briefing'), coord.indexOf('## Routine: context-over'));
    expect(routine).toMatch(/briefing_publish/);
    expect(routine).toMatch(/not in `routine_list`/);
    expect(routine).toMatch(/unseen_flag/);
    const sweep = coord.slice(coord.indexOf('## Procedure: sweep'), coord.indexOf('## Procedure: triage'));
    expect(sweep).toMatch(/6\. \*\*Report\*\*.*briefing_publish/);
    const daily = coord.slice(coord.indexOf('## Routine: daily-sweep'), coord.indexOf('## Routine: deploy-window'));
    expect(daily).toMatch(/3\. Publish the day's status update with `briefing_publish`/);
    const preamble = readFileSync(new URL('../BRIDGE_COORDINATOR.md', import.meta.url), 'utf8');
    expect(preamble).toMatch(/Status updates and sweep reports go out with `briefing_publish`/);
  });
});
