import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const repo = fileURLToPath(new URL('../', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it.each(['module', 'gate', 'invalid-config'])('leaves existing and absent token files untouched in %s preflight', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-preflight-'));
  roots.push(root);
  const checkout = path.join(root, 'bridge');
  fs.mkdirSync(checkout);
  for (const name of ['index.js', 'package.json', 'mcp-config.json', 'lib', 'bin']) fs.cpSync(path.join(repo, name), path.join(checkout, name), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(checkout, 'node_modules'));
  const server = net.createServer();
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(checkout, '.env'), `JOURNAL_WS_URL=ws://localhost:${port}/ws\nJOURNAL_TOKEN=fixture-only\n`);
  if (mode === 'invalid-config') fs.appendFileSync(path.join(checkout, '.env'), 'MATRON_RESTART_COLLECT_MS=invalid\n');
  for (const existing of [true, false]) {
    const home = fs.mkdtempSync(path.join(root, 'home-'));
    const file = path.join(home, '.matron-bridge-restart.env');
    if (existing) fs.writeFileSync(file, 'sentinel\n');
    const result = await new Promise(resolve => execFile(process.execPath, ['index.js'], {
      cwd: checkout, timeout: 5000, env: { HOME: home, TMPDIR: root, PATH: path.dirname(process.execPath),
        MATRON_BRIDGE_PREFLIGHT: mode === 'invalid-config' ? 'gate' : mode, MATRON_BRIDGE_API_PORT: String(port) },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, output: stdout + stderr })));
    expect(result.status, result.output).toBe(mode === 'invalid-config' ? 1 : 0);
    if (existing) expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null).toBe('sentinel\n');
    else expect(fs.existsSync(file)).toBe(false);
  }
});
