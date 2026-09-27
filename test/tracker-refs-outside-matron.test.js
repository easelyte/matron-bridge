import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The prompt files must tell agents not to write tracker item numbers or
// matron:// links into anything that leaves Matron (GitHub issues, PRs,
// commit messages): `#12` autolinks to an unrelated GitHub issue and GitHub
// strips the matron:// scheme. Numbers are a per-user counter, so they mean
// nothing to anyone else anyway.
describe('tracker references outside Matron', () => {
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  for (const [name, text] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
    it(`${name} forbids #N and matron:// item references on GitHub`, () => {
      expect(text).toMatch(/per-user and mean nothing outside Matron/);
      expect(text).toMatch(/GitHub issues, PR titles and bodies, commit messages/);
      expect(text).toMatch(/never write a tracker item as `#N`, `item #N`, or a `matron:\/\/` link/);
      expect(text).toMatch(/Say what was decided in words/);
      expect(text).toMatch(/attach it to the item with `links`/);
    });
  }
});
