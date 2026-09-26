import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OPS_SECTIONS, OPS_RESULT_MAX_BYTES, processName, splitCommand, parseCpuLine, parseProcPidStat,
  parseMeminfo, parsePasswd, fitToBudget, detectPageSize, readHostSection, runOpsCommand, createOpsSnapshot, OpsError,
} from '../lib/ops-snapshot.js';

describe('processName (contract §2.1: never the full command line)', () => {
  it('uses the argv0 basename for ordinary binaries', () => {
    expect(processName(['/usr/bin/claude', '--print', '--api-key', 'sk-secret'])).toBe('claude');
    expect(processName(['codex', 'exec', 'do the secret thing'])).toBe('codex');
    expect(processName(['/usr/sbin/nginx', '-g', 'daemon off;'])).toBe('nginx');
  });

  it('cuts setproctitle-style argv0 at the first space or colon', () => {
    expect(processName(['sshd: root@pts/0'])).toBe('sshd');
    expect(processName(['postgres: checkpointer'])).toBe('postgres');
    expect(processName(['nginx: worker process'])).toBe('nginx');
  });

  it('adds the script basename for interpreters', () => {
    expect(processName(['node', '/opt/matron/bridge-journal/index.js'])).toBe('node index.js');
    expect(processName(['/usr/bin/python3', '-u', '/root/x/watchdog.py', '--token', 'abc'])).toBe('python3 watchdog.py');
    expect(processName(['python3.12', 'app.py'])).toBe('python3.12 app.py');
    expect(processName(['/usr/bin/bash', '/root/scripts/run.sh', 'secret'])).toBe('bash run.sh');
    expect(processName(['sh', '-e', '/x/y.sh'])).toBe('sh y.sh');
    expect(processName(['node', '/usr/bin/codex', 'exec', 'prompt text'])).toBe('node codex');
  });

  it('never names a flag operand (review F1): only provable script paths', () => {
    expect(processName(['python3', '-W', 'ignore:sk_live_123', '/srv/worker.py'])).toBe('python3 worker.py');
    expect(processName(['python3', '-W', 'ignore:sk_live_123'])).toBe('python3');
    expect(processName(['node', '--token', 'sk_live_abc', 'arg2'])).toBe('node');
    expect(processName(['node', '--max-old-space-size', '4096', '/w/server.mjs'])).toBe('node server.mjs');
    expect(processName(['node', '-r', 'dotenv/config', 'sk-secret'])).toBe('node');
    expect(processName(['python3', 'ignore:sk_live_123'])).toBe('python3');
    expect(processName(['python3', '-m', 'sk live'])).toBe('python3');
    expect(processName(['bash', 'secret words'])).toBe('bash');
  });

  it('skips a bun/deno `run` subcommand', () => {
    expect(processName(['bun', 'run', 'server.ts'])).toBe('bun server.ts');
    expect(processName(['deno', 'run', '-A', '/w/main.ts'])).toBe('deno main.ts');
  });

  it('never appends inline code (-c / -e / --eval / -p / --print)', () => {
    expect(processName(['bash', '-c', 'curl -H "Authorization: Bearer sk-live" x'])).toBe('bash');
    expect(processName(['/usr/bin/bash', '-lc', 'export TOKEN=abc; run'])).toBe('bash');
    expect(processName(['node', '-e', 'require("x")("secret")'])).toBe('node');
    expect(processName(['node', '--eval=console.log(1)'])).toBe('node');
    expect(processName(['python3', '-c', 'print(1)'])).toBe('python3');
    expect(processName(['node', '-p', '1+1'])).toBe('node');
  });

  it('refuses a candidate carrying = or whitespace (not a script path)', () => {
    expect(processName(['node', 'KEY=value'])).toBe('node');
    expect(processName(['python3', 'a b c'])).toBe('python3');
  });

  it('falls back to comm when cmdline is empty (kernel threads, zombies)', () => {
    expect(processName([], 'kworker/0:1')).toBe('kworker/0:1');
    expect(processName(null, null)).toBe('?');
  });

  it('caps at 48 chars and strips control characters', () => {
    const long = `/x/${'a'.repeat(80)}`;
    expect(processName([long])).toHaveLength(48);
    expect(processName(['evil\u0007name'])).toBe('evilname');
  });
});

describe('splitCommand', () => {
  it('splits on whitespace, no shell semantics', () => {
    expect(splitCommand('  python3   /w/ops_snapshot.py  ')).toEqual(['python3', '/w/ops_snapshot.py']);
    expect(splitCommand('a;rm -rf / $(x)')).toEqual(['a;rm', '-rf', '/', '$(x)']);
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand(undefined)).toEqual([]);
  });
});

describe('/proc parsers', () => {
  it('parseCpuLine sums user..steal and treats idle+iowait as idle', () => {
    expect(parseCpuLine('cpu  100 5 50 800 40 1 4 0 0 0\ncpu0 1 1 1 1')).toEqual({ total: 1000, idle: 840 });
    expect(parseCpuLine('garbage')).toBeNull();
  });

  it('parseProcPidStat handles comm with spaces and parens', () => {
    const rest = 'S 1 1 1 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 100 1000000 2560';
    expect(parseProcPidStat(`42 (my (weird) proc) ${rest}`)).toEqual({ comm: 'my (weird) proc', ticks: 200, rssPages: 2560 });
    expect(parseProcPidStat('bad')).toBeNull();
  });

  it('parseMeminfo returns bytes', () => {
    const m = parseMeminfo('MemTotal:       1000 kB\nMemAvailable:    400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
    expect(m).toEqual({ MemTotal: 1_024_000, MemAvailable: 409_600, SwapTotal: 0, SwapFree: 0 });
  });

  it('parsePasswd maps uid -> name', () => {
    const p = parsePasswd('root:x:0:0:root:/root:/bin/bash\nbad line\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n');
    expect(p.get(0)).toBe('root');
    expect(p.get(33)).toBe('www-data');
    expect(p.size).toBe(2);
  });
});

describe('fitToBudget (contract §2 byte budget)', () => {
  const env = (data) => ({ section: 'timers', generated_at_ms: 1, truncated: false, data });
  const size = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

  it('passes an in-budget result through untouched', () => {
    const r = env({ timers: [{ a: 1 }] });
    expect(fitToBudget(r, 12_000)).toEqual(r);
  });

  it('drops trailing elements of the longest array until it fits and sets truncated', () => {
    const timers = Array.from({ length: 400 }, (_, i) => ({ unit: `unit-${i}.timer`, pad: 'x'.repeat(40) }));
    const cron = [{ schedule: '* * * * *', label: 'a' }];
    const out = fitToBudget(env({ timers, cron }), 12_000);
    expect(out.truncated).toBe(true);
    expect(size(out)).toBeLessThanOrEqual(12_000);
    expect(out.data.cron).toEqual(cron);
    expect(out.data.timers[0].unit).toBe('unit-0.timer'); // leading elements kept
    expect(out.data.timers.length).toBeGreaterThan(50);
  });

  it('recurses into nested arrays', () => {
    const inner = Array.from({ length: 500 }, (_, i) => `item-${i}-${'y'.repeat(30)}`);
    const out = fitToBudget(env({ security: { actions: inner }, other: [1, 2] }), 2_000);
    expect(out.truncated).toBe(true);
    expect(size(out)).toBeLessThanOrEqual(2_000);
    expect(out.data.other).toEqual([1, 2]);
  });

  it('returns null when nothing trimmable remains (too_large)', () => {
    expect(fitToBudget(env({ blob: 'z'.repeat(20_000) }), 12_000)).toBeNull();
  });

  it('does not mutate its input', () => {
    const data = { list: Array.from({ length: 1000 }, (_, i) => i) };
    fitToBudget(env(data), 500);
    expect(data.list).toHaveLength(1000);
  });

  it('counts bytes, not characters', () => {
    const list = Array.from({ length: 100 }, () => 'é'.repeat(50));
    const out = fitToBudget(env({ list }), 3_000);
    expect(size(out)).toBeLessThanOrEqual(3_000);
  });
});

// ---------------------------------------------------------------------------
// readHostSection against a fake /proc

function fakeProc() {
  // two phases: before and after the sample sleep
  const stat = (ticks, rss) => `S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 100 1000000 ${rss}`;
  const MB = 256; // pages per MiB at 4 KiB
  const phase = [
    {
      '/proc/stat': 'cpu  1000 0 0 9000 0 0 0 0 0 0\n',
      '/proc/10/stat': `10 (claude) ${stat(100, 200 * MB)}`,
      '/proc/11/stat': `11 (node) ${stat(500, 100 * MB)}`,
      '/proc/12/stat': `12 (tiny) ${stat(0, 1 * MB)}`,
      '/proc/13/stat': `13 (busy) ${stat(0, 1 * MB)}`,
      '/proc/14/stat': `14 (gone) ${stat(0, 50 * MB)}`,
    },
    {
      '/proc/stat': 'cpu  1400 0 0 9600 0 0 0 0 0 0\n', // dtotal 1000, didle 600 -> 40%
      '/proc/10/stat': `10 (claude) ${stat(150, 200 * MB)}`,  // 50 of 1000 * 4 cores -> 20%
      '/proc/11/stat': `11 (node) ${stat(500, 100 * MB)}`,
      '/proc/12/stat': `12 (tiny) ${stat(0, 1 * MB)}`,
      '/proc/13/stat': `13 (busy) ${stat(10, 1 * MB)}`,       // 4% -> kept despite small rss
      '/proc/15/stat': `15 (codex) ${stat(0, 30 * MB)}`,      // new in phase 2
    },
  ];
  const common = {
    '/proc/uptime': '12345.67 99999.00\n',
    '/proc/loadavg': '0.50 0.40 0.30 1/200 999\n',
    '/proc/meminfo': 'MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 1000 kB\nSwapFree: 500 kB\n',
    '/proc/10/cmdline': '/usr/bin/claude\0--print\0--system-prompt\0SECRET PROMPT\0',
    '/proc/11/cmdline': 'node\0/opt/matron/bridge-journal/index.js\0',
    '/proc/12/cmdline': 'tiny\0',
    '/proc/13/cmdline': 'bash\0-c\0echo $TOKEN\0',
    '/proc/15/cmdline': '/usr/lib/codex/codex\0exec\0secret\0',
    '/proc/10/status': 'Name:\tclaude\nUid:\t0\t0\t0\t0\nVmRSS:\t204800 kB\n',
    '/proc/11/status': 'Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t102400 kB\n',
    '/proc/13/status': 'Name:\tbash\nUid:\t4242\t4242\t4242\t4242\nVmRSS:\t1024 kB\n',
    '/proc/15/status': 'Name:\tcodex\nUid:\t0\t0\t0\t0\nVmRSS:\t30720 kB\n',
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/bash\ndan:x:1000:1000::/home/dan:/bin/bash\n',
  };
  let p = 0;
  const readText = async (file) => {
    const v = file in phase[p] ? phase[p][file] : common[file];
    if (v === undefined) { const e = new Error(`ENOENT ${file}`); e.code = 'ENOENT'; throw e; }
    return v;
  };
  const listPids = async () => Object.keys(phase[p]).map((k) => k.match(/^\/proc\/(\d+)\/stat$/)?.[1]).filter(Boolean);
  const sleep = vi.fn(async () => { p = 1; });
  return { readText, listPids, sleep };
}

describe('readHostSection', () => {
  const baseDeps = (f, over = {}) => ({
    readText: f.readText, listPids: f.listPids, sleep: f.sleep,
    hostname: () => 'box-a', cpuCores: () => 4,
    getDisk: () => ({ path: '/w', free_bytes: 10, total_bytes: 100 }),
    getLiveSessions: () => 3,
    ...over,
  });

  it('builds the §2.1 shape from a two-point sample', async () => {
    const f = fakeProc();
    const h = await readHostSection(baseDeps(f));
    expect(f.sleep).toHaveBeenCalledWith(300);
    expect(h.hostname).toBe('box-a');
    expect(h.cpu_cores).toBe(4);
    expect(h.uptime_s).toBe(12345);
    expect(h.load).toEqual([0.5, 0.4, 0.3]);
    expect(h.cpu_pct).toBe(40);
    expect(h.memory).toEqual({ total_bytes: 8_192_000_000, available_bytes: 2_048_000_000 });
    expect(h.swap).toEqual({ total_bytes: 1_024_000, free_bytes: 512_000 });
    expect(h.disk).toEqual({ path: '/w', free_bytes: 10, total_bytes: 100 });
    expect(h.live_sessions).toBe(3);
    expect(h.agents).toEqual({ claude: 1, codex: 1 });
  });

  it('lists processes by RSS with sanitized names, per-call cpu, and user lookup', async () => {
    const h = await readHostSection(baseDeps(fakeProc()));
    expect(h.processes.map((p) => p.pid)).toEqual([10, 11, 15, 13]); // 12 dropped (small+idle), 14 vanished
    expect(h.processes[0]).toEqual({ pid: 10, name: 'claude', rss_bytes: 204_800 * 1024, cpu_pct: 20, user: 'root' });
    expect(h.processes[1]).toMatchObject({ name: 'node index.js', cpu_pct: 0, user: 'dan' });
    expect(h.processes[2]).toMatchObject({ name: 'codex', cpu_pct: 0 }); // no baseline -> 0, not garbage
    expect(h.processes[3]).toMatchObject({ name: 'bash', cpu_pct: 4, user: null });
    expect(JSON.stringify(h)).not.toMatch(/SECRET|TOKEN|secret/);
  });

  it('detects the kernel page size so 64 KiB-page hosts keep their processes (review F2)', async () => {
    const f = fakeProc();
    const readText = async (file) => {
      if (file === '/proc/self/stat') return '1 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 1000000 320';
      if (file === '/proc/self/status') return 'VmRSS:\t20480 kB\n';
      return f.readText(file);
    };
    expect(await detectPageSize(readText)).toBe(65536);
    expect(await detectPageSize(f.readText)).toBe(4096);
    // 1 MiB of 4 KiB pages is 256 pages; at 64 KiB the same count reads 16 MiB.
    const h = await readHostSection(baseDeps(f, { readText }));
    expect(h.processes.map((p) => p.pid)).toContain(12);
  });

  it('caps the process list at 12', async () => {
    const f = fakeProc();
    const many = {};
    for (let i = 100; i < 130; i++) {
      many[`/proc/${i}/stat`] = `${i} (p) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 1000000 ${2560 + i}`;
      many[`/proc/${i}/cmdline`] = `p${i}\0`;
    }
    const readText = async (file) => (file in many ? many[file] : f.readText(file));
    const listPids = async () => [...(await f.listPids()), ...Object.keys(many).filter((k) => k.endsWith('/stat')).map((k) => k.split('/')[2])];
    const h = await readHostSection(baseDeps(f, { readText, listPids }));
    expect(h.processes).toHaveLength(12);
  });

  it('throws OpsError unavailable without /proc', async () => {
    const readText = async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    await expect(readHostSection(baseDeps(fakeProc(), { readText }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('degrades optional pieces to null instead of failing', async () => {
    const h = await readHostSection(baseDeps(fakeProc(), { getDisk: () => { throw new Error('x'); }, getLiveSessions: () => null }));
    expect(h.disk).toBeNull();
    expect(h.live_sessions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runOpsCommand with a stubbed spawn

function fakeSpawn(behaviour) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = vi.fn(() => { setImmediate(() => child.emit('close', null, 'SIGKILL')); });
    setImmediate(() => behaviour(child));
    return child;
  };
  return { impl, calls };
}

describe('runOpsCommand', () => {
  const run = (behaviour, over = {}) => {
    const s = fakeSpawn(behaviour);
    const p = runOpsCommand({
      argv: ['python3', '/w/ops_snapshot.py'], section: 'timers', cwd: '/w',
      env: { PATH: '/bin', JOURNAL_TOKEN: 'tok', JOURNAL_TOKEN_FILE: '/f', HMAC_SECRET: 'h' },
      spawnImpl: s.impl, ...over,
    });
    return { p, calls: s.calls };
  };

  it('spawns argv + --section without a shell, stderr discarded, journal creds stripped', async () => {
    const { p, calls } = run((c) => { c.stdout.emit('data', Buffer.from('{"section":"timers","data":{"timers":[]}}')); c.emit('close', 0, null); });
    await expect(p).resolves.toEqual({ timers: [] });
    expect(calls[0].cmd).toBe('python3');
    expect(calls[0].args).toEqual(['/w/ops_snapshot.py', '--section', 'timers']);
    expect(calls[0].opts.shell).toBe(false);
    expect(calls[0].opts.cwd).toBe('/w');
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'ignore']);
    expect(calls[0].opts.env).toEqual({ PATH: '/bin' });
  });

  it('non-zero exit -> unavailable', async () => {
    const { p } = run((c) => c.emit('close', 3, null));
    await expect(p).rejects.toMatchObject({ code: 'unavailable', detail: 'command exited 3' });
  });

  it('spawn error -> unavailable, no error text leaked', async () => {
    const { p } = run((c) => c.emit('error', new Error('ENOENT: /secret/path')));
    await expect(p).rejects.toMatchObject({ code: 'unavailable', detail: 'command failed to start' });
  });

  it('invalid JSON -> unavailable', async () => {
    const { p } = run((c) => { c.stdout.emit('data', Buffer.from('not json')); c.emit('close', 0, null); });
    await expect(p).rejects.toMatchObject({ code: 'unavailable', detail: 'invalid JSON' });
  });

  it('wrong section or non-object data -> unavailable', async () => {
    const a = run((c) => { c.stdout.emit('data', Buffer.from('{"section":"alerts","data":{}}')); c.emit('close', 0, null); });
    await expect(a.p).rejects.toMatchObject({ code: 'unavailable', detail: 'unexpected output shape' });
    const b = run((c) => { c.stdout.emit('data', Buffer.from('{"section":"timers","data":[1]}')); c.emit('close', 0, null); });
    await expect(b.p).rejects.toMatchObject({ code: 'unavailable', detail: 'unexpected output shape' });
  });

  it('stdout over the cap -> killed, unavailable', async () => {
    let child;
    const { p } = run((c) => { child = c; c.stdout.emit('data', Buffer.alloc(300 * 1024, 0x20)); }, { maxBytes: 256 * 1024 });
    await expect(p).rejects.toMatchObject({ code: 'unavailable', detail: 'output too large' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('timeout -> killed, unavailable', async () => {
    let child;
    const { p } = run((c) => { child = c; }, { timeoutMs: 20 });
    await expect(p).rejects.toMatchObject({ code: 'unavailable', detail: 'timed out' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('empty argv -> not_configured', async () => {
    await expect(runOpsCommand({ argv: [], section: 'timers', cwd: '/w', env: {}, spawnImpl: () => { throw new Error('no'); } }))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});

// ---------------------------------------------------------------------------
// createOpsSnapshot: dispatch, errors, cache, budget

describe('createOpsSnapshot', () => {
  const mk = (over = {}) => {
    let t = 1_000_000;
    const readHost = vi.fn(async () => ({ hostname: 'h', processes: [] }));
    const runCommand = vi.fn(async ({ section }) => ({ section, rows: [1, 2] }));
    const snap = createOpsSnapshot({ command: 'python3 /w/x.py', cwd: '/w', readHost, runCommand, now: () => t, ...over });
    return { snap, readHost, runCommand, advance: (ms) => { t += ms; } };
  };

  it('exposes the five sections', () => {
    expect(OPS_SECTIONS).toEqual(['host', 'timers', 'alerts', 'usage', 'posture']);
    expect(OPS_RESULT_MAX_BYTES).toBe(12_000);
  });

  it('bad_request for missing / unknown / non-string / prototype sections', async () => {
    const { snap } = mk();
    for (const s of [undefined, '', 'nope', 7, 'constructor', '__proto__']) {
      await expect(snap(s)).resolves.toEqual({ ok: false, error: { code: 'bad_request', detail: 'unknown section' } });
    }
  });

  it('host: wraps the reader output in the envelope', async () => {
    const { snap } = mk();
    await expect(snap('host')).resolves.toEqual({
      ok: true, result: { section: 'host', generated_at_ms: 1_000_000, truncated: false, data: { hostname: 'h', processes: [] } },
    });
  });

  it('host: OpsError from the reader maps to its code', async () => {
    const { snap } = mk({ readHost: async () => { throw new OpsError('unavailable', 'no /proc'); } });
    await expect(snap('host')).resolves.toEqual({ ok: false, error: { code: 'unavailable', detail: 'no /proc' } });
  });

  it('extras: not_configured when the command is unset/blank', async () => {
    for (const command of [undefined, '', '   ']) {
      const { snap, runCommand } = mk({ command });
      await expect(snap('timers')).resolves.toEqual({ ok: false, error: { code: 'not_configured', detail: 'MATRON_OPS_SNAPSHOT_CMD is not set' } });
      expect(runCommand).not.toHaveBeenCalled();
    }
  });

  it('extras: runs the command with split argv + cwd and wraps data', async () => {
    const { snap, runCommand } = mk();
    const r = await snap('alerts');
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ argv: ['python3', '/w/x.py'], section: 'alerts', cwd: '/w' }));
    expect(r).toEqual({ ok: true, result: { section: 'alerts', generated_at_ms: 1_000_000, truncated: false, data: { section: 'alerts', rows: [1, 2] } } });
  });

  it('extras failures map to their code and are not cached', async () => {
    const runCommand = vi.fn()
      .mockRejectedValueOnce(new OpsError('unavailable', 'timed out'))
      .mockResolvedValueOnce({ ok: 1 });
    const { snap } = mk({ runCommand });
    await expect(snap('usage')).resolves.toEqual({ ok: false, error: { code: 'unavailable', detail: 'timed out' } });
    await expect(snap('usage')).resolves.toMatchObject({ ok: true });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('an unexpected throw maps to unavailable with a generic detail', async () => {
    const { snap } = mk({ runCommand: async () => { throw new Error('/secret/path exploded'); } });
    await expect(snap('usage')).resolves.toEqual({ ok: false, error: { code: 'unavailable', detail: 'snapshot failed' } });
  });

  it('caches per section for 15 s and coalesces concurrent calls', async () => {
    const { snap, runCommand, readHost, advance } = mk();
    const [a, b] = await Promise.all([snap('timers'), snap('timers')]);
    expect(a).toEqual(b);
    await snap('posture');
    expect(runCommand).toHaveBeenCalledTimes(2);
    advance(14_999);
    await snap('timers');
    expect(runCommand).toHaveBeenCalledTimes(2);
    advance(1);
    await snap('timers');
    expect(runCommand).toHaveBeenCalledTimes(3);
    await snap('host'); await snap('host');
    expect(readHost).toHaveBeenCalledTimes(1);
  });

  it('applies the byte budget: truncates, or too_large when it cannot fit', async () => {
    const big = { timers: Array.from({ length: 1000 }, (_, i) => ({ unit: `u${i}`, pad: 'p'.repeat(30) })) };
    const { snap } = mk({ runCommand: async () => big });
    const r = await snap('timers');
    expect(r.ok).toBe(true);
    expect(r.result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.result))).toBeLessThanOrEqual(12_000);
    const { snap: snap2 } = mk({ runCommand: async () => ({ blob: 'z'.repeat(20_000) }) });
    await expect(snap2('usage')).resolves.toEqual({ ok: false, error: { code: 'too_large', detail: 'result exceeds 12000 bytes' } });
  });
});
