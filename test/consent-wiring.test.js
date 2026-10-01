import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { loadCoordinatorBlock } from '../lib/coordinator.js';

// index.js cannot be imported in-process (top-level side effects), so the
// consent wiring is pinned by source inspection — same approach as
// test/missions-wiring.test.js. The handlers themselves are unit-tested in
// test/consent-tools.test.js.
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

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('consent wiring (source inspection)', () => {
  it('builds the client on the journal HTTP base and the handlers on the shared session map', () => {
    expect(index).toMatch(/const consentClient = createConsentClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\)/);
    expect(index).toMatch(/const consentHandlers = createConsentHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: consentClient,/);
    // The journal's current role holder counts too, not only the spawn-time flag (Bugbot).
    expect(index).toContain("isCoordinator: (session, convoId) => session?.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId),");
  });

  it('mounts /consent/list and /consent/decide through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/consent\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /consent route matcher is missing').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual(['decide', 'list']);
    expect(index).toContain('consentHandlers[name]');
  });

  it('hands consent frames to journalHandleConsentFrame, which finds or resumes the Coordinator session and delivers the nudge as a turn plus a notice', () => {
    expect(index).toContain('onConsentFrame: (frame) => journalHandleConsentFrame(frame),');
    const fn = body('function journalHandleConsentFrame(frame) {', '\n}');
    expect(fn).toContain("if (!frame || frame.event !== 'pending') return;");
    expect(fn).toContain('formatConsentNudge(frame)');
    // The journal's current role holder, never a session's spawn-time flag
    // (Bugbot: a session that just gained the role is still flagged false,
    // one that just lost it still true).
    expect(fn).toContain('const { convoId } = coordinatorLookup.snapshot();');
    expect(fn).toContain('let session = findSessionByClaudeSessionId(convoId);');
    expect(fn).toContain('if (!session || !session.alive) session = journalResumeConvo(convoId, JOURNAL_RESUME_NOTICE);');
    expect(fn).not.toMatch(/s\.coordinator === true/);
    expect(fn).toContain('journalPublishNotice(journalConvoIdFor(session), text)');
    expect(fn).toContain('deliverCoordinatorTurn(session, text)');
  });

  it('registers consent_list and consent_decide, each through callConsent with its renderer', () => {
    expect(askUser).toMatch(/import \{[^}]*\bformatPendingList\b[^}]*\bformatDecideAck\b[^}]*\} from '\.\/lib\/consent-tools\.js'/);
    expect(askUser).toContain("'consent_list',");
    expect(askUser).toContain("callConsent('list', {}, formatPendingList)");
    expect(askUser).toContain("'consent_decide',");
    expect(askUser).toContain("callConsent('decide', args, (d) => formatDecideAck(d, args))");
    const decide = askUser.slice(askUser.indexOf("'consent_decide',"), askUser.indexOf('async function sessionControlCall'));
    expect(decide).toContain("kind: z.enum(['chat', 'spawn'])");
    expect(decide).toContain("decision: z.enum(['approve', 'decline'])");
    expect(decide).toContain('reason: z.string().min(1).max(200)');
    // Both descriptions carry the scope and the guardrails the user approved.
    expect(askUser).toMatch(/never tool permission prompts or secret requests/);
    expect(askUser).toMatch(/never into an offline box/);
  });

  it('the Coordinator prompt teaches the rules: own asks, box rules, reasons, the cap and the off switch', () => {
    expect(coord).toMatch(/^## Procedure: triage a consent request/m);
    expect(coord).toContain('`consent_list` and `consent_decide(kind, id, decision, reason)`');
    expect(coord).toMatch(/approve them yourself when they follow the rules/);
    expect(coord).toMatch(/never into a box that is offline/);
    expect(coord).toMatch(/last-resort boxes .*only when every other box is busy/);
    expect(coord).toMatch(/Always give a reason/);
    expect(coord).toMatch(/operator has set a daily cap on approvals and it is reached/);
    expect(coord).toMatch(/Declines are never capped/);
    expect(coord).toMatch(/Tool permission prompts and secret requests are never yours to answer/);
  });
});
