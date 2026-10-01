// The settings entry for one of the bridge's own Claude Code hooks, per
// platform.
//
// POSIX keeps the shell-form entry it has always used: the `.sh` script's
// absolute path as the `command` string, run through the user's shell. On
// Windows that string would go through Git Bash when it is installed and
// PowerShell otherwise, with MSYS path conversion on the arguments in
// between, so the bridge uses Claude Code's exec form instead: a real
// executable (`node.exe`, the one running the bridge) plus literal `args`,
// no shell at all. The Windows hooks are the Node ports in hooks/*.mjs; the
// stdin/stdout contract is the same.
import path from 'node:path';

// Join with the REQUESTED platform's separator (not the host's) so the entry
// a Linux bridge builds is the same whether or not it is unit-tested on
// Windows, and vice versa.
const joiner = (platform) => (platform === 'win32' ? path.win32 : path.posix);

export function hookEntry({
  hooksDir,
  name,
  args = [],
  timeout,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (!hooksDir || !name) throw new TypeError('hookEntry: hooksDir and name are required');
  const entry = { type: 'command' };
  if (platform === 'win32') {
    entry.command = execPath;
    entry.args = [joiner(platform).join(hooksDir, `${name}.mjs`), ...args.map(String)];
  } else {
    const script = joiner(platform).join(hooksDir, `${name}.sh`);
    entry.command = args.length ? [script, ...args.map(shellQuote)].join(' ') : script;
  }
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

// Same shape for a hook that is already a Node script on every platform
// (hooks/permission-gate.mjs): `node '<path>' args…` as a shell string on
// POSIX, exec form on Windows.
export function nodeHookEntry({
  hooksDir,
  name,
  args = [],
  timeout,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (!hooksDir || !name) throw new TypeError('nodeHookEntry: hooksDir and name are required');
  const script = joiner(platform).join(hooksDir, `${name}.mjs`);
  const entry = { type: 'command' };
  if (platform === 'win32') {
    entry.command = execPath;
    entry.args = [script, ...args.map(String)];
  } else {
    // Bare `--flag` tokens stay as they are; values are single-quoted.
    entry.command = ['node', shellQuote(script), ...args.map((a) => (/^--[a-z-]+$/.test(String(a)) ? String(a) : shellQuote(String(a))))].join(' ');
  }
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

// POSIX single-quote a value for a hook `command` string (run through a shell).
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
