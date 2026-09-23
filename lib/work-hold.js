// Work in flight keeps a session — and its box — up.
//
// The bridge's idle reaper kills a claude process after SESSION_IDLE_TIMEOUT_MS
// (an hour) without assistant text or user input. That clock knows nothing
// about a turn still running or a background job the agent started: a
// colleague's hour-plus `rake test`, launched from a chat session, was cut
// off at the 60-minute mark (Dan, 2026-09-21) — in interactive mode the PTY
// hang-up took the test run with it, the load fell, and the host's
// vm-idle-stop wound the box down 90 minutes later. The host probe's own
// signals (logins, ssh, a `claude` process, load ≥ 0.5, a hold_awake
// reminder) are all either gone or unreliable at that point.
//
// Two signals say "work in flight", both read at each reaper tick:
//   - the session is mid-turn (`session.busy`);
//   - the claude process has a live descendant that is not one of the
//     servers claude spawns for itself (MCP servers, the headless browser
//     stack) — a shell running a tool call, a background Bash task, and
//     whatever they spawned.
// While either holds, the reaper skips the session and index.js leases the
// guest-side keep-awake marker (the same ~/.matron-bridge-keepawake.json the
// hold_awake reminders use, read by the host's vm-idle-stop probe) so the box
// stays up even if the job's load dips below the probe's threshold — a test
// suite waiting on a lock, say. Both are bounded by WORK_HOLD_MAX_MS from the
// session's last activity so a wedged job cannot pin a session or a box for
// good; the lease is short and re-issued every tick so a crashed bridge
// cannot either.
//
// Pure: the process table, the clock and the session fields are injected.

export const WORK_HOLD_MAX_MS = 8 * 3600 * 1000;
// Re-issued every reaper tick (SESSION_IDLE_CHECK_MS, 5 min); three ticks of
// slack so one slow tick does not let the host's 10-minute probe see a lapse.
export const WORK_HOLD_LEASE_MS = 15 * 60 * 1000;

// What claude spawns for ITSELF, present for the whole session and never
// evidence of work: the MCP servers in the config it was started with — the
// bridge's own (ask-user, show-file, chrome-devtools behind
// hooks/xvfb-wrap.sh), any mcp-config.local.json extra — and whatever those
// start (the Xvfb + Chrome stack under the browser server). Anything else
// under the claude process is a tool call or a background task, which is
// exactly the work this exists to keep alive.
//
// A server is known by its own identity, not by name patterns (Bugbot on
// #289: a chrome/xvfb denylist matched a tool call running a browser test
// suite, and missed every server that was not a stock one). Its signature
// is the distinctive tokens of `command` + `args` — flags and generic
// launchers dropped — and a process is that server when its argv carries
// every one of them as a whole token. That survives the ways a server's
// argv differs from its config: `npx -y pkg` runs as `npm exec pkg`, a
// shebang script shows its interpreter first, uvx/pipx exec into the tool's
// own binary (matched by basename).
const LAUNCHERS = new Set([
  'node', 'nodejs', 'npx', 'npm', 'bun', 'bunx', 'deno', 'uvx', 'uv', 'pipx',
  'python', 'python3', 'sh', 'bash', 'zsh', 'env', 'exec', 'run',
]);

const basename = (tok) => tok.slice(tok.lastIndexOf('/') + 1);

function serverSignature(server) {
  if (!server || typeof server.command !== 'string') return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const anchors = [server.command, ...args]
    .filter((t) => typeof t === 'string' && t && !t.startsWith('-') && !LAUNCHERS.has(basename(t)));
  return anchors.length ? anchors : null;
}

// [{command, args}] or {name: {command, args}} -> [[anchor, …], …], one per
// stdio server with something distinctive to match on; url-only servers have
// no process.
export function mcpServerSignatures(servers) {
  const list = Array.isArray(servers) ? servers : Object.values(servers || {});
  const out = [];
  const seen = new Set();
  for (const server of list) {
    const sig = serverSignature(server);
    if (!sig || seen.has(sig.join('\0'))) continue;
    seen.add(sig.join('\0'));
    out.push(sig);
  }
  return out;
}

// A path anchor must appear in full (a stray `node server.js` is not the
// configured /abs/circleci-mcp/server.js); a bare one may also be the
// basename of a path token (uvx exec'd into /cache/…/bin/some-mcp).
function hasAnchor(tokens, anchor) {
  if (anchor.includes('/')) return tokens.includes(anchor);
  return tokens.some((t) => t === anchor || basename(t) === anchor);
}

export function isMcpServerProcess(args, signatures) {
  if (typeof args !== 'string' || !args || !Array.isArray(signatures) || !signatures.length) return false;
  const tokens = args.split(/\s+/).filter(Boolean);
  return signatures.some((sig) => sig.every((anchor) => hasAnchor(tokens, anchor)));
}

// `ps -axo pid=,ppid=,args=` (Linux and macOS alike) -> [{pid, ppid, args}].
export function parseProcessTable(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), args: m[3].trim() });
  }
  return out;
}

// Every descendant of `pid` (children, grandchildren, …) that counts as work:
// all of them but the configured MCP servers (`signatures`, from
// mcpServerSignatures) and their subtrees — the browser under the
// chrome-devtools server is not work either. With no signatures everything
// is work: an unknown config never hides a job.
export function liveWorkChildren(pid, table, signatures = []) {
  if (!Number.isInteger(pid) || !Array.isArray(table) || !table.length) return [];
  const byParent = new Map();
  for (const p of table) {
    if (!p || !Number.isInteger(p.pid) || !Number.isInteger(p.ppid)) continue;
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const work = [];
  const seen = new Set();
  const stack = [pid];
  while (stack.length) {
    const parent = stack.pop();
    for (const child of byParent.get(parent) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (isMcpServerProcess(child.args, signatures)) continue;
      work.push({ pid: child.pid, args: child.args });
      stack.push(child.pid);
    }
  }
  return work;
}

// The reaper's decision for one session: {reason} to keep it, or null to let
// the idle clock rule. `idleSince` is the session's last activity stamp.
export function workHold({ busy = false, children = [], idleSince = 0, now = Date.now() } = {}) {
  if (now - idleSince >= WORK_HOLD_MAX_MS) return null;
  if (busy) return { reason: 'turn in progress' };
  const live = Array.isArray(children) ? children : [];
  if (!live.length) return null;
  const first = String(live[0].args || '').slice(0, 160);
  return { reason: `${live.length} child process${live.length === 1 ? '' : 'es'} still running (${first})` };
}

// The marker's `until`: whichever of the hold_awake reminders and the work
// lease ends later, or null when neither is in force (the file is removed).
export function keepAwakeUntil({ timerUntil = null, workUntil = 0 } = {}) {
  const t = Number.isFinite(timerUntil) ? timerUntil : 0;
  const w = Number.isFinite(workUntil) ? workUntil : 0;
  const until = Math.max(t, w);
  return until > 0 ? until : null;
}
