// Install a complete attachment without replacing an existing upload.
import fs from 'fs';

export function writeSavedMediaFile(finalPath, buffer, { fsImpl = fs, reselectPath = null, maxAttempts = 8 } = {}) {
  // Write straight to the final name with O_EXCL: never overwrites an existing
  // upload, needs no hard-link support, and leaves no temp dotfile behind. The
  // path only reaches the agent after this returns, so a half-written file at
  // the final name is never read; on a failed write we remove what we created.
  let target = finalPath;
  let attempt = 0;
  for (;;) {
    try {
      fsImpl.writeFileSync(target, buffer, { flag: 'wx' });
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        if (reselectPath && ++attempt < maxAttempts) {
          target = reselectPath();
          continue;
        }
        throw err;
      }
      try { fsImpl.unlinkSync(target); } catch { /* nothing partial to remove */ }
      throw err;
    }
  }
  // Capture our own inode so cleanup only deletes the file we wrote.
  let identity = null;
  try {
    const st = fsImpl.lstatSync(target, { bigint: true });
    identity = { dev: st.dev, ino: st.ino };
  } catch { /* unknown identity disables destructive cleanup */ }
  return { path: target, identity, tmpPath: null };
}

export function makeIdentityAwareCleanup(filePath, identity, { fsImpl = fs, tmpPath = null } = {}) {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (tmpPath) { try { fsImpl.unlinkSync(tmpPath); } catch { /* already gone */ } }
    if (!filePath || !identity) return; // fail closed on missing target/identity
    try {
      const st = fsImpl.lstatSync(filePath, { bigint: true });
      if (st.dev !== identity.dev || st.ino !== identity.ino) {
        return;
      }
      fsImpl.unlinkSync(filePath);
    } catch { /* already gone / never written / stat failed — nothing to do */ }
  };
}
