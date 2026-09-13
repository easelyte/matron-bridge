import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js / ask-user.js, the same idiom as
// test/inflight-wiring.test.js: neither file has a unit-test harness (index.js
// boots a server, ask-user.js connects a stdio transport at import), so the
// couplings below have no behavioural coverage at all. Each one regresses
// silently — a missing route answers 404 with no stack trace anywhere, and a
// tool that forgets roomId gets "roomId is required" from a handler the user
// never sees.
const TOOLS = ['create', 'list', 'get', 'comment', 'close', 'reopen', 'reorder', 'move'];

describe('items tracker wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

  it('mounts all eight /items routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/items\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /items route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...TOOLS].sort());
    expect(index).toContain('itemsHandlers[name]');
  });

  it('uploads item attachments through send-attachment\'s guarded resolver, not a bespoke read', () => {
    expect(index).toMatch(/uploadLocalFile: \(session, reqPath\) => resolveAndUploadLocalFile\(\{ session, reqPath, publisher: journalPublisher \}\)/);
  });

  it('registers all eight item_* tools, each posting through callItems', () => {
    for (const t of TOOLS) {
      expect(askUser, `item_${t} is not registered`).toContain(`'item_${t}',`);
      expect(askUser, `item_${t} does not go through callItems`).toContain(`callItems('${t}',`);
    }
  });

  it('sends roomId on every item route call', () => {
    expect(askUser).toContain('JSON.stringify({ roomId: ROOM_ID, ...args })');
  });
});
