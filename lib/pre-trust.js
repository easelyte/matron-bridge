import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { atomicWriteFileSync } from './atomic-write.js';

const DEFAULT_PATH = path.join(os.homedir(), '.claude.json');

// claude reads this when deciding whether to show the global first-run wizard
// (theme picker, security note, etc). Setting it to a known non-empty version
// is enough to skip that wizard. We don't try to track the latest claude
// version; any value that satisfies `lastOnboardingVersion != null` works.
const ONBOARDING_VERSION_SENTINEL = '0.2.29';

// Pre-write `~/.claude.json` so claude's first-run dialogs do not appear when
// we spawn it in a PTY. Three distinct things get primed:
//
//   1. Per-workspace trust + project onboarding (the "Do you trust this
//      folder?" dialog). --print mode auto-skips this, but a TTY-attached
//      claude shows it.
//   2. Global onboarding (the theme picker, "Press enter to continue", etc.).
//      Without `hasCompletedOnboarding: true` + `lastOnboardingVersion`,
//      claude blocks on the theme picker before the first conversation
//      message — which the bridge surfaces as a Matrix prompt the user
//      cannot answer correctly because the picker's first option lives on
//      the same line as the heading and gets misclassified.
//   3. Bypass-permissions acceptance. The bridge always launches claude
//      with `--dangerously-skip-permissions`, which on first run shows a
//      modal whose default highlighted option is "No, exit" — pressing
//      Enter (or replying "1" over Matrix) exits the process with code 1
//      and the bridge restarts in a loop. Setting
//      `bypassPermissionsModeAccepted: true` skips that modal entirely.
export function ensureWorkspaceTrusted(workdir, claudeJsonPath = DEFAULT_PATH) {
  const abs = path.resolve(workdir);
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch (_) {
    // File doesn't exist or is unreadable — start fresh.
  }
  config.projects = config.projects || {};
  const existing = config.projects[abs] || {};
  const projectAlreadyPrimed =
    existing.hasTrustDialogAccepted === true &&
    existing.hasCompletedProjectOnboarding === true;
  const globalAlreadyPrimed =
    config.hasCompletedOnboarding === true &&
    typeof config.lastOnboardingVersion === 'string' &&
    config.lastOnboardingVersion.length > 0;
  const bypassAlreadyPrimed = config.bypassPermissionsModeAccepted === true;

  if (projectAlreadyPrimed && globalAlreadyPrimed && bypassAlreadyPrimed) {
    return;
  }

  if (!projectAlreadyPrimed) {
    config.projects[abs] = {
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
  }
  if (!globalAlreadyPrimed) {
    config.hasCompletedOnboarding = true;
    if (!config.lastOnboardingVersion) {
      config.lastOnboardingVersion = ONBOARDING_VERSION_SENTINEL;
    }
  }
  if (!bypassAlreadyPrimed) {
    config.bypassPermissionsModeAccepted = true;
  }
  // Atomic replace (PR #151 follow-up): this is claude's own global config —
  // a truncating rewrite that dies mid-write corrupts it for every claude
  // invocation on the machine, not just the bridge's spawns.
  atomicWriteFileSync(claudeJsonPath, JSON.stringify(config, null, 2), { fs });
}
