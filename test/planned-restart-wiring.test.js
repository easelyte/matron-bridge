import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the idiom of test/code-update-restart-wiring.test.js):
// index.js has no unit harness, and each coupling below fails silently if lost.
describe('planned restart wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const part = (from, to) => {
    const start = index.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    return index.slice(start, to ? index.indexOf(to, start) : undefined);
  };
  const block = part('// --- Planned restart (lib/planned-restart.js) ---', '// POST /wake (lib/wake-route.js)');

  it('can be switched off, and batches requests with a collect window', () => {
    expect(index).toContain("const PLANNED_RESTART_ENABLED = process.env.MATRON_PLANNED_RESTART !== '0';");
    expect(index).toContain('MATRON_RESTART_COLLECT_MS');
    expect(block).toContain('collectMs: RESTART_COLLECT_MS');
  });

  it('counts the code-update watcher\'s holds, uncapped, plus queued input, and treats an unreadable process table as not quiet', () => {
    const quiet = part('function plannedRestartQuiet() {', '\nconst plannedRestart = ');
    expect(quiet).toContain('sessionsHoldingRestart({ ageCap: false })');
    expect(quiet).toContain("why: 'queued_input'");
    expect(quiet).toContain("probe_error: unreadable ? 'process_table' : null");
    // An open turn whose busy flag is down, and input held while a resume loads.
    expect(quiet).toContain('sessionOccupiedForForeignTurn(session)');
    expect(quiet).toContain('session._resumeOutbox?.length > 0');
  });

  it('waits out a boot settle time, and stays closed without a git checkout', () => {
    expect(block).toContain('notBefore: Date.now() + PLANNED_RESTART_BOOT_SETTLE_MS');
    expect(block).toContain("if (!RESTART_BOOT_SHA) throw new Error('no checkout');");
  });

  it('latches through the code-update stamp and the ordinary graceful shutdown, never while shutting down', () => {
    const latch = part('const restartLatch = ', '\nif (plannedRestart) {');
    expect(latch).toContain('available: () => !shuttingDown');
    expect(latch).toContain('writeSelfRestartStamp(SELF_RESTART_STAMP_FILE, stamp)');
    expect(latch).toContain('gracefulShutdown(signal, options)');
    expect(latch).toContain('quiet: plannedRestartQuiet');
    expect(latch).not.toMatch(/force/i);
  });

  it('polls on an unref()d timer and reports a changed verdict rather than every poll', () => {
    const timer = part('if (plannedRestart) {\n  let previous;', '// Boot: a restart');
    expect(timer).toMatch(/timer\.unref\(\)/);
    expect(timer).toContain('plannedRestart.tick()');
    expect(timer).toContain('summary !== reported');
  });

  it('answers POST /restart after the loopback guard and before the journal read proxy, behind its own token', () => {
    const server = part('const apiServer = createServer(');
    const guard = server.indexOf('loopbackRefusal(req.headers)');
    const route = server.indexOf("url.pathname === '/restart' && req.method === 'POST'");
    const proxy = server.indexOf('journalReadProxy.handle(');
    expect(guard).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(guard);
    expect(proxy).toBeGreaterThan(route);
    const handler = server.slice(route, proxy);
    expect(handler).toContain('if (!PLANNED_RESTART_ENABLED) { reply(404');
    expect(handler).toContain('decideRestartRequest({ headers: req.headers, token: restartToken.token, body, stateStore: plannedRestartState })');
    expect(handler).toContain('RESTART_BODY_MAX_BYTES');
    // A permanent "unavailable" is not the 503 a latched restart answers.
    expect(handler).toContain("reply(501, { error: 'planned restart unavailable' })");
  });

  it('writes the token file once the listener is up, and removes it at exit', () => {
    const listen = part("apiServer.listen(API_PORT, '127.0.0.1', () => {", "console.log(`Local API listening");
    expect(listen).toContain('installRestartToken({ port: API_PORT })');
    expect(listen).toContain("process.on('exit'");
    expect(listen).toContain('removeRestartToken(restartToken)');
  });

  it('marks a latched restart back at boot, after the carry-on cards and before the watcher starts', () => {
    const main = part('async function main() {', 'main().catch');
    expect(main).toMatch(/publishRestartCarryOnCards\(\);\n\s*reconcilePlannedRestartAtBoot\(\);[\s\S]*startCodeUpdateWatcher\(\);/);
    const reconcile = part('function reconcilePlannedRestartAtBoot() {', '\n}\n');
    expect(reconcile).toContain("state.state !== 'restarting'");
    expect(reconcile).toContain("setState('back'");
    expect(reconcile).toContain('code_mismatch');
  });

  it('reports the restart in box_status', () => {
    const status = part('function publishBoxStatus(reason) {', '\nconst journalPublisher');
    expect(status).toContain('buildRestartStatus(plannedRestartState?.getState(), plannedRestartRuntime.gateVerdict)');
    expect(status).toContain('...(restart ? { restart } : {}),');
  });
});
