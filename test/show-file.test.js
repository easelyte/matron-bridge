import { describe, expect, it, vi } from 'vitest';
import {
  denialToStatus,
  parseShowFileUploadTimeoutMs,
  shareAgentMedia,
} from '../lib/show-file.js';

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
      deduped: false,
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

describe('shareAgentMedia dedup ledger', () => {
  function makeLedger() {
    const store = new Map();
    return {
      get: vi.fn((k) => store.get(k)),
      set: vi.fn((k, v) => { store.set(k, v); }),
      _store: store,
    };
  }

  it('records the publish in the ledger on the first share', async () => {
    const deps = makeDeps();
    const dedupLedger = makeLedger();

    const result = await share(deps, { token: 'tok-1', deps: { ...deps, dedupLedger } });

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(dedupLedger.set).toHaveBeenCalledTimes(1);
    expect(dedupLedger.set.mock.calls[0][1]).toEqual({ mediaId: 'media-123', kind: 'image' });
    expect(result).toEqual(expect.objectContaining({ ok: true, media_id: 'media-123', deduped: false }));
  });

  it('skips the re-publish and returns the prior media_id on an identity match', async () => {
    const dedupLedger = makeLedger();
    const first = makeDeps();
    await share(first, { token: 'tok-1', deps: { ...first, dedupLedger } });

    // Second call: same token/realPath/sha256/caption → a fresh upload, but the
    // publish must be suppressed and the prior media_id returned.
    const second = makeDeps();
    second.uploadMedia.mockResolvedValue({
      media_id: 'media-DUPLICATE', content_type: 'image/png', size: 10, sha256: 'sha-abc',
    });

    const result = await share(second, { token: 'tok-1', deps: { ...second, dedupLedger } });

    expect(second.uploadMedia).toHaveBeenCalledTimes(1); // upload still happens
    expect(second.publish).not.toHaveBeenCalled();       // publish suppressed
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      media_id: 'media-123', // the PRIOR id, not media-DUPLICATE
      kind: 'image',
      deduped: true,
    }));
  });

  it('does NOT dedup when the caption differs (intentional re-show is preserved)', async () => {
    const dedupLedger = makeLedger();
    const first = makeDeps();
    await share(first, { token: 'tok-1', caption: 'v1', deps: { ...first, dedupLedger } });

    const second = makeDeps();
    const result = await share(second, { token: 'tok-1', caption: 'v2 — updated', deps: { ...second, dedupLedger } });

    expect(second.publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ deduped: false }));
  });

  it('does NOT dedup across different tokens (per-session scope)', async () => {
    const dedupLedger = makeLedger();
    const first = makeDeps();
    await share(first, { token: 'tok-A', deps: { ...first, dedupLedger } });

    const second = makeDeps();
    const result = await share(second, { token: 'tok-B', deps: { ...second, dedupLedger } });

    expect(second.publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ deduped: false }));
  });

  it('does not dedup when sha256 is absent from upload metadata (cannot key)', async () => {
    const dedupLedger = makeLedger();
    const deps = makeDeps();
    deps.uploadMedia.mockResolvedValue({ media_id: 'media-partial' }); // no sha256

    const result = await share(deps, { token: 'tok-1', deps: { ...deps, dedupLedger } });

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(dedupLedger.set).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ ok: true, deduped: false }));
  });

  it('fails open and publishes normally when the ledger throws', async () => {
    const dedupLedger = {
      get: vi.fn(() => { throw new Error('ledger get boom'); }),
      set: vi.fn(() => { throw new Error('ledger set boom'); }),
    };
    const deps = makeDeps();

    const result = await share(deps, { token: 'tok-1', deps: { ...deps, dedupLedger } });

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ ok: true, media_id: 'media-123' }));
  });

  it('behaves exactly as before when no ledger is injected', async () => {
    const deps = makeDeps();
    const result = await share(deps, { token: 'tok-1' }); // no dedupLedger in deps

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ ok: true, media_id: 'media-123' }));
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
