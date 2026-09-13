import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

export const MIME_TO_EXT = {
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/aac': '.aac',
  'audio/x-caf': '.caf',
};

// Two very different failures wear the same "transcription failed" hat: this
// box never had ffmpeg/whisper installed, or this particular audio didn't
// transcribe. Only the first is actionable by the operator, and it used to be
// visible ONLY as `spawn ffmpeg ENOENT` in the service log while the user got
// a generic "could not transcribe" — so callers get a distinguishable code.
export const TRANSCRIBE_UNAVAILABLE = 'TRANSCRIBE_UNAVAILABLE';

function unavailable(dependency, detail) {
  const error = new Error(`${dependency} is not installed on this box (${detail})`);
  error.code = TRANSCRIBE_UNAVAILABLE;
  error.dependency = dependency;
  return error;
}

// whisper.cpp's own installer lays the tree out as models/<model>.bin next to
// build/bin/whisper-cli, so the binary is derivable from the configured model.
export function whisperCliPath(modelPath) {
  return path.join(path.dirname(modelPath), '../build/bin/whisper-cli');
}

// Checked up front: both are plain paths we compute, so there's no reason to
// spend an ffmpeg conversion on audio that whisper can't process. ffmpeg
// itself is resolved off PATH, so its absence is caught from the spawn error
// in execFfmpeg instead.
function assertWhisperInstalled(modelPath) {
  const bin = whisperCliPath(modelPath);
  if (!fs.existsSync(bin)) throw unavailable('whisper.cpp', `no whisper-cli at ${bin}`);
  if (!fs.existsSync(modelPath)) throw unavailable('the whisper model', `no model file at ${modelPath}`);
}

// A missing binary rejects with the string code ENOENT; a genuine ffmpeg
// failure rejects with its numeric exit status, so the two never collide.
async function execFfmpeg(args, timeout) {
  try {
    return await execFileAsync('ffmpeg', args, { timeout });
  } catch (error) {
    if (error.code === 'ENOENT') throw unavailable('ffmpeg', 'not found on PATH');
    throw error;
  }
}

export async function transcribeAudio(buffer, mime, { modelPath, language }) {
  const ext = MIME_TO_EXT[mime] || '.ogg';
  // mkdtemp gives us a private, unpredictably-named directory (0700) so the
  // audio files can't collide with or be pre-created by other local users.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  const inputPath = path.join(tmpDir, `input${ext}`);
  const wavPath = path.join(tmpDir, 'audio.wav');

  try {
    assertWhisperInstalled(modelPath);

    // Write audio buffer to temp file
    fs.writeFileSync(inputPath, buffer);

    // Convert to 16kHz mono WAV
    await execFfmpeg([
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      wavPath,
    ], 30000);

    // Transcribe with whisper-cli
    const { stdout } = await execFileAsync(
      whisperCliPath(modelPath),
      ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-l', language],
      { timeout: 120000 },
    );

    const text = stdout.replace(/\[.*?\]/g, '').trim();
    if (!text) throw new Error('empty transcription result');
    return text;
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Video containers a narration track may arrive inside (the video-frames
// pipeline hands the whole video here; ffmpeg pulls the audio out).
const VIDEO_MIME_TO_EXT = {
  'video/quicktime': '.mov',
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/webm': '.webm',
  'video/mpeg': '.mpg',
};

// whisper-cli's default (timestamped) stdout:
//   [00:00:04.320 --> 00:00:07.100]   And when I tap Pay, it freezes.
// Only the start matters downstream (it cross-references the frame
// filenames); non-speech markers ([BLANK_AUDIO], (typing sounds)) and empty
// segments are dropped.
export function parseWhisperSegments(stdout) {
  const segments = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*\[(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> [^\]]+\]\s*(.*)$/);
    if (!m) continue;
    const text = m[5].trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue;
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    segments.push({ start, text });
  }
  return segments;
}

/// transcribeAudio's timestamped sibling for video narration: accepts a
/// video container (ffmpeg drops the video track with -vn), keeps whisper's
/// segment timestamps, and returns [{start, text}]. Silence is [] rather
/// than an error — a mute screen recording is the normal case, not a
/// failure (unlike a voice note, whose whole point is the speech).
export async function transcribeAudioSegments(buffer, mime, { modelPath, language }) {
  const ext = MIME_TO_EXT[mime] || VIDEO_MIME_TO_EXT[mime] || '.ogg';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  const inputPath = path.join(tmpDir, `input${ext}`);
  const wavPath = path.join(tmpDir, 'audio.wav');

  try {
    assertWhisperInstalled(modelPath);

    fs.writeFileSync(inputPath, buffer);

    await execFfmpeg([
      '-i', inputPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      wavPath,
    ], 60000);

    const { stdout } = await execFileAsync(
      whisperCliPath(modelPath),
      ['-m', modelPath, '-f', wavPath, '-l', language],
      { timeout: 120000 },
    );

    const segments = parseWhisperSegments(stdout);
    // Silence hallucination guard (verified on a real near-silent screen
    // recording): whisper invents a lone tiny segment — "you", "Thank you."
    // — for audio with no speech. A transcript that short carries no signal
    // even when genuine, and a fabricated narration section is worse than
    // none, so drop the lot.
    const totalText = segments.map((s) => s.text).join(' ');
    if (totalText.length < 12) return [];
    return segments;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
