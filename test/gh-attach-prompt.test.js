import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The prompt files must tell agents that GitHub's own `gh --attach` is how an
// image reaches an issue, PR or comment, which gh version carries it, and that
// an attachment on a public repository is public.
describe('screenshots on GitHub', () => {
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  for (const [name, text] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
    it(`${name} points agents at gh --attach`, () => {
      expect(text).toMatch(/## Screenshots on GitHub \(`gh --attach`\)/);
      expect(text).toMatch(/`gh` 2\.99\.0 or later/);
      expect(text).toMatch(/gh pr comment 123 --attach/);
      expect(text).toMatch(/readable by anyone on a public one/);
      expect(text).toMatch(/Do not use third-party uploaders/);
    });
  }
});
