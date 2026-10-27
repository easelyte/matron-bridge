import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/planned-restart.sh', import.meta.url));
const roots = [];
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
// A real loopback HTTP server stands in for the bridge: the script calls an
// absolute curl, so no binary can be substituted through PATH.
async function fixture({ token = 'a'.repeat(64), statuses = ['200'], rotate = false, rotatedPort, transport = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-client-'));
  roots.push(root);
  const file = path.join(root, '.matron-bridge-restart.env');
  if (token !== null) fs.writeFileSync(file, `MATRON_RESTART_TOKEN=${token}\n`);
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      const status = statuses[requests.length - 1] ?? '200';
      if (rotate && requests.length === 1) fs.writeFileSync(file, `MATRON_RESTART_TOKEN=${'b'.repeat(64)}\n${rotatedPort ? `MATRON_BRIDGE_API_PORT=${rotatedPort}\n` : ''}`);
      if (transport) { req.socket.destroy(); return; }
      res.writeHead(Number(status), { 'Content-Type': 'application/json' });
      res.end('{"state":"pending"}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = server.address().port;
  return { file, root, port, requests,
    run(args = ['config "quoted"\nnext', '--sha', 'c'.repeat(40), '--request-key', 'alice'], { env = {}, viaBash = false } = {}) {
      const command = viaBash ? '/bin/bash' : script;
      const bare = viaBash === 'bare';
      const argv = bare ? [path.basename(script), ...args] : viaBash === 'p' ? ['-p', script, ...args] : viaBash ? [script, ...args] : args;
      return new Promise(resolve => {
        const child = spawn(command, argv, { cwd: bare ? path.dirname(script) : undefined, env: { HOME: root, MATRON_RESTART_ENV_FILE: file, MATRON_BRIDGE_API_PORT: String(port), ...env } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
        child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      });
    } };
}
it('refuses an absent token file', async () => {
  const f = await fixture({ token: null });
  const result = await f.run();
  expect(result.status).toBe(4);
  expect(result.stderr).toContain('bridge restarting or down, retry after back');
  expect(f.requests).toHaveLength(0);
});
it.each(['bad', 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64) + '\nEXEC=bad', '$(touch marker)'])('refuses malformed token input %s', async token => {
  const f = await fixture({ token });
  expect((await f.run()).status).toBe(2);
  expect(f.requests).toHaveLength(0);
  expect(fs.existsSync(path.join(f.root, 'marker'))).toBe(false);
});
it('refuses an unreadable token input', async () => {
  const f = await fixture({ token: null });
  fs.mkdirSync(f.file);
  expect((await f.run()).status).toBe(2);
  expect(f.requests).toHaveLength(0);
});
it('re-reads a rotated token once after unauthorized', async () => {
  const f = await fixture({ statuses: ['401', '200'], rotate: true });
  expect((await f.run()).status).toBe(0);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0].headers['x-matron-restart-token']).toBe('a'.repeat(64));
  expect(f.requests[1].headers['x-matron-restart-token']).toBe('b'.repeat(64));
});
it('refuses a token still stale after one retry', async () => {
  const f = await fixture({ statuses: ['401', '401'] });
  const result = await f.run();
  expect(result.status).toBe(5);
  expect(result.stderr).toContain('token stale, bridge restarted; retry after back');
  expect(f.requests).toHaveLength(2);
});
it('refuses restarting and transport failures', async () => {
  expect((await (await fixture({ statuses: ['503'] })).run()).status).toBe(6);
  expect((await (await fixture({ transport: true })).run()).status).toBe(4);
});
it('maps only connection-level curl failures to exit 4', async () => {
  // Connection refused (curl 7): the port of a server that has just closed.
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const refused = await fixture();
  const failure = await refused.run(undefined, { env: { MATRON_BRIDGE_API_PORT: String(closedPort) } });
  expect(failure.status).toBe(4);
  expect(failure.stderr).toContain(`retry after back (port ${closedPort})`);
  // A reply curl cannot parse as HTTP is not retryable: exit 2.
  const garbage = net.createServer(socket => { socket.end('not http at all\r\n\r\n', () => socket.destroy()); });
  servers.push(garbage);
  await new Promise(resolve => garbage.listen(0, '127.0.0.1', resolve));
  const odd = await fixture();
  const result = await odd.run(undefined, { env: { MATRON_BRIDGE_API_PORT: String(garbage.address().port) } });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('curl exit');
});
it('requires an executable /usr/bin/curl and refuses a bare script name', async () => {
  expect(fs.readFileSync(script, 'utf8')).toContain("[[ -x /usr/bin/curl ]] || { echo '/usr/bin/curl not found' >&2; exit 2; }");
  const f = await fixture();
  const result = await f.run(['restart'], { viaBash: 'bare' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('by path');
  expect(f.requests).toHaveLength(0);
});
it('refuses an unexpected HTTP status', async () => {
  const result = await (await fixture({ statuses: ['500'] })).run();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('HTTP 500');
});
it.each(['9802@example.com', '0', '65536', '99999', '080', '-1', '1e3'])('refuses an invalid port %s with exit 2', async port => {
  const f = await fixture();
  const result = await f.run(undefined, { env: { MATRON_BRIDGE_API_PORT: port } });
  expect(result.status).toBe(2);
  expect(f.requests).toHaveLength(0);
});
it('retains the legacy default port without connecting to it', () => {
  const source = fs.readFileSync(script, 'utf8');
  expect(source).toContain('port=9802');
  expect(source).toContain('http://127.0.0.1:${port}/restart');
});
it.each([false, true])('uses the file port with an explicit token path (%s)', async explicit => {
  const f = await fixture();
  fs.writeFileSync(f.file, `MATRON_RESTART_TOKEN=${'a'.repeat(64)}\nMATRON_BRIDGE_API_PORT=${f.port}\n`);
  const result = await f.run(undefined, { env: {
    MATRON_RESTART_ENV_FILE: explicit ? f.file : '',
    // Without an explicit file, even an invalid ambient override is ignored.
    MATRON_BRIDGE_API_PORT: explicit ? '' : 'invalid',
  } });
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].headers['x-matron-restart-token']).toBe('a'.repeat(64));
});
it('lets an explicit override take precedence over the file port', async () => {
  const target = await fixture();
  const other = await fixture();
  fs.writeFileSync(target.file, `MATRON_RESTART_TOKEN=${'a'.repeat(64)}\nMATRON_BRIDGE_API_PORT=${other.port}\n`);
  expect((await target.run()).status).toBe(0);
  expect(target.requests).toHaveLength(1);
  expect(other.requests).toHaveLength(0);
});
it.each([
  'OTHER=1234', 'MATRON_BRIDGE_API_PORT=', 'MATRON_BRIDGE_API_PORT=0',
  'MATRON_BRIDGE_API_PORT=65536', 'MATRON_BRIDGE_API_PORT=080',
  'MATRON_BRIDGE_API_PORT=-1', 'MATRON_BRIDGE_API_PORT=1e3',
  'MATRON_BRIDGE_API_PORT=1234 ', ' MATRON_BRIDGE_API_PORT=1234',
  'MATRON_BRIDGE_API_PORT=$(touch marker)', 'MATRON_BRIDGE_API_PORT=1234\nOTHER=bad',
  '', 'MATRON_BRIDGE_API_PORT=1234\n', 'MATRON_BRIDGE_API_PORT=1234\0ignored',
])('rejects a malformed second line even with a valid override (%j)', async line => {
  const f = await fixture();
  fs.writeFileSync(f.file, `MATRON_RESTART_TOKEN=${'a'.repeat(64)}\n${line}\n`);
  const result = await f.run();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('malformed restart token file');
  expect(f.requests).toHaveLength(0);
  expect(fs.existsSync(path.join(f.root, 'marker'))).toBe(false);
});
it.each([false, true])('accepts a file without its final newline (port line: %s)', async withPort => {
  const f = await fixture();
  fs.writeFileSync(f.file, `MATRON_RESTART_TOKEN=${'a'.repeat(64)}${withPort ? `\nMATRON_BRIDGE_API_PORT=${f.port}` : ''}`);
  expect((await f.run(undefined, { env: withPort ? { MATRON_BRIDGE_API_PORT: '' } : {} })).status).toBe(0);
  expect(f.requests).toHaveLength(1);
});
it('re-reads the file port as well as the token after unauthorized', async () => {
  const target = await fixture();
  const first = await fixture({ statuses: ['401'], rotate: true, rotatedPort: target.port });
  fs.writeFileSync(first.file, `MATRON_RESTART_TOKEN=${'a'.repeat(64)}\nMATRON_BRIDGE_API_PORT=${first.port}\n`);
  const result = await first.run(undefined, { env: { MATRON_BRIDGE_API_PORT: '' } });
  expect(result.status).toBe(0);
  expect(first.requests).toHaveLength(1);
  expect(target.requests).toHaveLength(1);
  expect(target.requests[0].headers['x-matron-restart-token']).toBe('b'.repeat(64));
});
it('sends a JSON request with the token only in a header and prints the response', async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('{"state":"pending"}');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].url).toBe('/restart');
  expect(f.requests[0].headers['x-matron-restart-token']).toBe('a'.repeat(64));
  expect(f.requests[0].body).not.toContain('a'.repeat(64));
  expect(JSON.parse(f.requests[0].body)).toEqual({ reason: 'config "quoted"\nnext', sha: 'c'.repeat(40), request_key: 'alice' });
});
it('refuses invalid arguments', async () => {
  const f = await fixture();
  for (const args of [[], [''], ['config', '--force'], ['config', '--sha'], ['config', '--request-key']]) expect((await f.run(args)).status).toBe(2);
  expect(f.requests).toHaveLength(0);
});

it.each([
  ['--eval=console.log("unexpected")', 'c'.repeat(40), 'alice'],
  ['--eval', 'c'.repeat(40), 'alice'],
  ['--reason', '--sha-value', '--key-value'],
])('preserves leading dash data (%s)', async (reason, sha, requestKey) => {
  const f = await fixture();
  expect((await f.run([reason, '--sha', sha, '--request-key', requestKey])).status).toBe(0);
  expect(JSON.parse(f.requests[0].body)).toEqual({ reason, sha, request_key: requestKey });
});

// Ambient shell state (a changed rc file in a later session) must not reach the script.
function hostile(root) {
  const bin = path.join(root, 'hostile-bin');
  fs.mkdirSync(bin);
  const marker = path.join(root, 'marker');
  for (const name of ['curl', 'node', 'env', 'cat', 'rm', 'mktemp']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name}" >> "${marker}"\nexit 99\n`, { mode: 0o755 });
  }
  const rc = path.join(root, 'bash-env');
  fs.writeFileSync(rc, `echo bash_env >> "${marker}"\n`);
  const names = ['curl', 'node', 'env', 'cat', 'rm', 'mktemp', 'printf', 'exec', 'unset', 'exit', 'builtin', 'command', '[', 'read', 'set', 'declare', 'echo', 'source', 'local'];
  const functions = Object.fromEntries(names.map(name => [`BASH_FUNC_${name}%%`, `() { echo fn_${name} >> "${marker}"; return 99; }`]));
  fs.writeFileSync(path.join(root, '.curlrc'), `header = "X-Injected: 1"\n`);
  return { marker, env: { PATH: `${bin}:/usr/bin:/bin`, BASH_ENV: rc, ENV: rc, ...functions, MATRON_RESTART_CLEAN: '1' } };
}
function markerText(h) { return fs.existsSync(h.marker) ? fs.readFileSync(h.marker, 'utf8') : ''; }
it('ignores a hostile PATH, exported functions, BASH_ENV and curlrc when run directly', async () => {
  const f = await fixture();
  const h = hostile(f.root);
  const result = await f.run(undefined, { env: h.env });
  expect(markerText(h)).toBe('');
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].headers['x-injected']).toBeUndefined();
});
it('ignores a hostile PATH, exported functions and BASH_ENV when started with bash -p', async () => {
  const f = await fixture();
  const h = hostile(f.root);
  const result = await f.run(undefined, { env: h.env, viaBash: 'p' });
  expect(markerText(h)).toBe('');
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
});
it('ignores a hostile PATH and exported functions when started through plain bash', async () => {
  // BASH_ENV in the outer bash cannot be prevented by the script; the re-exec and env -i children are the protection.
  const f = await fixture();
  const h = hostile(f.root);
  delete h.env.BASH_ENV; delete h.env.ENV;
  const result = await f.run(undefined, { env: h.env, viaBash: true });
  expect(markerText(h)).toBe('');
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].headers['x-injected']).toBeUndefined();
});
it.each([undefined, true, 'p'])('does not leak ambient proxy variables to the request (via %s)', async viaBash => {
  const f = await fixture();
  const proxy = 'http://127.0.0.1:1';
  const result = await f.run(undefined, { viaBash, env: { http_proxy: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, all_proxy: proxy } });
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
});
it('a forged canary in the environment alone does not skip the clean re-exec', async () => {
  const f = await fixture();
  const h = hostile(f.root);
  delete h.env.BASH_ENV; delete h.env.ENV;
  const env = { ...h.env, MATRON_RESTART_CANARY: 'forged', http_proxy: 'http://127.0.0.1:1' };
  const result = await f.run(undefined, { viaBash: true, env });
  // A function printf on the success path would have written the marker.
  expect(markerText(h)).toBe('');
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
});
it('a canary forged in both argv and env is the caller own choice: re-exec is skipped, curl still runs under env -i', async () => {
  // argv is chosen by whoever starts the script, so this is not a boundary; pin the behaviour.
  const f = await fixture();
  const marker = path.join(f.root, 'marker');
  const env = {
    'BASH_FUNC_printf%%': `() { echo fn_printf >> "${marker}"; builtin printf "$@"; }`,
    MATRON_RESTART_CANARY: 'forged', http_proxy: 'http://127.0.0.1:1',
  };
  const result = await f.run(['--matron-restart-reexec=forged', 'restart'], { viaBash: true, env });
  expect(result.status).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(JSON.parse(f.requests[0].body).reason).toBe('restart');
  expect(fs.readFileSync(marker, 'utf8')).toContain('fn_printf');
});
it('guards the re-exec with an exit 2 when env or bash is missing', () => {
  expect(fs.readFileSync(script, 'utf8')).toContain("[[ -x /usr/bin/env && -x /bin/bash ]] || { echo 'missing /usr/bin/env or /bin/bash' >&2; exit 2; }");
});
