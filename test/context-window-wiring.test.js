import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The status frame's window must come from sessionContextWindow (alias, id
// and gauge), never from the transcript id alone — pinned by source
// inspection like the other index.js wiring tests.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('context window wiring (source inspection)', () => {
  it('keeps the chosen alias on both Claude session literals and refreshes it on an accepted interactive switch', () => {
    expect(index).toContain('_modelAlias: printModel || null,');
    expect(index).toContain('_modelAlias: model || null,');
    expect(index).toContain('session._modelAlias = normalizeModelArg(arg);');
    // Rebuilds hand the alias on, not the transcript id.
    expect(index).toContain('model: session._modelAlias || session.currentModel || undefined,');
    expect(index).toContain('currentModel: existing._modelAlias || existing.currentModel, pendingModel: existing._coordinatorModel');
  });
  it('the status frame and the auto-resume check settle the window from alias, id and gauge', () => {
    expect(index.match(/sessionContextWindow\(\{ model: session\.currentModel \|\| session\.initData\?\.model, alias: session\._modelAlias, contextTokens: session\._lastContextTokens \}\)/g)).toHaveLength(2);
    expect(index).not.toMatch(/contextWindowFor\(/);
  });
  it('a subagent child reads its parent\'s settled window and model', () => {
    expect(index).toContain('getParentWindow: () => contextWindowForSession(session),');
    expect(index).toContain('getParentModel: () => session.currentModel || session.initData?.model,');
  });
});
