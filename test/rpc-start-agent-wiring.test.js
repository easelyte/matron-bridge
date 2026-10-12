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

  it('assigns a stable journal id at Codex construction and flushes the buffered seed', () => {
    const src = block('function createCodexSessionForRoom(', 'function codexToolIndicator(');
    expect(src).toMatch(/journalConvoId: options\.journalConvoId \|\| persisted\?\.journalConvoId \|\| resumeSessionId \|\| newSessionConvoId\(\)/);
    expect(src).toMatch(/sessions\.set\(roomId, session\);[\s\S]*?journalFlushForSession\(session\)/);
  });

  it('persists a fresh Codex identity and requested settings before its native thread starts', () => {
    const src = block('function createCodexSessionForRoom(', 'function codexToolIndicator(');
    expect(src).toMatch(/sessions\.set\(roomId, session\);[\s\S]*?persistSession\(roomId, session\.claudeSessionId, cwd, null\)/);
    const start = rpcStart();
    expect(start).toMatch(/const mintedConvoId = session\.agent === AGENT_CODEX && !session\.claudeSessionId/);
    expect(start).toMatch(/\(mcpExtras\.length > 0 \|\| model \|\| effort \|\| mintedConvoId\) && \(session\.claudeSessionId \|\| mintedConvoId\)/);
  });

  it('hands the handler a live Codex-availability check and the transport flag', () => {
    const src = handlerWiring();
    expect(indexSource).toMatch(/const codexSpawnable = \(\) => process\.platform !== 'win32' && detectCodexBinary\(\);/);
    expect(src).toMatch(/^\s*codexAvailable: codexSpawnable,$/m);
    expect(src).toMatch(/codexAppServer: CODEX_APP_SERVER/);
    expect(indexSource).toMatch(/import \{[^}]*\bdetectCodexBinary\b[^}]*\} from '\.\/lib\/codex-paths\.js'/);
  });
});
