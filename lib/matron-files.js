import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Root directory for files the user sends from Matron to an SDK-mode session.
// Kept OUTSIDE the session workdir so received files never clutter a
// project/git tree (the iv-mode counterpart is lib/iv-uploads.js, rooted at
// ~/.claude-matrix-uploads). Overridable via MATRON_FILES_DIR.
export function matronFilesRoot() {
  return process.env.MATRON_FILES_DIR || path.join(os.homedir(), 'matron-files');
}

// Per-project directory under the root, keyed on the workdir's basename so
// the folder name tells you which repo the files belong to. Created on
// demand unless mkdir is false. Sanitization mirrors sanitizeRoomId in
// lib/iv-uploads.js; basename('/') is '' and '.'/'..' would resolve to a
// directory inside path.join, so all three fold into the 'project' fallback.
export function matronFilesDir(workdir, { mkdir = true } = {}) {
  const base = path.basename(String(workdir || ''));
  const safe =
    base === '' || base === '.' || base === '..'
      ? 'project'
      : base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const dir = path.join(matronFilesRoot(), safe);
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
