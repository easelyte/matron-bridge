import { describe, it, expect } from 'vitest';
import { classifyVideo, frameFilename, parseShowinfoTimes, extractVideoFrames, videoFramesMessage } from '../lib/video-frames.js';

// ffprobe -print_format json shapes trimmed to what the classifier reads.
function probeWithTags(tags) {
  return { format: { duration: '47.5', tags }, streams: [] };
}

describe('classifyVideo', () => {
  it('classifies camera video by com.apple.quicktime.make/model tags', () => {
    expect(classifyVideo(probeWithTags({
      'com.apple.quicktime.make': 'Apple',
      'com.apple.quicktime.model': 'iPhone 15 Pro',
    }))).toBe('camera');
  });

  it('classifies screen recording by com.apple.quicktime.software without camera tags', () => {
    expect(classifyVideo(probeWithTags({
      'com.apple.quicktime.software': '18.6.2',
    }))).toBe('screen');
  });

  it('camera tags win over a software tag', () => {
    expect(classifyVideo(probeWithTags({
      'com.apple.quicktime.make': 'Apple',
      'com.apple.quicktime.software': '18.6.2',
    }))).toBe('camera');
  });

  it('returns unknown for stripped metadata (transcoded files)', () => {
    // Every real-world sample probed during design had been through
    // HandBrake/WhatsApp and carried only brand + creation_time.
    expect(classifyVideo(probeWithTags({
      major_brand: 'mp42',
      creation_time: '2024-05-22T09:41:08.000000Z',
    }))).toBe('unknown');
  });

  it('returns unknown for missing format/tags entirely', () => {
    expect(classifyVideo({})).toBe('unknown');
    expect(classifyVideo(null)).toBe('unknown');
  });
});

describe('frameFilename', () => {
  it('encodes ordinal and minute/second timestamp', () => {
    expect(frameFilename(1, 0)).toBe('frame-01-at-0m00s.jpg');
    expect(frameFilename(3, 84.3)).toBe('frame-03-at-1m24s.jpg');
  });

  it('zero-pads the ordinal so shell globs sort in time order', () => {
    expect(frameFilename(12, 754.9)).toBe('frame-12-at-12m34s.jpg');
  });
});

describe('parseShowinfoTimes', () => {
  it('extracts pts_time seconds from ffmpeg showinfo stderr', () => {
    const stderr = [
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'/tmp/in.mov\':',
      '[Parsed_showinfo_2 @ 0x600002f04000] n:   0 pts:      0 pts_time:0       duration:512',
      '[Parsed_showinfo_2 @ 0x600002f04000] n:   1 pts:  38912 pts_time:4.06667 duration:512',
      '[Parsed_showinfo_2 @ 0x600002f04000] n:   2 pts: 120832 pts_time:12.6    duration:512',
      'frame=    3 fps=0.0 q=4.0 Lsize=N/A',
    ].join('\n');
    expect(parseShowinfoTimes(stderr)).toEqual([0, 4.06667, 12.6]);
  });

  it('returns empty array when no showinfo lines are present', () => {
    expect(parseShowinfoTimes('some unrelated ffmpeg output')).toEqual([]);
  });

  it('ignores pts_time on non-showinfo lines', () => {
    // Only lines stamped by the showinfo filter count — other filters could
    // echo a pts_time token in unrelated diagnostics.
    const stderr = '[mov @ 0x1] seek pts_time:9.99\n[Parsed_showinfo_0 @ 0x2] n: 0 pts: 0 pts_time:1.5 x';
    expect(parseShowinfoTimes(stderr)).toEqual([1.5]);
  });
});

describe('videoFramesMessage', () => {
  const frames = [
    { path: '/w/clip-frames/frame-01-at-0m00s.jpg', seconds: 0 },
    { path: '/w/clip-frames/frame-02-at-0m03s.jpg', seconds: 3.2 },
    { path: '/w/clip-frames/frame-03-at-0m10s.jpg', seconds: 10.4 },
  ];

  it('describes a screen recording with duration, frame dir, and every filename', () => {
    const msg = videoFramesMessage({
      name: 'RPReplay_Final.mp4', durationSeconds: 13.2, kind: 'screen',
      frames, dir: '/w/clip-frames',
    });
    expect(msg).toContain('🎬');
    expect(msg).toContain('RPReplay_Final.mp4');
    expect(msg).toContain('13s screen recording');
    expect(msg).toContain('/w/clip-frames');
    expect(msg).toContain('frame-01-at-0m00s.jpg');
    expect(msg).toContain('frame-03-at-0m10s.jpg');
    // Steers claude to lazy, selective Read calls — the whole token-cost
    // design rests on not reading every frame.
    expect(msg).toMatch(/Read/);
    expect(msg).toMatch(/selectively/i);
  });

  it('appends a narration section with frame-style timestamps when segments are given', () => {
    const msg = videoFramesMessage({
      name: 'RPReplay_Final.mp4', durationSeconds: 13.2, kind: 'screen',
      frames, dir: '/w/clip-frames',
      narration: [
        { start: 0.4, text: "So here's the checkout page." },
        { start: 7.1, text: 'And when I tap Pay, it freezes.' },
      ],
    });
    expect(msg).toContain('Narration');
    expect(msg).toContain('[0m00s] So here\'s the checkout page.');
    expect(msg).toContain('[0m07s] And when I tap Pay, it freezes.');
  });

  it('omits the narration section when segments are absent or empty', () => {
    const bare = videoFramesMessage({ name: 'c.mp4', durationSeconds: 5, kind: 'screen', frames, dir: '/d' });
    expect(bare).not.toContain('Narration');
    const empty = videoFramesMessage({ name: 'c.mp4', durationSeconds: 5, kind: 'screen', frames, dir: '/d', narration: [] });
    expect(empty).not.toContain('Narration');
  });

  it('labels camera and unknown kinds without claiming screen recording', () => {
    const camera = videoFramesMessage({ name: 'IMG_1.mov', durationSeconds: 60, kind: 'camera', frames, dir: '/d' });
    expect(camera).toContain('60s video');
    expect(camera).not.toContain('screen recording');
    const unknown = videoFramesMessage({ name: 'clip.mp4', durationSeconds: 5, kind: 'unknown', frames, dir: '/d' });
    expect(unknown).toContain('5s video');
  });
});

// --- extractVideoFrames orchestration (fake exec + fake fs) ----------------

function showinfoStderr(times) {
  return times.map((t, i) => `[Parsed_showinfo_2 @ 0x1] n: ${i} pts: 1 pts_time:${t} duration:512`).join('\n');
}

// Minimal fs seam: records calls, serves a configurable frame listing for the
// tmp extraction dir.
function makeFakeFs({ producedFrames = [] } = {}) {
  const calls = { renames: [], removed: [], written: [], mkdirs: [], unlinked: [] };
  let produced = producedFrames;
  return {
    calls,
    setProduced(frames) { produced = frames; },
    impl: {
      mkdtempSync: (prefix) => `${prefix}FAKE`,
      mkdirSync: (dir, opts) => { calls.mkdirs.push({ dir, opts }); },
      writeFileSync: (file, buf) => { calls.written.push({ file, size: buf.length }); },
      readdirSync: () => [...produced],
      unlinkSync: (f) => { calls.unlinked.push(f); },
      renameSync: (from, to) => { calls.renames.push({ from, to }); },
      rmSync: (target, opts) => { calls.removed.push({ target, opts }); },
    },
  };
}

function probeJson({ tags = {}, duration = '47.5' } = {}) {
  return JSON.stringify({ format: { duration, tags }, streams: [] });
}

describe('extractVideoFrames', () => {
  it('screen recording: scene-select run, frames renamed with showinfo timestamps', async () => {
    const fakeFs = makeFakeFs({ producedFrames: ['out-001.jpg', 'out-002.jpg', 'out-003.jpg'] });
    const execCalls = [];
    const exec = async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'ffprobe') {
        return { stdout: probeJson({ tags: { 'com.apple.quicktime.software': '18.6' } }), stderr: '' };
      }
      return { stdout: '', stderr: showinfoStderr([0, 4.06667, 12.6]) };
    };
    const result = await extractVideoFrames(Buffer.from('vid'), 'video/quicktime', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });

    expect(result.kind).toBe('screen');
    expect(result.strategy).toBe('scene');
    expect(result.durationSeconds).toBeCloseTo(47.5);
    // No audio stream in the probe → the caller must not attempt narration.
    expect(result.hasAudio).toBe(false);
    expect(result.frames).toEqual([
      { path: '/frames/dest/frame-01-at-0m00s.jpg', seconds: 0 },
      { path: '/frames/dest/frame-02-at-0m04s.jpg', seconds: 4.06667 },
      { path: '/frames/dest/frame-03-at-0m12s.jpg', seconds: 12.6 },
    ]);
    expect(fakeFs.calls.renames).toHaveLength(3);

    const ffmpeg = execCalls.find((c) => c.cmd === 'ffmpeg');
    const vf = ffmpeg.args[ffmpeg.args.indexOf('-vf') + 1];
    expect(vf).toContain('scene,0.04');
    // Animation transitions select a burst of near-identical frames — the
    // select expression must enforce a minimum gap since the last kept frame.
    expect(vf).toContain('prev_selected_t');
    // Coverage floor: typing-style content changes too little per frame to
    // ever clear the scene threshold, so a heartbeat keeps one frame per
    // uniform interval (5s here) through quiet stretches regardless.
    expect(vf).toContain('gte(t-prev_selected_t,5)');
    expect(vf).toContain('showinfo');
    expect(vf).toContain('1568');
    expect(ffmpeg.args).toContain('-frames:v');
    // The input written from the buffer keeps the mime's extension so ffmpeg
    // container detection has its usual hint.
    expect(fakeFs.calls.written[0].file).toMatch(/\.mov$/);
  });

  it('camera video: uniform sampling with computed timestamps, no scene filter', async () => {
    const fakeFs = makeFakeFs({ producedFrames: ['out-001.jpg', 'out-002.jpg'] });
    const execCalls = [];
    const exec = async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'ffprobe') {
        return {
          stdout: JSON.stringify({
            format: { duration: '60', tags: { 'com.apple.quicktime.make': 'Apple' } },
            streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    const result = await extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });

    expect(result.kind).toBe('camera');
    expect(result.strategy).toBe('uniform');
    expect(result.hasAudio).toBe(true);
    // 60s / 30 max frames = 2s, floored at the 5s minimum interval.
    expect(result.frames).toEqual([
      { path: '/frames/dest/frame-01-at-0m00s.jpg', seconds: 0 },
      { path: '/frames/dest/frame-02-at-0m05s.jpg', seconds: 5 },
    ]);
    const ffmpeg = execCalls.find((c) => c.cmd === 'ffmpeg');
    const vf = ffmpeg.args[ffmpeg.args.indexOf('-vf') + 1];
    expect(vf).toContain('fps=1/5');
    expect(vf).not.toContain('scene');
  });

  it('motion-heavy unknown video: scene pass hits the cap early, falls back to uniform', async () => {
    // 30 selected frames but the last lands at 20s of a 100s video — the
    // scene threshold is drowning in motion, so a uniform re-run must cover
    // the full duration instead.
    const fakeFs = makeFakeFs({ producedFrames: Array.from({ length: 30 }, (_, i) => `out-${String(i + 1).padStart(3, '0')}.jpg`) });
    const sceneTimes = Array.from({ length: 30 }, (_, i) => i * 0.7);
    const ffmpegRuns = [];
    const exec = async (cmd, args) => {
      if (cmd === 'ffprobe') return { stdout: probeJson({ duration: '100' }), stderr: '' };
      ffmpegRuns.push(args);
      return { stdout: '', stderr: ffmpegRuns.length === 1 ? showinfoStderr(sceneTimes) : '' };
    };
    const result = await extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });

    expect(ffmpegRuns).toHaveLength(2);
    expect(ffmpegRuns[0][ffmpegRuns[0].indexOf('-vf') + 1]).toContain('scene');
    expect(ffmpegRuns[1][ffmpegRuns[1].indexOf('-vf') + 1]).toContain('fps=1/5');
    expect(result.strategy).toBe('uniform');
    // 100s at 1 frame per 5s = timestamps 0,5,10... for the produced frames.
    expect(result.frames[1].seconds).toBe(5);
  });

  it('uniform fallback does not inherit stale frames from the scene pass', async () => {
    // The scene pass leaves out-001..030 in the work dir; the uniform re-run
    // (same dir, same pattern) produces only 12. The 18 stale scene files
    // must not survive into the result.
    const tmpFiles = new Set();
    const fakeFs = makeFakeFs();
    fakeFs.impl.readdirSync = () => [...tmpFiles].sort();
    fakeFs.impl.unlinkSync = (f) => { tmpFiles.delete(f.split('/').pop()); };
    fakeFs.impl.renameSync = (from) => { tmpFiles.delete(from.split('/').pop()); };
    let ffmpegRun = 0;
    const exec = async (cmd) => {
      if (cmd === 'ffprobe') return { stdout: probeJson({ duration: '100' }), stderr: '' };
      ffmpegRun += 1;
      const count = ffmpegRun === 1 ? 30 : 12;
      for (let i = 1; i <= count; i += 1) tmpFiles.add(`out-${String(i).padStart(3, '0')}.jpg`);
      return { stdout: '', stderr: ffmpegRun === 1 ? showinfoStderr(Array.from({ length: 30 }, (_, i) => i * 0.7)) : '' };
    };
    const result = await extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });
    expect(result.strategy).toBe('uniform');
    expect(result.frames).toHaveLength(12);
  });

  it('static screen recording that keeps only frame 0 stays on the scene result', async () => {
    const fakeFs = makeFakeFs({ producedFrames: ['out-001.jpg'] });
    const exec = async (cmd) => (cmd === 'ffprobe'
      ? { stdout: probeJson({ tags: { 'com.apple.quicktime.software': '18.6' } }), stderr: '' }
      : { stdout: '', stderr: showinfoStderr([0]) });
    const result = await extractVideoFrames(Buffer.from('vid'), 'video/quicktime', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });
    expect(result.strategy).toBe('scene');
    expect(result.frames).toHaveLength(1);
  });

  it('rejects when ffprobe fails, and still removes the temp dir', async () => {
    const fakeFs = makeFakeFs();
    const exec = async () => { throw new Error('ffprobe exploded'); };
    await expect(extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    })).rejects.toThrow('ffprobe exploded');
    expect(fakeFs.calls.removed.some((r) => r.target.includes('FAKE'))).toBe(true);
  });

  it('rejects when ffmpeg produces no frames', async () => {
    const fakeFs = makeFakeFs({ producedFrames: [] });
    const exec = async (cmd) => (cmd === 'ffprobe'
      ? { stdout: probeJson({}), stderr: '' }
      : { stdout: '', stderr: '' });
    await expect(extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    })).rejects.toThrow(/no frames/i);
  });

  it('falls back to copy+unlink when rename crosses filesystems (EXDEV)', async () => {
    // On the Linux bridge boxes os.tmpdir() is commonly tmpfs while the
    // session workdir is on disk — renameSync throws EXDEV across devices.
    const fakeFs = makeFakeFs({ producedFrames: ['out-001.jpg'] });
    const copies = [];
    fakeFs.impl.renameSync = () => { const e = new Error('EXDEV: cross-device link'); e.code = 'EXDEV'; throw e; };
    fakeFs.impl.copyFileSync = (from, to) => { copies.push({ from, to }); };
    const exec = async (cmd) => (cmd === 'ffprobe'
      ? { stdout: probeJson({}), stderr: '' }
      : { stdout: '', stderr: showinfoStderr([0]) });
    const result = await extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });
    expect(copies).toHaveLength(1);
    expect(copies[0].to).toBe('/frames/dest/frame-01-at-0m00s.jpg');
    expect(result.frames[0].path).toBe('/frames/dest/frame-01-at-0m00s.jpg');
  });

  it('removes the temp working dir after a successful run', async () => {
    const fakeFs = makeFakeFs({ producedFrames: ['out-001.jpg'] });
    const exec = async (cmd) => (cmd === 'ffprobe'
      ? { stdout: probeJson({}), stderr: '' }
      : { stdout: '', stderr: showinfoStderr([0]) });
    await extractVideoFrames(Buffer.from('vid'), 'video/mp4', {
      outDir: '/frames/dest', exec, fs: fakeFs.impl,
    });
    expect(fakeFs.calls.removed.some((r) => r.target.includes('FAKE'))).toBe(true);
  });
});
