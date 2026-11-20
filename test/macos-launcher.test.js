// "Matron Bridge.app" (macos/launcher): the bundle's static files everywhere,
// and on a Mac with a Swift toolchain, the launcher's process behaviour and
// the plist setup/service-macos.sh writes for it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const SOURCE = path.join(root, 'macos/launcher/Sources/MatronBridgeLauncher/main.swift');

const onMac = process.platform === 'darwin';
const hasSwift = onMac && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;

describe('macos/launcher bundle files', () => {
  it('Info.plist names the app, hides it from the Dock and explains Apple Events', () => {
    const info = read('macos/launcher/Info.plist');
    expect(info).toMatch(/<key>CFBundleIdentifier<\/key>\s*<string>chat\.matron\.bridge<\/string>/);
    expect(info).toMatch(/<key>CFBundleName<\/key>\s*<string>Matron Bridge<\/string>/);
    expect(info).toMatch(/<key>CFBundleExecutable<\/key>\s*<string>matron-bridge-launcher<\/string>/);
    expect(info).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
    expect(info).toMatch(/<key>NSAppleEventsUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  });

  it('asks for Apple Events and nothing else', () => {
    const ent = read('macos/launcher/launcher.entitlements');
    const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(['com.apple.security.automation.apple-events']);
  });

  it('spawns the bridge and never execs it', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    expect(src).toContain('posix_spawn(&pid');
    expect(src).not.toMatch(/\bexecv?p?e?\(/);
    expect(src).not.toMatch(/disclaim\(/);
  });

  it('the service plist runs the app directly, never through open', () => {
    const svc = read('setup/service-macos.sh');
    const block = svc.slice(svc.indexOf('program_arguments() {'), svc.indexOf('write_plist() {'));
    expect(block).toContain('<string>$(xml_escape "$LAUNCHER_BIN")</string>');
    expect(block).toContain('<key>AssociatedBundleIdentifiers</key>');
    expect(block).not.toMatch(/\bopen\b/);
  });
});

describe.runIf(hasSwift)('matron-bridge-launcher process behaviour', () => {
  let tmp;
  let launcher;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-launcher-')));
    launcher = path.join(tmp, 'matron-bridge-launcher');
    const res = spawnSync('xcrun', ['swiftc', '-O', SOURCE, '-o', launcher], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`swiftc failed: ${res.stderr}`);
  }, 180_000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A stand-in checkout whose bin/run-named-node is the given sh body.
  function repo(name, body) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'run-named-node'), body);
    return dir;
  }

  it('runs run-named-node with the bridge name and script, and passes the exit code through', () => {
    const dir = repo('exit75', 'printf "%s|%s\\n" "$1" "$2"; exit 75\n');
    const res = spawnSync(launcher, [dir], { encoding: 'utf8' });
    expect(res.stdout).toBe(`matron-bridge|${dir}/index.js\n`);
    expect(res.status).toBe(75);
  });

  it('passes SIGTERM on to the bridge and exits as it does', async () => {
    const dir = repo('term', "trap 'echo got-term; exit 0' TERM\necho ready\nwhile :; do sleep 0.05; done\n");
    const child = spawn(launcher, [dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    await new Promise((resolve) => child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('ready')) resolve();
    }));
    child.kill('SIGTERM');
    const [code, signal] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    expect(out).toContain('got-term');
    expect([code, signal]).toEqual([0, null]);
  });

  it('dies of the same signal when the bridge is killed', () => {
    const dir = repo('killed', 'kill -KILL $$\n');
    const res = spawnSync(launcher, [dir], { encoding: 'utf8' });
    expect(res.signal).toBe('SIGKILL');
    expect(res.stderr).toMatch(/killed by signal 9/);
  });

  it('refuses a relative repo path and a directory that is not a checkout', () => {
    expect(spawnSync(launcher, ['relative/repo']).status).toBe(64);
    const res = spawnSync(launcher, [path.join(tmp, 'nowhere')], { encoding: 'utf8' });
    expect(res.status).toBe(78);
    expect(res.stderr).toMatch(/run-named-node not found/);
  });

  describe('setup/service-macos.sh', () => {
    let fakeRepo;
    let app;

    beforeAll(() => {
      fakeRepo = path.join(tmp, 'svc-repo');
      fs.mkdirSync(path.join(fakeRepo, 'setup'), { recursive: true });
      fs.copyFileSync(path.join(root, 'setup/service-macos.sh'), path.join(fakeRepo, 'setup/service-macos.sh'));
      fs.writeFileSync(path.join(fakeRepo, '.env'), 'EXAMPLE_SETTING=on\n');
      app = path.join(tmp, 'Apps', 'Matron Bridge.app');
      fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
      fs.copyFileSync(launcher, path.join(app, 'Contents/MacOS/matron-bridge-launcher'));
      fs.writeFileSync(path.join(app, 'Contents/Info.plist'),
        read('macos/launcher/Info.plist').replace('@VERSION@', '1.0.0').replace('@BUILD@', '1'));
      const sign = spawnSync('codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' });
      if (sign.status !== 0) throw new Error(`codesign failed: ${sign.stderr}`);
    });

    function writePlist(env) {
      const out = fs.mkdtempSync(path.join(tmp, 'plists-'));
      const res = spawnSync('bash', [path.join(fakeRepo, 'setup/service-macos.sh')], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin', HOME: tmp, NODE_BIN: process.execPath, MATRON_SERVICE_WRITE_ONLY: out, ...env },
      });
      expect(res.status, res.stderr).toBe(0);
      return { plist: fs.readFileSync(path.join(out, 'chat.matron.matron-bridge.plist'), 'utf8'),
        viewer: fs.readFileSync(path.join(out, 'chat.matron.matron-bridge-viewer.plist'), 'utf8'),
        stderr: res.stderr };
    }

    it('runs the bridge under the app when it is installed and signed', () => {
      const { plist, viewer } = writePlist({ MATRON_LAUNCHER_APP: app });
      expect(plist).toContain(`<array>\n    <string>${app}/Contents/MacOS/matron-bridge-launcher</string>\n    <string>${fakeRepo}</string>\n  </array>`);
      expect(plist).toMatch(/<key>AssociatedBundleIdentifiers<\/key>\s*<string>chat\.matron\.bridge<\/string>/);
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
      expect(plist).toMatch(/<key>EXAMPLE_SETTING<\/key>\s*<string>on<\/string>/);
      expect(viewer).toContain('<string>/bin/sh</string>');
      expect(viewer).not.toContain('AssociatedBundleIdentifiers');
    });

    it('writes the plain node service without the app, or with MATRON_LAUNCHER=0', () => {
      for (const env of [{ MATRON_LAUNCHER_APP: path.join(tmp, 'missing.app') }, { MATRON_LAUNCHER_APP: app, MATRON_LAUNCHER: '0' }]) {
        const { plist } = writePlist(env);
        expect(plist).toContain('<string>/bin/sh</string>');
        expect(plist).toContain(`<string>${fakeRepo}/bin/run-named-node</string>`);
        expect(plist).not.toContain('AssociatedBundleIdentifiers');
      }
    });

    it('falls back to the plain service when the app fails its signature check', () => {
      const broken = path.join(tmp, 'Broken', 'Matron Bridge.app');
      fs.cpSync(app, broken, { recursive: true });
      fs.appendFileSync(path.join(broken, 'Contents/Info.plist'), '\n');
      const { plist, stderr } = writePlist({ MATRON_LAUNCHER_APP: broken });
      expect(stderr).toMatch(/fails its signature check/);
      expect(plist).toContain('<string>/bin/sh</string>');
    });
  });
});

describe.runIf(process.platform !== 'win32')('setup/service-macos.sh without node', () => {
  it('says node was not found instead of exiting silently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-svc-nonode-'));
    try {
      fs.mkdirSync(path.join(dir, 'setup'));
      fs.copyFileSync(path.join(root, 'setup/service-macos.sh'), path.join(dir, 'setup/service-macos.sh'));
      fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_SETTING=on\n');
      // A PATH holding only dirname, the one external command the script runs
      // before its node check, so node is missing wherever it is installed.
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.symlinkSync(spawnSync('bash', ['-c', 'command -v dirname'], { encoding: 'utf8' }).stdout.trim(), path.join(bin, 'dirname'));
      const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
      const res = spawnSync(bash, [path.join(dir, 'setup/service-macos.sh')], {
        encoding: 'utf8',
        env: { PATH: bin, HOME: dir, MATRON_SERVICE_WRITE_ONLY: path.join(dir, 'out') },
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/node not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
