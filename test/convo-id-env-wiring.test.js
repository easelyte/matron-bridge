import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (top-level side effects), so the
// MATRON_CONVO_ID wiring is pinned by source inspection. What the builders
// put in the env is unit-tested in spawn-env.test.js; these pins check that
// each spawn path hands the builder the same journal conversation id it
// stores on the session, so the child env and the bridge never disagree.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function fnBody(name) {
  const start = indexSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = indexSource.indexOf('\nfunction ', start + 1);
  return indexSource.slice(start, next === -1 ? undefined : next);
}

const PATHS = [
  { name: 'createSession', builder: 'buildClaudeSpawnEnv', id: 'printJournalConvoId' },
  { name: 'createInteractiveSessionForRoom', builder: 'buildClaudeSpawnEnv', id: 'ivJournalConvoId' },
  { name: 'createCodexSessionForRoom', builder: 'buildCodexSpawnEnv', id: 'codexJournalConvoId' },
];

describe('MATRON_CONVO_ID wiring (source inspection)', () => {
  for (const { name, builder, id } of PATHS) {
    it(`${name} passes the session's journal conversation id to ${builder}`, () => {
      const src = fnBody(name);
      const decl = src.indexOf(`const ${id} = `);
      const call = src.indexOf(`${builder}({`);
      expect(decl).toBeGreaterThan(-1);
      expect(call).toBeGreaterThan(decl);
      const callArgs = src.slice(call, src.indexOf('})', call));
      expect(callArgs).toContain(`convoId: ${id},`);
      expect(src).toContain(`journalConvoId: ${id},`);
    });
  }
});
