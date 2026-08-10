import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeProjectDir } from './subagent-watcher.js';

// The bridge-shipped producer shim launcher, resolved once. detectProducer
// compares each on-PATH `codex` realpath against this to recognise the shim.
const SHIPPED_SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shim', 'codex',
);

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// T-1.6: is there an event PRODUCER for the sessions this bridge launches?
// A producer exists when EITHER (return true on first match):
//   1. MATRON_CODEX_REAL_BIN is set — the son-of-anton integration point is
//      active, which means codex_execute.sh is the launcher and is itself a
//      redaction-aware producer (G1). This is the key correctness point: the
//      wrapper-only deployment (shim dir unset) has a valid producer and MUST
//      NOT be treated as "no producer".
//   2. `codex` resolves on env.PATH to the bridge shim (realpath equals the
//      shipped shim launcher).
// Only when NEITHER holds (bare stock codex on PATH, no MATRON_CODEX_REAL_BIN,
// no shim) is there truly no producer — the silent-empty-view condition.
export function detectProducer({ env = process.env, shimPath = SHIPPED_SHIM_PATH } = {}) {
  if (typeof env.MATRON_CODEX_REAL_BIN === 'string' && env.MATRON_CODEX_REAL_BIN.trim()) {
    return true;
  }
  const shimReal = safeRealpath(shimPath);
  if (shimReal) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      if (safeRealpath(path.join(dir, 'codex')) === shimReal) return true;
    }
  }
  return false;
}

export function codexRunsDirFor(workdir, sessionId) {
  const encoded = encodeProjectDir(path.resolve(workdir));
  return path.join(os.homedir(), '.claude', 'projects', encoded, sessionId, 'codex-runs') + path.sep;
}

export function configureCodexSinkEnv({
  spawnEnv,
  workdir,
  sessionId,
  env = process.env,
  mkdirSync = fs.mkdirSync,
  warn = console.warn,
}) {
  try {
    if (env.MATRON_CODEX_VIZ !== '0') {
      const dir = codexRunsDirFor(workdir, sessionId);
      mkdirSync(dir, { recursive: true });
      spawnEnv.MATRON_CODEX_SINK_DIR = dir;
      return dir;
    }
    delete spawnEnv.MATRON_CODEX_SINK_DIR;
  } catch (error) {
    delete spawnEnv.MATRON_CODEX_SINK_DIR;
    try {
      warn(`[codex-viz] sink dir setup failed, viz disabled for this session: ${error.message}`);
    } catch { /* logging must never block the shared session spawn path */ }
  }
  return null;
}

export function launchWithCodexSinkEnv({
  spawnEnv,
  workdir,
  sessionId,
  launch,
  configureOptions = {},
}) {
  configureCodexSinkEnv({
    ...configureOptions,
    spawnEnv,
    workdir,
    sessionId,
  });
  return launch(spawnEnv);
}
