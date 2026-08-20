import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQueuedReleaseOutbox, ACK_RETENTION_MS } from '../lib/queued-release-outbox.js';

function rec(overrides = {}) {
  return {
    convoId: 'convo-1',
    promptId: 'pr_1',
    itemId: 'pr_1::0',
    action: 'cancel',
    releasedIds: ['pr_1::0'],
    status: 'pending',
    at: 1_000,
    ...overrides,
  };
}
const KEY = 'pr_1\0pr_1::0\0cancel';

describe('queued-release-outbox', () => {
  let dir;
  let file;
  let store;

  beforeEach(() => {
    // A private 0700 temp DIR (not a predictable name in the shared tmpdir) so
    // the store file + its siblings (.tmp, .corrupt-*) can't collide or be
    // pre-created by another user, and cleanup is a single recursive remove.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-outbox-'));
    file = path.join(dir, 'outbox.json');
    store = createQueuedReleaseOutbox({ file, log: { warn() {} } });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('list() is empty before anything is put (missing file)', () => {
    expect(store.list()).toEqual([]);
  });

  it('put() persists a record (atomic tmp+rename, no leftover tmp) and returns true', () => {
    expect(store.put(KEY, rec())).toBe(true);
    // No leftover tmp of any name (the write uses a random suffix + rename).
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: KEY, promptId: 'pr_1', action: 'cancel', status: 'pending' });
    expect(typeof list[0].enqueuedAt).toBe('number');
  });

  it('put() is an idempotent upsert that preserves the original enqueuedAt', () => {
    store.put(KEY, rec({ at: 1_000 }));
    const first = store.list()[0].enqueuedAt;
    store.put(KEY, rec({ at: 9_999, status: 'pending' }));
    const after = store.list()[0];
    expect(after.enqueuedAt).toBe(first);
    expect(after.at).toBe(9_999);
  });

  it('persists across a fresh instance and RELABELS on-disk pending -> pending_inherited (state gate)', () => {
    store.put(KEY, rec());
    const reopened = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    const list = reopened.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('pending_inherited');
  });

  it('an acked record survives a reopen WITHOUT being relabelled (only pending is inherited)', () => {
    store.put(KEY, rec());
    store.markAcked('pr_1', 'cancel');
    const reopened = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(reopened.list()[0].status).toBe('acked');
  });

  it('markAcked flips every record matching (promptId, action) and returns the count', () => {
    store.put(KEY, rec());
    store.put('pr_1\0pr_1::0\0send', rec({ action: 'send' }));
    expect(store.markAcked('pr_1', 'cancel')).toBe(1);
    const byKey = Object.fromEntries(store.list().map(r => [r.key, r.status]));
    expect(byKey[KEY]).toBe('acked');
    expect(byKey['pr_1\0pr_1::0\0send']).toBe('pending');
  });

  it('markAcked flips IN MEMORY even when the disk persist throws (best-effort persist)', () => {
    store.put(KEY, rec());
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('EIO'); });
    try {
      expect(store.markAcked('pr_1', 'cancel')).toBe(1);
      expect(store.list()[0].status).toBe('acked'); // in-memory ack is authoritative
    } finally {
      spy.mockRestore();
    }
  });

  it('put() returns false (fail-closed) when the durable write fails, and does NOT commit in memory', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('ENOSPC'); });
    try {
      expect(store.put(KEY, rec())).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(store.list()).toEqual([]); // nothing committed
  });

  it('remove() drops a record; remove() on an absent key is a no-op true', () => {
    store.put(KEY, rec());
    expect(store.remove(KEY)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove('nope')).toBe(true);
  });

  it('abort() drops a record IN MEMORY even when the disk persist throws (rollback is retry-safe)', () => {
    store.put(KEY, rec());
    expect(store.pendingCount()).toBe(1);
    // Same faulting disk that would trigger a send rollback: the persist of the
    // removal fails, but the record must still leave the in-memory pending set
    // so republishPendingReleases (retry driver) can never republish it.
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('ENOSPC'); });
    try {
      store.abort(KEY);
      expect(store.list()).toEqual([]);      // gone from memory (authoritative)
      expect(store.pendingCount()).toBe(0);  // no longer retry-eligible
    } finally {
      spy.mockRestore();
    }
  });

  it('abort() persists the removal when the disk is healthy; no-op on an absent key', () => {
    store.put(KEY, rec());
    store.abort(KEY);
    expect(store.list()).toEqual([]);
    // Durable: a fresh instance sees nothing.
    const reopened = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(reopened.list()).toEqual([]);
    expect(() => store.abort('nope')).not.toThrow();
  });

  it('sweepAcked drops acked records older than retention, keeps fresh + non-acked (fake clock)', () => {
    store.put(KEY, rec());
    store.put('pr_2\0pr_2::0\0send', rec({ promptId: 'pr_2', itemId: 'pr_2::0', action: 'send' }));
    store.markAcked('pr_1', 'cancel'); // ackedAt = now
    const now = Date.now();
    // Nothing aged yet.
    expect(store.sweepAcked(ACK_RETENTION_MS, now)).toBe(0);
    // Far future -> the acked record is swept, the pending one stays.
    expect(store.sweepAcked(ACK_RETENTION_MS, now + ACK_RETENTION_MS + 1)).toBe(1);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('pending');
  });

  it('quarantines a corrupt file instead of overwriting it, then starts clean', () => {
    fs.writeFileSync(file, '{ this is not json');
    const fresh = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(fresh.list()).toEqual([]);
    const dir = path.dirname(file);
    const base = path.basename(file);
    const quarantined = fs.readdirSync(dir).filter(n => n.startsWith(`${base}.corrupt-`));
    expect(quarantined).toHaveLength(1);
    expect(fresh.put(KEY, rec())).toBe(true);
    expect(fresh.list()).toHaveLength(1);
  });

  it('a non-object JSON payload is treated as corrupt and quarantined', () => {
    fs.writeFileSync(file, '[1,2,3]');
    const fresh = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(fresh.list()).toEqual([]);
    const dir = path.dirname(file);
    const base = path.basename(file);
    expect(fs.readdirSync(dir).filter(n => n.startsWith(`${base}.corrupt-`))).toHaveLength(1);
  });

  it('refuses to overwrite a present-but-unreadable file: put/remove return false', () => {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    fs.mkdirSync(file); // readFileSync throws EISDIR -> unreadable
    try {
      const ro = createQueuedReleaseOutbox({ file, log: { warn() {} } });
      expect(ro.list()).toEqual([]);
      expect(ro.put(KEY, rec())).toBe(false);
      expect(ro.remove(KEY)).toBe(false);
      expect(fs.statSync(file).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });

  // Nicety (a): O(1) pending gate for the hot retry driver.
  it('pendingCount() tracks retry-eligible pending records only', () => {
    expect(store.pendingCount()).toBe(0);
    store.put(KEY, rec());
    expect(store.pendingCount()).toBe(1);
    store.put('pr_2\0pr_2::0\0send', rec({ promptId: 'pr_2', itemId: 'pr_2::0', action: 'send' }));
    expect(store.pendingCount()).toBe(2);
    store.markAcked('pr_1', 'cancel'); // acked no longer counts
    expect(store.pendingCount()).toBe(1);
    store.remove('pr_2\0pr_2::0\0send');
    expect(store.pendingCount()).toBe(0);
  });

  it('inherited (relabelled) records do not count toward pendingCount()', () => {
    store.put(KEY, rec());
    const reopened = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(reopened.list()[0].status).toBe('pending_inherited');
    expect(reopened.pendingCount()).toBe(0);
  });

  // Nicety (a): sweepAcked is no longer boot-only — markAcked GCs aged acked.
  it('markAcked sweeps retention-expired acked records (GC no longer boot-only)', () => {
    const oldAckedAt = Date.now() - (ACK_RETENTION_MS + 60_000);
    fs.writeFileSync(file, JSON.stringify({
      'old\0old::0\0send': { promptId: 'old', itemId: 'old::0', action: 'send', releasedIds: ['old::0'], status: 'acked', ackedAt: oldAckedAt, at: 1 },
      [KEY]: rec(), // pending -> pending_inherited on reopen
    }));
    const s = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(s.list().find(r => r.key === 'old\0old::0\0send')).toBeTruthy();
    s.markAcked('pr_1', 'cancel'); // flips inherited->acked AND sweeps the aged one
    expect(s.list().find(r => r.key === 'old\0old::0\0send')).toBeUndefined();
  });

  // Nicety (b): env override for the state-file path (dev/live isolation).
  it('honors MATRON_QUEUED_RELEASE_OUTBOX_FILE as the default state-file path', async () => {
    const envFile = path.join(dir, 'env-default-outbox.json');
    const prev = process.env.MATRON_QUEUED_RELEASE_OUTBOX_FILE;
    process.env.MATRON_QUEUED_RELEASE_OUTBOX_FILE = envFile;
    try {
      // Fresh module eval (distinct specifier) so the module-level DEFAULT_FILE
      // const re-reads process.env.
      const mod = await import('../lib/queued-release-outbox.js?envfiletest');
      const s = mod.createQueuedReleaseOutbox({ log: { warn() {} } }); // no file arg
      expect(s.put(KEY, rec())).toBe(true);
      expect(fs.existsSync(envFile)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MATRON_QUEUED_RELEASE_OUTBOX_FILE;
      else process.env.MATRON_QUEUED_RELEASE_OUTBOX_FILE = prev;
    }
  });

  // Minor: sweep stale tmp/quarantine litter at boot.
  it('sweeps stale .tmp litter at boot but preserves a recent .corrupt-* quarantine', () => {
    const staleTmp = `${file}.deadbeef.tmp`;
    fs.writeFileSync(staleTmp, 'junk');
    const oldCorrupt = `${file}.corrupt-1`;
    fs.writeFileSync(oldCorrupt, 'junk');
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000); // > 24h
    fs.utimesSync(oldCorrupt, aged, aged);
    const recentCorrupt = `${file}.corrupt-${Date.now()}`;
    fs.writeFileSync(recentCorrupt, 'junk');

    createQueuedReleaseOutbox({ file, log: { warn() {} } });

    expect(fs.existsSync(staleTmp)).toBe(false);     // stale tmp swept
    expect(fs.existsSync(oldCorrupt)).toBe(false);    // aged quarantine swept
    expect(fs.existsSync(recentCorrupt)).toBe(true);  // recent quarantine preserved
  });
});
