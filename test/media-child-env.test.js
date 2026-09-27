// ffmpeg / ffprobe / whisper-cli run on untrusted media: they must not inherit
// the journal credential or the bridge-only secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: (cmd, args, opts, cb) => {
      calls.push({ cmd, opts });
      // ffmpeg "succeeds" so transcribe goes on to whisper-cli; anything else fails.
      if (cmd === 'ffmpeg') cb(null, { stdout: '', stderr: '' });
      else cb(new Error('stubbed'));
    },
  };
});

const { transcribeAudio } = await import('../lib/transcribe.js');
const { extractVideoFrames } = await import('../lib/video-frames.js');

const SECRETS = { JOURNAL_TOKEN: 'boot-token', JOURNAL_TOKEN_FILE: '/etc/matron/agent-token', HMAC_SECRET: 'boot-secret', OPENAI_API_KEY: 'sk-boot', GEMINI_API_KEY: 'gemini-boot' };
let saved;
beforeEach(() => {
  calls.length = 0;
  saved = Object.fromEntries(Object.keys(SECRETS).map(k => [k, process.env[k]]));
  Object.assign(process.env, SECRETS);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function expectScoped(opts) {
  expect(opts.env).toBeTypeOf('object');
  for (const key of Object.keys(SECRETS)) expect(key in opts.env).toBe(false);
  expect(opts.env.PATH).toBe(process.env.PATH);
}

describe('media child spawns', () => {
  it('transcribe: ffmpeg and whisper-cli run without the secrets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    try {
      const modelPath = path.join(root, 'models', 'ggml.bin');
      fs.mkdirSync(path.dirname(modelPath), { recursive: true });
      fs.mkdirSync(path.join(root, 'build', 'bin'), { recursive: true });
      fs.writeFileSync(modelPath, '');
      fs.writeFileSync(path.join(root, 'build', 'bin', 'whisper-cli'), '');
      await expect(transcribeAudio(Buffer.from('x'), 'audio/ogg', { modelPath, language: 'en' })).rejects.toThrow();
      expect(calls[0].cmd).toBe('ffmpeg');
      expectScoped(calls[0].opts);
      expect(calls[0].opts.timeout).toBe(30000);
      expect(calls[1].cmd).toMatch(/whisper-cli$/);
      expectScoped(calls[1].opts);
      expect(calls[1].opts.timeout).toBe(120000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('video frames: the default exec runs ffprobe without the secrets', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-out-'));
    try {
      await expect(extractVideoFrames(Buffer.from('x'), 'video/mp4', { outDir })).rejects.toThrow();
      expect(calls[0].cmd).toBe('ffprobe');
      expectScoped(calls[0].opts);
      expect(calls[0].opts.timeout).toBe(120_000);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
