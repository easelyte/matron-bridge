import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINK_CHECK_FIELDS } from '../lib/tracker-link-check.js';

describe('tracker link check wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('builds one checker from the journal lookup, the search route and the session\'s link base', () => {
    expect(index).toContain("import { createTrackerLinkChecker, withTrackerLinkCheck, LINK_CHECK_FIELDS } from './lib/tracker-link-check.js';");
    const start = index.indexOf('const trackerLinkCheck = createTrackerLinkChecker({');
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, index.indexOf('});', start));
    expect(block).toContain('lookup: (user, num) => sharingClient.lookup(user, num),');
    expect(block).toContain('missionsClient.searchAll(');
    expect(block).toContain('base: () => trackerUrlBaseNow(),');
  });

  it('runs the check in front of every route it lists', () => {
    expect(index).toContain("linkChecked('agent-chat-start', agentChatHandlers.chatStart)");
    expect(index).toContain("linkChecked('agent-chat-send', agentChatHandlers.chatSend)");
    expect(index).toContain('linkChecked(`items/${name}`, itemsHandlers[name])');
    expect(index).toContain('linkChecked(`missions/${name}`, handler)');
    expect(index).toContain('linkChecked(`briefing/${name}`, briefingHandlers[name])');
    expect(index).toContain('linkChecked(`sharing/${name}`, sharingHandlers[name])');
    // Every listed route is one those matchers can reach.
    const reachable = (route) => {
      const [group, op] = route.split('/');
      if (!op) return index.includes(`url.pathname === '/${group}'`);
      const m = index.match(new RegExp(`url\\.pathname\\.match\\(/\\^\\\\/${group}\\\\/\\(([a-z_|]+)\\)\\$/\\)`));
      return !!m && m[1].split('|').includes(op);
    };
    for (const route of Object.keys(LINK_CHECK_FIELDS)) expect(reachable(route), route).toBe(true);
  });
});
