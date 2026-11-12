import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Both prompt files carry the same short clear-writing section, so Claude and
// Codex sessions write to the user by the same rules.
describe('write plainly', () => {
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  const section = (text) => text.split('## Write plainly')[1]?.split('\n## ')[0] ?? '';

  for (const [name, text] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
    it(`${name} names the three faults`, () => {
      expect(text).toMatch(/^## Write plainly$/m);
      expect(text).toMatch(/\*\*Hidden actors and actions\.\*\*/);
      expect(text).toMatch(/\*\*Vague wording\.\*\*/);
      expect(text).toMatch(/\*\*Empty statements and buried points\.\*\*/);
      expect(text).toMatch(/Plain is not vague/);
    });
  }

  it('the two files carry the same section', () => {
    expect(section(codexMd)).toBe(section(claudeMd));
  });
});
