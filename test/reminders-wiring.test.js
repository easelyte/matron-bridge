import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js / ask-user.js / the bridge guidance,
// the same idiom as test/items-wiring.test.js: none of these files has a
// unit harness, and every coupling below fails silently — a missing route
// answers 404, a tool that forgets roomId gets "roomId is required", a
// marker the host never sees just lets the box sleep.
const TOOLS = ['create', 'list', 'cancel'];

describe('reminders wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  it('mounts the three /reminders routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/reminders\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /reminders route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...TOOLS].sort());
    expect(index).toContain('reminderHandlers[name]');
    expect(index).toMatch(/createReminderHandlers\(\{[\s\S]*?timerStore,[\s\S]*?announce: announceAgentReminder/);
  });

  it('writes the guest-side keep-awake marker from the same save the timers persist through', () => {
    // The host's vm-idle-stop probe greps ~/.matron-bridge-keepawake.json for
    // "until":<epoch-ms>; the marker must be derived from the persisted
    // timers (one source of truth) and removed when no hold remains.
    expect(index).toMatch(/const KEEPAWAKE_FILE = path\.join\(os\.homedir\(\), '\.matron-bridge-keepawake\.json'\)/);
    expect(index).toMatch(/save: \(data\) => \{\n\s*atomicWriteFileSync\(TIMERS_FILE, JSON\.stringify\(data, null, 2\)\);\n\s*writeKeepAwakeMarker\(data\.timers\);/);
    expect(index).toMatch(/keepAwakeMarker\(timers\)/);
    expect(index).toMatch(/fs\.rmSync\(KEEPAWAKE_FILE, \{ force: true \}\)/);
  });

  it('the idle reaper leaves a session alone while it holds a hold-awake reminder', () => {
    const reaper = index.slice(index.indexOf('function startIdleReaper'), index.indexOf('function startIdleReaper') + 2500);
    expect(reaper).toMatch(/if \(now - last < SESSION_IDLE_TIMEOUT_MS\) continue;\n[\s\S]*?holdAwakeUntil\(journalConvoIdFor\(session\)\)[\s\S]*?continue;/);
  });

  it('fires an agent reminder as a turn the model can tell from user input', () => {
    const fire = index.slice(index.indexOf('async function fireTimer'), index.indexOf('async function fireTimer') + 1600);
    expect(fire).toMatch(/record\.source === 'agent'/);
    expect(fire).toMatch(/⏰ Reminder #\$\{record\.id\}/);
  });

  it('registers the three reminder_* tools, each posting through callReminders with roomId', () => {
    for (const t of TOOLS) {
      expect(askUser, `reminder_${t} is not registered`).toContain(`'reminder_${t}',`);
      expect(askUser, `reminder_${t} does not go through callReminders`).toContain(`callReminders('${t}',`);
    }
    expect(askUser).toMatch(/fetch\(`\$\{BRIDGE_API\}\/reminders\/\$\{name\}`[\s\S]*?JSON\.stringify\(\{ roomId: ROOM_ID, \.\.\.args \}\)/);
  });

  it('tells both agents to prefer reminder_create over in-process scheduling for anything past the idle reap', () => {
    for (const md of [claudeMd, codexMd]) {
      expect(md).toContain('reminder_create');
      expect(md).toContain('hold_awake');
    }
    expect(claudeMd).toMatch(/CronCreate/);
  });
});
