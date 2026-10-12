import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import childProcess, { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { probeConfinement, startBridge, supervise } from './helpers/bridge-process.js';

it('requires a successful namespace launch even when bwrap version succeeds', () => {
  let status = 1;
  const run = vi.fn((command, args) => ({ status: args.includes('--version') ? 0 : status }));
  expect(probeConfinement(run)).toBe(false);
  status = null; // Missing binary, signal or timeout.
  expect(probeConfinement(run)).toBe(false);
  status = 0;
  expect(probeConfinement(run)).toBe(true);
  expect(run).toHaveBeenCalledWith('bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true'],
    { env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 1000 });
});

it.each([true, false])('keeps the literal /tmp sweep inert (confine=%s)', async confine => {
  const error = new Error('harness launch intercepted');
  let env;
  // Inspect the actual spawn options without booting a sweep, even on red.
  const launch = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
    env = options.env;
    throw error;
  });
  try {
    await expect(startBridge({ confine })).rejects.toThrow(error.message);
    const ttl = Number.parseInt(env.MATRON_LIVE_OUTPUT_TTL, 10);
    expect(Number.isInteger(ttl)).toBe(true);
    expect(ttl).toBeGreaterThanOrEqual(31536000);
  } finally {
    launch.mockRestore();
  }
}, 15000);

describe('fake bridge supervisor', () => {
  function fixture() {
    const children = [];
    const supervisor = supervise(() => {
      const child = new EventEmitter();
      child.kill = signal => child.emit('exit', null, signal);
      children.push(child);
      return child;
    });
    return { supervisor, children };
  }

  it('counts launches and relaunches on exit 75', () => {
    const { supervisor, children } = fixture();
    expect(supervisor.launches).toBe(1);
    children[0].emit('exit', 75, null);
    expect(supervisor.launches).toBe(2);
    expect(supervisor.child).toBe(children[1]);
    expect(supervisor.exits).toEqual([{ code: 75, signal: null }]);
    supervisor.stop();
  });

  it.each([0, 74, 76, 1, null])('does not relaunch on exit %s', code => {
    const { supervisor, children } = fixture();
    children[0].emit('exit', code, code === null ? 'SIGTERM' : null);
    expect(supervisor.exits).toHaveLength(1);
    expect(supervisor.launches).toBe(1);
    supervisor.stop();
  });

  it('stopping suppresses a pending exit-75 relaunch', () => {
    const { supervisor, children } = fixture();
    children[0].kill = () => {};
    supervisor.stop();
    children[0].emit('exit', 75, null);
    expect(supervisor.exits).toHaveLength(1);
    expect(supervisor.launches).toBe(1);
  });
});

function processTable(home) {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,stat='], {
    encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' },
  }).trim().split('\n').map(line => {
    const [pid, ppid, stat] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), stat };
  });
}

it.each(['auto', 'fallback'])('boots, sees hello, starts a stub session and exits 0 on SIGTERM (%s)', async mode => {
  const fallback = mode === 'fallback';
  const originalCopy = fs.cpSync;
  // A child outside session bookkeeping must also die with the fallback group.
  const copy = fallback && vi.spyOn(fs, 'cpSync').mockImplementation((source, target, options) => {
    originalCopy(source, target, options);
    if (path.basename(source) === 'index.js') fs.appendFileSync(target, `
const { spawn: harnessSpawn } = await import('node:child_process');
harnessSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  env: process.env, stdio: 'ignore',
});
`);
  });
  let bridge;
  try {
    bridge = await startBridge({ confine: !fallback });
  } finally {
    if (copy) copy.mockRestore();
  }
  try {
    expect(bridge.ready).toBe(true);
    if (fallback) {
      expect(bridge.supervisor.child.spawnargs[0]).toBe(process.execPath);
      expect(bridge.confined).toBe(false);
    }
    if (bridge.confined) {
      expect(bridge.output).toContain('harness: real repo write refused');
      expect(bridge.output).toContain('harness: outside HOME write refused');
      expect(bridge.supervisor.child.spawnargs).toContain('--unshare-pid');
      expect(bridge.supervisor.child.spawnargs).toContain('--ro-bind');
    }
    expect(bridge.port).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(bridge.checkout, '.mcp-config-generated.json'))).toBe(true);
    expect(bridge.frames.some(frame => frame.op === 'hello')).toBe(true);
    const session = await bridge.startSession();
    expect(session.alive).toBe(true);
    expect(session.workdir.startsWith(bridge.home)).toBe(true);
    expect(await bridge.echo('harness smoke')).toContain('echo: harness smoke');
    const descendants = new Set([bridge.supervisor.child.pid]);
    if (fallback) {
      const table = processTable(bridge.home);
      let size;
      do {
        size = descendants.size;
        for (const row of table) if (descendants.has(row.ppid)) descendants.add(row.pid);
      } while (descendants.size !== size);
      expect(descendants.size).toBeGreaterThan(2); // bridge, extra child, stub session
    }
    const exit = await bridge.terminate();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(bridge.supervisor.launches).toBe(1);
    if (fallback) {
      await vi.waitFor(() => {
        const live = processTable(bridge.home).filter(row => descendants.has(row.pid) && !row.stat.startsWith('Z'));
        expect(live.map(row => row.pid)).toEqual([]);
      }, { timeout: 3000, interval: 50 });
    }
  } finally {
    // Test-owned group only; also clean up when testing a broken group-kill mutation.
    if (fallback && bridge.supervisor.child.spawnargs[0] === process.execPath) {
      try { process.kill(-bridge.supervisor.child.pid, 'SIGKILL'); } catch (error) {
        expect(error.code).toBe('ESRCH');
      }
    }
    await bridge.close();
    expect(fs.existsSync(bridge.home)).toBe(false);
  }
}, 20000);

// These faults affect only the disposable source copy, before any real boot.
it.each(['ENOENT', 'EACCES', 'EIO'])('refuses source-copy failure %s and cleans HOME', async code => {
  const error = Object.assign(new Error(`fixture ${code}`), { code });
  const homes = vi.spyOn(fs, 'mkdtempSync');
  const copy = vi.spyOn(fs, 'cpSync').mockImplementationOnce(() => { throw error; });
  try {
    await expect(startBridge()).rejects.toThrow(`fixture ${code}`);
    expect(fs.existsSync(homes.mock.results[0].value)).toBe(false);
  } finally {
    copy.mockRestore();
    homes.mockRestore();
  }
});

it('refuses boot timeout and cleans HOME', async () => {
  let resolved;
  const originalCopy = fs.cpSync;
  const homes = vi.spyOn(fs, 'mkdtempSync');
  const copy = vi.spyOn(fs, 'cpSync').mockImplementation((source, target, options) => {
    if (path.basename(source) === 'index.js') {
      fs.writeFileSync(target, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n");
    } else {
      originalCopy(source, target, options);
    }
  });
  try {
    await expect(startBridge().then(bridge => { resolved = bridge; return bridge; })).rejects.toThrow('bridge harness timed out:');
    expect(fs.existsSync(homes.mock.results[0].value)).toBe(false);
  } finally {
    await resolved?.close();
    copy.mockRestore();
    homes.mockRestore();
  }
}, 15000);
