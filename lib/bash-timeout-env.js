// Bash-tool timeout floor for bridge-spawned Claude Code sessions.
//
// Claude Code caps every Bash tool call at BASH_DEFAULT_TIMEOUT_MS (built-in
// default 120000ms = 2 min) unless the model passes an explicit `timeout`, and
// caps that explicit value at BASH_MAX_TIMEOUT_MS (built-in default 600000ms =
// 10 min). Bridge sessions routinely run long Codex adversarial reviews and full
// test suites that legitimately exceed 2 minutes; with the built-in default they
// get SIGTERM'd at 120s (exit 143) even when the underlying command has a much
// larger budget of its own. The bridge never overrode these, so we lift the floor
// here and hand the raised values to every spawned session via its env. Env-var
// names/semantics per the Claude Code env reference (code.claude.com/docs/en/env-vars).
//
// Both values are env-overridable so the operator can tune the RUNNING bridge
// without a code change (matching the parseInt(process.env...) pattern used for
// the other tunables in index.js). An explicit value already present in the source
// env wins — but only when it is a valid positive-integer millisecond string.
// A malformed override (empty, non-numeric, zero, negative) is REJECTED with a
// warning and falls back to the raised default rather than silently passing
// through: Claude Code silently reverts a malformed value to its 120s built-in,
// which would quietly recreate the exact failure this fix removes (fail-visible,
// never fail-into-the-bug).

// 20 min default per Bash call; 30 min ceiling for an explicit per-call timeout.
// The default must comfortably exceed the longest supported unattended command a
// bridge session issues without its own explicit timeout — chiefly a foreground
// Codex adversarial review, whose workflow budget is ~15 min — so it isn't
// SIGTERM'd before that budget elapses. The 30 min ceiling matches the deepest
// Codex budget (codex_execute.sh TIMEOUT=1800s) so an explicit per-call timeout
// can reach it.
export const DEFAULT_BASH_DEFAULT_TIMEOUT_MS = 1200000;
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 1800000;

// Absolute ceiling for an operator override (1 hour). The env vars are meant to
// TUNE the timeout, so we don't hard-cap at the 30-min default — but an obvious
// fat-finger typo (e.g. an extra zero: 18000000 = 5h) would otherwise let a hung
// Bash command occupy a session for hours. Anything above this is clamped down
// with a warning. 1h also matches the SESSION_IDLE_TIMEOUT_MS reaper window, so a
// single Bash call can never outlive the session that owns it.
export const ABSOLUTE_MAX_TIMEOUT_MS = 3600000;

// Coerce one operator override to a positive-integer millisecond value.
// Returns `fallback` (and warns) for absent or malformed input. Acceptance is
// deliberately aligned with Claude Code's own numeric parsing so we never REJECT
// a value the runtime would have honored (e.g. "9e5" -> 900000): any string that
// Number() resolves to a positive safe integer is accepted and re-emitted in
// canonical decimal form. Truly malformed input — "600000ms", "600000.5", "0",
// "-1", "", "abc" — is rejected, because Claude Code silently reverts those to
// its 120s built-in, which would quietly recreate the bug this fix removes.
function coerceTimeoutMs(raw, fallback, name, warn) {
  // undefined/null = the operator simply didn't set the key: take the default
  // silently. An explicit empty (or whitespace) string IS a set-but-malformed
  // value and flows through to the warn-and-fall-back path below.
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  const n = Number(trimmed);
  const valid =
    trimmed !== '' &&
    Number.isInteger(n) &&
    Number.isSafeInteger(n) &&
    n > 0;
  if (!valid) {
    warn(
      `[bash-timeout-env] ignoring invalid ${name}=${JSON.stringify(raw)} ` +
        `(expected a positive integer of milliseconds); using ${fallback}`,
    );
    return fallback;
  }
  if (n > ABSOLUTE_MAX_TIMEOUT_MS) {
    warn(
      `[bash-timeout-env] ${name}=${n} exceeds the ${ABSOLUTE_MAX_TIMEOUT_MS}ms ` +
        `(1h) ceiling (likely a typo); clamping to ${ABSOLUTE_MAX_TIMEOUT_MS}`,
    );
    return ABSOLUTE_MAX_TIMEOUT_MS;
  }
  return n;
}

// Build the { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } pair to merge into a
// spawn env. `env` (default process.env) supplies operator overrides; `warn`
// (default console.warn) receives fail-visible diagnostics. Values are returned
// as strings because they are handed to a child process env. Invariant enforced:
// max >= default (else an explicit per-call timeout could not reach the default
// ceiling); a too-small max override is raised to the default, with a warning.
export function bashTimeoutEnv(env = process.env, { warn = console.warn } = {}) {
  const def = coerceTimeoutMs(
    env.BASH_DEFAULT_TIMEOUT_MS,
    DEFAULT_BASH_DEFAULT_TIMEOUT_MS,
    'BASH_DEFAULT_TIMEOUT_MS',
    warn,
  );
  let max = coerceTimeoutMs(
    env.BASH_MAX_TIMEOUT_MS,
    DEFAULT_BASH_MAX_TIMEOUT_MS,
    'BASH_MAX_TIMEOUT_MS',
    warn,
  );
  if (max < def) {
    warn(
      `[bash-timeout-env] BASH_MAX_TIMEOUT_MS (${max}) < BASH_DEFAULT_TIMEOUT_MS ` +
        `(${def}); raising max to the default so per-call timeouts can reach it`,
    );
    max = def;
  }
  return {
    BASH_DEFAULT_TIMEOUT_MS: String(def),
    BASH_MAX_TIMEOUT_MS: String(max),
  };
}
