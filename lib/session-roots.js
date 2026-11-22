import { randomUUID } from 'node:crypto';
import { pinAllowedRootsSync } from './file-link-guard.js';

// Filesystem roots a new session may hand out links for, pinned once at
// session creation, before the agent process is spawned (resolving the
// pathnames later would let the agent swap them first).
//
// Two capabilities come out of it:
//
// - pageLinkPinnedRoots: the workdir alone, for share_html_page. That tool
//   lives in the always-on ask-user MCP server, so every session gets it and
//   every session needs this pin.
// - showFilePinnedRoots + showFileToken: the workdir plus the configured
//   artifact roots, for show_file. Only when the opt-in `share` extra is on.
//
// The two are pinned separately on purpose. A session without `share`, or
// one whose artifact roots fail to pin, still gets working page links.
export function pinSessionRoots({ cwd, shareEnabled = false, artifactRoots = [], roomId = '', warn = console.warn } = {}) {
  let pageLinkPinnedRoots = null;
  try {
    pageLinkPinnedRoots = pinAllowedRootsSync([cwd]);
  } catch (error) {
    warn(`[page-link] disabled for ${roomId}: failed to pin the workdir (${error.message})`);
  }
  let showFilePinnedRoots = null;
  let showFileToken;
  if (shareEnabled) {
    try {
      showFilePinnedRoots = pinAllowedRootsSync([cwd, ...artifactRoots]);
      showFileToken = randomUUID();
    } catch (error) {
      warn(`[show-file] disabled for ${roomId}: failed to pin allowed roots (${error.message})`);
    }
  }
  return { pageLinkPinnedRoots, showFilePinnedRoots, showFileToken };
}
