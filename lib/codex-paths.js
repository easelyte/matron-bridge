import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeProjectDir } from './subagent-watcher.js';

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
