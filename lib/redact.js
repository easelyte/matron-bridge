import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REDACTOR_CONFIG_PARTS = ['memory', 'config', 'lesson_redactor.yaml'];

function sha256Prefix(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

function compilePythonPattern(source) {
  let flags = 'g';
  let javascriptSource = source;
  if (javascriptSource.startsWith('(?i)')) {
    javascriptSource = javascriptSource.slice(4);
    flags += 'i';
  }
  return new RegExp(javascriptSource, flags);
}

function parseRedactorConfig(source) {
  const patterns = [];
  let pendingName = null;
  for (const line of source.split(/\r?\n/)) {
    const nameMatch = /^\s*-\s+name:\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (nameMatch) {
      if (pendingName !== null) throw new Error('redactor pattern is missing a regex');
      pendingName = nameMatch[1];
      continue;
    }
    const regexMatch = /^\s+regex:\s*'(.*)'\s*$/.exec(line);
    if (regexMatch && pendingName !== null) {
      const regex = regexMatch[1].replaceAll("''", "'");
      patterns.push({ name: pendingName, compiled: compilePythonPattern(regex) });
      pendingName = null;
    }
  }
  if (pendingName !== null || patterns.length === 0) {
    throw new Error('redactor config has no complete patterns');
  }
  return patterns;
}

/**
 * Build the shared bridge-side adapter for the canonical lesson-redactor
 * policy. Config is loaded once, lazily; any load/compile failure latches the
 * adapter closed so callers drop the event or omit the optional field.
 */
export function createPublishRedactor({
  workspaceRoot,
  configPath = typeof workspaceRoot === 'string'
    ? path.join(workspaceRoot, ...REDACTOR_CONFIG_PARTS)
    : null,
  readFileSyncFn = readFileSync,
} = {}) {
  let patterns;
  let loadFailed = false;
  return value => {
    if (typeof value !== 'string') throw new TypeError('publish redactor requires a string');
    if (loadFailed) throw new Error('publish redactor is unavailable');
    if (!patterns) {
      try {
        if (typeof configPath !== 'string' || configPath.length === 0) {
          throw new Error('publish redactor config is unavailable');
        }
        patterns = parseRedactorConfig(readFileSyncFn(configPath, 'utf8'));
      } catch {
        loadFailed = true;
        throw new Error('publish redactor config failed');
      }
    }
    let output = value;
    for (const pattern of patterns) {
      output = output.replace(pattern.compiled, match => (
        `[REDACTED:${pattern.name}:${sha256Prefix(match)}]`
      ));
    }
    return output;
  };
}
