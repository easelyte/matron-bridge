// Approval and running of a repository's `.matron/worktree-setup` script for a
// fresh worktree, on top of lib/worktree-setup.js (the policy and the runner).
// The consent card is a tracker question in the session's conversation; a tap
// on it is applied here, never handed to the agent.
import nodeFs from 'node:fs';
import path from 'node:path';

import { gitRun } from './worktree.js';
import { parseAllowlist, planSetup, runSetup, setupSummary, setupTimeoutMs } from './worktree-setup.js';

export const ALLOW_LABEL = 'Allow setup script';
export const DECLINE_LABEL = 'Decline';
const SCRIPT_PREVIEW_CHARS = 4000;

const labelOf = (payload) => (typeof payload?.comment?.action === 'string' ? payload.comment.action
  : typeof payload?.comment?.meta?.action === 'string' ? payload.comment.meta.action : '').trim();

export function createSetupFlow({
  ledger, consent, logDir, env = process.env, run = gitRun, fs = nodeFs, now = Date.now,
}) {
  const exists = (p) => fs.existsSync(p);
  const allowlist = () => parseAllowlist(env.MATRON_WORKTREE_SETUP_ORIGINS);
  const logFileFor = (name) => path.join(logDir, `worktree-setup-${name}-${now()}.log`);
  const plan = (entry, origin) => planSetup({ worktree: entry.path, root: entry.root, origin, allowlist: allowlist(), consent, run, fs });

  // Run the approved bytes. The state is `running` from before the first
  // await, so a second tap or start cannot run it twice.
  async function execSetup(entry, buffer, keep = {}) {
    ledger.update(entry.path, { setup: { state: 'running', ...keep } });
    const res = await runSetup({
      buffer, worktree: entry.path, root: entry.root, name: entry.name, gitDir: entry.gitDir,
      logFile: logFileFor(entry.name), timeoutMs: setupTimeoutMs(env), env, fs,
    });
    const setup = res.ok
      ? { state: 'ok', logFile: res.logFile, ...keep }
      : { state: 'failed', code: res.code, timedOut: res.timedOut, logFile: res.logFile, error: res.error, ...keep };
    ledger.update(entry.path, { setup });
    return { ...res, setup };
  }

  const failureNote = (setup) => `${setupSummary(setup)}${setup.logFile ? ` Log: ${setup.logFile}` : ''}`;

  return {
    // Decide what to do for a new worktree. Resolves, without throwing:
    // {notes, plan (needs a card) | null, runNow (async () => notes) | null}.
    async begin(entry, origin) {
      let p;
      try { p = await plan(entry, origin); } catch (e) { p = { state: 'refused', reason: `could not be checked (${e?.message || e})` }; }
      if (p.state === 'refused') {
        const setup = { state: 'refused', reason: p.reason };
        ledger.update(entry.path, { setup });
        return { notes: [setupSummary(setup)], plan: null, runNow: null };
      }
      if (p.state === 'needs_consent') {
        ledger.update(entry.path, { setup: { state: 'pending', sha256: p.sha256 } });
        return { notes: [], plan: p, runNow: null };
      }
      if (p.state === 'ready') {
        ledger.update(entry.path, { setup: { state: 'running' } });
        return {
          notes: [], plan: null,
          runNow: async () => {
            const r = await execSetup(entry, p.buffer);
            return r.ok ? ['The repository\'s worktree setup script finished successfully.'] : [failureNote(r.setup)];
          },
        };
      }
      return { notes: [], plan: null, runNow: null };
    },

    // The consent card for a script that is not approved (yet).
    consentCard(entry, p) {
      const changed = p.changed ? ' It has changed since you last approved it.' : '';
      const shown = p.content.length > SCRIPT_PREVIEW_CHARS
        ? `${p.content.slice(0, SCRIPT_PREVIEW_CHARS)}\n… (${p.content.length - SCRIPT_PREVIEW_CHARS} more characters not shown)`
        : p.content;
      return {
        kind: 'question',
        title: `Run the worktree setup script for ${p.key}?`,
        body: [
          `The repository ${p.key} has a \`.matron/worktree-setup\` script. Allowing it runs the script (below) on this machine, inside the worktree \`${entry.path}\`, with a 10 minute limit.${changed}`,
          'The approval covers exactly this version (sha256 below); if the script changes, you are asked again.',
          '',
          `sha256: \`${p.sha256}\``,
          '',
          '```sh',
          shown,
          '```',
        ].join('\n'),
        actions: [ALLOW_LABEL, DECLINE_LABEL],
        labels: ['worktree'],
      };
    },

    rememberCard(wtPath, itemId) {
      const entry = ledger.get(wtPath);
      if (entry?.setup) ledger.update(wtPath, { setup: { ...entry.setup, itemId } });
    },

    // Whether a tracker marker is a tap on one of our cards, answered or
    // not. Sync, so the item router can keep it from the agent: a second tap
    // on a card already acted on is swallowed too.
    isCardReply(payload) {
      const id = payload?.item_id;
      if (typeof id !== 'string' || payload?.action !== 'commented') return false;
      const label = labelOf(payload);
      return (label === ALLOW_LABEL || label === DECLINE_LABEL)
        && ledger.list().some((e) => e.setup?.itemId === id);
    },

    // Act on a tap. Resolves null when there is nothing to do (not ours, or
    // the card was already answered); else {message, close}.
    async onCardReply(payload) {
      if (!this.isCardReply(payload)) return null;
      const entry = ledger.list().find((e) => e.setup?.itemId === payload.item_id);
      if (!entry || entry.setup.state !== 'pending') return null;
      const keep = { itemId: payload.item_id };
      if (labelOf(payload) === DECLINE_LABEL) {
        ledger.update(entry.path, { setup: { state: 'refused', reason: 'declined by the user', ...keep } });
        return { message: 'Worktree setup script declined; it was not run.', close: { resolution: 'answered', comment: 'Declined. The script was not run.' } };
      }
      // Claimed before any await: a second tap finds `running` and is ignored.
      ledger.update(entry.path, { setup: { state: 'running', ...keep } });
      const refuse = (reason, message) => {
        ledger.update(entry.path, { setup: { state: 'refused', reason, ...keep } });
        return { message, close: { resolution: 'answered', comment: `Not run: ${reason}.` } };
      };
      if (!exists(entry.path)) return refuse('the worktree no longer exists', 'The worktree is gone, so the setup script was not run.');
      let p;
      // The remote URL is not kept in the ledger (it can carry credentials),
      // so read it from the repository again at approval time.
      try {
        const o = await run(['config', '--get', 'remote.origin.url'], { cwd: entry.root });
        p = await plan(entry, o.code === 0 ? o.stdout : null);
      } catch (e) { return refuse(`it could not be checked (${e?.message || e})`, 'Worktree setup script not run: it could not be checked.'); }
      if (p.state === 'refused' || p.state === 'none') {
        const reason = p.reason || 'the script is gone';
        return refuse(reason, `Worktree setup script not run: ${reason}.`);
      }
      if (p.sha256 !== entry.setup.sha256) {
        return refuse('the script changed after the card was shown', 'Worktree setup script not run: it changed after the approval card was shown. Start a new worktree to be asked again.');
      }
      consent.set(p.key, p.sha256);
      const r = await execSetup(entry, p.buffer, keep);
      return {
        message: r.ok ? 'Worktree setup script finished successfully.' : failureNote(r.setup),
        close: { resolution: 'answered', comment: r.ok ? 'Allowed; the script finished.' : 'Allowed; the script failed.' },
      };
    },
  };
}
