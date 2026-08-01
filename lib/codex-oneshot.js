import os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';

const KILL_GRACE_MS = 3_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 4_096;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

export function parseTimeout(value) {
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout >= MIN_TIMEOUT_MS && timeout <= MAX_TIMEOUT_MS
    ? timeout
    : DEFAULT_TIMEOUT_MS;
}

// Run a contained, ephemeral Codex turn for cosmetic summary generation.
// Every failure resolves to a structured result so callers can fail open.
export async function codexOneShot(prompt, {
  model = process.env.SUMMARY_CODEX_MODEL || null,
  timeoutMs = parseTimeout(process.env.SUMMARY_CODEX_TIMEOUT_MS),
  cwd = os.tmpdir(),
  spawnImpl = nodeSpawn,
  command = 'codex',
} = {}) {
  const startedAt = Date.now();
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--ignore-user-config',
    '--ephemeral',
    ...(model ? ['-m', model] : []),
    '-',
  ];
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  };

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timeoutTimer = null;
    let killTimer = null;
    let terminalReason = null;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const result = (text, reason, exitCode = null, signal = null) => ({
      text,
      reason,
      exitCode,
      signal,
      durationMs: Date.now() - startedAt,
    });

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(value);
    };

    const kill = (signal) => {
      try {
        child?.kill(signal);
      } catch {
        // Process termination is best-effort; the guarded result still resolves.
      }
    };

    const scheduleForceKill = () => {
      if (settled && terminalReason !== 'output-overflow') return;
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        if (terminalReason === 'timeout') {
          resolveOnce(result(null, 'timeout'));
        }
      }, KILL_GRACE_MS);
    };

    const handleOverflow = () => {
      if (terminalReason) return;
      terminalReason = 'output-overflow';
      kill('SIGTERM');
      scheduleForceKill();
      resolveOnce(result(null, 'output-overflow'));
    };

    const appendOutput = (stream, chunk) => {
      if (terminalReason) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (stream === 'stdout') {
        if (stdoutBytes + bytes > MAX_OUTPUT_BYTES) {
          handleOverflow();
          return;
        }
        stdoutBytes += bytes;
        stdout += chunk.toString();
        return;
      }
      if (stderrBytes + bytes > MAX_OUTPUT_BYTES) {
        handleOverflow();
        return;
      }
      stderrBytes += bytes;
      stderr += chunk.toString();
    };

    const lastAgentMessage = () => {
      let text = null;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (
            event.type === 'item.completed'
            && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string'
          ) {
            text = event.item.text.slice(0, MAX_TEXT_CHARS);
          }
        } catch {
          // Ignore non-JSON diagnostic lines; absence of an agent message fails open.
        }
      }
      return text;
    };

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolveOnce(result(null, 'spawn-error'));
      return;
    }

    try {
      child.on('error', () => {
        resolveOnce(result(null, 'spawn-error'));
      });
      child.stdin.on('error', () => {
        resolveOnce(result(null, 'stdin-error'));
      });
      child.stdout.on('data', chunk => appendOutput('stdout', chunk));
      child.stderr.on('data', chunk => appendOutput('stderr', chunk));
      child.on('close', (exitCode, signal) => {
        if (killTimer) clearTimeout(killTimer);
        if (terminalReason) {
          resolveOnce(result(null, terminalReason, exitCode, signal));
          return;
        }
        if (exitCode !== 0) {
          resolveOnce(result(null, 'nonzero-exit', exitCode, signal));
          return;
        }
        const text = lastAgentMessage();
        resolveOnce(text === null
          ? result(null, 'no-output', exitCode, signal)
          : result(text, null, exitCode, signal));
      });

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        terminalReason = 'timeout';
        kill('SIGTERM');
        if (!settled) scheduleForceKill();
      }, timeoutMs);

      child.stdin.end(prompt);
    } catch {
      resolveOnce(result(null, 'stdin-error'));
    }
  });
}
