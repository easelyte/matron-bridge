import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-level pins for the `search` tool's plumbing (spec 2026-10-12
// unified search), same style as test/missions-wiring.test.js and the
// spawn-tool wiring block in test/agent-spawn.test.js: read index.js and
// ask-user.js as text and assert on the exact wiring, so a refactor that
// silently drops the route or the loopback call fails here rather than
// only showing up as a confusing runtime 404.
describe('search wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

  it('mounts the /search/all route through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/search\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /search route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual(['all']);
    expect(index).toContain('searchHandlers[name]');
    expect(index).toMatch(/createSearchHandlers\(\{\s*sessions,\s*client: missionsClient,?\s*\}\)/);
  });

  it('posts to the loopback search route with roomId: ROOM_ID', () => {
    const start = askUser.indexOf('async function callSearch');
    expect(start, 'callSearch is missing from ask-user.js').toBeGreaterThan(-1);
    const end = askUser.indexOf('\n}', start);
    const body = askUser.slice(start, end);
    expect(body).toContain('${BRIDGE_API}/search/all`');
    expect(body).toContain('roomId: ROOM_ID');
    expect(body).toMatch(/method: 'POST'/);
  });

  it('declares the search tool and routes it through callSearch', () => {
    expect(askUser).toMatch(/server\.tool\(\s*\n\s*'search',/);
    const start = askUser.indexOf("'search',");
    const next = askUser.indexOf('server.tool(', start);
    const block = askUser.slice(start, next === -1 ? undefined : next);
    expect(block).toContain('async (args) => callSearch(args)');
  });
});
