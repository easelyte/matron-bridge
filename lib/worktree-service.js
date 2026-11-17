// The bridge-side flow of `/start --worktree`, on top of lib/worktree.js (git)
// and lib/worktree-ledger.js (the record of what exists). index.js wires the
// real session machinery in; tests stub it.
import nodeFs from 'node:fs';

import { createWorktree, finishWorktree, gitRun, worktreeNoticeBlock } from './worktree.js';
import { readNoticeExtra, setupSummary } from './worktree-setup.js';

// Thrown by callers that resume or replace a session whose worktree was
// removed: the conversation cannot continue there, and the folder is never
// recreated empty. Callers show `message` to the user.
export class WorktreeRemovedError extends Error {
  constructor(entry) {
    super(`The worktree ${entry.path} (branch ${entry.branch}) was removed, so this session cannot be resumed. Start a new one with /start --worktree <name>.`);
    this.name = 'WorktreeRemovedError';
  }
}

export function createWorktreeService({
  ledger,
  // lib/worktree-setup-flow.js, or null: no setup script support.
  setup = null,
  env = process.env,
  run = gitRun,
  fs = nodeFs,
  statfs,
}) {
  const exists = (p) => fs.existsSync(p);

  return {
    ledger,

    // Create the worktree for `/start --worktree`. Everything that can refuse
    // (name, limits, disk, fetch, taken branch) happens here, before a
    // session exists. Resolves {ok:false, error} or
    // {ok:true, cwd, entry, notes, background}. `background()` does the slow
    // rest (submodules, LFS) and resolves the notes to tell the user; the
    // caller starts the session first and runs it afterwards, so a start never
    // waits on them.
    // With a setup flow it also runs an approved setup script, and `plan` is a
    // script that needs the user's approval, for the caller to put on a card.
    async start({ workdir, name }) {
      const created = await createWorktree({
        workdir, name, run, fs, statfs, env,
        countExisting: (root) => ledger.list(root).filter((e) => exists(e.path)).length,
        ledgerHas: (p) => !!ledger.get(p),
      });
      if (!created.ok) return created;
      const entry = {
        name: created.name, branch: created.branch, root: created.root, base: created.base,
        gitDir: created.gitDir,
      };
      ledger.add(created.path, entry);
      const full = { path: created.path, ...entry };

      // From here on the worktree exists, so nothing below may throw: a
      // failure is a note and the session starts without the extra.
      let begun = { notes: [], plan: null, runNow: null };
      if (setup) {
        try { begun = await setup.begin(full, created.origin); } catch (e) {
          begun = { notes: [`Worktree setup was skipped: ${e?.message || e}`], plan: null, runNow: null };
        }
      }
      const background = async () => {
        const notes = [];
        notes.push(...begun.notes);
        try { notes.push(...await finishWorktree({ path: created.path, run, fs })); } catch (e) { notes.push(`Post-create steps failed: ${e?.message || e}`); }
        if (begun.runNow) {
          try { notes.push(...await begun.runNow()); } catch (e) { notes.push(`Worktree setup failed to run: ${e?.message || e}`); }
        }
        return notes;
      };
      return {
        ok: true, cwd: created.cwd, entry: full, notes: [],
        plan: begun.plan,
        background,
      };
    },

    // The notice facts for a spawn in `cwd`, or null when it is not one of
    // ours. Cheap: one ledger lookup and at most one small file read.
    info(cwd) {
      const entry = ledger.get(cwd);
      if (!entry || !exists(entry.path)) return null;
      return {
        ...entry,
        setupLine: setupSummary(entry.setup),
        extra: readNoticeExtra(entry.gitDir, { fs }),
      };
    },

    noticeBlock(cwd) { return worktreeNoticeBlock(this.info(cwd)); },

    // `{path, root, branch}` for a workdir that was one of ours and is gone.
    removedFor(workdir) { return ledger.removedFor(workdir, { exists }); },
  };
}
