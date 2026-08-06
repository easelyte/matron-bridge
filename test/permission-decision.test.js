import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve('hooks/permission-decision.sh');
const DEFAULT_INPUT = {
  session_id: 'session-1',
  tool_use_id: 'tool-1',
  tool_name: 'Bash',
  tool_input: { command: 'echo super-secret-value' },
};

let testDir;
let capturePath;

function runHook({ input = DEFAULT_INPUT, mode = 'allow', enabled = true } = {}) {
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MATRON_'))
  );
  const result = spawnSync(HOOK, [], {
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: {
      ...parentEnv,
      PATH: `${testDir}:${parentEnv.PATH}`,
      FAKE_CURL_MODE: mode,
      CURL_CAPTURE: capturePath,
      ...(enabled ? { MATRON_PERMISSION_CARDS: '1' } : {}),
    },
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result;
}

function permissionOutput(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

beforeEach(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'permission-hook-'));
  capturePath = path.join(testDir, 'request-body.json');
  writeFileSync(path.join(testDir, 'curl'), `#!/bin/sh
body=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    body="$1"
  fi
  shift
done
printf '%s' "$body" > "$CURL_CAPTURE"

case "$FAKE_CURL_MODE" in
  unreachable) exit 7 ;;
  empty) printf '\\n200' ;;
  malformed) printf 'not-json\\n200' ;;
  non2xx) printf '{"decision":"allow","reason":"must not pass"}\\n503' ;;
  deny) printf '{"decision":"deny","reason":"operator denied"}\\n200' ;;
  *) printf '{"decision":"allow","reason":"operator allowed"}\\n200' ;;
esac
`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('permission-decision.sh', () => {
  it('passes through without contacting the bridge when permission cards are disabled', () => {
    const result = runHook({ enabled: false });

    expect(JSON.parse(result.stdout)).toEqual({});
    expect(existsSync(capturePath)).toBe(false);
  });

  it.each([
    ['unreachable', 'bridge unreachable or timed out'],
    ['empty', 'bridge returned an empty response'],
    ['malformed', 'bridge returned an invalid response'],
    ['non2xx', 'bridge returned HTTP status 503'],
  ])('fails closed for a %s bridge response', (mode, reason) => {
    const result = runHook({ mode });
    const output = permissionOutput(result.stdout);

    expect(output).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    });
  });

  it('returns a valid allow decision and sends only non-secret tool identity', () => {
    const result = runHook();

    expect(permissionOutput(result.stdout)).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'operator allowed',
    });

    const rawBody = readFileSync(capturePath, 'utf8');
    expect(JSON.parse(rawBody)).toEqual({
      session_id: 'session-1',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(rawBody).not.toContain('tool_input');
    expect(rawBody).not.toContain('super-secret-value');
  });

  it('returns a valid deny decision', () => {
    const result = runHook({ mode: 'deny' });

    expect(permissionOutput(result.stdout)).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'operator denied',
    });
  });
});
