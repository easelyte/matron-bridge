import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The restart_session tool's two ends: the MCP surface in ask-user.js and the
// endpoint/session wiring in index.js. index.js can't be imported (it starts a
// bridge), so its wiring is pinned by source inspection — the same technique
// restart-deferral.test.js and the busy-queue wiring tests use. The decision
// logic itself is behaviourally tested in self-restart*.test.js.

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf-8');

describe('ask-user.js restart_session tool', () => {
  const start = askUser.indexOf("'restart_session'");
  const body = askUser.slice(start, askUser.indexOf('server.tool(', start + 10));

  it('is registered', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('posts to the bridge /restart-session endpoint', () => {
    expect(body).toMatch(/\$\{BRIDGE_API\}\/restart-session/);
  });

  it('sends the caller room so the bridge knows which session to restart', () => {
    expect(body).toMatch(/roomId: ROOM_ID/);
  });

  it('takes a required continuation and optional browser/model/reason', () => {
    expect(body).toMatch(/continue_with: z\.string\(\)/);
    expect(body).toMatch(/browser: z\.boolean\(\)\.optional\(\)/);
    expect(body).toMatch(/model: z\.string\(\)\.optional\(\)/);
    expect(body).toMatch(/reason: z\.string\(\)[.\w()]*\.optional\(\)/);
  });

  it('surfaces the bridge refusal verbatim so the agent can act on it', () => {
    // A budget-exhausted or bad-model refusal is only useful if the agent
    // reads the reason instead of a bare HTTP status.
    expect(body).toMatch(/data\.error/);
  });
});

describe('index.js /restart-session endpoint', () => {
  it('imports the handler factory rather than inlining the rules', () => {
    expect(src).toMatch(/import \{[^}]*createSelfRestartHandler[^}]*\} from '\.\/lib\/self-restart\.js'/);
  });

  it('routes /restart-session through the shared JSON responder', () => {
    expect(src).toMatch(/url\.pathname === '\/restart-session'/);
    expect(src).toMatch(/respondAgentChatRoute\(res, data, selfRestartHandler/);
  });
});

describe('index.js self-restart dependency wiring', () => {
  const start = src.indexOf('createSelfRestartHandler({');
  const body = src.slice(start, src.indexOf('});', start));

  it('is wired', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('queues the continuation as an ordinary text entry on queuedMessages', () => {
    // recreateSession carries queuedMessages onto the replacement and
    // flushes them once it is ready — that IS the delivery mechanism.
    expect(body).toMatch(/queuedMessages/);
    expect(body).toMatch(/type: 'text'/);
  });

  it('keeps queuedMessages and queueNotifications in lockstep (placeholder slot, undone together)', () => {
    // cancel / send_one address the queue by notification index; an entry
    // with no slot would land later tiles on the wrong message.
    expect(body).toMatch(/session\.queueNotifications\.push\(notification\)/);
    expect(body).toMatch(/id: null, eventId: null/);
    expect(body).toMatch(/session\.queueNotifications\.splice\(j, 1\)/);
  });

  it('does NOT mark the continuation journal-origin, so it mirrors exactly once', () => {
    // markJournalOrigin means "the journal already has this row, skip the
    // mirror" (lib/queue-flush.js). This text is bridge-generated, so
    // marking it would hide from the user what the session told itself.
    expect(body).not.toMatch(/markJournalOrigin\(/);
  });

  it('parks mid-turn restarts on the same stash a typed /restart uses', () => {
    expect(body).toMatch(/_deferredCommandText/);
  });

  it('runs an idle restart through the existing deferred-command dispatcher', () => {
    expect(body).toMatch(/dispatchDeferredCommand/);
  });
});

describe('index.js self-restart loop budget', () => {
  it('carries the count across the session swap so a restart cannot clear it', () => {
    const start = src.indexOf('function recreateSession');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/next\._agentRestartCount = existing\._agentRestartCount/);
  });

  it('carries the count across BOTH crash auto-restarts (print-mode and iv-mode)', () => {
    // recreateSession is not the only session swap: a crash auto-restart
    // builds its own replacement. Each of those must carry the budget too,
    // or a self-restart that crashes comes back with a fresh 3.
    const marker = 'restarted.restartCount = session.restartCount + 1;';
    const sites = [];
    for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) sites.push(i);
    expect(sites).toHaveLength(2);
    for (const at of sites) {
      expect(src.slice(at, at + 4000)).toMatch(/restarted\._agentRestartCount = session\._agentRestartCount/);
    }
  });

  it('does not carry the pending flag across the swap, so the replacement may restart again', () => {
    const start = src.indexOf('function recreateSession');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).not.toMatch(/_selfRestartPending/);
  });

  it('resets the count when the user sends media too (voice note, photo)', () => {
    const start = src.indexOf('function journalOnMedia(');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/_agentRestartCount = 0/);
  });

  it('clears the pending flag when the deferred command fails, so a retry is not 409d', () => {
    const start = src.indexOf('function dispatchDeferredCommand(');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/\.catch\(/);
    expect(body).toMatch(/_selfRestartPending = false/);
  });

  it('keeps explicit queue releases from draining into a session with a parked restart', () => {
    // send / send_one / the magic word all go through flushQueue; the queue
    // carries into the replacement, so a parked !restart must hold it.
    const start = src.indexOf('function flushQueue(');
    const body = src.slice(start, src.indexOf('\n}', start));
    const guard = body.indexOf("_deferredCommandText.startsWith('!restart')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('dispatchMergedFlush('));
    expect(body.slice(guard, guard + 400)).toMatch(/restore\(\)/);
    expect(body).toMatch(/const restore = \(\) => \{\s*restoreQueuedBatch\(session, queued\)/);
  });

  it('resets the count when the user sends text, handing back a fresh budget', () => {
    const start = src.indexOf('async function journalRouteTextToSession');
    const body = src.slice(start, start + 1200);
    expect(body).toMatch(/_agentRestartCount = 0/);
  });
});
