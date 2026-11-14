import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSavedMediaFile, makeIdentityAwareCleanup } from '../lib/saved-media-file.js';

describe('saved attachments', () => {
  let dir;
  let target;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-media-'));
    target = path.join(dir, 'report.pdf');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('installs complete bytes and cleans the same file once', () => {
    const saved = writeSavedMediaFile(target, Buffer.from('complete'));
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('complete');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
    const cleanup = makeIdentityAwareCleanup(saved.path, saved.identity);
    cleanup();
    fs.writeFileSync(target, 'later upload');
    cleanup();
    expect(fs.readFileSync(target, 'utf8')).toBe('later upload');
  });

  it('reselects after a name collision without replacing the existing upload', () => {
    fs.writeFileSync(target, 'existing');
    const next = path.join(dir, 'report-2.pdf');
    const saved = writeSavedMediaFile(target, Buffer.from('new'), { reselectPath: () => next });
    expect(saved.path).toBe(next);
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readFileSync(next, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir).sort()).toEqual(['report-2.pdf', 'report.pdf']);
  });

  it('does not need hard links and leaves no temporary files', () => {
    const fsImpl = { ...fs, linkSync: () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); } };
    const saved = writeSavedMediaFile(target, Buffer.from('new'), { fsImpl });
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
  });

  it('removes the partial file it created when the write fails', () => {
    const fsImpl = { ...fs, writeFileSync: (p, b, o) => {
      fs.writeFileSync(p, 'par', o);
      throw new Error('disk failure');
    } };
    expect(() => writeSavedMediaFile(target, Buffer.from('new'), { fsImpl })).toThrow('disk failure');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('compares identities as bigint', () => {
    const stats = [];
    const fsImpl = { ...fs, lstatSync: (p, opts) => { stats.push(opts); return fs.lstatSync(p, opts); } };
    const saved = writeSavedMediaFile(target, Buffer.from('x'), { fsImpl });
    expect(typeof saved.identity.ino).toBe('bigint');
    makeIdentityAwareCleanup(saved.path, saved.identity, { fsImpl })();
    expect(stats.every(o => o && o.bigint === true)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('leaves the existing upload when name selection throws', () => {
    fs.writeFileSync(target, 'existing');
    expect(() => writeSavedMediaFile(target, Buffer.from('new'), {
      reselectPath: () => { throw new Error('selection failed'); },
    })).toThrow('selection failed');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
  });

  it('bounds collision retries', () => {
    fs.writeFileSync(target, 'existing');
    expect(() => writeSavedMediaFile(target, Buffer.from('new'), {
      reselectPath: () => target, maxAttempts: 2,
    })).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
  });

  it('leaves a replacement file and unknown identities alone', () => {
    const saved = writeSavedMediaFile(target, Buffer.from('first'));
    fs.renameSync(target, path.join(dir, 'original.pdf'));
    fs.writeFileSync(target, 'replacement');
    makeIdentityAwareCleanup(target, saved.identity)();
    makeIdentityAwareCleanup(target, null)();
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
  });
});
