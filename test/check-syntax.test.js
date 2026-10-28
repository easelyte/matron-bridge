import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('npm run check', () => {
  it('walks the tree instead of listing files by hand', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.check).toBe('node scripts/check-syntax.mjs');
    const script = readFileSync(new URL('../scripts/check-syntax.mjs', import.meta.url), 'utf8');
    expect(script).toContain("entry.name === 'node_modules'");
    expect(script).toContain("['--check', file]");
  });
});
