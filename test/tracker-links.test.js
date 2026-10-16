import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { trackerUrlBase, trackerLink, renderTrackerLinks, FALLBACK_TRACKER_URL } from '../lib/tracker-links.js';
import { createJournalIdentity } from '../lib/journal-identity.js';
import { loadCoordinatorBlock, loadNoticesBlock } from '../lib/coordinator.js';

const BASE = 'https://chat.example/u/alice';

describe('trackerUrlBase', () => {
  it('builds <origin>/u/<name> from an https journal base and a journal name', () => {
    expect(trackerUrlBase({ httpBase: 'https://chat.example', userName: 'alice' })).toBe(BASE);
    expect(trackerUrlBase({ httpBase: 'https://chat.example/', userName: 'alice' })).toBe(BASE);
    expect(trackerUrlBase({ httpBase: 'https://example.com/journal/', userName: 'bob.b-1' })).toBe('https://example.com/journal/u/bob.b-1');
  });

  it('is null — the matron:// form — when either half is unknown or unusable', () => {
    for (const args of [
      {},
      { httpBase: 'https://chat.example' },
      { userName: 'alice' },
      { httpBase: '', userName: 'alice' },
      { httpBase: 'http://chat.example', userName: 'alice' }, // not reachable as a tapped link
      { httpBase: 'not a url', userName: 'alice' },
      { httpBase: 'https://u:p@chat.example', userName: 'alice' },
      { httpBase: 'https://chat.example/?x=1', userName: 'alice' },
      { httpBase: 'https://chat.example', userName: 'al ice' },
      { httpBase: 'https://chat.example', userName: '-alice' },
      { httpBase: 'https://chat.example', userName: 'a/../b' },
    ]) expect(trackerUrlBase(args), JSON.stringify(args)).toBeNull();
  });
});

describe('trackerLink', () => {
  it('appends the number to the https prefix, or falls back to matron://item', () => {
    expect(trackerLink(12, BASE)).toBe('https://chat.example/u/alice/12');
    expect(trackerLink(12)).toBe('matron://item/12');
    expect(trackerLink(12, null)).toBe(`${FALLBACK_TRACKER_URL}/12`);
  });
});

describe('renderTrackerLinks', () => {
  const text = 'Link it: `[#12]({{TRACKER_URL}}/12)`. {{TRACKER_LINK_RULE}} Convo: `[t](matron://convo/<id>)`.';

  it('renders the https form, naming every record kind and the per-user rule', () => {
    const out = renderTrackerLinks(text, BASE);
    expect(out).toContain('`[#12](https://chat.example/u/alice/12)`');
    expect(out).toMatch(/Items, missions, milestones and projects/);
    expect(out).toMatch(/Numbers are per-user/);
    expect(out).toContain('`https://chat.example/u/<their name>/<their number>`');
    expect(out).toContain('matron://convo/<id>');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('matron://item');
  });

  it('renders the old matron:// form when the name or origin is unknown', () => {
    const out = renderTrackerLinks(text, null);
    expect(out).toContain('`[#12](matron://item/12)`');
    expect(out).toContain('Link items by number: `[#12](matron://item/12)`.');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('/u/');
  });

  it('passes a missing block through', () => {
    expect(renderTrackerLinks(null, BASE)).toBeNull();
    expect(renderTrackerLinks(undefined, null)).toBeUndefined();
  });
});

// Every shipped instruction file, rendered the way a spawn renders it.
describe('the instruction files, rendered', () => {
  const root = new URL('../', import.meta.url);
  const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
  const coordinatorBlock = loadCoordinatorBlock({
    readFile: (p) => readFileSync(p, 'utf8'),
    path: fileURLToPath(new URL('BRIDGE_COORDINATOR.md', root)),
    dir: fileURLToPath(new URL('coordinator', root)),
    readDir: (d) => readdirSync(d),
  });
  const notices = loadNoticesBlock({ readFile: (p) => readFileSync(p, 'utf8'), path: fileURLToPath(new URL('BRIDGE_NOTICES.md', root)) });
  const files = {
    'BRIDGE_CLAUDE.md': read('BRIDGE_CLAUDE.md'),
    'BRIDGE_CODEX.md': read('BRIDGE_CODEX.md'),
    'coordinator block': coordinatorBlock,
    'notices block': [notices.all, notices.coordinator].join('\n\n'),
  };

  for (const [name, raw] of Object.entries(files)) {
    it(`${name} uses the placeholder, never a hard-coded item link`, () => {
      expect(raw).toContain('{{TRACKER_URL}}/');
      expect(raw).not.toMatch(/matron:\/\/item\/(\d|N)/);
      expect(raw).not.toMatch(/\/u\/[A-Za-z]/);
    });

    it(`${name} renders the https form when the user name is known`, () => {
      const out = renderTrackerLinks(raw, BASE);
      expect(out).not.toContain('{{');
      expect(out).toMatch(/\]\(https:\/\/chat\.example\/u\/alice\/(12|N)\)/);
      expect(out).not.toContain('matron://item');
    });

    it(`${name} renders the matron:// form when it is not`, () => {
      const out = renderTrackerLinks(raw, null);
      expect(out).not.toContain('{{');
      expect(out).toMatch(/\]\(matron:\/\/item\/(12|N)\)/);
      expect(out).not.toContain('/u/');
    });
  }

  it('the main prompts and the coordinator block state the per-user rule in the https form', () => {
    for (const name of ['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'coordinator block']) {
      expect(renderTrackerLinks(files[name], BASE), name).toMatch(/Numbers are per-user: a link to another user's shared item or mission uses their name/);
    }
  });

  it('keeps conversation links in the matron://convo form (the journal has no https form for them)', () => {
    for (const name of ['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'coordinator block']) {
      expect(renderTrackerLinks(files[name], BASE), name).toContain('matron://convo/<');
    }
  });
});

describe('createJournalIdentity', () => {
  const ok = (name) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user: { id: 'u1', name, is_admin: false } }) }));

  it('reads the name from GET /me with the agent token, and keeps it', async () => {
    const fetchImpl = ok('alice');
    const saved = [];
    const id = createJournalIdentity({ baseUrl: 'https://chat.example/', token: 'tok', fetchImpl, save: (d) => saved.push(d) });
    expect(id.name()).toBeNull();
    expect(await id.refresh()).toBe('alice');
    expect(fetchImpl).toHaveBeenCalledWith('https://chat.example/me', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer tok' } }));
    expect(saved).toEqual([{ base: 'https://chat.example', name: 'alice' }]);
    // Known: an unforced refresh does not ask again; a forced one does.
    await id.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await id.refresh({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(saved.length).toBe(1); // unchanged name, nothing rewritten
  });

  it('starts from the persisted name for the same journal only', () => {
    const load = () => ({ base: 'https://chat.example', name: 'alice' });
    expect(createJournalIdentity({ baseUrl: 'https://chat.example', token: 't', load }).name()).toBe('alice');
    expect(createJournalIdentity({ baseUrl: 'https://other.example', token: 't', load }).name()).toBeNull();
    expect(createJournalIdentity({ baseUrl: 'https://chat.example', token: 't', load: () => { throw new Error('corrupt'); } }).name()).toBeNull();
  });

  it('stays unknown, warning once, when the journal fails; never throws', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const id = createJournalIdentity({ baseUrl: 'https://chat.example', token: 'tok', fetchImpl, log: { warn } });
    expect(await id.refresh()).toBeNull();
    expect(await id.refresh()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('tok');
    const throwing = createJournalIdentity({ baseUrl: 'https://chat.example', token: 'tok', fetchImpl: async () => { throw new Error('down'); }, log: { warn() {} } });
    await expect(throwing.refresh()).resolves.toBeNull();
  });

  it('does nothing without a journal', async () => {
    const fetchImpl = vi.fn();
    expect(await createJournalIdentity({ baseUrl: '', token: '', fetchImpl }).refresh()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// index.js boots a bridge at import, so its wiring is pinned by source text.
describe('index.js wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('builds the prefix from the journal base and the GET /me name', () => {
    expect(index).toContain("const trackerUrlBaseNow = () => trackerUrlBase({ httpBase: journalHttpBase, userName: journalIdentity.name() });");
    expect(index).toMatch(/createJournalIdentity\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,/);
  });

  it('refreshes the name at boot and on every hello_ok (forced) and at each spawn', () => {
    expect(index.match(/journalIdentity\.refresh\(\{ force: true \}\);/g)?.length).toBe(2);
    expect(index).toMatch(/userDefaults\.refresh\(\);\n\s*journalIdentity\.refresh\(\);/);
  });

  it('renders every instruction block through it at spawn', () => {
    expect(index.match(/basePrompt: trackerLinksNow\(BRIDGE_SYSTEM_PROMPT\), block: trackerLinksNow\(COORDINATOR_BLOCK\)/g)?.length).toBe(2);
    expect(index).toContain('baseInstructions: trackerLinksNow(CODEX_BRIDGE_PROMPT), block: trackerLinksNow(COORDINATOR_BLOCK)');
    expect(index).toContain('coordinatorTurnText(role, trackerLinksNow(COORDINATOR_BLOCK)');
    expect(index).toMatch(/const noticesBlockNow = [^\n]*=> trackerLinksNow\(renderNoticesBlock\(/);
    expect(index).not.toMatch(/(basePrompt|baseInstructions|block): (BRIDGE_SYSTEM_PROMPT|CODEX_BRIDGE_PROMPT|COORDINATOR_BLOCK)[,)]/);
  });
});
