import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { stripJournalCreds } from './journal-cred-scope.js';

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

// Vocabulary prompt. whisper-cli decodes --prompt as if it were the text just
// before the audio, so its words become the likely spellings of what follows:
// box names, "sudo", "PR", template names. Measured on 50 of Dan's real voice
// notes (2026-09-30): small went from 4.5% to 3.9% word error and from 10 to
// 6 names wrong, and "Dan Mack can get the pseudo password" came out right.
// Kept short and generic on purpose: a long list of rare terms made whisper
// hallucinate one of them onto a 3-second note.
export const DEFAULT_WHISPER_PROMPT = 'Matron voice note. Matron, Claude, Codex, sudo, GitHub, PR, merge train, deploy.';

// WHISPER_PROMPT unset -> the built-in vocabulary; set but empty -> no prompt
// (an opt-out for a language or a fleet the default fits badly); otherwise the
// operator's own words.
export function resolveWhisperPrompt(envValue = process.env.WHISPER_PROMPT) {
  if (envValue === undefined) return DEFAULT_WHISPER_PROMPT;
  return String(envValue).trim();
}

const promptArgs = (prompt) => (prompt ? ['--prompt', prompt] : []);

// The prompt plus this user's box names, which is where most of the gain is:
// measured on the same 50 notes, the generic words alone took names wrong
// from 10 to 9, the box names took them to 5. fetchNames is the journal
// roster (async, may resolve null/throw); the names are cached for ttlMs so a
// voice note never waits on the journal twice in a row, and a failed fetch
// falls back to the base prompt and is retried after the same interval. An
// empty base (WHISPER_PROMPT explicitly '') means no prompt at all, names
// included.
export function makeWhisperPrompt({ base, fetchNames, ttlMs = 10 * 60_000, now = Date.now } = {}) {
  let names = [];
  let fetchedAt = -Infinity;
  return async function whisperPrompt() {
    if (!base) return '';
    if (typeof fetchNames === 'function' && now() - fetchedAt >= ttlMs) {
      fetchedAt = now();
      try {
        const got = await fetchNames();
        if (Array.isArray(got)) {
          names = [...new Set(got.filter((n) => typeof n === 'string' && /^[\w.-]{1,40}$/.test(n)))].sort();
        }
      } catch { /* keep the last good names */ }
    }
    return names.length ? `${base} ${names.join(', ')}.` : base;
  };
}

// The prompt's one failure mode, seen on one 124-second note out of 50: a
// particular wording made whisper small drop everything but the last
// sentence (16 words for two minutes of speech), deterministically, while a
// reordering of the same words was fine. No rule predicts it, so the guard
// is on the output: speech runs at two to three words a second, and a
// transcript under 0.4 words a second for anything longer than eight seconds
// is rerun without the prompt, keeping whichever run says more. The WAV is
// ffmpeg's own 16 kHz mono 16-bit output, so its byte length is its duration.
export const PROMPT_GUARD_MIN_SECONDS = 8;
// transcribeAudioSegments' silence hallucination threshold (see there).
const SILENCE_MIN_CHARS = 12;
export const PROMPT_GUARD_WORDS_PER_SECOND = 0.4;

export function wavSeconds(wavPath) {
  try { return Math.max(0, (fs.statSync(wavPath).size - 44) / 32000); } catch { return 0; }
}

export function promptLooksTruncated(text, seconds) {
  if (seconds < PROMPT_GUARD_MIN_SECONDS) return false;
  const words = String(text).split(/\s+/).filter(Boolean).length;
  return words < seconds * PROMPT_GUARD_WORDS_PER_SECOND;
}

// Runs whisper-cli with the prompt, and again without it if the guard above
// trips; returns the stdout of the run with more words. `words` maps stdout
// to the text the guard should count (segments output carries timestamps).
// `retryWorthIt` lets a caller veto the rerun on what the prompted run said:
// the narration path declines when that output is the silence hallucination
// (a lone "you"), since an unprompted rerun of a quiet recording invents more
// words rather than recovering real ones. A rerun that fails (timeout, crash)
// costs nothing: the prompted transcript stands.
async function runWhisper(modelPath, wavPath, args, prompt, words, retryWorthIt = () => true) {
  const exec = (extra) => execFileAsync(
    whisperCliPath(modelPath),
    ['-m', modelPath, '-f', wavPath, ...args, ...extra],
    { timeout: 120000, env: stripJournalCreds() },
  );
  const first = await exec(promptArgs(prompt));
  if (!prompt) return first;
  const firstText = words(first.stdout);
  if (!promptLooksTruncated(firstText, wavSeconds(wavPath)) || !retryWorthIt(firstText)) return first;
  let second;
  try { second = await exec([]); } catch { return first; }
  const count = (text) => text.split(/\s+/).filter(Boolean).length;
  return count(words(second.stdout)) > count(firstText) ? second : first;
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
    return await execFileAsync('ffmpeg', args, { timeout, env: stripJournalCreds() });
  } catch (error) {
    if (error.code === 'ENOENT') throw unavailable('ffmpeg', 'not found on PATH');
    throw error;
  }
}

export async function transcribeAudio(buffer, mime, { modelPath, language, prompt }) {
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
    const cleaned = (out) => out.replace(/\[.*?\]/g, '').trim();
    const { stdout } = await runWhisper(modelPath, wavPath, ['--no-timestamps', '-l', language], prompt, cleaned);

    const text = cleaned(stdout);
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
export async function transcribeAudioSegments(buffer, mime, { modelPath, language, prompt }) {
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

    const segmentText = (out) => parseWhisperSegments(out).map((s) => s.text).join(' ');
    // No rerun for what the silence guard below would drop anyway.
    const { stdout } = await runWhisper(modelPath, wavPath, ['-l', language], prompt, segmentText, (text) => text.length >= SILENCE_MIN_CHARS);

    const segments = parseWhisperSegments(stdout);
    // Silence hallucination guard (verified on a real near-silent screen
    // recording): whisper invents a lone tiny segment — "you", "Thank you."
    // — for audio with no speech. A transcript that short carries no signal
    // even when genuine, and a fabricated narration section is worse than
    // none, so drop the lot.
    const totalText = segments.map((s) => s.text).join(' ');
    if (totalText.length < SILENCE_MIN_CHARS) return [];
    return segments;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
