// bin/run-named-node: runs a script from a copy of node with a Matron name
// (macOS) or with node itself (everywhere else, or when opted out). The real
// node is swapped for a tiny sh script that answers node's execPath query and
// otherwise prints how it was invoked, so these tests can see which file was
// exec'd and with what arguments. MATRON_NAMED_NODE_FORCE=1 takes the macOS
// path on any OS.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../bin/run-named-node', import.meta.url));

// Answers `-e <code>` (the launcher's execPath query) with its own path, as
// node does; any other invocation prints $0, each argument and the
// MATRON_REAL_NODE the launcher exported.
const FAKE_NODE = `#!/bin/sh
if [ "$1" = -e ]; then printf %s "$0"; exit 0; fi
printf 'argv0=%s\\n' "$0"
for a in "$@"; do printf 'arg=%s\\n' "$a"; done
printf 'real=%s\\n' "\${MATRON_REAL_NODE:-}"
`;

let tmp;
let fakeNode;
let binDir;

function writeExecutable(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function run(args, env = {}) {
  const res = spawnSync('/bin/sh', [LAUNCHER, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: tmp,
      NODE_BIN: fakeNode,
      MATRON_NAMED_NODE_DIR: binDir,
      MATRON_NAMED_NODE_FORCE: '1',
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function parse(stdout) {
  const lines = stdout.trimEnd().split('\n');
  return {
    argv0: lines.find((l) => l.startsWith('argv0='))?.slice(6),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4)),
    real: lines.find((l) => l.startsWith('real='))?.slice(5),
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-named-node-')));
  fakeNode = path.join(tmp, 'node');
  writeExecutable(fakeNode, FAKE_NODE);
  binDir = path.join(tmp, 'named-bin');
});

afterEach(() => {
  try { fs.chmodSync(binDir, 0o755); } catch { /* not created */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bin/run-named-node', () => {
  it('is an executable POSIX sh script', () => {
    const fd = fs.openSync(LAUNCHER, 'r');
    try {
      expect(fs.fstatSync(fd).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(fd, 'utf8').split('\n')[0]).toBe('#!/bin/sh');
    } finally {
      fs.closeSync(fd);
    }
  });

  it('copies node under the given name and execs the script with it', () => {
    const res = run(['matron-test', '/srv/app/index.js', 'one', 'two words']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const copy = path.join(binDir, 'matron-test');
    expect(parse(res.stdout)).toEqual({
      argv0: copy,
      args: ['/srv/app/index.js', 'one', 'two words'],
      real: fakeNode,
    });
    expect(fs.readFileSync(copy, 'utf8')).toBe(FAKE_NODE);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o755);
    expect(Math.floor(fs.statSync(copy).mtimeMs / 1000)).toBe(Math.floor(fs.statSync(fakeNode).mtimeMs / 1000));
    // No temp file left behind.
    expect(fs.readdirSync(binDir)).toEqual(['matron-test']);
  });

  it('reuses a fresh copy instead of copying again', () => {
    run(['matron-test', 'a.js']);
    const copy = path.join(binDir, 'matron-test');
    const ino = fs.statSync(copy).ino;
    const res = run(['matron-test', 'b.js']);
    expect(parse(res.stdout).argv0).toBe(copy);
    expect(fs.statSync(copy).ino).toBe(ino);
  });

  it('refreshes the copy when node changes size', () => {
    run(['matron-test', 'a.js']);
    const copy = path.join(binDir, 'matron-test');
    const upgraded = `${FAKE_NODE}# upgraded\n`;
    // Rewrite node but keep its mtime (which the copy shares, via cp -p), so
    // only the size gives the change away.
    const fd = fs.openSync(fakeNode, 'r+');
    try {
      const { atime, mtime } = fs.fstatSync(fd);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, upgraded, 0);
      fs.futimesSync(fd, atime, mtime);
    } finally {
      fs.closeSync(fd);
    }
    const res = run(['matron-test', 'b.js']);
    expect(parse(res.stdout).argv0).toBe(copy);
    expect(fs.readFileSync(copy, 'utf8')).toBe(upgraded);
  });

  it('refreshes the copy when node changes mtime', () => {
    run(['matron-test', 'a.js']);
    const copy = path.join(binDir, 'matron-test');
    const ino = fs.statSync(copy).ino;
    const later = new Date(fs.statSync(fakeNode).mtimeMs + 60_000);
    fs.utimesSync(fakeNode, later, later);
    run(['matron-test', 'b.js']);
    expect(fs.statSync(copy).ino).not.toBe(ino);
    expect(Math.floor(fs.statSync(copy).mtimeMs / 1000)).toBe(Math.floor(later.getTime() / 1000));
  });

  it('copies the binary node reports, not a version-manager shim in front of it', () => {
    const shim = path.join(tmp, 'shim-node');
    writeExecutable(shim, `#!/bin/sh
if [ "$1" = -e ]; then printf %s '${fakeNode}'; exit 0; fi
exec '${fakeNode}' "$@"
`);
    const res = run(['matron-test', 'a.js'], { NODE_BIN: shim });
    expect(parse(res.stdout)).toMatchObject({ argv0: path.join(binDir, 'matron-test'), real: fakeNode });
    expect(fs.readFileSync(path.join(binDir, 'matron-test'), 'utf8')).toBe(FAKE_NODE);
  });

  it('finds node on PATH when NODE_BIN is unset', () => {
    const res = run(['matron-test', 'a.js'], { NODE_BIN: '', PATH: `${tmp}:/usr/bin:/bin` });
    expect(parse(res.stdout)).toMatchObject({ argv0: path.join(binDir, 'matron-test'), real: fakeNode });
  });

  it('defaults the copy directory to $HOME/.matron/bin', () => {
    const res = run(['matron-test', 'a.js'], { MATRON_NAMED_NODE_DIR: '' });
    expect(parse(res.stdout).argv0).toBe(path.join(tmp, '.matron', 'bin', 'matron-test'));
  });

  it('runs node itself, with no copy, when MATRON_NAMED_NODE=0', () => {
    const res = run(['matron-test', 'a.js', 'x'], { MATRON_NAMED_NODE: '0' });
    expect(res.status).toBe(0);
    expect(parse(res.stdout)).toEqual({ argv0: fakeNode, args: ['a.js', 'x'], real: '' });
    expect(fs.existsSync(binDir)).toBe(false);
  });

  it.skipIf(os.platform() === 'darwin')('runs node itself on systems other than macOS', () => {
    const res = run(['matron-test', 'a.js'], { MATRON_NAMED_NODE_FORCE: '' });
    expect(parse(res.stdout)).toMatchObject({ argv0: fakeNode, args: ['a.js'], real: '' });
    expect(fs.existsSync(binDir)).toBe(false);
  });

  it.each(['bridge', 'matron-', 'matron-Bridge', 'matron-a/b', 'matron-a b', 'matron-a.b', '../matron-x', 'xmatron-a'])(
    'refuses the name %j',
    (name) => {
      const res = run([name, 'a.js']);
      expect(res.status).toBe(64);
      expect(res.stdout).toBe('');
      expect(res.stderr).toMatch(/refusing name/);
      expect(fs.existsSync(binDir)).toBe(false);
    },
  );

  it('refuses to run without a script', () => {
    const res = run(['matron-test']);
    expect(res.status).toBe(64);
    expect(res.stderr).toMatch(/usage/);
  });

  it.skipIf(process.getuid?.() === 0)('falls back to node itself, with one warning, when the copy cannot be written', () => {
    fs.mkdirSync(binDir);
    fs.chmodSync(binDir, 0o555);
    const res = run(['matron-test', 'a.js', 'x']);
    expect(res.status).toBe(0);
    expect(parse(res.stdout)).toEqual({ argv0: fakeNode, args: ['a.js', 'x'], real: '' });
    expect(res.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(res.stderr).toMatch(/^run-named-node: could not copy /);
  });

  it('falls back to node itself when node cannot report its own binary', () => {
    const odd = path.join(tmp, 'odd-node');
    writeExecutable(odd, `#!/bin/sh
if [ "$1" = -e ]; then printf %s 'relative/node'; exit 0; fi
printf 'argv0=%s\\n' "$0"
`);
    const res = run(['matron-test', 'a.js'], { NODE_BIN: odd });
    expect(res.status).toBe(0);
    expect(parse(res.stdout).argv0).toBe(odd);
    expect(res.stderr).toMatch(/^run-named-node: could not locate the node binary/);
    expect(fs.existsSync(binDir)).toBe(false);
  });
});

// The starters that used to run `node index.js` / `node viewer/start.js`
// directly now go through the launcher with a fixed Matron name each.
describe('run-named-node wiring', () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

  it('the macOS service runs both units through the launcher with NODE_BIN set', () => {
    const svc = read('setup/service-macos.sh');
    expect(svc).toMatch(/<string>\/bin\/sh<\/string>\n\s*<string>\$\(xml_escape "\$REPO_DIR\/bin\/run-named-node"\)<\/string>\n\s*<string>\$\(xml_escape "\$process_name"\)<\/string>\n\s*<string>\$\(xml_escape "\$REPO_DIR\/\$script"\)<\/string>/);
    expect(svc).toMatch(/<key>NODE_BIN<\/key>\n\s*<string>\$\(xml_escape "\$NODE_BIN"\)<\/string>/);
    expect(svc).toContain('write_plist "$BRIDGE_PLIST" "$BRIDGE_LABEL" "index.js" "matron-bridge" ');
    expect(svc).toContain('write_plist "$VIEWER_PLIST" "$VIEWER_LABEL" "viewer/start.js" "matron-viewer" ');
  });

  it('the sh starters launch the bridge as matron-bridge', () => {
    expect(read('start-bridge.sh')).toContain('exec ./bin/run-named-node matron-bridge index.js ');
    const restart = read('restart.sh');
    expect(restart).toContain('nohup ./bin/run-named-node matron-bridge index.js ');
    expect(restart).not.toMatch(/^\s*nohup node /m);
  });
});
