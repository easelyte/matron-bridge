import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// restart.sh on a Mac whose bridge is a launchd service must restart it
// through launchd. Stopping the service's process and starting a copy with
// nohup leaves the bridge outside launchd: launchd does not relaunch after a
// clean exit, so nothing supervises the copy and the next deploy restarts a
// service that can no longer bind the port.
//
// These run a copy of the real script in a scratch directory with stub
// launchctl / systemctl / pkill / pgrep / lsof on PATH, so nothing on the
// machine running the tests is touched.
const RESTART_SH = fileURLToPath(new URL('../restart.sh', import.meta.url));
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const DOMAIN = `gui/${UID}`;

let dir;
let calls;

function stub(name, body) {
  const file = path.join(dir, 'stubs', name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function run({ services = '', kickstartExit = 0, servicePid = '', portPids = '' } = {}) {
  const res = spawnSync('bash', [path.join(dir, 'repo', 'restart.sh')], {
    encoding: 'utf8',
    env: {
      PATH: `${path.join(dir, 'stubs')}:/usr/bin:/bin`,
      HOME: path.join(dir, 'home'),
      CALLS: calls,
      FAKE_LAUNCHD_SERVICES: services,
      FAKE_KICKSTART_EXIT: String(kickstartExit),
      FAKE_SERVICE_PID: String(servicePid),
      FAKE_PORT_PIDS: String(portPids),
    },
  });
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
  return { ...res, log };
}

describe.skipIf(process.platform === 'win32')('restart.sh on a launchd install', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-sh-'));
    calls = path.join(dir, 'calls.log');
    for (const d of ['stubs', 'home', 'repo/bin']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.copyFileSync(RESTART_SH, path.join(dir, 'repo', 'restart.sh'));

    // The bridge itself: record the start and stay alive long enough for the
    // script's "did it start?" check.
    const bridge = path.join(dir, 'repo', 'bin', 'run-named-node');
    fs.writeFileSync(bridge, '#!/bin/sh\necho "bridge-started $*" >> "$CALLS"\nexec /bin/sleep 2\n');
    fs.chmodSync(bridge, 0o755);

    // No systemd unit, nothing running, nothing on the port.
    stub('systemctl', 'exit 1');
    stub('pkill', 'exit 1');
    stub('pgrep', 'exit 1');
    stub('lsof', 'exit 1');
    stub('sleep', 'exit 0');
    // launchd knows the services listed in FAKE_LAUNCHD_SERVICES.
    stub('launchctl', [
      'case "$1" in',
      '  print)',
      '    for s in $FAKE_LAUNCHD_SERVICES; do [ "$s" = "$2" ] && { [ -n "$FAKE_SERVICE_PID" ] && echo "	pid = $FAKE_SERVICE_PID"; exit 0; }; done',
      '    exit 113 ;;',
      '  kickstart) exit "$FAKE_KICKSTART_EXIT" ;;',
      'esac',
      'exit 0',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restarts the installed service through launchd and starts no copy of its own', () => {
    const target = `${DOMAIN}/chat.matron.matron-bridge`;
    const res = run({ services: target });

    expect(res.log).toContain(`launchctl kickstart -k ${target}`);
    expect(res.log.filter((l) => l.startsWith('bridge-started'))).toEqual([]);
    expect(res.log.filter((l) => l.startsWith('pkill'))).toEqual([]);
    expect(res.status).toBe(0);
  });

  it('finds a service installed under the older label', () => {
    const target = `${DOMAIN}/chat.matron.claude-matrix-bridge`;
    const res = run({ services: target });

    expect(res.log).toContain(`launchctl kickstart -k ${target}`);
    expect(res.log.filter((l) => l.startsWith('bridge-started'))).toEqual([]);
    expect(res.status).toBe(0);
  });

  it('fails without starting a copy when launchd refuses the restart', () => {
    const target = `${DOMAIN}/chat.matron.matron-bridge`;
    const res = run({ services: target, kickstartExit: 1 });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(target);
    expect(res.log.filter((l) => l.startsWith('bridge-started'))).toEqual([]);
    expect(res.log.filter((l) => l.startsWith('pkill'))).toEqual([]);
  });

  it('stops a copy left outside launchd on the port, but not the service, before the restart', async () => {
    const idle = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const leftover = idle();
    const service = idle();
    try {
      const leftoverGone = new Promise((resolve) => leftover.once('exit', resolve));
      // lsof reports both pids on the port; launchd says which is the service.
      stub('lsof', 'for p in $FAKE_PORT_PIDS; do echo "$p"; done');
      const target = `${DOMAIN}/chat.matron.matron-bridge`;
      const res = run({ services: target, servicePid: service.pid, portPids: `${leftover.pid} ${service.pid}` });

      expect(res.status).toBe(0);
      expect(res.log).toContain(`launchctl kickstart -k ${target}`);
      await leftoverGone;
      expect(leftover.signalCode).toBe('SIGTERM');
      expect(service.exitCode).toBeNull();
      expect(service.signalCode).toBeNull();
    } finally {
      leftover.kill();
      service.kill();
    }
  }, 15_000);

  it('still starts the bridge itself when no launchd service is installed', () => {
    const res = run({ services: '' });

    expect(res.log.filter((l) => l.startsWith('launchctl kickstart'))).toEqual([]);
    // The script starts the bridge in the background and (with `sleep`
    // stubbed) can return before the bridge has recorded its start.
    const started = 'bridge-started matron-bridge index.js';
    const readLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n') : []);
    for (let i = 0; i < 100 && !readLog().includes(started); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    expect(readLog()).toContain(started);
    expect(res.status).toBe(0);
  });
});
