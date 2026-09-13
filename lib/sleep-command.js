// /sleep command handling — stop the machine the bridge runs on, on demand,
// instead of waiting out whatever idle timer the deployment has.
//
// This is the bridge's FIRST command whose effect lands on the host rather
// than on a session (/restart and friends only ever kill and recreate the
// agent child process), so the host action itself is deliberately NOT
// hardcoded here. What "sleep" means — and crucially whether it is
// reversible — is a property of the deployment, not of the bridge:
//
//   - On an orchestrated box (a VM whose supervisor starts it again when a
//     chat message targets it) `poweroff` is a nap.
//   - On a laptop or a plain VPS the SAME command means the box is gone and
//     nothing, including this bridge, can bring it back.
//
// So MATRON_SLEEP_COMMAND is unset by default and /sleep is inert until a
// deployer opts in, and MATRON_SLEEP_WAKE_HINT lets them say how to undo it
// in the one place the user will read it — the confirmation card. Shipping a
// default here would be shipping a footgun to every deployment that isn't
// ours.

// Shown when /sleep runs with no command configured. Names the variable so
// the reply is actionable rather than a dead end.
export const SLEEP_NOT_CONFIGURED =
  'No sleep command is configured on this box. Set MATRON_SLEEP_COMMAND in the bridge .env to enable /sleep.';

// Deliberately vague — with no MATRON_SLEEP_WAKE_HINT the bridge genuinely
// does not know what can start this machine again, and guessing ("message me
// and I'll wake up") would be a promise only some deployments keep.
export const DEFAULT_WAKE_HINT = 'something starts it again';

// env -> { command, wakeHint }. `command` is null when unset or blank, which
// is what every caller treats as "/sleep is off here".
export function sleepConfig(env = process.env) {
  const raw = String(env.MATRON_SLEEP_COMMAND ?? '').trim();
  const hint = String(env.MATRON_SLEEP_WAKE_HINT ?? '').trim();
  return {
    command: raw || null,
    wakeHint: hint || DEFAULT_WAKE_HINT,
  };
}

// The confirmation card's buttons, following the picker-button convention
// (lib/timer-command.js timerCancelButton): the `sleep-` id prefix is what
// classifies the frame as non-answerable in lib/journal-input-router.js (so
// taps are seq-proven against this exact frame and never advance the reply
// staleness guard), and a tap sends the VALUE back — Matron taps send values,
// not ids — which lib/picker-dispatch.js routes to the bridge's sleep seam.
// Picker frames are single-use, so a double-tap cannot fire two shutdowns.
export function sleepButtons() {
  return [
    { id: 'sleep-confirm', label: '😴 Sleep now', value: 'sleep:confirm' },
    { id: 'sleep-cancel', label: '✋ Stay awake', value: 'sleep:cancel' },
  ];
}

// The card body. Always names the wake path: this is the one moment the user
// can still change their mind, so the card has to say how to undo what it is
// about to do. A mid-turn session is surfaced but NOT a refusal — the user
// asked for the box to sleep and may well mean "yes, including that turn".
export function sleepCardText({ wakeHint = DEFAULT_WAKE_HINT, busyCount = 0 } = {}) {
  const lines = [`Sleep this box now? It will stop until ${wakeHint}.`];
  if (busyCount > 0) {
    lines.push(busyCount === 1
      ? '⚠️ 1 session is mid-turn and will be interrupted.'
      : `⚠️ ${busyCount} sessions are mid-turn and will be interrupted.`);
  }
  return lines.join('\n');
}

// How long a still-running sleep command is given before it counts as
// succeeded. A shutdown that has actually started will tear this process down
// long before an exit could be observed, so waiting for one would hang the
// reply forever; a command that is going to fail (passworded sudo, a typo'd
// binary) does so in well under a second.
export const SLEEP_SETTLE_MS = 3000;

// Cap on retained stderr from a failing command — enough for the line that
// explains the failure ("sudo: a password is required"), not enough for a
// runaway process to grow the reply without bound.
const STDERR_LIMIT = 2000;

// Launch the host command and report whether it actually got going.
//
// `spawn` succeeding does NOT mean the sleep succeeded, and both failure modes
// matter:
//
//   - the spawn itself can fail asynchronously (fork(2) returning EAGAIN under
//     memory pressure, a missing shell). That arrives as an 'error' event, and
//     an unhandled 'error' on a ChildProcess terminates the whole bridge;
//   - the command can exit non-zero almost immediately (passworded sudo). Left
//     undetected, the user is told the box is sleeping while it stays wide
//     awake.
//
// Detached so the command outlives the bridge it is about to stop; unref'd
// only once it has settled, so the wait below can still observe an early exit.
// stderr is piped purely so a failure can say WHY.
export function runSleepCommand(cmd, { spawn, setTimer = setTimeout, settleMs = SLEEP_SETTLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk).slice(0, STDERR_LIMIT - stderr.length);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      // A signal kill (code === null) is far more likely to BE the shutdown
      // than a failure of it: once the machine starts going down, systemd
      // SIGTERMs everything, and this child is inside the settle window. So
      // it counts as success — claiming "still awake" while the box is
      // powering off is exactly the contradiction this seam exists to avoid.
      if (code === 0 || code === null || signal) return resolve();
      const detail = stderr.trim();
      reject(new Error(`sleep command exited ${code}${detail ? `: ${detail}` : ''}`));
    });
    // Still alive at the settle window: the shutdown is under way. Let go of
    // the child so it cannot hold this process open, and report success.
    setTimer(() => {
      child.unref();
      resolve();
    }, settleMs);
  });
}

// Publish the goodbye, settle the journal, THEN run the host command.
//
// The ordering is the whole point: `command` kills this process (that is what
// it is for), so a goodbye still sitting in the outbound queue is a goodbye
// nobody ever sees. flush() is bounded by its own timeout upstream, and a
// flush FAILURE must not block the sleep — a dead socket is precisely when a
// user is most likely to be reaching for /sleep.
//
// Every impure edge is injected (publish/flush/exec) so the ordering can be
// asserted in a unit test without powering anything off.
export async function performSleep({ command, publish, flush, exec }) {
  if (!command) {
    await publish(SLEEP_NOT_CONFIGURED);
    return { ok: false, error: 'not configured' };
  }

  await publish('😴 Sleeping now.');
  try {
    await flush();
  } catch {
    // Deliberately swallowed — see above. The sleep proceeds.
  }

  try {
    await exec(command);
  } catch (e) {
    // The box is still awake and the user was just told it was going away.
    // Silence would be the worst outcome, so contradict the goodbye loudly.
    const message = e?.message ?? String(e);
    await publish(`Sleep failed — still awake: ${message}`);
    return { ok: false, error: message };
  }
  return { ok: true };
}
