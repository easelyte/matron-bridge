import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// deploy.sh must refuse an argument it does not know before it does anything:
// a typo such as --dryrun used to fall through to the default path, which
// pulls and restarts the live bridge. Argument parsing runs first, so these
// runs exit before any git, npm or service command.
const DEPLOY = fileURLToPath(new URL('../deploy.sh', import.meta.url));
const run = (...args) => spawnSync('bash', [DEPLOY, ...args], { encoding: 'utf8' });

describe.skipIf(process.platform === 'win32')('deploy.sh arguments', () => {
  it('refuses an unknown argument', () => {
    const r = run('--dryrun');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown argument: --dryrun');
    expect(r.stdout).not.toContain('git pull');
  });

  it('refuses more than one argument', () => {
    const r = run('--dry-run', '--when-quiet');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('too many arguments');
  });
});
