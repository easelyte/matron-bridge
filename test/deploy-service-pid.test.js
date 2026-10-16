import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// deploy.sh reads the launchd bridge's pid from `launchctl print`, whose keys
// are indented with a TAB. A pattern that wanted a leading space never
// matched, so every macOS deploy logged "old PID: none" and gave no way to
// check that the restart had happened. This runs deploy.sh's own awk program
// against output shaped like the real thing.
const deploy = fs.readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');

function launchdPidAwk() {
  const line = deploy.split('\n').find((l) => l.includes('service_pid()') && l.includes('launchctl print'));
  const m = line && line.match(/awk -F'= ' '([^']+)'/);
  if (!m) throw new Error('no launchctl service_pid awk program in deploy.sh');
  return m[1];
}

const servicePid = (out) => execFileSync('awk', ['-F= ', launchdPidAwk()], { input: out, encoding: 'utf8' });

const LAUNCHCTL_PRINT = [
  'gui/501/chat.matron.matron-bridge = {',
  '\tactive count = 1',
  '\tstate = running',
  '\tenvironment = {',
  '\t\tHOME => /Users/someone',
  '\t}',
  '\truns = 2',
  '\tpid = 2462',
  '\timmediate reason = semaphore',
  '\tlast exit code = 75: EX_TEMPFAIL',
  '}',
  '',
].join('\n');

// deploy.sh never runs on Windows, whose runner need not have awk.
describe.skipIf(process.platform === 'win32')('deploy.sh service_pid on macOS', () => {
  it('reads the pid from tab-indented launchctl output', () => {
    expect(servicePid(LAUNCHCTL_PRINT)).toBe('2462\n');
  });

  it('prints nothing when launchd runs no process', () => {
    expect(servicePid(LAUNCHCTL_PRINT.replace('\tpid = 2462\n', ''))).toBe('');
  });
});
