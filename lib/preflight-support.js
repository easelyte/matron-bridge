import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = "export const PREFLIGHT_PROTOCOL = 'gate/1';";

export function preflightSupport(repoDir, sha) {
  if (typeof repoDir !== 'string' || !repoDir || typeof sha !== 'string' || !sha || sha.startsWith('-')) return 'unsupported';
  const options = { cwd: repoDir, timeout: 5000, stdio: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:lib/preflight-support.js`], options);
    // Git has no whole-line grep option; compare the committed lines exactly.
    const source = execFileSync('git', ['show', `${sha}:index.js`], { ...options, encoding: 'utf8' });
    return source.split('\n').includes(MARKER) ? 'gate/1' : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid = args.length === 4 && args[0] === '--repo' && args[2] === '--sha';
  console.log(valid ? preflightSupport(args[1], args[3]) : 'unsupported');
}
