import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS = ['start', 'post', 'update', 'join', 'get', 'close'];
const TOOL_CALLS = {
  mission_start: "callMissions('start', args, formatStartAck)",
  milestone_post: "callMissions('post', args, formatMilestoneAck)",
  mission_update: "callMissions('update', args, (d) => missionLine(d.mission))",
  mission_join: "callMissions('join', args, (d) => missionLine(d.mission))",
  mission_get: "callMissions('get', args, formatMissionDetail)",
  mission_close: "callMissions('close', args, (d) => missionLine(d.mission))",
  item_move: "callItems('move', args, (d) => itemLine(d.item))",
};

describe('missions wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  it('mounts all six /missions routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/missions\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /missions route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('missionsHandlers[name]');
    expect(index).toMatch(/createMissionsHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: missionsClient,?\s*\}\)/);
  });

  it('registers the six mission tools and item_move, each pinned to its exact renderer', () => {
    for (const [tool, call] of Object.entries(TOOL_CALLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through ${call}`).toContain(call);
    }
  });

  it('no mission or item_move tool schema takes a convo_id parameter', () => {
    expect(askUser).not.toMatch(/(?<!\w)convo_id:\s*z\./);
  });

  it('callMissions maps the journal error codes and sends an idem_key for the two creating ops only', () => {
    expect(askUser).toMatch(/import \{[^}]*\bformatJournalError\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
    expect(askUser).toMatch(/import \{[^}]*\bmissionIdemKey\b[^}]*\} from '\.\/lib\/missions-idem\.js'/);
    const start = askUser.indexOf('async function callMissions');
    const end = askUser.indexOf('const missionToolName');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = askUser.slice(start, end);
    // Non-409 errors are rendered through the mapper, never as data.error.
    expect(fn).toContain('formatJournalError(name, data)');
    expect(fn).not.toMatch(/failed: \$\{data\?\.error/);
    // start and post carry a key the model never supplies; update/join/get/
    // close must not (they are not idempotent routes on the journal).
    expect(fn).toMatch(/name === 'start' \|\| name === 'post'/);
    expect(fn).toMatch(/payload\.idem_key = missionIdemKey\(\{ op: name, roomId: ROOM_ID, kind: args\?\.kind, title: args\?\.title, body: args\?\.body \}\)/);
    expect(fn).toContain('body: JSON.stringify(payload)');
    // …and no tool schema exposes it.
    expect(askUser).not.toMatch(/idem_key:\s*z\./);
  });

  it('both prompt files carry the missions section', () => {
    expect(claudeMd).toMatch(/^## Missions & milestones/m);
    expect(claudeMd).toMatch(/mission_start/);
    expect(claudeMd).toMatch(/kind: "user_input"/);
    expect(claudeMd).toMatch(/refused until the conversation has a mission/);
    expect(codexMd).toMatch(/^## Missions & milestones/m);
    expect(codexMd).toMatch(/POST \$BASE\/milestones/);
  });

  it('the prompts promise only the inheritance the journal actually wires, and idempotency-key REUSE', () => {
    // Only conversations with a parent_convo_id inherit; a box spawned via
    // agent_session_start does not, so the prompt must not imply it does.
    expect(claudeMd).toContain("Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not — put the mission number in its task and have it `mission_join #N`.");
    expect(claudeMd).not.toMatch(/A spawned session inherits its parent's mission/);
    expect(codexMd).toMatch(/Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not/);
    // A fresh uuid per attempt defeats the whole point of the header.
    // Scoped to the missions section — the items section above it has its own
    // (older) idempotency wording that this branch does not touch.
    const missionsSection = codexMd.slice(codexMd.indexOf('## Missions & milestones'));
    expect(missionsSection).toMatch(/REUSE the same key when you retry the same request/);
    expect(missionsSection).not.toMatch(/Idempotency-Key: \$\(uuidgen\)/);
    expect(missionsSection).toMatch(/KEY=\$\(uuidgen\)/);
    expect(missionsSection).toMatch(/Idempotency-Key: \$KEY/);
  });
});
