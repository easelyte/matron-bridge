import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQueuedReleaseOutbox, ACK_RETENTION_MS } from '../lib/queued-release-outbox.js';

function tmpFile() {
  return path.join(os.tmpdir(), `qr-outbox-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

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
  let file;
  let store;

  beforeEach(() => {
    file = tmpFile();
    store = createQueuedReleaseOutbox({ file, log: { warn() {} } });
  });

  afterEach(() => {
    for (const f of [file, `${file}.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    try {
      const dir = path.dirname(file);
      const base = path.basename(file);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${base}.corrupt-`)) fs.unlinkSync(path.join(dir, name));
      }
    } catch { /* ignore */ }
  });

  it('list() is empty before anything is put (missing file)', () => {
    expect(store.list()).toEqual([]);
  });

  it('put() persists a record (atomic tmp+rename, no leftover tmp) and returns true', () => {
    expect(store.put(KEY, rec())).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
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
});
