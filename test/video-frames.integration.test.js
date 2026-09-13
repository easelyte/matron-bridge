import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractVideoFrames } from '../lib/video-frames.js';

// Real-ffmpeg integration: synthesizes fixture videos at test time (nothing
// binary in the repo) and runs the actual extraction pipeline — the unit
// suite fakes exec, so only this file proves the filtergraph strings parse
// and showinfo timestamps really line up with produced files.

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = hasFfmpeg();

describe.skipIf(!FFMPEG)('extractVideoFrames — real ffmpeg', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-integration-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFixture(name, filterSrc) {
    const file = path.join(tmpDir, name);
    execFileSync('ffmpeg', ['-nostdin', '-f', 'lavfi', '-i', filterSrc,
      '-pix_fmt', 'yuv420p', '-y', file], { stdio: 'ignore', timeout: 60_000 });
    return fs.readFileSync(file);
  }

  it('screen-like video: one hard cut yields the opening frame plus the cut frame, timestamped', async () => {
    // 4s red then 4s blue — a single full-frame change at t=4. No Apple
    // metadata, so classification is 'unknown' and the scene pass runs.
    const buf = makeFixture('cut.mp4',
      'color=c=red:size=320x240:duration=4:rate=10,drawbox=w=1:h=1 [a]; color=c=blue:size=320x240:duration=4:rate=10 [b]; [a][b] concat');
    const outDir = path.join(tmpDir, 'cut-frames');
    const result = await extractVideoFrames(buf, 'video/mp4', { outDir });

    expect(result.kind).toBe('unknown');
    expect(result.strategy).toBe('scene');
    expect(result.durationSeconds).toBeCloseTo(8, 0);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0].seconds).toBe(0);
    expect(result.frames[1].seconds).toBeCloseTo(4, 0);
    // Files really exist and are JPEGs (FFD8 magic).
    for (const f of result.frames) {
      const bytes = fs.readFileSync(f.path);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    }
    expect(result.frames[1].path).toMatch(/frame-02-at-0m04s\.jpg$/);
  });

  it('motion-heavy video: frame count respects the cap and coverage spans the duration', async () => {
    // testsrc mutates every frame (rolling counter), the worst case for
    // scene selection — whatever strategy wins, the result must stay within
    // the cap and cover most of the clip rather than just its start.
    const buf = makeFixture('motion.mp4', 'testsrc=size=320x240:duration=20:rate=15');
    const outDir = path.join(tmpDir, 'motion-frames');
    const result = await extractVideoFrames(buf, 'video/mp4', { outDir, maxFrames: 10 });

    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.frames.length).toBeLessThanOrEqual(10);
    const last = result.frames[result.frames.length - 1];
    expect(last.seconds).toBeGreaterThanOrEqual(result.durationSeconds * 0.5);
  });

  it('downscales frames to the maxEdge bound', async () => {
    const buf = makeFixture('big.mp4',
      'color=c=green:size=1920x1080:duration=2:rate=10');
    const outDir = path.join(tmpDir, 'big-frames');
    const result = await extractVideoFrames(buf, 'video/mp4', { outDir, maxEdge: 640 });
    const probe = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json',
      '-show_streams', result.frames[0].path]);
    const { streams } = JSON.parse(probe.toString());
    expect(streams[0].width).toBe(640);
    expect(streams[0].height).toBe(360);
  });

  it('garbage bytes reject instead of hanging or returning empty frames', async () => {
    await expect(extractVideoFrames(Buffer.from('not a video at all'), 'video/mp4', {
      outDir: path.join(tmpDir, 'garbage-frames'),
    })).rejects.toThrow();
  });
});

describe.skipIf(FFMPEG)('extractVideoFrames — ffmpeg missing', () => {
  it.skip('integration suite skipped: ffmpeg not on PATH', () => {});
});
