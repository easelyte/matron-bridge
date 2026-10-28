import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  loadNoticesBlock,
  renderNoticesBlock,
  claudeCoordinatorArgs,
  codexCoordinatorOptions,
  coordinatorTurnText,
  COORDINATOR_ASSIGNED_PREFIX,
  NOTICES_COORDINATOR_MARKER,
} from '../lib/coordinator.js';

const quiet = { warn: () => {} };
const md = readFileSync(new URL('../BRIDGE_NOTICES.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const real = loadNoticesBlock({ readFile: () => md, path: 'BRIDGE_NOTICES.md', log: quiet });

describe('BRIDGE_NOTICES.md', () => {
  it('has an every-session part and a Coordinator part, split at the marker', () => {
    expect(md).toContain(NOTICES_COORDINATOR_MARKER);
    expect(real.all).toMatch(/^## Things the user needs to read go to For you as notices/);
    expect(real.all).toContain('kind: "notice"');
    expect(real.all).toMatch(/Seen button/);
    expect(real.all).toMatch(/does not reach you|without reaching you/);
    expect(real.all).toMatch(/Routine news/);
    expect(real.all).toMatch(/Don't also file a question/);
    expect(real.all).not.toContain('Coordinator');
    expect(real.coordinator).toMatch(/Briefings and status replies/);
    expect(real.coordinator).toMatch(/open item already covers/);
    expect(real.all).not.toContain(NOTICES_COORDINATOR_MARKER);
    expect(real.coordinator).not.toContain(NOTICES_COORDINATOR_MARKER);
  });
});

describe('loadNoticesBlock', () => {
  it('a file without the marker is all every-session text', () => {
    expect(loadNoticesBlock({ readFile: () => '  hello \n', path: 'x', log: quiet })).toEqual({ all: 'hello', coordinator: '' });
  });
  it('an unreadable file warns and leaves the block out', () => {
    const warns = [];
    const r = loadNoticesBlock({ readFile: () => { throw new Error('ENOENT'); }, path: '/nope', log: { warn: (m) => warns.push(m) } });
    expect(r).toEqual({ all: '', coordinator: '' });
    expect(warns[0]).toMatch(/could not read \/nope/);
  });
});

describe('renderNoticesBlock', () => {
  const blocks = { all: 'ALL', coordinator: 'COORD' };
  it('off renders nothing, for anyone', () => {
    expect(renderNoticesBlock(blocks, { enabled: false })).toBe('');
    expect(renderNoticesBlock(blocks, { enabled: false, coordinator: true })).toBe('');
    expect(renderNoticesBlock(blocks, { enabled: false, coordinator: true, coordinatorOnly: true })).toBe('');
  });
  it('on: every session gets its part, the Coordinator its own part too', () => {
    expect(renderNoticesBlock(blocks, { enabled: true })).toBe('ALL');
    expect(renderNoticesBlock(blocks, { enabled: true, coordinator: true })).toBe('ALL\n\nCOORD');
    expect(renderNoticesBlock(blocks, { enabled: true, coordinator: true, coordinatorOnly: true })).toBe('COORD');
    expect(renderNoticesBlock(blocks, { enabled: true, coordinatorOnly: true })).toBe('');
    expect(renderNoticesBlock({ all: '', coordinator: '' }, { enabled: true, coordinator: true })).toBe('');
  });
});

describe('the notices block in a session\'s instructions', () => {
  const on = (coordinator) => renderNoticesBlock(real, { enabled: true, coordinator });
  const off = (coordinator) => renderNoticesBlock(real, { enabled: false, coordinator });

  it('notices on: Claude and Codex, ordinary and Coordinator, carry it before the memory block', () => {
    const c = claudeCoordinatorArgs({ coordinator: false, basePrompt: 'BASE', block: 'BLOCK', memoryBlock: 'MEM', noticesBlock: on(false) }).appendSystemPrompt;
    expect(c).toBe(`BASE\n\n${real.all}\n\nMEM`);
    const cc = claudeCoordinatorArgs({ coordinator: true, basePrompt: 'BASE', block: 'BLOCK', memoryBlock: 'MEM', noticesBlock: on(true) }).appendSystemPrompt;
    expect(cc).toBe(`BASE\n\nBLOCK\n\n${real.all}\n\n${real.coordinator}\n\nMEM`);
    const x = codexCoordinatorOptions({ coordinator: false, baseInstructions: 'B', block: 'K', baseSandbox: 's', memoryBlock: 'MEM', noticesBlock: on(false) }).developerInstructions;
    expect(x).toBe(`B\n\n${real.all}\n\nMEM`);
    const xc = codexCoordinatorOptions({ coordinator: true, baseInstructions: 'B', block: 'K', baseSandbox: 's', noticesBlock: on(true) }).developerInstructions;
    expect(xc).toBe(`B\n\nK\n\n${real.all}\n\n${real.coordinator}`);
    expect(coordinatorTurnText('assigned', 'BLOCK', 'MEM', renderNoticesBlock(real, { enabled: true, coordinator: true, coordinatorOnly: true })))
      .toBe(`${COORDINATOR_ASSIGNED_PREFIX}\n\nBLOCK\n\n${real.coordinator}\n\nMEM`);
  });

  it('notices off: the instructions are byte-identical to having no block at all', () => {
    expect(claudeCoordinatorArgs({ coordinator: false, basePrompt: 'BASE', block: 'BLOCK', memoryBlock: 'MEM', noticesBlock: off(false) }).appendSystemPrompt).toBe('BASE\n\nMEM');
    expect(claudeCoordinatorArgs({ coordinator: true, basePrompt: 'BASE', block: 'BLOCK', noticesBlock: off(true) }).appendSystemPrompt).toBe('BASE\n\nBLOCK');
    expect(codexCoordinatorOptions({ coordinator: false, baseInstructions: 'B', block: 'K', baseSandbox: 's', noticesBlock: off(false) }).developerInstructions).toBe('B');
    expect(coordinatorTurnText('assigned', 'BLOCK', '', off(true))).toBe(`${COORDINATOR_ASSIGNED_PREFIX}\n\nBLOCK`);
  });
});

describe('notices wiring (source inspection)', () => {
  it('reads BRIDGE_NOTICES.md (or BRIDGE_NOTICES_MD_PATH) once at boot', () => {
    expect(index).toContain("const DEFAULT_BRIDGE_NOTICES_MD_PATH = path.join(__dirname, 'BRIDGE_NOTICES.md');");
    expect(index).toContain('const BRIDGE_NOTICES_MD_PATH = process.env.BRIDGE_NOTICES_MD_PATH || DEFAULT_BRIDGE_NOTICES_MD_PATH;');
    expect(index).toMatch(/const NOTICES_BLOCKS = loadNoticesBlock\(\{\s*readFile: \(p\) => fs\.readFileSync\(p, 'utf-8'\),\s*path: BRIDGE_NOTICES_MD_PATH,/);
  });

  it('renders the block from the cached notices setting, kept current by the publisher\'s onSettings', () => {
    expect(index).toMatch(/const userSettings = createUserSettings\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    expect(index).toContain('renderNoticesBlock(NOTICES_BLOCKS, { enabled: userSettings.notices(), coordinator: coordinator === true, coordinatorOnly })');
    expect(index).toContain('onSettings: (settings, { hello }) => { if (hello) userSettings.onHello(settings); else userSettings.apply(settings); },');
    const builders = index.match(/noticesBlock: noticesBlockNow\(\{ coordinator: !!options\.coordinator \}\), matronMdBlock: matronMd\.block \}\);/g) || [];
    expect(builders).toHaveLength(3);
  });
});

describe('instruction files name the For you list and the notice kind', () => {
  for (const file of ['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'BRIDGE_COORDINATOR.md']) {
    it(file, () => {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text).toMatch(/For you/);
      expect(text).not.toMatch(/Decisions list|reaches them in Decisions/);
      expect(text).toMatch(/notice/);
      expect(text).toMatch(/built-in Seen button; the tap closes it and does not reach you/);
    });
  }
  it('the Codex HTTP fallback lists notice among the kinds', () => {
    const text = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');
    expect(text).toContain('kind=task|question|decision|notice');
    expect(text).toContain('"kind":"question"|"decision"|"task"|"notice"');
  });
});
