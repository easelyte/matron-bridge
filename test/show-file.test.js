import { describe, expect, it, vi } from 'vitest';
import {
  denialToStatus,
  parseShowFileUploadTimeoutMs,
  shareAgentMedia,
} from '../lib/show-file.js';
import { DEDUP_MAX_BYTES } from '../lib/show-file.js';
import { createMediaDedupLedger } from '../lib/media-dedup-ledger.js';

class MockFileLinkDenied extends Error {
  constructor(reason) {
    super(`denied: ${reason}`);
    this.reason = reason;
  }
}

function makeDeps({ realPath = '/work/chart.PNG', content = Buffer.from('image data') } = {}) {
  return {
    validateAndOpen: vi.fn().mockResolvedValue({ content, realPath }),
    FileLinkDenied: MockFileLinkDenied,
    uploadMedia: vi.fn().mockResolvedValue({
      media_id: 'media-123',
      content_type: 'image/png',
      size: content.length,
      sha256: 'sha-abc',
    }),
    publish: vi.fn(),
  };
}

function share(deps, overrides = {}) {
  return shareAgentMedia({
    filePath: '/work/chart.PNG',
    caption: 'Quarterly chart',
    pinnedRoots: { roots: [{ realPath: '/work' }] },
    maxBytes: 50 * 1024 * 1024,
    uploadTimeoutMs: 30000,
    deps,
    ...overrides,
  });
}

describe('shareAgentMedia', () => {
  it('uploads and publishes an image with its filename, name, and caption', async () => {
    const content = Buffer.from('image data');
    const deps = makeDeps({ content });

    const result = await share(deps);

    expect(deps.validateAndOpen).toHaveBeenCalledWith('/work/chart.PNG', {
      allowedRoots: { roots: [{ realPath: '/work' }] },
      maxBytes: 50 * 1024 * 1024,
      strictSnapshot: true,
    });
    expect(deps.uploadMedia).toHaveBeenCalledWith({
      bytes: content,
      contentType: 'image/png',
      name: 'chart.PNG',
      timeoutMs: 30000,
    });
    expect(deps.publish).toHaveBeenCalledWith('publishImage', {
      blob_ref: 'media-123',
      content_type: 'image/png',
      name: 'chart.PNG',
      filename: 'chart.PNG',
      size: content.length,
      caption: 'Quarterly chart',
    });
    expect(result).toEqual({
      ok: true,
      media_id: 'media-123',
      kind: 'image',
      realPath: '/work/chart.PNG',
      size: content.length,
      sha256: 'sha-abc',
    });
  });

  it('publishes a non-image as a file without an absent caption', async () => {
    const content = Buffer.from('pdf data');
    const deps = makeDeps({ realPath: '/work/report.pdf', content });
    deps.uploadMedia.mockResolvedValue({
      media_id: 'media-pdf',
      content_type: 'application/octet-stream',
      size: content.length,
      sha256: 'sha-pdf',
    });

    const result = await share(deps, {
      filePath: '/work/report.pdf',
      caption: undefined,
    });

    expect(deps.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'application/octet-stream',
      name: 'report.pdf',
    }));
    expect(deps.publish).toHaveBeenCalledWith('publishFile', {
      blob_ref: 'media-pdf',
      content_type: 'application/octet-stream',
      name: 'report.pdf',
      filename: 'report.pdf',
      size: content.length,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      media_id: 'media-pdf',
      kind: 'file',
      realPath: '/work/report.pdf',
      size: content.length,
      sha256: 'sha-pdf',
    }));
  });

  it.each([
    'sensitive',
    'outside-scope',
    'too-large',
    'not-a-file',
    'unreadable',
    'symlink',
    'relative-path',
    'bad-workdir',
  ])('surfaces the %s denial without uploading or publishing', async (reason) => {
    const deps = makeDeps();
    deps.validateAndOpen.mockRejectedValue(new MockFileLinkDenied(reason));

    await expect(share(deps)).resolves.toEqual({ denied: reason });
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['a pinned object with no roots', { roots: [] }],
    ['a pinned object missing roots', { pinned: true }],
    ['undefined', undefined],
  ])('fails closed with bad-workdir when the pinned root set is %s', async (_label, pinnedRoots) => {
    const deps = makeDeps();

    await expect(share(deps, { pinnedRoots })).resolves.toEqual({ denied: 'bad-workdir' });
    expect(deps.validateAndOpen).not.toHaveBeenCalled();
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('routes an SVG to the downloadable-attachment path, not an inline image', async () => {
    const content = Buffer.from('<svg></svg>');
    const deps = makeDeps({ realPath: '/work/diagram.svg', content });
    deps.uploadMedia.mockResolvedValue({ media_id: 'media-svg' });

    const result = await share(deps, { filePath: '/work/diagram.svg' });

    expect(deps.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'application/octet-stream',
      name: 'diagram.svg',
    }));
    expect(deps.publish).toHaveBeenCalledWith('publishFile', expect.objectContaining({
      blob_ref: 'media-svg',
      content_type: 'application/octet-stream',
    }));
    expect(result).toEqual(expect.objectContaining({ ok: true, kind: 'file' }));
  });

  it('returns upload-failed and does not publish when uploadMedia returns null', async () => {
    const deps = makeDeps();
    deps.uploadMedia.mockResolvedValue(null);

    await expect(share(deps)).resolves.toEqual({ denied: 'upload-failed' });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('falls back to the requested MIME and local byte length when upload metadata is partial', async () => {
    const content = Buffer.from('image data');
    const deps = makeDeps({ content });
    deps.uploadMedia.mockResolvedValue({ media_id: 'media-partial' });

    const result = await share(deps);

    expect(deps.publish).toHaveBeenCalledWith('publishImage', expect.objectContaining({
      blob_ref: 'media-partial',
      content_type: 'image/png',
      size: content.length,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      media_id: 'media-partial',
      size: content.length,
    }));
  });
});

describe('denialToStatus', () => {
  it.each([
    ['sensitive', 403],
    ['outside-scope', 403],
    ['too-large', 413],
    ['not-a-file', 404],
    ['unreadable', 404],
    ['symlink', 404],
    ['relative-path', 404],
    ['bad-workdir', 404],
    ['upload-failed', 502],
  ])('maps %s to %i', (reason, status) => {
    expect(denialToStatus(reason)).toBe(status);
  });

  it('maps an unknown denial to the safe 502 default', () => {
    expect(denialToStatus('unexpected-reason')).toBe(502);
  });
});

describe('parseShowFileUploadTimeoutMs', () => {
  it.each(['-1', 'Infinity', 'not-a-number', '300001'])(
    'warns and defaults invalid value %s to 30000',
    (rawValue) => {
      const warn = vi.fn();

      expect(parseShowFileUploadTimeoutMs(rawValue, warn)).toBe(30000);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(rawValue));
    },
  );

  it('returns a valid positive integer unchanged without warning', () => {
    const warn = vi.fn();

    expect(parseShowFileUploadTimeoutMs('45000', warn)).toBe(45000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('shareAgentMedia retry dedup', () => {
  const run = (deps, overrides = {}) => share(deps, { token: 'tok-1', ...overrides });

  it('records the first publish and returns the same media_id on a retry without uploading again', async () => {
    const dedupLedger = createMediaDedupLedger();
    const first = makeDeps();
    const r1 = await run({ ...first, dedupLedger });
    expect(r1).toMatchObject({ ok: true, media_id: 'media-123' });
    expect(r1.deduped).toBeUndefined();

    const second = makeDeps();
    const r2 = await run({ ...second, dedupLedger });
    expect(r2).toMatchObject({ ok: true, media_id: 'media-123', kind: 'image', sha256: 'sha-abc', deduped: true });
    // Neither a second stored blob nor a second bubble.
    expect(second.uploadMedia).not.toHaveBeenCalled();
    expect(second.publish).not.toHaveBeenCalled();
  });

  it('does not dedup when the caption, content, or session token differs', async () => {
    const dedupLedger = createMediaDedupLedger();
    await run({ ...makeDeps(), dedupLedger });

    for (const [overrides, content] of [
      [{ caption: 'new caption' }, undefined],
      [{}, Buffer.from('different bytes')],
      [{ token: 'tok-2' }, undefined],
    ]) {
      const deps = makeDeps(content ? { content } : {});
      const r = await run({ ...deps, dedupLedger }, overrides);
      expect(r.deduped).toBeUndefined();
      expect(deps.uploadMedia).toHaveBeenCalledOnce();
      expect(deps.publish).toHaveBeenCalledOnce();
    }
  });

  it('reports when the earlier publish happened', async () => {
    let t = 5000;
    const dedupLedger = createMediaDedupLedger({ now: () => t });
    await run({ ...makeDeps(), dedupLedger });
    t = 9000;
    const r = await run({ ...makeDeps(), dedupLedger });
    expect(r).toMatchObject({ deduped: true, deduped_at: 5000 });
  });

  it('skips dedup (and the hash) for files over the size cap', async () => {
    const dedupLedger = createMediaDedupLedger();
    const big = Buffer.alloc(DEDUP_MAX_BYTES + 1);
    await run({ ...makeDeps({ content: big }), dedupLedger });
    const again = makeDeps({ content: big });
    const r = await run({ ...again, dedupLedger });
    expect(r.deduped).toBeUndefined();
    expect(again.uploadMedia).toHaveBeenCalledOnce();
    expect(dedupLedger.size).toBe(0);
  });

  it('treats an empty and a missing caption as the same publish', async () => {
    const dedupLedger = createMediaDedupLedger();
    await run({ ...makeDeps(), dedupLedger }, { caption: '' });
    const r = await run({ ...makeDeps(), dedupLedger }, { caption: undefined });
    expect(r.deduped).toBe(true);
  });

  it('does not record a failed upload, so the retry uploads again', async () => {
    const dedupLedger = createMediaDedupLedger();
    const failing = makeDeps();
    failing.uploadMedia.mockResolvedValue(null);
    expect(await run({ ...failing, dedupLedger })).toEqual({ denied: 'upload-failed' });
    const retry = makeDeps();
    const r = await run({ ...retry, dedupLedger });
    expect(r.deduped).toBeUndefined();
    expect(retry.publish).toHaveBeenCalledOnce();
  });

  it('fails open: a broken ledger warns and the publish proceeds', async () => {
    const dedupLedger = { get: () => { throw new Error('boom'); }, set: () => { throw new Error('boom'); } };
    const warn = vi.fn();
    const deps = makeDeps();
    const r = await run({ ...deps, dedupLedger, warn });
    expect(r).toMatchObject({ ok: true });
    expect(r.deduped).toBeUndefined();
    expect(deps.publish).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
  });
});
