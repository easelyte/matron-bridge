import { describe, it, expect } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = path.resolve('hooks/matron-bash-tee.sh');
const TEE = path.resolve('hooks/matron-tee');

function runHook(input, env = {}, hook = HOOK) {
  // Strip MATRON_* vars from the parent env so the test result is determined
  // entirely by the `env` arg. Without this, tests run inside a bridge-spawned
  // claude (where MATRON_BASH_TEE_ENABLED=1 is set) see leaked state in the
  // "unset" / "non-Bash" cases.
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('MATRON_'))
  );
  return new Promise((resolve, reject) => {
    const child = execFile(hook, [], {
      env: { ...parentEnv, ...env },
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

describe('matron-bash-tee.sh', () => {
  it('rewrites Bash commands when MATRON_BASH_TEE_ENABLED=1', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: 'toolu_abc',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' }
    }, { MATRON_BASH_TEE_ENABLED: '1' });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.updatedInput.command).toBe(
      `'${TEE}' /tmp/matron-cmd-toolu_abc.log -- bash -c 'ls -la'`
    );
  });

  it('rewrites to a command that still runs when the install path has a space', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tee it's "));
    try {
      const hook = path.join(dir, 'matron-bash-tee.sh');
      fs.copyFileSync(HOOK, hook);
      fs.chmodSync(hook, 0o755);
      // Stand-in for matron-tee: drop the log path and `--`, run the rest.
      fs.writeFileSync(path.join(dir, 'matron-tee'), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
      const { stdout } = await runHook({
        session_id: 's1',
        tool_use_id: 'toolu_abc',
        tool_name: 'Bash',
        tool_input: { command: 'echo ran' }
      }, { MATRON_BASH_TEE_ENABLED: '1' }, hook);
      const rewritten = JSON.parse(stdout).hookSpecificOutput.updatedInput.command;
      expect(execFileSync('bash', ['-c', rewritten], { encoding: 'utf8' })).toBe('ran\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes through when MATRON_BASH_TEE_ENABLED unset', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: 'toolu_abc',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' }
    });
    expect(stdout.trim()).toBe('');
  });

  it('passes through for non-Bash tools', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: 'toolu_abc',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' }
    }, { MATRON_BASH_TEE_ENABLED: '1' });
    expect(stdout.trim()).toBe('');
  });

  it('passes through on malformed JSON input (no crash, no rewrite)', async () => {
    const { stdout, stderr: _stderr } = await new Promise((resolve, reject) => {
      const child = execFile(HOOK, [], {
        env: { ...process.env, MATRON_BASH_TEE_ENABLED: '1' },
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      });
      child.stdin.write('this is not json');
      child.stdin.end();
    });
    expect(stdout.trim()).toBe('');
  });

  it('passes through when tool_use_id is malformed', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: '../../../etc/passwd',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    }, { MATRON_BASH_TEE_ENABLED: '1' });
    expect(stdout.trim()).toBe('');
  });
});
