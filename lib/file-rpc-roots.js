// Root set for the phone-driven read_file / edit_file RPCs.
//
// The maintainer's review of the upstream File Explorer stack: on dev boxes
// DEFAULT_WORKDIR is $HOME, so a root of $HOME would let any signed-in client
// device read or edit ~/.bashrc, ~/.secrets or the bridge's own index.js, and
// a root of / was accepted outright. So a candidate root that IS the
// filesystem root, or that is (or contains) the service user's home, is
// refused. The rest are pinned as before. Refusing only narrows the set: if
// nothing survives, the RPCs answer bad_workdir (fail closed) and the rest of
// the bridge is unaffected.
//
// The home comes from the passwd entry, not $HOME, so an overridden HOME
// cannot move the boundary.
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

export function serviceUserHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Path-boundary-safe containment: /a/b contains /a/b and /a/b/c, not /a/bc.
function contains(parent, child) {
  if (parent === path.sep) return true;
  return child === parent || child.startsWith(parent + path.sep);
}

// -> { kept: string[], refused: [{ root, reason }] }
export function filterFileRpcRoots(candidates, { home = serviceUserHome() } = {}) {
  const homeReal = home ? canonical(home) : null;
  const kept = [];
  const refused = [];
  for (const root of candidates || []) {
    if (!root) continue;
    const real = canonical(root);
    if (real === path.sep) {
      refused.push({ root, reason: 'filesystem-root' });
    } else if (homeReal && contains(real, homeReal)) {
      refused.push({ root, reason: real === homeReal ? 'home' : 'contains-home' });
    } else if (!kept.includes(root)) {
      kept.push(root);
    }
  }
  return { kept, refused };
}
