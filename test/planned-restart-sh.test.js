import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/planned-restart.sh', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture({ token = 'a'.repeat(64), statuses = '200', rotate = false, transport = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-client-'));
  roots.push(root);
  const file = path.join(root, '.matron-bridge-restart.env');
  const argv = path.join(root, 'argv');
  if (token !== null) fs.writeFileSync(file, `MATRON_RESTART_TOKEN=${token}\n`);
  fs.writeFileSync(path.join(root, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$FIXTURE_ARGV"
cat >> "$FIXTURE_HEADERS"
count=0
[[ ! -f "$FIXTURE_COUNT" ]] || read -r count < "$FIXTURE_COUNT"
count=$((count+1)); printf '%s\\n' "$count" > "$FIXTURE_COUNT"
read -r -a statuses <<< "$FIXTURE_STATUSES"
if [[ "$FIXTURE_ROTATE" == 1 && "$count" == 1 ]]; then printf 'MATRON_RESTART_TOKEN=%s\\n' "${'b'.repeat(64)}" > "$MATRON_RESTART_ENV_FILE"; fi
[[ "$FIXTURE_TRANSPORT" != 1 ]] || exit 7
while [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then printf '{"state":"pending"}\\n' > "$2"; break; fi; shift; done
printf '%s' "\${statuses[count-1]:-200}"
`, { mode: 0o755 });
  return { file, argv, root,
    run(args = ['config "quoted"\nnext', '--sha', 'c'.repeat(40), '--request-key', 'alice']) {
      return spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 5000,
        env: { HOME: root, PATH: `${root}:/usr/bin:/bin`, MATRON_RESTART_ENV_FILE: file,
          FIXTURE_ARGV: argv, FIXTURE_HEADERS: path.join(root, 'headers'), FIXTURE_COUNT: path.join(root, 'count'),
          FIXTURE_STATUSES: statuses, FIXTURE_ROTATE: rotate ? '1' : '0', FIXTURE_TRANSPORT: transport ? '1' : '0' } });
    } };
}
it('refuses an absent token file', () => {
  const f = fixture({ token: null });
  const result = f.run();
  expect(result.status).toBe(4);
  expect(result.stderr).toContain('bridge restarting or down, retry after back');
  expect(fs.existsSync(f.argv)).toBe(false);
});
it.each(['bad', 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64) + '\nEXEC=bad', '$(touch marker)'])('refuses malformed token input %s', token => {
  const f = fixture({ token });
  expect(f.run().status).toBe(2);
  expect(fs.existsSync(f.argv)).toBe(false);
  expect(fs.existsSync(path.join(f.root, 'marker'))).toBe(false);
});
it('refuses an unreadable token input', () => {
  const f = fixture({ token: null });
  fs.mkdirSync(f.file);
  expect(f.run().status).toBe(2);
  expect(fs.existsSync(f.argv)).toBe(false);
});
it('re-reads a rotated token once after unauthorized', () => {
  const f = fixture({ statuses: '401 200', rotate: true });
  expect(f.run().status).toBe(0);
  expect(fs.readFileSync(path.join(f.root, 'count'), 'utf8').trim()).toBe('2');
  expect(fs.readFileSync(path.join(f.root, 'headers'), 'utf8')).toContain('b'.repeat(64));
});
it('refuses a token still stale after one retry', () => {
  const f = fixture({ statuses: '401 401' });
  const result = f.run();
  expect(result.status).toBe(5);
  expect(result.stderr).toContain('token stale, bridge restarted; retry after back');
  expect(fs.readFileSync(path.join(f.root, 'count'), 'utf8').trim()).toBe('2');
});
it('refuses restarting and transport failures', () => {
  expect(fixture({ statuses: '503' }).run().status).toBe(6);
  expect(fixture({ transport: true }).run().status).toBe(4);
});
it('sends a JSON request with the token only on stdin', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const argv = fs.readFileSync(f.argv, 'utf8');
  expect(argv).not.toContain('a'.repeat(64));
  expect(argv).toContain('-H\n@-\n');
  const data = argv.split('\n').find(line => line.startsWith('{'));
  expect(JSON.parse(data)).toEqual({ reason: 'config "quoted"\nnext', sha: 'c'.repeat(40), request_key: 'alice' });
  expect(fs.readFileSync(path.join(f.root, 'headers'), 'utf8')).toBe(`X-Matron-Restart-Token: ${'a'.repeat(64)}\n`);
});
it('refuses invalid arguments', () => {
  const f = fixture();
  for (const args of [[], [''], ['config', '--force'], ['config', '--sha'], ['config', '--request-key']]) expect(f.run(args).status).toBe(2);
  expect(fs.existsSync(f.argv)).toBe(false);
});

it.each([
  ['--eval=console.log("unexpected")', 'c'.repeat(40), 'alice'],
  ['--eval', 'c'.repeat(40), 'alice'],
  ['--reason', '--sha-value', '--key-value'],
])('preserves leading dash data (%s)', (reason, sha, requestKey) => {
  const f = fixture();
  expect(f.run([reason, '--sha', sha, '--request-key', requestKey]).status).toBe(0);
  const data = fs.readFileSync(f.argv, 'utf8').split('\n').find(line => line.startsWith('{'));
  expect(typeof data).toBe('string');
  expect(JSON.parse(data)).toEqual({ reason, sha, request_key: requestKey });
});
