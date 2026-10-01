import { readFileSync, readdirSync } from 'node:fs';
import { loadCoordinatorBlock } from '../lib/coordinator.js';
import { describe, expect, it } from 'vitest';

// The Coordinator prompt is the preamble plus the playbook directory
// (spec 2026-10-01 coordinator routines), assembled as index.js does.
const coordinatorPlaybook = () => loadCoordinatorBlock({
  readFile: (p) => readFileSync(p, 'utf8'),
  path: new URL('../BRIDGE_COORDINATOR.md', import.meta.url).pathname,
  dir: new URL('../coordinator', import.meta.url).pathname,
  readDir: (d) => readdirSync(d),
});

const OPS = ['start', 'create', 'post', 'update', 'status', 'join', 'leave', 'get', 'list', 'close'];
const TOOL_CALLS = {
  mission_start: "callMissions('start', args, formatStartAck)",
  mission_create: "callMissions('create', args, formatCreateAck)",
  milestone_post: "callMissions('post', args, formatMilestoneAck)",
  mission_update: "callMissions('update', args, formatUpdateAck)",
  mission_status: "callMissions('status', args, formatStatusAck)",
  mission_join: "callMissions('join', args, formatJoinAck)",
  mission_leave: "callMissions('leave', args, formatLeaveAck)",
  mission_get: "callMissions('get', args, formatMissionDetail)",
  mission_list: "callMissions('list', args, formatMissionList)",
  mission_close: "callMissions('close', args, (d) => missionLine(d.mission))",
  item_move: "callItems('move', args, (d) => itemLine(d.item))",
};
// Spec 2026-09-28 missions dashboard §2 — the agent reads exactly this.
const MISSION_STATUS_DESCRIPTION = "Set the mission's status — one short paragraph (≤600 chars) saying where the work is, what's next, and anything blocked or waiting on the user. It is the headline on the mission's card in the apps, so write it for the user at a glance, not as a log. Replace it whenever that picture changes: after a progress milestone, when you get blocked, when you hand off. Pass `mission` only to set another mission's status (the Coordinator does this).";

describe('missions wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  it('mounts all ten /missions routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/missions\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /missions route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('missionsHandlers[name]');
    expect(index).toMatch(/createMissionsHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: missionsClient,?\s*\}\)/);
  });

  it('registers the ten mission tools and item_move, each pinned to its exact renderer', () => {
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
    expect(fn).toMatch(/payload\.idem_key = missionIdemKey\(\{ op: name, roomId: ROOM_ID, kind: args\?\.kind, title: args\?\.title, body: args\?\.body, mission: args\?\.mission \}\)/);
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
    expect(claudeMd).toContain("Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not, unless you pass `mission: N` — then it is on mission #N from its first turn.");
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

  it('mission_create sends an idem_key and renders through formatCreateAck', () => {
    const start = askUser.indexOf('async function callMissions');
    const fn = askUser.slice(start, askUser.indexOf('const missionToolName'));
    expect(fn).toMatch(/name === 'start' \|\| name === 'post' \|\| name === 'create'/);
    expect(askUser).toMatch(/import \{[^}]*\bformatCreateAck\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
    expect(askUser).toContain("create: 'mission_create'");
  });

  it('both prompt files teach mission_create and the agent_session_start mission param', () => {
    expect(claudeMd).toMatch(/`mission_create` creates a mission without joining this conversation to it/);
    expect(claudeMd).toMatch(/`agent_session_start` .*`mission: N`/);
    expect(codexMd).toMatch(/`mission_create`/);
    expect(codexMd).toMatch(/`mission: N`/);
    expect(codexMd).toMatch(/"attach":false/);
  });

  // M3 (final-review, 2026-09-30): `mission_start` returns the current
  // mission unchanged once there is one (BRIDGE_CLAUDE.md two lines
  // earlier), so "Use mission_start for your own work" read as though it
  // still applied after the conversation already has one.
  it('BRIDGE_CLAUDE.md scopes "Use mission_start for your own work" to a conversation with no mission yet', () => {
    expect(claudeMd).toContain('Use `mission_start` for your own work when this conversation has no mission yet.');
    expect(claudeMd).not.toContain('Use `mission_start` for your own work.');
  });

  it('mission_close takes an optional mission number for the Coordinator, and the Coordinator prompt teaches it', () => {
    const tool = askUser.slice(askUser.indexOf("'mission_close',"), askUser.indexOf("'item_move',"));
    expect(tool).toContain("mission: z.number().int().min(1).optional()");
    expect(tool).toMatch(/Coordinator/);
    const coord = coordinatorPlaybook();
    expect(coord).toMatch(/^## Procedure: close missions/m);
    expect(coord).toContain('`mission_close` with `mission: N`');
    expect(coord).toContain('Never call `mission_close` without `mission`');
    // I1 (final-review, 2026-09-30): the journal allows a named-mission close
    // to any conversation with an active link to it, not the Coordinator
    // alone — the prompt must not claim exclusivity it no longer has.
    expect(coord).not.toContain('The journal allows this to the Coordinator alone.');
  });

  it('mission_status carries the spec description verbatim and its schema; mission_list takes only state', () => {
    const tool = askUser.slice(askUser.indexOf("'mission_status',"), askUser.indexOf("'mission_list',"));
    expect(tool).toContain(JSON.stringify(MISSION_STATUS_DESCRIPTION));
    expect(tool).toMatch(/status: z\.string\(\)/);
    expect(tool).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    const listStart = askUser.indexOf("'mission_list',");
    const list = askUser.slice(listStart, askUser.indexOf("'mission_join',", listStart));
    expect(list).toMatch(/state: z\.enum\(\['open', 'closed'\]\)\.optional\(\)/);
    expect(askUser).toMatch(/import \{[^}]*\bformatStatusAck\b[^}]*\bformatMissionList\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
  });

  it('both prompt files teach mission_status: after a progress milestone that changes the card, blocked, handing off — one status, overwritten', () => {
    for (const [name, md] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
      const section = md.slice(md.indexOf('## Missions & milestones'));
      expect(section, name).toMatch(/`mission_status`/);
      expect(section, name).toMatch(/Set it when you become blocked or hand off, when the user redirects the work, and after a `progress` milestone that changes the picture on the card \(where it is, what's next, what's blocked\) — not after every checkpoint/);
      expect(section, name).toMatch(/one status, overwritten, not a second milestone log/);
    }
    expect(codexMd).toMatch(/`mission_close`, `milestone_post`, `mission_status`, `mission_list`, `item_move`/);
    expect(codexMd).toContain('`{"status":"...","convo_id":"<id>"}` sets the status');
    expect(codexMd).toContain('`GET $BASE/missions?state=open`');
    // Fix round 1 (#2): "Close it" read as closing the status, not the mission.
    expect(codexMd).toContain('Close the mission when the work is done, not when the session ends.');
  });

  it('the Coordinator brief carries the refresh procedure and the exact app message', () => {
    const coord = coordinatorPlaybook();
    expect(coord).toContain('## Procedure: refresh mission and project statuses');
    expect(coord).toContain('"Refresh the status of every open mission from its latest milestones, sessions and open items."');
    expect(coord).toMatch(/`mission_list` for the open missions, then for each one `mission_get N` and `mission_status` with `mission: N`/);
    // Fix round 1 (#1): the journal has no idle state — skip only on running
    // conversations, not a fictional "idle".
    // Fix round 2: neither mission_get nor item_list prints an item
    // timestamp, so "no open item newer than the status" isn't checkable —
    // skip only when every listed open item is already reflected in it.
    expect(coord).toMatch(/You may skip a mission whose status is newer than its last milestone, none of whose conversations is `running`, and where every open item `mission_get` lists is already reflected in the status/);
    expect(coord).not.toMatch(/whose sessions are all idle/);
    expect(coord).not.toMatch(/no open item newer than the status/);
    // Fix round 3 (final review #4): an agent-written status on a mission
    // with a running conversation must not be skipped by the FIRST rule
    // (it requires no conversation running) — a second rule covers it, so
    // the Coordinator does not overwrite a status the working agent just set.
    expect(coord).toContain('Also skip a mission whose status `mission_list` marks ", by an agent" when that status is newer than its last milestone, even if a conversation is running: the working agent that wrote it is keeping it current.');
    // Fix round 1 (#4): a status the user wrote themselves (", by the user")
    // is left alone unless clearly stale, and a replacement is called out.
    expect(coord).toContain('A status `mission_list` marks ", by the user" is one they wrote themselves: leave it unless it is clearly out of date against newer milestones or items, and if you do replace it, say so in that mission\'s reply line.');
    expect(coord).toMatch(/one line per mission( and per project)? you changed/);
    expect(coord).toContain('Never call `mission_status` without `mission`');
    expect(coord).toMatch(/`mission_list` for every open mission/);
  });

  it('spec 2026-09-30: new and changed mission schemas', () => {
    // R10: anchor on the registration — missionToolName names the tools too.
    const slice = (from, to) => askUser.slice(askUser.indexOf(`server.tool(\n  '${from}',`), askUser.indexOf(`server.tool(\n  '${to}',`));
    expect(slice('mission_start', 'mission_create')).toMatch(/project: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(slice('mission_create', 'milestone_post')).toMatch(/project: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(slice('milestone_post', 'mission_update')).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    const update = slice('mission_update', 'mission_status');
    expect(update).toMatch(/project: z\.number\(\)\.int\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/);
    expect(update).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(slice('mission_leave', 'mission_get')).toMatch(/num: z\.number\(\)\.int\(\)\.min\(1\)/);
    expect(slice('mission_join', 'mission_leave')).not.toMatch(/already belongs/);
    expect(askUser).not.toMatch(/already belongs to another mission/);
    expect(askUser).toContain("leave: 'mission_leave'");
    expect(askUser).toMatch(/import \{[^}]*\bformatJoinAck\b[^}]*\bformatLeaveAck\b[^}]*\bformatUpdateAck\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
  });
});
