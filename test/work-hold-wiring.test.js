import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the reminders-wiring idiom): the idle
// reaper consults lib/work-hold.js before killing a session, and the
// guest-side keep-awake marker the host's vm-idle-stop probe reads is leased
// while any session has work in flight — not only for hold_awake reminders.
describe('work in flight holds the session and the box', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

  function fnBody(name) {
    const start = index.indexOf(`function ${name}(`);
    expect(start, `function ${name} is missing from index.js`).toBeGreaterThan(-1);
    const next = index.indexOf('\nfunction ', start + 1);
    return index.slice(start, next === -1 ? undefined : next);
  }

  it('the reaper skips a session with work in flight, after the idle clock and before the kill', () => {
    const body = fnBody('startIdleReaper');
    const idle = body.indexOf('now - last < SESSION_IDLE_TIMEOUT_MS');
    const hold = body.indexOf('sessionWorkHold(session, last, now, processTable())');
    const kill = body.indexOf("killSession(session, 'SIGTERM')");
    expect(idle).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(idle);
    expect(kill).toBeGreaterThan(hold);
    expect(body).toMatch(/debug\(`Not reaping \$\{roomId\}: \$\{hold\.reason\}`\)/);
    // The lease is (re)issued once per tick from the number of held sessions
    // and the marker rewritten — so it lapses on its own when nothing holds.
    expect(body).toMatch(/workHoldUntil = held > 0 \? now \+ WORK_HOLD_LEASE_MS : 0;/);
    expect(body).toMatch(/refreshKeepAwakeMarker\(\);/);
  });

  it('reads the process table at most once per tick, only when a session has passed the idle timeout', () => {
    const body = fnBody('startIdleReaper');
    expect(body).toMatch(/let table = null;/);
    expect(body).toMatch(/const processTable = \(\) => \(table \?\?= readProcessTable\(\)\);/);
  });

  it('finds the claude child pid for every session shape', () => {
    const body = fnBody('sessionChildPid');
    expect(body).toMatch(/session\.proc\?\.pid/);
    expect(body).toMatch(/session\.iv\?\.pty\?\.pid/);
    expect(body).toMatch(/session\.codex\?\.child\?\.pid/);
  });

  it('decides with the pure helper on the session\'s busy flag and live work children', () => {
    const body = fnBody('sessionWorkHold');
    expect(body).toMatch(/workHold\(\{\s*busy: !!session\.busy,\s*children: liveWorkChildren\(sessionChildPid\(session\), table, MCP_SERVER_SIGNATURES\),\s*idleSince: last,\s*now,?\s*\}\)/);
  });

  it('knows the MCP servers by the merged config claude is spawned with — every extras group, local overlay included', () => {
    // Bugbot on #289: a stock-server denylist pinned a session that had an
    // mcp-config.local.json extra running. The signatures come from the same
    // buildMcpServers() resolution the spawn uses (absolute paths, macify).
    expect(index).toMatch(/import \{[^}]*\bmcpServerSignatures\b[^}]*\} from '\.\/lib\/work-hold\.js'/);
    const decl = index.indexOf('const MCP_SERVER_SIGNATURES = mcpServerSignatures(');
    expect(decl).toBeGreaterThan(-1);
    const block = index.slice(decl, decl + 600);
    expect(block).toMatch(/KNOWN_MCP_EXTRAS\.map\(/);
    expect(block).toMatch(/buildMcpServers\(\{ baseConfig: RAW_MCP_CONFIG, extras, askUserBaseDir: __dirname \}\)/);
  });

  it('reads the process table with ps, failing closed to an empty table', () => {
    const body = fnBody('readProcessTable');
    expect(body).toMatch(/execFileSync\('ps', \['-axo', 'pid=,ppid=,args='\]/);
    expect(body).toMatch(/return parseProcessTable\(/);
    expect(body).toMatch(/catch[\s\S]*return \[\];/);
  });

  it('the keep-awake marker is the later of the reminder hold and the work lease, and is refreshable without a timer save', () => {
    // The timer save path (pinned by reminders-wiring) still calls
    // writeKeepAwakeMarker(data.timers); both it and the reaper's refresh go
    // through the same writer, so the two sources can never overwrite each
    // other with a marker that forgets the other one.
    expect(index).toMatch(/function writeKeepAwakeMarker\(timers\) \{\s*\n\s*writeKeepAwake\(keepAwakeMarker\(timers\)\);/);
    expect(index).toMatch(/function refreshKeepAwakeMarker\(\) \{\s*\n\s*writeKeepAwake\(timerStore\.holdAwakeMarker\(\)\);/);
    const body = fnBody('writeKeepAwake');
    expect(body).toMatch(/keepAwakeUntil\(\{ timerUntil: marker\?\.until \?\? null, workUntil: workHoldUntil \}\)/);
    expect(body).toMatch(/fs\.rmSync\(KEEPAWAKE_FILE, \{ force: true \}\)/);
    expect(body).toMatch(/atomicWriteFileSync\(KEEPAWAKE_FILE, JSON\.stringify\(\{ until, reminders: marker\?\.reminders \?\? 0, work: workHoldSessions, updatedAt: Date\.now\(\) \}, null, 2\)\)/);
    expect(index).toMatch(/import \{[^}]*\bkeepAwakeUntil\b[^}]*\} from '\.\/lib\/work-hold\.js'/);
  });

  it('tells the agent that a running turn or background job already holds the box', () => {
    for (const [name, text] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd], ['ask-user.js', askUser]]) {
      expect(text, `${name} should say work in flight already holds the box and the session`).toMatch(/turn in progress[^\n]*background[^\n]*(hold|keep)[^\n]*(box|session)/i);
    }
  });
});
