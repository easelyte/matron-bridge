import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the idiom of test/box-status-wiring.js
// — index.js has no unit harness). The self-restart onto new code only
// closes the "a bridge with an always-live session never updates" hole if
// index.js actually starts the watcher, counts mid-turn sessions the way
// the rest of the bridge does, and exits NON-zero through the ordinary
// graceful shutdown. Each coupling below fails silently if lost: the bridge
// simply keeps running old code, which is the status quo this fixes.
describe('code-update self-restart wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = index.indexOf('function startCodeUpdateWatcher()');
  const fn = index.slice(start, index.indexOf('\n}\n', start) + 3);
  const shutdown = index.slice(index.indexOf('async function gracefulShutdown('), index.indexOf("process.on('SIGINT'"));

  it('starts the watcher at the end of main(), after the carry-on cards', () => {
    const main = index.slice(index.indexOf('async function main()'), index.indexOf('main().catch'));
    expect(main).toMatch(/publishRestartCarryOnCards\(\);[\s\S]*startCodeUpdateWatcher\(\);/);
  });

  it('watches the checkout index.js runs from, and is off without a reflog or when disabled', () => {
    expect(fn).toMatch(/if \(!CODE_UPDATE_RESTART\) \{/);
    expect(fn).toMatch(/resolveGitDir\(__dirname\)/);
    expect(fn).toMatch(/readHeadReflog\(gitDir\)/);
    expect(fn).toMatch(/defaultPreflight\(__dirname\)/);
    expect(index).toMatch(/const CODE_UPDATE_RESTART = codeUpdateRestartEnabled\(process\.env\.MATRON_CODE_UPDATE_RESTART\)/);
  });

  it('never forces a mid-turn restart unless the box opts in (deploy-1, 2026-10-03)', () => {
    // 0 = never; the env is the only way to turn forcing on.
    expect(index).toMatch(/const CODE_UPDATE_FORCE_AFTER_MS = parseCodeUpdateMsOrOff\(process\.env\.MATRON_CODE_UPDATE_FORCE_AFTER_MS, CODE_UPDATE_FORCE_AFTER_DEFAULT_MS\)/);
    expect(fn).toMatch(/forceAfterMs: CODE_UPDATE_FORCE_AFTER_MS,/);
    expect(fn).toMatch(/warnEveryMs: CODE_UPDATE_WARN_EVERY_MS,/);
    expect(index).not.toMatch(/MAX_DEFER/);
  });

  it('counts mid-turn sessions as alive && busy — the flag /sessions reports and restart_session parks on', () => {
    expect(fn).toMatch(/busySessions: \(\) => \{[^}]*s\.alive && s\.busy/);
  });

  it('restarts through gracefulShutdown with the non-zero exit code, never while already shutting down', () => {
    expect(fn).toMatch(/if \(shuttingDown\) return;/);
    expect(fn).toMatch(/gracefulShutdown\('code-update', \{ exitCode: CODE_UPDATE_EXIT_CODE \}\)/);
    expect(shutdown).toMatch(/async function gracefulShutdown\(signal, \{ exitCode = 0 \} = \{\}\)/);
    expect(shutdown).toMatch(/process\.exit\(exitCode\);/);
    expect(shutdown).not.toMatch(/process\.exit\(0\);/);
  });

  it('polls on an unref()d timer so the watcher never holds the process open', () => {
    expect(fn).toMatch(/setInterval\(\(\) => \{\n\s*watcher\.tick\(\)\.catch/);
    expect(fn).toMatch(/timer\.unref\(\)/);
  });

  it('stamps a FORCED restart with its bootId before exiting, and shrugs off a failed write', () => {
    expect(fn).toMatch(/if \(info\.forced\) \{\n\s*try \{\n\s*writeSelfRestartStamp\(SELF_RESTART_STAMP_FILE, \{ bootId: BRIDGE_BOOT_ID, sha: info\.sha, busy: info\.busy \}\);/);
    expect(fn).toMatch(/could not write \$\{SELF_RESTART_STAMP_FILE\}/);
    // The stamp is written BEFORE the shutdown that exits the process.
    expect(fn.indexOf('writeSelfRestartStamp(')).toBeLessThan(fn.indexOf("gracefulShutdown('code-update'"));
  });

  it('at boot: takes the stamp, resumes only its own interruptions by itself, cards the rest', () => {
    const boot = index.slice(index.indexOf('function publishRestartCarryOnCards()'), index.indexOf('async function main()'));
    // Taken (and removed) before the early return, so it can never outlive the boot it was meant for.
    expect(boot).toMatch(/const stamp = takeSelfRestartStamp\(SELF_RESTART_STAMP_FILE\);\n\s*if \(!stale\.length\) return;/);
    expect(boot).toMatch(/selectAutoCarryOn\(stale, stamp, \{ enabled: CODE_UPDATE_AUTO_CARRY_ON \}\)/);
    // Same two gates as a card: a persisted session to resume, and a convo id a resume can address.
    expect(boot).toMatch(/auto\.filter\(rec => resumable\.has\(rec\.convoId\) && isResumeConvoId\(rec\.convoId\)\)/);
    expect(boot).toMatch(/setTimeout\(\(\) => \{[\s\S]*?carryOnConvo\(rec\.convoId, null, null, CODE_UPDATE_AUTO_CARRY_ON_TEXT, notice\)[\s\S]*?\}, CODE_UPDATE_AUTO_CARRY_ON_DELAY_MS\)/);
    // The resume notice says why, instead of the default "session was idle" copy.
    expect(boot).toMatch(/const notice = `🔄 The bridge restarted itself onto new code[^`]*carry on automatically\.`;/);
    // The card loop skips what carries on by itself.
    expect(boot).toMatch(/for \(const rec of stale\) \{\n\s*if \(autoSet\.has\(rec\)\) continue;/);
    expect(index).toMatch(/const CODE_UPDATE_AUTO_CARRY_ON = codeUpdateAutoCarryOnEnabled\(process\.env\.MATRON_CODE_UPDATE_AUTO_CARRY_ON\)/);
  });

  it('carryOnConvo still delivers the literal "carry on" for a tap, and the marked text for the automatic path', () => {
    const fnCarry = index.slice(index.indexOf('async function carryOnConvo('), index.indexOf('async function carryOnConvo(') + 2400);
    expect(fnCarry).toMatch(/async function carryOnConvo\(convoId, session, _sendReply, text = 'carry on', resumeNotice = undefined\)/);
    expect(fnCarry).toMatch(/await journalRouteTextToSession\(target, text\);/);
    expect(fnCarry).toMatch(/journalResumeConvo\(convoId, resumeNotice\)/);
  });

  it('is in the syntax-check script like every other lib', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.check).toMatch(/node --check lib\/code-update-restart\.js/);
  });
});
