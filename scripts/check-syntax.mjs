#!/usr/bin/env node
// npm run check: `node --check` on every .js/.mjs file in the repository
// (node_modules and dot-directories aside). Found by walking the tree, so a
// new file is covered without anyone having to add it to a list.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) yield full;
  }
}

let checked = 0;
let failed = 0;
for (const file of sources(root)) {
  checked++;
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(`${path.relative(root, file)}\n${r.stderr}\n`);
  }
}
console.log(`node --check: ${checked} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
