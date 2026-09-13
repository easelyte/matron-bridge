// Video → key-frame extraction so a screen recording (or any video) a Matron
// client sends can reach claude as a handful of timestamped JPEG stills —
// the Claude API has no video input type, so frames are the only way in.

import { execFile } from 'child_process';
import { promisify } from 'util';
import realFs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

export const VIDEO_MIME_TO_EXT = {
  'video/quicktime': '.mov',
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/webm': '.webm',
  'video/mpeg': '.mpg',
};

// What kind of video an ffprobe metadata blob describes. Metadata is a HINT,
// not the gate: every real-world sample probed during design (WhatsApp,
// HandBrake re-encodes) had its Apple tags stripped, so 'unknown' is the
// common case and the extraction strategy self-corrects from probe output.
// Camera originals carry com.apple.quicktime.make/model; Apple screen
// recordings stamp com.apple.quicktime.software (an OS version) instead.
export function classifyVideo(probe) {
  const tags = (probe && probe.format && probe.format.tags) || {};
  if (tags['com.apple.quicktime.make'] || tags['com.apple.quicktime.model']) return 'camera';
  if (tags['com.apple.quicktime.software']) return 'screen';
  return 'unknown';
}

// frame-03-at-1m24s.jpg — the zero-padded ordinal keeps directory listings in
// time order, and the human-readable timestamp lets claude binary-search a
// recording ("open the frame nearest 2m") without any sidecar index.
// Truncate, never round: "12m34s" must mean AT/after 12:34, so seeking to
// that time in a player always lands at or before the moment. Shared by
// frame filenames and narration lines so the two cross-reference exactly.
function timestampLabel(seconds) {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}m${s}s`;
}

export function frameFilename(ordinal, seconds) {
  return `frame-${String(ordinal).padStart(2, '0')}-at-${timestampLabel(seconds)}.jpg`;
}

// The showinfo filter logs one stderr line per frame that reaches it; placed
// after select= it therefore records the source pts of exactly the frames
// that were kept — the only reliable way to learn a scene-selected frame's
// original timestamp (output files renumber from 1).
export function parseShowinfoTimes(stderr) {
  const times = [];
  for (const line of String(stderr).split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue;
    const m = line.match(/pts_time:([0-9.]+)/);
    if (m) times.push(parseFloat(m[1]));
  }
  return times;
}

// The user-turn text that hands claude the extracted frames. Frames stay on
// disk and are listed by name — claude Reads them lazily, so context is only
// spent on frames it actually opens (the load-bearing property that keeps a
// long recording from flooding the window).
export function videoFramesMessage({ name, durationSeconds, kind, frames, dir, narration }) {
  const label = kind === 'screen' ? 'screen recording' : 'video';
  const dur = `${Math.round(durationSeconds)}s`;
  const list = frames.map((f) => f.path.split('/').pop()).join(', ');
  let msg = `🎬 Video attached: ${name} (${dur} ${label}). `
    + `${frames.length} key frame${frames.length === 1 ? '' : 's'} extracted to ${dir} `
    + `(filenames carry the timestamp): ${list}. `
    + `Read frames selectively with the Read tool — start with the one nearest the moment of interest rather than reading all of them.`;
  if (Array.isArray(narration) && narration.length) {
    // The narration is the user's commentary track — it usually says which
    // moment matters, letting claude pick the right frame without opening
    // the rest. Same m/s labels as the frame filenames.
    msg += '\n\nNarration (timestamps match the frame names):\n'
      + narration.map((seg) => `[${timestampLabel(seg.start)}] ${seg.text}`).join('\n');
  }
  return msg;
}

// Cap width AND height at maxEdge without ever upscaling: min(iw,cap) /
// min(ih,cap) shrink the box to the source for small videos, and
// force_original_aspect_ratio=decrease fits larger ones inside it.
// (Filtergraph-level quotes keep the commas inside min() out of the
// filter-chain parser.)
function scaleFilter(maxEdge) {
  return `scale='min(iw,${maxEdge})':'min(ih,${maxEdge})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

// Slow ceiling, generous stderr buffer (showinfo logs a line per frame).
const FFMPEG_OPTS = { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 };

function ffmpegArgs(inputPath, vf, maxFrames, outPattern) {
  return [
    '-nostdin', '-i', inputPath,
    '-vf', vf,
    '-fps_mode', 'vfr',
    '-frames:v', String(maxFrames),
    '-q:v', '4',
    '-y', outPattern,
  ];
}

/// Extracts up to maxFrames timestamped JPEG stills from a video buffer into
/// outDir. Strategy: camera-tagged video is uniformly sampled (constant
/// motion makes scene detection meaningless); everything else tries
/// scene-change selection first — ideal for screen recordings, which are
/// static between interactions — and self-corrects to uniform sampling when
/// the scene pass burns its frame budget early (motion-heavy content that
/// metadata failed to identify). Throws on any ffprobe/ffmpeg failure or an
/// empty result; the caller falls back to delivering the raw file.
export async function extractVideoFrames(buffer, mime, {
  outDir,
  maxFrames = 30,
  maxEdge = 1568,
  // Calibrated on a real iOS screen recording: taps/menu changes score
  // 0.03–0.09 (only part of the frame changes — nothing like a movie cut's
  // 0.3+), scroll noise sits below ~0.03. 0.1 selected NOTHING.
  sceneThreshold = 0.04,
  exec = (cmd, args, opts) => execFileAsync(cmd, args, opts),
  fs = realFs,
} = {}) {
  const ext = VIDEO_MIME_TO_EXT[mime] || '.mp4';
  // Private 0700 work dir, same pattern as transcribe.js.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frames-'));
  const inputPath = path.join(tmpDir, `input${ext}`);
  const outPattern = path.join(tmpDir, 'out-%03d.jpg');

  // One extraction pass: runs ffmpeg, returns the produced tmp files. Clears
  // any previous pass's output first — the uniform fallback reuses the same
  // dir/pattern, and a shorter second pass must not inherit the scene pass's
  // leftover higher-numbered frames.
  async function runPass(vf) {
    for (const f of fs.readdirSync(tmpDir)) {
      if (/^out-\d+\.jpg$/.test(f)) fs.unlinkSync(path.join(tmpDir, f));
    }
    const { stderr } = await exec('ffmpeg', ffmpegArgs(inputPath, vf, maxFrames, outPattern), FFMPEG_OPTS);
    const files = fs.readdirSync(tmpDir)
      .filter((f) => /^out-\d+\.jpg$/.test(f))
      .sort();
    return { files, stderr };
  }

  try {
    fs.writeFileSync(inputPath, buffer);

    const { stdout: probeOut } = await exec('ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
      FFMPEG_OPTS);
    const probe = JSON.parse(probeOut);
    const kind = classifyVideo(probe);
    const durationSeconds = parseFloat(probe && probe.format && probe.format.duration) || 0;
    // Whether a narration pass is even worth attempting — screen recordings
    // are commonly captured with the mic off and carry no audio stream.
    const hasAudio = Array.isArray(probe.streams)
      && probe.streams.some((s) => s && s.codec_type === 'audio');
    // ≥5s between uniform frames: a camera clip doesn't need frame-dense
    // coverage, and long videos stretch the interval to stay under the cap.
    const uniformInterval = Math.max(5, durationSeconds / maxFrames);
    const uniformVf = `fps=1/${uniformInterval},${scaleFilter(maxEdge)}`;

    let strategy;
    let files;
    let times;
    if (kind === 'camera') {
      strategy = 'uniform';
      ({ files } = await runPass(uniformVf));
      times = files.map((_, i) => i * uniformInterval);
    } else {
      // eq(n,0) always keeps the opening frame; showinfo (after select) logs
      // the source pts of exactly the kept frames. NOTE: showinfo prints at
      // info loglevel — do not silence ffmpeg here.
      strategy = 'scene';
      // Three OR'd keep-rules: (1) the opening frame; (2) a heartbeat frame
      // once per uniform interval, because typing-style screen content
      // changes too little per frame to EVER clear a scene threshold and
      // would otherwise reduce a whole recording to frame 0; (3) scene
      // changes, gated to ≥1s since the last kept frame so a UI transition's
      // ~10-frame animation burst contributes one frame, not ten.
      // (prev_selected_t is NaN before anything is kept — both gte() terms
      // are then false, and rule 1 covers the start.)
      const sceneVf = `select='eq(n,0)+gte(t-prev_selected_t,${uniformInterval})+gt(scene,${sceneThreshold})*gte(t-prev_selected_t,1)',${scaleFilter(maxEdge)},showinfo`;
      const pass = await runPass(sceneVf);
      files = pass.files;
      times = parseShowinfoTimes(pass.stderr);
      // Cap hit with most of the video unseen: the threshold is drowning in
      // motion (a camera video with stripped metadata) — re-run uniform so
      // coverage spans the whole duration instead of the first seconds.
      const lastTime = times[times.length - 1] || 0;
      if (files.length >= maxFrames && durationSeconds > 0 && lastTime < durationSeconds * 0.8) {
        strategy = 'uniform';
        ({ files } = await runPass(uniformVf));
        times = files.map((_, i) => i * uniformInterval);
      }
    }

    if (!files.length) throw new Error(`video produced no frames (${mime}, ${durationSeconds}s)`);

    fs.mkdirSync(outDir, { recursive: true });
    const frames = files.map((f, i) => {
      // A showinfo/file-count mismatch shouldn't lose frames — reuse the
      // last known time rather than dropping or inventing one.
      const seconds = times[i] !== undefined ? times[i] : (times[times.length - 1] || 0);
      const dest = path.join(outDir, frameFilename(i + 1, seconds));
      const src = path.join(tmpDir, f);
      try {
        fs.renameSync(src, dest);
      } catch (e) {
        // tmpDir is commonly tmpfs on the Linux boxes while outDir lives on
        // disk — rename can't cross devices (EXDEV), so copy instead. The
        // finally-block tmpDir removal cleans up the source.
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(src, dest);
      }
      return { path: dest, seconds };
    });

    return { kind, strategy, durationSeconds, frames, hasAudio };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    catch { /* best-effort cleanup */ }
  }
}
