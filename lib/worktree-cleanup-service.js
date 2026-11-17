// Archive and delete of a worktree session, and the picker and box-status
// view of the worktrees that exist. On top of lib/worktree.js (git) and
// lib/worktree-ledger.js (the record).
import nodeFs from 'node:fs';

import { assessWorktree, gitRun, removeWorktree } from './worktree.js';

export const DISCARD_LABEL = 'Discard worktree';
export const KEEP_LABEL = 'Keep it';
export const DISCARD_ITEM_LABEL = 'worktree-discard';

const labelOf = (c) => (typeof c?.action === 'string' ? c.action : typeof c?.meta?.action === 'string' ? c.meta.action : '').trim();

export function createCleanupService({
  ledger,
  sizes = null,
  // Step-up for a discard that would lose work (index.js wires the tracker):
  //   file(spec) -> item id | null          file the signed question
  //   verify(itemId, subject) -> boolean    a signed "Discard worktree" tap on
  //                                         that item, for exactly that subject
  //   consume(itemId) -> void               close the question once it is used
  stepUp = null,
  run = gitRun,
  fs = nodeFs,
  now = Date.now,
}) {
  const exists = (p) => fs.existsSync(p);

  return {
    // Folder picker view: bridge-made worktrees grouped under their repo,
    // each with its cached size (null until measured). No git, no walk.
    describe(limit = 20) {
      return ledger.list()
        .filter((e) => exists(e.path))
        .slice(0, limit)
        .map((e) => ({ path: e.path, repo: e.root, branch: e.branch, size_bytes: sizes ? sizes.get(e.path) : null }));
    },

    // Box status line: how many worktrees and how much disk they hold.
    summary() {
      const list = this.describe(1000);
      if (!list.length) return null;
      const known = list.filter((w) => typeof w.size_bytes === 'number');
      return { count: list.length, ...(known.length === list.length ? { total_bytes: known.reduce((a, w) => a + w.size_bytes, 0) } : {}) };
    },

    // Remove a session's worktree when nothing would be lost. When something
    // would be, it is kept and the reply says what is left, with
    // needsStepUp. `discard` asks to lose that work anyway; it is honoured
    // only with a signed tap (stepUpItem) on a question this bridge filed for
    // exactly this worktree, never on the caller's word alone.
    async cleanup({ workdir, action, discard = false, stepUpItem = null, convoId = null, inUse = () => false }) {
      const entry = ledger.get(workdir);
      if (!entry) {
        if (ledger.removedFor(workdir, { exists })) return { ok: true, removed: true, alreadyGone: true };
        return { ok: false, code: 'not_a_worktree' };
      }
      if (inUse(entry.path)) return { ok: false, code: 'session_active', detail: 'a session is still running in this worktree' };
      const base = { path: entry.path, branch: entry.branch, root: entry.root, base: entry.base, run, fs };
      const a = await assessWorktree(base);
      if (a.error) return { ok: true, removed: false, kept: true, blockers: a.blockers, error: a.error, action, path: entry.path, branch: entry.branch };

      let allowDiscard = false;
      let askedItem = null;
      if (!a.removable) {
        if (discard) {
          const subject = { op: 'discard_worktree', worktree: entry.path, branch: entry.branch };
          let verified = false;
          if (stepUpItem && stepUp) { try { verified = await stepUp.verify(stepUpItem, subject); } catch { verified = false; } }
          if (verified) allowDiscard = true;
          else if (stepUp) {
            try { askedItem = await stepUp.file({ entry, blockers: a.blockers, subject, convoId }); } catch { askedItem = null; }
          }
        }
        if (!allowDiscard) {
          const out = {
            ok: true, removed: false, kept: true, blockers: a.blockers, needsStepUp: true, action,
            path: entry.path, branch: entry.branch, ...(askedItem ? { stepUpItem: askedItem } : {}),
          };
          if (action === 'archive') {
            out.notice = {
              title: `Worktree kept: ${entry.branch}`,
              body: `The session was archived but its worktree \`${entry.path}\` was kept because work would be lost:\n\n${a.blockers.map((b) => `- ${b}`).join('\n')}\n\nCommit and push (or merge) the branch, then remove it with \`git worktree remove\`.`,
            };
          }
          return out;
        }
      }
      const res = await removeWorktree({ ...base, discard: allowDiscard });
      if (res.removed) {
        ledger.markRemoved(entry.path, now());
        sizes?.forget(entry.path);
        if (allowDiscard && stepUp?.consume) { try { await stepUp.consume(stepUpItem); } catch { /* the work is already gone */ } }
      }
      return { ok: true, ...res, action, path: entry.path, branch: entry.branch };
    },
  };
}

// The question a signed tap answers before work is thrown away.
export function discardQuestion({ entry, blockers, subject, convoId }) {
  return {
    kind: 'question',
    title: `Discard worktree ${entry.branch}?`,
    body: [
      `The worktree \`${entry.path}\` still holds work that exists nowhere else:`,
      '',
      ...blockers.map((b) => `- ${b}`),
      '',
      'Discarding removes the folder with all of it. The branch is kept unless it is merged.',
    ].join('\n'),
    actions: [DISCARD_LABEL, KEEP_LABEL],
    labels: [DISCARD_ITEM_LABEL],
    step_up: true,
    subject,
    ...(convoId ? { convo_id: convoId } : {}),
  };
}

// Whether `data` (an item read with its comments) carries a signed
// "Discard worktree" tap for `subject`. `check` is the box's own signature
// check when it has pinned keys, else null: the journal checked the
// signature before it stored the tap, and an unsigned tap has no `approval`.
export async function verifyDiscardTap(data, subject, { check = null } = {}) {
  const item = data?.item;
  if (!item || item.step_up !== true) return false;
  // A tap is good once: the question is closed after it is used.
  if (item.state && item.state !== 'open') return false;
  if (!Array.isArray(item.labels) || !item.labels.includes(DISCARD_ITEM_LABEL)) return false;
  const s = item.subject;
  if (!s || s.op !== subject.op || s.worktree !== subject.worktree || s.branch !== subject.branch) return false;
  const taps = (Array.isArray(data.comments) ? data.comments : []).filter((c) => c && labelOf(c) === DISCARD_LABEL && c.approval);
  for (const tap of taps) {
    if (!check) return true;
    try { if ((await check(data, tap))?.ok === true) return true; } catch { /* next */ }
  }
  return false;
}
