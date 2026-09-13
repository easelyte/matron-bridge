import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (top-level side effects — same
// constraint start-model-flag-wiring.test.js works around), so the New Chat
// agent switch's wiring is pinned by source inspection. The RPC handler's own
// behaviour (agent_options, the `agent` param, its refusals) is unit-tested
// in journal-rpc-handlers.test.js; what these pins protect is that index.js
// actually hands the handler what it needs and carries the pick to the spawn.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function block(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

const rpcStart = () => block('function journalStartSessionForRpc(', 'const journalRpcHandler = createRpcRequestHandler(');
const handlerWiring = () => block('const journalRpcHandler = createRpcRequestHandler(', 'function journalConvoIdFor(');

describe('New Chat agent switch wiring (source inspection)', () => {
  it('the RPC start body accepts an agent and forwards it to createSession', () => {
    const src = rpcStart();
    expect(src).toMatch(/function journalStartSessionForRpc\(\{[^}]*\bagent\b/);
    expect(src).toMatch(/createSession\([\s\S]*?\.\.\.\(agent \? \{ agent \} : \{\}\)/);
  });

  // A fresh Codex session learns its thread id from the stream, so at spawn it
  // has no journal convo id — and the RPC handler tears such a session down as
  // unsupported_mode. The RPC path must mint the stable id itself (as /switch
  // does) and flush the buffered seed so the app can navigate to a convo that
  // exists.
  it('mints a journal convo id for a Codex start and flushes the buffered seed', () => {
    const src = rpcStart();
    expect(src).toMatch(/AGENT_CODEX[\s\S]*?journalConvoId = newSessionConvoId\(\)/);
    expect(src).toMatch(/journalConvoId = newSessionConvoId\(\)[\s\S]*?journalFlushForSession\(session\)/);
  });

  // Bugbot (PR #263): the minted id must ALSO be persisted at once —
  // journalResumeConvo matches on the persisted journalConvoId/sessionId,
  // both unset until thread.started, so an idle reap or bridge restart in
  // that window would orphan the chat the app just opened.
  it('persists the minted Codex convo id immediately, not only at thread.started', () => {
    const src = rpcStart();
    expect(src).toMatch(/const mintedConvoId = session\.agent === AGENT_CODEX && !session\.journalConvoId/);
    expect(src).toMatch(/\(mcpExtras\.length > 0 \|\| model \|\| mintedConvoId\) && \(session\.claudeSessionId \|\| mintedConvoId\)/);
  });

  it('hands the handler a live Codex-availability check and the transport flag', () => {
    const src = handlerWiring();
    expect(src).toMatch(/codexAvailable: \(\) => detectCodexBinary\(\)/);
    expect(src).toMatch(/codexAppServer: CODEX_APP_SERVER/);
    expect(indexSource).toMatch(/import \{[^}]*\bdetectCodexBinary\b[^}]*\} from '\.\/lib\/codex-paths\.js'/);
  });
});
