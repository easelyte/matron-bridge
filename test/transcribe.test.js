import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track execFile calls for assertions
const execFileCalls = [];

// Mock child_process with custom promisify support
vi.mock('child_process', () => {
  const fn = vi.fn();
  // Node's promisify uses this symbol for execFile to return { stdout, stderr }
  fn[Symbol.for('nodejs.util.promisify.custom')] = vi.fn();
  return { execFile: fn };
});

// Mock fs
vi.mock('fs', () => ({
  default: {
    mkdtempSync: vi.fn((prefix) => `${prefix}XXXXXX`),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
    // The install preflight; whisper + model present unless a test says
    // otherwise. vi.clearAllMocks() wipes implementations, so each suite's
    // beforeEach restores it.
    existsSync: vi.fn(() => true),
  },
}));

import { execFile } from 'child_process';
import fs from 'fs';
import { transcribeAudio, transcribeAudioSegments, parseWhisperSegments, MIME_TO_EXT, TRANSCRIBE_UNAVAILABLE } from '../lib/transcribe.js';

function mockExecFile(ffmpegResult, whisperResult) {
  const customFn = execFile[Symbol.for('nodejs.util.promisify.custom')];
  customFn.mockImplementation((cmd, args, opts) => {
    execFileCalls.push({ cmd, args, opts });
    if (cmd === 'ffmpeg') {
      if (ffmpegResult?.error) return Promise.reject(ffmpegResult.error);
      return Promise.resolve({ stdout: ffmpegResult?.stdout || '', stderr: ffmpegResult?.stderr || '' });
    } else if (cmd.includes('whisper-cli')) {
      if (whisperResult?.error) return Promise.reject(whisperResult.error);
      return Promise.resolve({ stdout: whisperResult?.stdout || '', stderr: whisperResult?.stderr || '' });
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

const CONFIG = {
  modelPath: '/opt/whisper/models/ggml-small.bin',
  language: 'en',
};

describe('MIME_TO_EXT', () => {
  it('maps common voice note MIME types', () => {
    expect(MIME_TO_EXT['audio/ogg']).toBe('.ogg');
    expect(MIME_TO_EXT['audio/opus']).toBe('.opus');
    expect(MIME_TO_EXT['audio/mp4']).toBe('.m4a');
    expect(MIME_TO_EXT['audio/mpeg']).toBe('.mp3');
    expect(MIME_TO_EXT['audio/wav']).toBe('.wav');
    expect(MIME_TO_EXT['audio/webm']).toBe('.webm');
    expect(MIME_TO_EXT['audio/aac']).toBe('.aac');
    expect(MIME_TO_EXT['audio/x-caf']).toBe('.caf');
  });
});

describe('transcribeAudio', () => {
  const fakeBuffer = Buffer.from('fake audio data');

  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockImplementation(() => true);
    execFileCalls.length = 0;
  });

  it('returns transcribed text', async () => {
    mockExecFile(
      { stdout: '', stderr: '' },
      { stdout: 'Hello, this is a test.' },
    );

    const result = await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);
    expect(result).toBe('Hello, this is a test.');
  });

  it('strips whisper timestamp brackets from output', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: '[00:00:00.000 --> 00:00:03.000]  Hello world.\n[00:00:03.000 --> 00:00:05.000]  Testing.' },
    );

    const result = await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);
    expect(result).toBe('Hello world.\n  Testing.');
  });

  it('throws on empty transcription', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: '   \n  ' },
    );

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toThrow('empty transcription result');
  });

  it('passes correct ffmpeg args for 16kHz mono WAV conversion', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'transcribed text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    const ffmpegCall = execFileCalls.find(c => c.cmd === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall.args).toContain('-ar');
    expect(ffmpegCall.args).toContain('16000');
    expect(ffmpegCall.args).toContain('-ac');
    expect(ffmpegCall.args).toContain('1');
    expect(ffmpegCall.args).toContain('-f');
    expect(ffmpegCall.args).toContain('wav');
    expect(ffmpegCall.args).toContain('-y');
  });

  it('passes correct whisper-cli args', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'transcribed text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    const whisperCall = execFileCalls.find(c => c.cmd.includes('whisper-cli'));
    expect(whisperCall).toBeDefined();
    expect(whisperCall.args).toContain('-m');
    expect(whisperCall.args).toContain(CONFIG.modelPath);
    expect(whisperCall.args).toContain('--no-timestamps');
    expect(whisperCall.args).toContain('-l');
    expect(whisperCall.args).toContain('en');
  });

  it('derives whisper-cli path from modelPath', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    const whisperCall = execFileCalls.find(c => c.cmd.includes('whisper-cli'));
    expect(whisperCall.cmd).toBe('/opt/whisper/build/bin/whisper-cli');
  });

  it('uses correct file extension from MIME type', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/mp4', CONFIG);

    const ffmpegCall = execFileCalls.find(c => c.cmd === 'ffmpeg');
    const inputArg = ffmpegCall.args[ffmpegCall.args.indexOf('-i') + 1];
    expect(inputArg).toMatch(/\.m4a$/);
  });

  it('falls back to .ogg for unknown MIME types', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/unknown-format', CONFIG);

    const ffmpegCall = execFileCalls.find(c => c.cmd === 'ffmpeg');
    const inputArg = ffmpegCall.args[ffmpegCall.args.indexOf('-i') + 1];
    expect(inputArg).toMatch(/\.ogg$/);
  });

  it('writes buffer to temp file', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync.mock.calls[0][1]).toBe(fakeBuffer);
  });

  it('cleans up the temp dir on success', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    expect(fs.rmSync.mock.calls[0][0]).toBe(fs.mkdtempSync.mock.results[0].value);
    expect(fs.rmSync.mock.calls[0][1]).toEqual({ recursive: true, force: true });
  });

  it('cleans up temp files on ffmpeg error', async () => {
    mockExecFile(
      { error: new Error('ffmpeg failed') },
      { stdout: '' },
    );

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toThrow('ffmpeg failed');

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
  });

  it('cleans up temp files on whisper error', async () => {
    mockExecFile(
      { stdout: '' },
      { error: new Error('whisper crashed') },
    );

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toThrow('whisper crashed');

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
  });

  // An uninstalled box and an unusable recording used to be indistinguishable
  // to callers — both surfaced as "could not transcribe that voice note",
  // with the actionable half (`spawn ffmpeg ENOENT`) buried in the log.
  it('reports a missing whisper-cli as an install gap, before spending an ffmpeg run', async () => {
    mockExecFile({ stdout: '' }, { stdout: 'text' });
    fs.existsSync.mockImplementation((p) => !String(p).includes('whisper-cli'));

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toMatchObject({ code: TRANSCRIBE_UNAVAILABLE, dependency: 'whisper.cpp' });
    expect(execFileCalls).toEqual([]);
  });

  it('reports a missing model file as an install gap', async () => {
    mockExecFile({ stdout: '' }, { stdout: 'text' });
    fs.existsSync.mockImplementation((p) => p !== CONFIG.modelPath);

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toMatchObject({ code: TRANSCRIBE_UNAVAILABLE, dependency: 'the whisper model' });
  });

  it('reports a missing ffmpeg as an install gap', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    mockExecFile({ error: enoent }, { stdout: '' });

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toMatchObject({ code: TRANSCRIBE_UNAVAILABLE, dependency: 'ffmpeg' });
    expect(fs.rmSync).toHaveBeenCalledTimes(1);
  });

  // ffmpeg IS installed and rejected the audio: exit status, not spawn ENOENT.
  // Telling the user to install ffmpeg here would send them in circles.
  it('does not mistake a genuine ffmpeg failure for a missing ffmpeg', async () => {
    const failed = Object.assign(new Error('Invalid data found when processing input'), { code: 1 });
    mockExecFile({ error: failed }, { stdout: '' });

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toMatchObject({ code: 1 });
  });

  it('respects custom language config', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'transcribed text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', { ...CONFIG, language: 'de' });

    const whisperCall = execFileCalls.find(c => c.cmd.includes('whisper-cli'));
    expect(whisperCall.args).toContain('de');
  });
});

describe('parseWhisperSegments', () => {
  it('parses timestamped whisper-cli lines into {start, text}', () => {
    const stdout = [
      '[00:00:00.000 --> 00:00:04.320]   So here\'s the checkout page.',
      '[00:00:04.320 --> 00:00:07.100]   And when I tap Pay, it freezes.',
    ].join('\n');
    expect(parseWhisperSegments(stdout)).toEqual([
      { start: 0, text: "So here's the checkout page." },
      { start: 4.32, text: 'And when I tap Pay, it freezes.' },
    ]);
  });

  it('handles hour-scale timestamps', () => {
    const stdout = '[01:01:01.500 --> 01:01:03.000]  late remark';
    expect(parseWhisperSegments(stdout)).toEqual([{ start: 3661.5, text: 'late remark' }]);
  });

  it('drops non-speech markers and empty segments', () => {
    const stdout = [
      '[00:00:00.000 --> 00:00:02.000]  [BLANK_AUDIO]',
      '[00:00:02.000 --> 00:00:04.000]  (typing sounds)',
      '[00:00:04.000 --> 00:00:05.000]   ',
      '[00:00:05.000 --> 00:00:06.000]  real words',
      'whisper diagnostic line without brackets',
    ].join('\n');
    expect(parseWhisperSegments(stdout)).toEqual([{ start: 5, text: 'real words' }]);
  });
});

describe('transcribeAudioSegments', () => {
  const fakeBuffer = Buffer.from('fake video data');

  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockImplementation(() => true);
    execFileCalls.length = 0;
  });

  it('runs whisper WITH timestamps and returns parsed segments', async () => {
    mockExecFile(
      { stdout: '', stderr: '' },
      { stdout: '[00:00:00.000 --> 00:00:03.000]  hello there, watch this closely' },
    );
    const segments = await transcribeAudioSegments(fakeBuffer, 'video/mp4', CONFIG);
    expect(segments).toEqual([{ start: 0, text: 'hello there, watch this closely' }]);
    const whisperCall = execFileCalls.find((c) => c.cmd.includes('whisper-cli'));
    expect(whisperCall.args).not.toContain('--no-timestamps');
  });

  it('accepts a video container: input keeps the video extension, ffmpeg drops the video track', async () => {
    mockExecFile({ stdout: '' }, { stdout: '[00:00:00.000 --> 00:00:01.000] x' });
    await transcribeAudioSegments(fakeBuffer, 'video/quicktime', CONFIG);
    const writtenPath = fs.writeFileSync.mock.calls[0][0];
    expect(writtenPath).toMatch(/input\.mov$/);
    const ffmpegCall = execFileCalls.find((c) => c.cmd === 'ffmpeg');
    expect(ffmpegCall.args).toContain('-vn');
  });

  it('returns [] for silence instead of throwing (a mute recording is not an error)', async () => {
    mockExecFile({ stdout: '' }, { stdout: '[00:00:00.000 --> 00:00:09.000]  [BLANK_AUDIO]' });
    const segments = await transcribeAudioSegments(fakeBuffer, 'video/mp4', CONFIG);
    expect(segments).toEqual([]);
  });

  it('drops whisper\'s silence hallucination (a lone tiny segment like "you")', async () => {
    // Verified against a real near-silent screen recording: whisper emits a
    // single hallucinated "you"/"Thank you." — a fake narration section is
    // worse than none.
    mockExecFile({ stdout: '' }, { stdout: '[00:00:00.000 --> 00:00:09.000]  you' });
    const segments = await transcribeAudioSegments(fakeBuffer, 'video/mp4', CONFIG);
    expect(segments).toEqual([]);
  });

  // The video-narration path shares the preflight, so index.js can tell "no
  // whisper on this box" from "this recording wouldn't transcribe" in its log.
  it('reports an install gap rather than attempting the extraction', async () => {
    mockExecFile({ stdout: '' }, { stdout: '' });
    fs.existsSync.mockImplementation(() => false);

    await expect(transcribeAudioSegments(fakeBuffer, 'video/mp4', CONFIG))
      .rejects.toMatchObject({ code: TRANSCRIBE_UNAVAILABLE });
    expect(execFileCalls).toEqual([]);
  });

  it('cleans up temp files on whisper error', async () => {
    mockExecFile({ stdout: '' }, { error: new Error('whisper died') });
    await expect(transcribeAudioSegments(fakeBuffer, 'video/mp4', CONFIG)).rejects.toThrow('whisper died');
    expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining('voice-'), { recursive: true, force: true });
  });
});
