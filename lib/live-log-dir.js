// Where the live Bash-output logs (`matron-cmd-<tool_use_id>.log`) live.
//
// The bridge (index.js) predicts the path from the tool_use_id, and the
// PreToolUse tee hook writes it, so both must agree on the directory. POSIX
// keeps the historical literal `/tmp` (the bridge and its sessions may have
// different TMPDIRs, and `/tmp` is the one place they are known to share).
// Windows has no /tmp: the user's temp dir (`os.tmpdir()`, from %TEMP%) is
// shared by the bridge, the Claude child and the hook, which all run as the
// same user.
import os from 'node:os';
import path from 'node:path';

export function liveLogDir({ platform = process.platform, tmpdir = os.tmpdir } = {}) {
  return platform === 'win32' ? tmpdir() : '/tmp';
}

export function liveLogPath(toolUseId, opts = {}) {
  return path.join(liveLogDir(opts), `matron-cmd-${toolUseId}.log`);
}
