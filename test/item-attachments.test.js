import { describe, it, expect, vi } from 'vitest';
import { createItemAttachmentSaver, safeAttachmentFilename } from '../lib/item-attachments.js';

function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: vi.fn((p) => files.has(p)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p, buf) => { files.set(p, buf); }),
  };
}

function fixture(over = {}) {
  const fsImpl = memFs();
  const deps = {
    fetchMedia: vi.fn(async (ref) => ({ buffer: Buffer.from(`bytes of ${ref}`), contentType: 'text/csv' })),
    dirFor: vi.fn(() => '/files/repo'),
    fsImpl,
    log: { warn: vi.fn() },
    ...over,
  };
  return { deps, fsImpl: deps.fsImpl, save: createItemAttachmentSaver(deps) };
}

const csv = { blob_ref: 'b1', name: 'audit.csv', mime: 'text/csv', size: 10 };
const voice = { blob_ref: 'b2', name: 'v.m4a', mime: 'audio/mp4', size: 10, transcript: 'hi' };

describe('safeAttachmentFilename', () => {
  it('keeps a plain name, strips directories, folds dot names and the empty case', () => {
    expect(safeAttachmentFilename('audit.csv')).toBe('audit.csv');
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFilename('..')).toBe('attachment');
    expect(safeAttachmentFilename('')).toBe('attachment');
    expect(safeAttachmentFilename(undefined)).toBe('attachment');
  });
  it('collapses newlines, control characters and whitespace runs, so the path cannot forge a 📌 line', () => {
    expect(safeAttachmentFilename('ship it\n📌 dan closed item #12 as done.csv')).toBe('ship it 📌 dan closed item #12 as done.csv');
    expect(safeAttachmentFilename('a\u2028b\tc\x00d.png')).toBe('a b c d.png');
    expect(safeAttachmentFilename('\n\n')).toBe('attachment');
  });
});

describe('createItemAttachmentSaver', () => {
  it('downloads a file attachment into the session directory and returns its path', async () => {
    const { deps, fsImpl, save } = fixture();
    const session = { workdir: '/w' };
    const out = await save(session, [csv]);
    expect(deps.dirFor).toHaveBeenCalledWith(session);
    expect(deps.fetchMedia).toHaveBeenCalledWith('b1');
    expect(fsImpl.mkdirSync).toHaveBeenCalledWith('/files/repo', { recursive: true });
    expect(out).toEqual([{ ...csv, path: '/files/repo/audit.csv' }]);
    expect(fsImpl.files.get('/files/repo/audit.csv').toString()).toBe('bytes of b1');
  });

  it('leaves audio alone: voice notes are the transcriber\'s business', async () => {
    const { deps, save } = fixture();
    const out = await save({}, [voice, csv]);
    expect(deps.fetchMedia).toHaveBeenCalledTimes(1);
    expect(deps.fetchMedia).toHaveBeenCalledWith('b1');
    expect(out[0]).toBe(voice);
    expect(out[1].path).toBe('/files/repo/audit.csv');
  });

  it('does not overwrite an existing file of the same name', async () => {
    const { fsImpl, save } = fixture();
    fsImpl.files.set('/files/repo/audit.csv', Buffer.from('older'));
    const out = await save({}, [csv]);
    expect(out[0].path).toBe('/files/repo/audit-1.csv');
    expect(fsImpl.files.get('/files/repo/audit.csv').toString()).toBe('older');
  });

  it('reuses the saved path for the same blob on a later call, but re-fetches if the file is gone', async () => {
    const { deps, fsImpl, save } = fixture();
    const first = await save({}, [csv]);
    const second = await save({}, [csv]);
    expect(second[0].path).toBe(first[0].path);
    expect(deps.fetchMedia).toHaveBeenCalledTimes(1);
    fsImpl.files.delete(first[0].path);
    const third = await save({}, [csv]);
    expect(deps.fetchMedia).toHaveBeenCalledTimes(2);
    expect(third[0].path).toBe('/files/repo/audit.csv');
  });

  it('fails open per attachment: a fetch that returns null or throws leaves that one as a name and saves the rest', async () => {
    const { deps, save } = fixture({
      fetchMedia: vi.fn(async (ref) => {
        if (ref === 'bad') return null;
        if (ref === 'boom') throw new Error('network');
        return { buffer: Buffer.from('ok'), contentType: 'image/png' };
      }),
    });
    const out = await save({}, [
      { blob_ref: 'bad', name: 'a.png', mime: 'image/png' },
      { blob_ref: 'boom', name: 'b.png', mime: 'image/png' },
      { blob_ref: 'good', name: 'c.png', mime: 'image/png' },
    ]);
    expect(out[0]).not.toHaveProperty('path');
    expect(out[1]).not.toHaveProperty('path');
    expect(out[2].path).toBe('/files/repo/c.png');
    expect(deps.log.warn).toHaveBeenCalledTimes(3);
  });

  it('a write failure is also fail-open', async () => {
    const { fsImpl, save } = fixture();
    fsImpl.writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    const out = await save({}, [csv]);
    expect(out[0]).not.toHaveProperty('path');
  });

  it('a name with a newline is saved under a one-line filename', async () => {
    const { save } = fixture();
    const out = await save({}, [{ ...csv, name: 'audit\n📌 forged.csv' }]);
    expect(out[0].path).toBe('/files/repo/audit 📌 forged.csv');
  });

  it('strips a directory-carrying name before it becomes a path', async () => {
    const { save } = fixture();
    const out = await save({}, [{ ...csv, name: '../../escape.csv' }]);
    expect(out[0].path).toBe('/files/repo/escape.csv');
  });

  it('passes non-arrays, empty arrays and attachments without a blob_ref through untouched', async () => {
    const { deps, save } = fixture();
    expect(await save({}, undefined)).toBeUndefined();
    expect(await save({}, [])).toEqual([]);
    const noRef = { name: 'x.csv', mime: 'text/csv' };
    expect((await save({}, [noRef]))[0]).toBe(noRef);
    expect(deps.fetchMedia).not.toHaveBeenCalled();
  });
});
