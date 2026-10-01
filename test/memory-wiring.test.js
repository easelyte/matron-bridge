import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the memories wiring (spec 2026-09-27 memories, "Bridge") is
// pinned by source inspection — same approach as test/coordinator-wiring.test.js
// and test/missions-wiring.test.js. The decisions themselves are unit-tested
// in test/memory-*.test.js and test/coordinator.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

const OPS = ['save', 'list', 'get', 'delete'];
const TOOL_CALLS = {
  memory_save: "callMemory('save', args, formatSaveAck)",
  memory_list: "callMemory('list', args, formatMemoryList)",
  memory_get: "callMemory('get', args, formatMemoryDetail)",
  memory_delete: "callMemory('delete', args, formatDeleteAck)",
};

describe('memory tools wiring (source inspection)', () => {
  it('builds the client, the lookup and the handlers on the journal base and token', () => {
    expect(index).toMatch(/const memoryClient = createMemoryClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    expect(index).toMatch(/const memoryLookup = createMemoryLookup\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    expect(index).toContain('const repoNames = createRepoNameLookup();');
    expect(index).toContain('const memoryBlockNow = ({ coordinator, workdir }) => renderMemoryBlock(memoryLookup.snapshot(), { coordinator: coordinator === true, repo: repoNames.nameFor(workdir) });');
    expect(index).toMatch(/const memoryHandlers = createMemoryHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: memoryClient,\s*isCoordinator: \(session, convoId\) => session\?\.coordinator === true \|\| \(!!convoId && coordinatorLookup\.snapshot\(\)\.convoId === convoId\),\s*repoFor: \(session\) => repoNames\.nameFor\(session\?\.workdir\),\s*\}\);/);
  });

  it('mounts the four /memory routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/memory\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /memory route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('memoryHandlers[name]');
  });

  it('refreshes the memory cache at boot, on every hello_ok, behind every spawn and on every memory marker', () => {
    const boot = body('if (JOURNAL_ENABLED) {', '\nfunction expandHome(');
    expect(boot).toContain('memoryLookup.refresh({ force: true });');
    const reconnect = body('function handleJournalReconnect()', '\nfunction ');
    expect(reconnect).toContain('memoryLookup.refresh({ force: true });');
    const spawn = body('function coordinatorRoleAtSpawn(', '\nfunction ');
    expect(spawn).toContain('memoryLookup.refresh();');
    expect(index).toMatch(/onMemoryEvent: \(\) => \{ memoryLookup\.refresh\(\{ force: true \}\); \},/);
  });

  it('all three spawn builders and the live assigned turn carry the memory block for that session\'s role and workdir', () => {
    const audience = '{ coordinator: !!options.coordinator, workdir: cwd }';
    expect(index).toContain(`claudeCoordinatorArgs({ coordinator: !!options.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK, baseDisallowed: ['AskUserQuestion'], memoryBlock: memoryBlockNow(${audience}) });`);
    expect(index).toContain(`claudeCoordinatorArgs({ coordinator: !!options.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK, memoryBlock: memoryBlockNow(${audience}) });`);
    expect(index).toContain(`codexCoordinatorOptions({ coordinator: !!options.coordinator, baseInstructions: CODEX_BRIDGE_PROMPT, block: COORDINATOR_BLOCK, baseSandbox: CODEX_SANDBOX_MODE, memoryBlock: memoryBlockNow(${audience}) });`);
    expect(index).toContain("coordinatorTurnText(role, COORDINATOR_BLOCK, memoryBlockNow({ coordinator: role === 'assigned', workdir: target?.workdir }))");
    expect(index).not.toContain('memoryBlockNow()');
    expect(index).not.toContain('coordinatorTurnText(role, COORDINATOR_BLOCK)');
  });

  it('a new Coordinator refreshes its memories before it is respawned', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    const refreshAt = fn.indexOf("if (role === 'assigned') await memoryLookup.refresh({ force: true });");
    const respawnAt = fn.indexOf('recreateSession(roomId');
    expect(refreshAt).toBeGreaterThan(-1);
    expect(respawnAt).toBeGreaterThan(refreshAt);
  });

  it('registers the four memory tools, each pinned to its exact renderer, with no convo_id parameter', () => {
    for (const [tool, call] of Object.entries(TOOL_CALLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through ${call}`).toContain(call);
    }
    expect(askUser).toMatch(/import \{[^}]*\bformatSaveAck\b[^}]*\} from '\.\/lib\/memory-format\.js'/);
    const fn = askUser.slice(askUser.indexOf('async function callMemory'), askUser.indexOf("server.tool(\n  'memory_save'"));
    expect(fn).toContain('`${BRIDGE_API}/memory/${name}`');
    expect(fn).toContain('body: JSON.stringify({ roomId: ROOM_ID, ...args })');
  });

  it('memory_save tells the model the description is the line every session sees and that an update must send the body back', () => {
    const tool = askUser.slice(askUser.indexOf("'memory_save'"), askUser.indexOf("'memory_list'"));
    expect(tool).toMatch(/one line every session sees at spawn/);
    expect(askUser).not.toMatch(/read by the Coordinator/);
    expect(tool).toMatch(/send the body back/);
    expect(tool).toMatch(/one memory per rule/);
  });

  it('memory_save takes a scope and memory_list an all flag, each explained (spec 2026-10-01 memory scopes)', () => {
    const save = askUser.slice(askUser.indexOf("'memory_save'"), askUser.indexOf("'memory_list'"));
    expect(save).toMatch(/scope: z\.string\(\)\.optional\(\)/);
    expect(save).toMatch(/'coordinator'.*'repo:<name>'/);
    expect(save).toMatch(/Omitted on an update keeps the stored scope/);
    const list = askUser.slice(askUser.indexOf("'memory_list'"), askUser.indexOf("'memory_get'"));
    expect(list).toMatch(/all: z\.boolean\(\)\.optional\(\)/);
    expect(list).toMatch(/the Coordinator always gets every one/);
    expect(askUser).toMatch(/const MEMORY_WHAT = .*Each has a scope/);
  });

  it('the instruction files explain the three scopes and when to pick each', () => {
    for (const file of ['BRIDGE_COORDINATOR.md', 'BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md']) {
      const md = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(md, `${file} does not name the scopes`).toMatch(/`global`.*`coordinator`.*`repo:<name>`/s);
    }
    const coord = readFileSync(new URL('../BRIDGE_COORDINATOR.md', import.meta.url), 'utf8');
    expect(coord).toMatch(/you see every memory in every scope/);
    expect(coord).toMatch(/scope: 'coordinator'/);
    for (const file of ['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md']) {
      const md = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(md, `${file} does not say the section names its scopes`).toMatch(/says which scopes it covers/);
      expect(md, `${file} does not mention all: true`).toMatch(/`all: true`/);
    }
  });

  it('the instruction files tell sessions and the Coordinator to save rules with memory_save', () => {
    for (const file of ['BRIDGE_COORDINATOR.md', 'BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md']) {
      const md = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(md, `${file} does not mention memory_save`).toContain('memory_save');
    }
    const coord = readFileSync(new URL('../BRIDGE_COORDINATOR.md', import.meta.url), 'utf8');
    expect(coord).toContain('## Remember what the user tells you');
    expect(coord).toMatch(/Do not park rules in decision items/);
  });

  it('the Claude and Codex instruction files tell every session its memories are listed at the end and to follow them', () => {
    for (const file of ['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md']) {
      const md = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(md, `${file} does not point at the injected index`).toMatch(/listed under "Your memories" at the end of these instructions/);
      expect(md, `${file} does not say to follow them`).toMatch(/follow them without being asked/);
      expect(md, `${file} still says only the Coordinator reads memories`).not.toMatch(/read by the Coordinator/);
    }
  });
});
