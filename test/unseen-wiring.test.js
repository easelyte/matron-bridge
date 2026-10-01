import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { loadCoordinatorBlock } from '../lib/coordinator.js';

// index.js cannot be imported in-process (top-level side effects), so the
// unseen wiring is pinned by source inspection, like consent-wiring. The
// handlers themselves are unit-tested in test/unseen-tools.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
// The Coordinator prompt is the preamble plus the playbook directory
// (spec 2026-10-01 coordinator routines), assembled as index.js does.
const coord = loadCoordinatorBlock({
  readFile: (p) => readFileSync(p, 'utf8'),
  path: new URL('../BRIDGE_COORDINATOR.md', import.meta.url).pathname,
  dir: new URL('../coordinator', import.meta.url).pathname,
  readDir: (d) => readdirSync(d),
});
const claude = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
const codex = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('unseen wiring (source inspection)', () => {
  it('builds the client and the handlers, counting the journal\'s current Coordinator', () => {
    expect(index).toMatch(/const unseenClient = createUnseenClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\)/);
    expect(index).toMatch(/const unseenHandlers = createUnseenHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: unseenClient,/);
    const h = body('const unseenHandlers = createUnseenHandlers({', '});');
    expect(h).toContain('coordinatorLookup.snapshot().convoId === convoId');
  });

  it('mounts /unseen/list, /unseen/mine and /unseen/flag', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/unseen\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /unseen route matcher is missing').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual(['flag', 'list', 'mine']);
    expect(index).toContain('unseenHandlers[name]');
  });

  it('hands unseen frames to the Coordinator as a turn plus a notice, resuming it if reaped', () => {
    expect(index).toContain('onUnseenFrame: (frame) => journalHandleUnseenFrame(frame),');
    const fn = body('function journalHandleUnseenFrame(frame) {', '\n}');
    expect(fn).toContain("if (!frame || frame.event !== 'pending') return;");
    expect(fn).toContain('formatUnseenNudge(frame)');
    expect(fn).toContain('const { convoId } = coordinatorLookup.snapshot();');
    expect(fn).toContain('if (!session || !session.alive) session = journalResumeConvo(convoId, JOURNAL_RESUME_NOTICE);');
    expect(fn).toContain('journalPublishNotice(journalConvoIdFor(session), text)');
    expect(fn).toContain('deliverCoordinatorTurn(session, text)');
  });

  it('registers the three tools through callUnseen with their renderers', () => {
    expect(askUser).toMatch(/import \{[^}]*\bformatUnseenList\b[^}]*\} from '\.\/lib\/unseen-tools\.js'/);
    expect(askUser).toContain("callUnseen('list', args, formatUnseenList)");
    expect(askUser).toContain("callUnseen('mine', args, formatUnseenMine)");
    expect(askUser).toContain("callUnseen('flag', args, (d) => formatFlagAck(d, d.refs || args.refs))");
    for (const t of ["'unseen_list',", "'unseen_mine',", "'unseen_flag',"]) expect(askUser).toContain(t);
  });

  it('the prompts teach the rules: Coordinator section, and unseen_mine for every agent', () => {
    expect(coord).toMatch(/^## Procedure: tell the user what they missed/m);
    expect(coord).toMatch(/"You haven't seen" section: at most 5 lines/);
    expect(coord).toMatch(/call `unseen_flag` with its refs/);
    expect(coord).toMatch(/Never nag/);
    for (const doc of [claude, codex]) {
      expect(doc).toMatch(/^## Messages the user hasn't seen \(`unseen_mine`\)/m);
      expect(doc).toMatch(/restate it once, briefly/);
      expect(doc).toMatch(/never tell the user they haven't read something/);
    }
  });
});
