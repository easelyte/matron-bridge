import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorktreeLedger } from '../lib/worktree-ledger.js';
import { createWorktreeService } from '../lib/worktree-service.js';
import { ALLOW_LABEL, DECLINE_LABEL, createSetupFlow } from '../lib/worktree-setup-flow.js';
import { createConsentStore } from '../lib/worktree-setup.js';
import { git, makeRepo, roomyStatfs } from './helpers/worktree-repo.js';

const KEY = 'example.com/owner/repo';
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

// Local origins have no host, so the clone's origin is a URL that normalises
// to example.com/owner/repo, and fetching keeps working through insteadOf.
function allowed(files, extraEnv = {}) {
  const r = makeRepo({ files });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wtflow-'));
  cleanups.push(() => { r.cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
  git(r.repo, 'config', `url.${r.origin}.insteadOf`, 'https://example.com/owner/repo.git');
  git(r.repo, 'remote', 'set-url', 'origin', 'https://example.com/owner/repo.git');
  const env = { MATRON_WORKTREE_SETUP_ORIGINS: KEY, ...extraEnv };
  const ledger = createWorktreeLedger({ file: path.join(home, 'worktrees.json') });
  const consent = createConsentStore({ file: path.join(home, 'consent.json') });
  const setup = createSetupFlow({ ledger, consent, logDir: path.join(home, 'logs'), env });
  const service = createWorktreeService({ ledger, setup, statfs: roomyStatfs, env });
  return { r, home, ledger, consent, setup, service, start: (name) => service.start({ workdir: r.repo, name }) };
}

const scriptFiles = (body = '#!/bin/sh\necho ran >> "$MATRON_WORKTREE_PATH/ran.txt"\n') => ({ 'README.md': 'x\n', '.matron/worktree-setup': body });
const sha = (r) => createHash('sha256').update(fs.readFileSync(path.join(r.repo, '.matron', 'worktree-setup'))).digest('hex');
const tap = (itemId, label) => ({ item_id: itemId, action: 'commented', comment: { action: label } });
const ran = (out) => path.join(out.entry.path, 'ran.txt');

describe('gating', () => {
  it('does not run for an origin outside the allowlist (default: none) and says so', async () => {
    for (const list of ['', 'example.com/other/repo']) {
      const h = allowed(scriptFiles(), { MATRON_WORKTREE_SETUP_ORIGINS: list });
      h.consent.set(KEY, sha(h.r));
      const out = await h.start('x');
      expect(out.ok).toBe(true);
      expect(out.plan).toBe(null);
      const notes = await out.background();
      expect(notes.join(' ')).toMatch(/allowlist/);
      expect(h.ledger.get(out.cwd).setup.state).toBe('refused');
      expect(fs.existsSync(ran(out))).toBe(false);
      expect(h.service.info(out.cwd).setupLine).toMatch(/did not run/);
    }
  });

  it('refuses a fork even with an approval on file', async () => {
    const h = allowed(scriptFiles());
    h.consent.set(KEY, sha(h.r));
    git(h.r.repo, 'remote', 'add', 'upstream', 'https://example.com/someone/else.git');
    const out = await h.start('x');
    expect((await out.background()).join(' ')).toMatch(/fork/);
    expect(fs.existsSync(ran(out))).toBe(false);
  });

  it('no setup script means no setup at all', async () => {
    const h = allowed();
    const out = await h.start('x');
    expect(out.plan).toBe(null);
    expect(await out.background()).toEqual([]);
    expect(h.ledger.get(out.cwd).setup).toBeUndefined();
  });
});

describe('consent', () => {
  it('first start: the session can start at once, the plan comes back for a card, nothing ran', async () => {
    const h = allowed(scriptFiles());
    const out = await h.start('x');
    expect(out.ok).toBe(true);
    expect(out.plan.state).toBe('needs_consent');
    expect(h.ledger.get(out.cwd).setup.state).toBe('pending');
    expect(await out.background()).toEqual([]);
    expect(fs.existsSync(ran(out))).toBe(false);
    const card = h.setup.consentCard(out.entry, out.plan);
    expect(card.kind).toBe('question');
    expect(card.actions).toEqual([ALLOW_LABEL, DECLINE_LABEL]);
    expect(card.body).toContain(out.plan.sha256);
    expect(card.body).toContain('echo ran');
    expect(h.service.info(out.cwd).setupLine).toMatch(/waiting for the user's approval/);
  });

  it('Allow stores the sha, runs the script in the worktree, and a later start runs without asking', async () => {
    const h = allowed(scriptFiles());
    const first = await h.start('one');
    h.setup.rememberCard(first.entry.path, 'item-1');
    expect(h.setup.isCardReply(tap('item-1', ALLOW_LABEL))).toBe(true);
    expect(h.setup.isCardReply(tap('item-1', 'something else'))).toBe(false);
    expect(h.setup.isCardReply(tap('other', ALLOW_LABEL))).toBe(false);
    const res = await h.setup.onCardReply(tap('item-1', ALLOW_LABEL));
    expect(res.message).toMatch(/finished successfully/);
    expect(fs.readFileSync(ran(first), 'utf-8').trim()).toBe('ran');
    expect(h.consent.get(KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(h.ledger.get(first.cwd).setup.state).toBe('ok');

    const second = await h.start('two');
    expect(second.plan).toBe(null);
    expect((await second.background()).join(' ')).toMatch(/finished successfully/);
    expect(fs.existsSync(ran(second))).toBe(true);
  });

  it('a double tap runs the script once, and the second tap is swallowed, not sent to the agent', async () => {
    const h = allowed(scriptFiles('#!/bin/sh\nsleep 1\necho ran >> "$MATRON_WORKTREE_PATH/ran.txt"\n'));
    const out = await h.start('x');
    h.setup.rememberCard(out.entry.path, 'item-d');
    const [a, b] = await Promise.all([
      h.setup.onCardReply(tap('item-d', ALLOW_LABEL)),
      h.setup.onCardReply(tap('item-d', ALLOW_LABEL)),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(fs.readFileSync(ran(out), 'utf-8').trim().split('\n')).toHaveLength(1);
    // Even after it finished, a late tap on the answered card is still the bridge's.
    expect(h.setup.isCardReply(tap('item-d', ALLOW_LABEL))).toBe(true);
    expect(await h.setup.onCardReply(tap('item-d', ALLOW_LABEL))).toBe(null);
    expect(fs.readFileSync(ran(out), 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('a state of running is set before the first await (a concurrent tap sees it)', async () => {
    const h = allowed(scriptFiles());
    const out = await h.start('x');
    h.setup.rememberCard(out.entry.path, 'item-r');
    const first = h.setup.onCardReply(tap('item-r', ALLOW_LABEL));
    expect(h.ledger.get(out.cwd).setup.state).toBe('running');
    await first;
  });

  it('Decline runs nothing and stores no approval', async () => {
    const h = allowed(scriptFiles());
    const out = await h.start('x');
    h.setup.rememberCard(out.entry.path, 'item-2');
    const res = await h.setup.onCardReply(tap('item-2', DECLINE_LABEL));
    expect(res.message).toMatch(/declined/);
    expect(fs.existsSync(ran(out))).toBe(false);
    expect(h.consent.get(KEY)).toBe(null);
  });

  it('a script that changed after the card was shown is not run on the old approval', async () => {
    const h = allowed(scriptFiles());
    const out = await h.start('x');
    h.setup.rememberCard(out.entry.path, 'item-3');
    fs.appendFileSync(path.join(out.entry.path, '.matron', 'worktree-setup'), 'echo evil\n');
    const res = await h.setup.onCardReply(tap('item-3', ALLOW_LABEL));
    expect(res.message).toMatch(/changed after the approval card/);
    expect(h.consent.get(KEY)).toBe(null);
    expect(fs.existsSync(ran(out))).toBe(false);
  });

  it('a changed script asks again on the next start', async () => {
    const h = allowed(scriptFiles());
    const first = await h.start('one');
    h.setup.rememberCard(first.entry.path, 'i');
    await h.setup.onCardReply(tap('i', ALLOW_LABEL));
    fs.writeFileSync(path.join(h.r.seed, '.matron', 'worktree-setup'), '#!/bin/sh\necho changed\n');
    git(h.r.seed, 'add', '-A');
    git(h.r.seed, 'commit', '-m', 'change script');
    git(h.r.seed, 'push', 'origin', 'main');
    const second = await h.start('two');
    expect(second.plan.state).toBe('needs_consent');
    expect(second.plan.changed).toBe(true);
  });
});

describe('running', () => {
  it('start does not wait for an approved script: it runs in background()', async () => {
    const h = allowed(scriptFiles('#!/bin/sh\nsleep 1\necho ran >> "$MATRON_WORKTREE_PATH/ran.txt"\n'));
    h.consent.set(KEY, sha(h.r));
    const t0 = Date.now();
    const out = await h.start('x');
    expect(Date.now() - t0).toBeLessThan(900 + 3000); // create only, never the script
    expect(fs.existsSync(ran(out))).toBe(false);
    expect(h.ledger.get(out.cwd).setup.state).toBe('running');
    expect(h.service.info(out.cwd).setupLine).toMatch(/still running/);
    const notes = await out.background();
    expect(notes.join(' ')).toMatch(/finished successfully/);
    expect(fs.existsSync(ran(out))).toBe(true);
  });

  it('a failing script still starts the session, with a notice', async () => {
    const h = allowed(scriptFiles('#!/bin/sh\necho nope >&2\nexit 7\n'));
    h.consent.set(KEY, sha(h.r));
    const out = await h.start('x');
    expect(out.ok).toBe(true);
    const notes = await out.background();
    expect(notes.join(' ')).toMatch(/failed \(exit 7\)/);
    const setup = h.ledger.get(out.cwd).setup;
    expect(setup).toMatchObject({ state: 'failed', code: 7 });
    expect(fs.readFileSync(setup.logFile, 'utf-8')).toContain('nope');
    expect(h.service.info(out.cwd).setupLine).toMatch(/failed/);
  });

  it('a script that times out still starts the session, with a notice', async () => {
    const h = allowed(scriptFiles('#!/bin/sh\nsleep 30\n'), { MATRON_WORKTREE_SETUP_TIMEOUT_MS: '300' });
    h.consent.set(KEY, sha(h.r));
    const out = await h.start('x');
    expect(out.ok).toBe(true);
    const notes = await out.background();
    expect(notes.join(' ')).toMatch(/timed out/);
    expect(h.ledger.get(out.cwd).setup).toMatchObject({ state: 'failed', timedOut: true });
  });

  it('puts what the script wrote into the agent notice', async () => {
    const h = allowed(scriptFiles('#!/bin/sh\necho "The dev server for this copy is on port 4002." > "$MATRON_WORKTREE_NOTICE_FILE"\n'));
    h.consent.set(KEY, sha(h.r));
    const out = await h.start('x');
    await out.background();
    expect(h.service.noticeBlock(out.cwd)).toContain('port 4002');
  });

  it('a script that cannot be read after the worktree was added: the session still starts, no orphan', async () => {
    const r = makeRepo({ files: scriptFiles() });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wtflow-'));
    cleanups.push(() => { r.cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
    git(r.repo, 'config', `url.${r.origin}.insteadOf`, 'https://example.com/owner/repo.git');
    git(r.repo, 'remote', 'set-url', 'origin', 'https://example.com/owner/repo.git');
    const env = { MATRON_WORKTREE_SETUP_ORIGINS: KEY };
    const flaky = { ...fs, readFileSync: (f, ...a) => { if (String(f).endsWith('worktree-setup')) throw Object.assign(new Error('io'), { code: 'EIO' }); return fs.readFileSync(f, ...a); } };
    const ledger = createWorktreeLedger({ file: path.join(home, 'w.json') });
    const setup = createSetupFlow({ ledger, consent: createConsentStore({ file: path.join(home, 'c.json') }), logDir: home, env, fs: flaky });
    const service = createWorktreeService({ ledger, setup, statfs: roomyStatfs, env });
    const out = await service.start({ workdir: r.repo, name: 'x' });
    expect(out.ok).toBe(true);
    expect(fs.existsSync(out.entry.path)).toBe(true);
    expect(ledger.get(out.cwd)).toBeTruthy();
    expect((await out.background()).join(' ')).toMatch(/could not be read/);
  });

  it('a setup flow that throws outright is a note, and the worktree is still recorded', async () => {
    const h = allowed(scriptFiles());
    const boom = { begin: async () => { throw new Error('exploded'); } };
    const service = createWorktreeService({ ledger: h.ledger, setup: boom, statfs: roomyStatfs });
    const out = await service.start({ workdir: h.r.repo, name: 'y' });
    expect(out.ok).toBe(true);
    expect(h.ledger.get(out.cwd)).toBeTruthy();
    expect((await out.background()).join(' ')).toMatch(/skipped: exploded/);
  });
});
