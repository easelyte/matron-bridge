import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (top-level express/journal side
// effects — same constraint session-summary.test.js and agent-spawn.test.js
// work around), so the /start-family --model wiring is pinned by source
// inspection. The parsing itself is unit-tested in model-flag.test.js; what
// these pins protect is that each command actually runs the extractor, reads
// its positional args from the FILTERED token list, and refuses the flag for
// Codex instead of passing a Claude alias to a Codex spawn.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function commandBlock(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

const BLOCKS = {
  '!start': () => commandBlock("case '!start':", "case '!stop':"),
  '!restart': () => commandBlock("case '!restart':", "case '!resume':"),
  '!resume': () => commandBlock("case '!resume':", "case '!workdir':"),
  '!workdir': () => commandBlock("case '!workdir':", "case '!status':"),
};

describe('--model wiring in the /start command family (source inspection)', () => {
  for (const [name, getBlock] of Object.entries(BLOCKS)) {
    it(`${name} parses --model with extractModelFlag`, () => {
      expect(getBlock()).toMatch(/extractModelFlag\(/);
    });

    it(`${name} refuses --model for Codex rather than validating a Codex id as a Claude alias`, () => {
      const block = getBlock();
      expect(block).toContain('CODEX_MODEL_FLAG_REFUSAL');
      // The refusal is gated on `.present`, not `.model`: `--model gpt-5` on
      // a Codex session must get the Codex explanation, not "Unknown model".
      expect(block).toMatch(/ModelFlag\.present/);
    });

    it(`${name} surfaces the extractor's error instead of starting on the wrong model`, () => {
      expect(getBlock()).toMatch(/ModelFlag\.error/);
    });
  }

  // The extractor consumes `--model <alias>` as TWO tokens, so any positional
  // read from the pre-extraction list would pick up "--model" or the alias as
  // a workdir / session id.
  it('!start reads its workdir positional from the extractor output', () => {
    expect(BLOCKS['!start']()).toContain('const arg = startModelFlag.rest[0]');
  });

  it('!resume reads its session-id positional from the extractor output', () => {
    expect(BLOCKS['!resume']()).toMatch(/const resumeArg = resumeModelFlag\.rest\[0\]/);
  });

  // The no-session-id branch delegates to !sessions and RETURNS, so anything
  // checked after it is unreachable for `/resume --model …` (Bugbot, PR
  // #243). Anchored on the delegation call itself, not on any comment.
  it('!resume answers a --model typed with no session id before falling back to the list', () => {
    const block = BLOCKS['!resume']();
    // Anchor on the delegation CALL, not on its argument text: an argument
    // spelled any other way would leave indexOf finding a later, unmoved
    // copy and the pin would pass through a real reordering. !resume makes
    // exactly one nested handleCommand call, so this is unambiguous.
    expect(block.match(/handleCommand\(roomId,/g)).toHaveLength(1);
    const delegation = block.indexOf('handleCommand(roomId,');
    expect(delegation).toBeGreaterThan(-1);
    for (const anchor of ['resumeModelFlag.present', 'resumeModelFlag.error', 'CODEX_MODEL_FLAG_REFUSAL']) {
      const at = block.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(delegation);
    }
  });

  it('!workdir reads its path positional from the extractor output', () => {
    expect(BLOCKS['!workdir']()).toContain('workdirModelFlag.rest.join(\' \')');
  });

  // persistSession auto-carries mcpExtras but NOT model (in-TUI /model picks
  // are deliberately session-scoped), so a /start-flag model only survives a
  // bridge restart if it goes through the explicit `extra` argument — and
  // only if the persist runs at all when extras are empty.
  it('!start persists the flag model explicitly, even with no mcpExtras', () => {
    const block = BLOCKS['!start']();
    expect(block).toContain('mcpExtras.length > 0 || startModel');
    expect(block).toContain('startModel ? { model: startModel } : undefined');
  });

  it('!workdir persists the flag model explicitly, even with no mcpExtras', () => {
    const block = BLOCKS['!workdir']();
    expect(block).toContain('workdirExtras.length > 0 || workdirModel');
    expect(block).toContain('workdirModel ? { model: workdirModel } : undefined');
  });

  it('!restart persists the flag model AFTER the recreate, when the new session exists', () => {
    const block = BLOCKS['!restart']();
    const recreate = block.indexOf('recreateSession(roomId');
    const persist = block.indexOf('persistSession(roomId, restarted.claudeSessionId');
    expect(recreate).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(recreate);
    expect(block).toContain('restarted.currentModel = restartModelFlag.model');
  });

  // The RPC start path (journalStartSessionForRpc) is the New Chat picker's
  // route into the same options; same explicit-extra rule.
  it('journalStartSessionForRpc accepts and persists a model', () => {
    const start = indexSource.indexOf('function journalStartSessionForRpc(');
    expect(start).toBeGreaterThan(-1);
    const block = indexSource.slice(start, indexSource.indexOf('\n}', start));
    expect(block).toMatch(/function journalStartSessionForRpc\(\{[^}]*\bmodel\b/);
    expect(block).toContain('...(model ? { model } : {})');
    expect(block).toContain('mcpExtras.length > 0 || model');
    expect(block).toContain('model ? { model } : undefined');
  });

  // journal-rpc.js gates model selection on the box's default agent and
  // fails CLOSED, so an unwired dep costs the picker rather than starting
  // Codex on a Claude alias — but the wire itself still has to be there.
  it('the RPC handler is given the real DEFAULT_AGENT', () => {
    const start = indexSource.indexOf('createRpcRequestHandler({');
    expect(start).toBeGreaterThan(-1);
    const block = indexSource.slice(start, indexSource.indexOf('\n});', start));
    expect(block).toMatch(/^\s*defaultAgent: DEFAULT_AGENT,$/m);
  });

  it('the /help text documents --model', () => {
    const help = commandBlock("case '!help':", "case '!tools':");
    expect(help).toMatch(/\/start --model/);
    expect(help).toMatch(/VALID_ALIAS_HINT/);
  });
});
