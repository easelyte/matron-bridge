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
    pinnedRoots: { pinned: true },
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
      allowedRoots: { pinned: true },
      maxBytes: 50 * 1024 * 1024,
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

  it('returns upload-failed and does not publish when uploadMedia returns null', async () => {
    const deps = makeDeps();
    deps.uploadMedia.mockResolvedValue(null);

    await expect(share(deps)).resolves.toEqual({ denied: 'upload-failed' });
    expect(deps.publish).not.toHaveBeenCalled();
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
