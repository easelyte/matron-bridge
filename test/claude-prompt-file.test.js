import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRunDir, sweepDeadRunDirs } from '../lib/header-files.js';
import { launchWithClaudePromptFile } from '../lib/claude-prompt-file.js';
import { failedSpawnProcess, attachSpawnErrorHandler } from '../lib/spawn-guard.js';

const roots = [];
function privateRunDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-file-test-'));
  roots.push(root);
  return createRunDir(path.join(root, 'run'));
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Claude prompt file transport', () => {
  it.each(['close', 'exit'])('keeps an exact private snapshot until %s', exitEvent => {
    const runDir = privateRunDir();
    const prompt = '  Rules\r\n\nRésumé — 日本語 🐾\n';
    const args = ['--resume', 'example-session'];
    const child = new EventEmitter();
    let file;
    const result = launchWithClaudePromptFile({
      prompt, args, runDir, exitEvent,
      launch: actual => {
        expect(actual.slice(0, 2)).toEqual(args);
        expect(actual[2]).toBe('--append-system-prompt-file');
        file = actual[3];
        expect(path.isAbsolute(file)).toBe(true);
        expect(fs.readFileSync(file)).toEqual(Buffer.from(prompt));
        if (process.platform !== 'win32') {
          expect(fs.statSync(runDir).mode & 0o777).toBe(0o700);
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
        return child;
      },
    });
    expect(result).toBe(child);
    expect(args).toEqual(['--resume', 'example-session']);
    child.emit('spawn');
    expect(fs.existsSync(file)).toBe(true);
    child.emit(exitEvent);
    expect(fs.readdirSync(runDir)).toEqual([]);
    expect(() => child.emit(exitEvent)).not.toThrow();
  });

  it('launches with a UTF-8 prompt larger than the Linux single-argument limit', async () => {
    const runDir = privateRunDir();
    const prompt = '日本語 🐾\r\n'.repeat(20_000);
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(128 * 1024);
    // A real child reads the same file argument as Claude would. It reports
    // a digest only; no model, network call or private fixture is involved.
    const reader = "const fs=require('node:fs'),crypto=require('node:crypto');const f=process.argv[process.argv.indexOf('--append-system-prompt-file')+1];console.log(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))";
    const child = launchWithClaudePromptFile({
      prompt, args: [], runDir,
      launch: actual => {
        expect(Math.max(...actual.map(arg => Buffer.byteLength(arg)))).toBeLessThan(4096);
        expect(actual).not.toContain(prompt);
        return spawn(process.execPath, ['-e', reader, '--', ...actual], { stdio: ['ignore', 'pipe', 'pipe'] });
      },
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    expect(code, errors).toBe(0);
    expect(output.trim()).toBe(createHash('sha256').update(prompt).digest('hex'));
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it('keeps concurrent and resumed spawns independent', () => {
    const runDir = privateRunDir();
    const children = [];
    const files = [];
    for (const prompt of ['first rules', 'updated rules']) {
      launchWithClaudePromptFile({
        prompt, args: ['--resume', 'same-example-session'], runDir,
        launch: args => {
          files.push(args.at(-1));
          const child = new EventEmitter();
          children.push(child);
          return child;
        },
      });
    }
    expect(files[0]).not.toBe(files[1]);
    children[0].emit('close');
    expect(fs.readFileSync(files[1], 'utf8')).toBe('updated rules');
    children[1].emit('close');
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it('cleans up a synchronous launch failure (including PTY fallback)', () => {
    const runDir = privateRunDir();
    expect(() => launchWithClaudePromptFile({
      prompt: 'rules', args: [], runDir, exitEvent: 'exit',
      launch: () => { throw new Error('spawn failed'); },
    })).toThrow('spawn failed');
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it('cleans up when an asynchronous spawn error is followed by close', async () => {
    const runDir = privateRunDir();
    const child = launchWithClaudePromptFile({
      prompt: 'rules', args: [], runDir,
      launch: args => spawn(path.join(runDir, 'nonexistent-cli'), args),
    });
    let error;
    child.on('error', value => { error = value; });
    await new Promise(resolve => child.on('close', resolve));
    expect(error.code).toBe('ENOENT');
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it('fails closed and removes partial writes without launching', () => {
    const runDir = privateRunDir();
    const launch = vi.fn();
    const fsImpl = {
      ...fs,
      writeFileSync(file, content, options) {
        fs.writeFileSync(file, content.slice(0, 2), options);
        throw new Error('disk full');
      },
    };
    expect(() => launchWithClaudePromptFile({ prompt: 'rules', args: [], runDir, launch, fsImpl })).toThrow('disk full');
    expect(launch).not.toHaveBeenCalled();
    expect(fs.readdirSync(runDir)).toEqual([]);
    expect(() => launchWithClaudePromptFile({ prompt: 'rules', args: [], runDir: null, launch })).toThrow('private bridge run directory');
    expect(launch).not.toHaveBeenCalled();
  });

  it('lets the existing dead-process sweep remove files after a bridge crash', () => {
    const runDir = privateRunDir();
    launchWithClaudePromptFile({ prompt: 'rules', args: [], runDir, launch: () => new EventEmitter() });
    expect(fs.readdirSync(runDir)).toHaveLength(1);
    expect(sweepDeadRunDirs(path.dirname(runDir), { alive: () => false, selfPid: -1 })).toEqual([path.basename(runDir)]);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it('recreates a removed private run directory before the next spawn', () => {
    const runDir = privateRunDir();
    fs.rmSync(runDir, { recursive: true });
    const child = launchWithClaudePromptFile({
      prompt: 'rules', args: [], runDir,
      launch: args => {
        expect(fs.readFileSync(args.at(-1), 'utf8')).toBe('rules');
        if (process.platform !== 'win32') expect(fs.statSync(runDir).mode & 0o777).toBe(0o700);
        return new EventEmitter();
      },
    });
    child.emit('close');
  });

  it('refuses a symlink in place of the private run directory', () => {
    const runDir = privateRunDir();
    const other = path.join(path.dirname(runDir), 'other');
    fs.mkdirSync(other);
    fs.rmSync(runDir, { recursive: true });
    fs.symlinkSync(other, runDir, 'junction');
    const launch = vi.fn();
    expect(() => launchWithClaudePromptFile({ prompt: 'rules', args: [], runDir, launch })).toThrow('not a directory');
    expect(launch).not.toHaveBeenCalled();
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it('reports unavailable storage through the normal error/close path and can retry later', async () => {
    const runDir = privateRunDir();
    const allocate = vi.fn()
      .mockImplementationOnce(() => { throw new Error('storage unavailable'); })
      .mockReturnValue(runDir);
    const launch = vi.fn(() => new EventEmitter());
    const make = () => launchWithClaudePromptFile({
      prompt: 'rules', args: [], runDir: allocate, launch, onError: failedSpawnProcess,
    });
    const failed = make(); // does not throw out of an automatic restart
    const notify = vi.fn();
    attachSpawnErrorHandler(failed, { notify, log: () => {} });
    failed.stdout.on('data', () => {});
    failed.stderr.on('data', () => {});
    const events = [];
    failed.on('error', () => events.push('error'));
    const code = await new Promise(resolve => failed.on('close', code => { events.push('close'); resolve(code); }));
    expect(code).toBe(-1);
    expect(events).toEqual(['error', 'close']);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
    expect(failed.kill()).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(fs.readdirSync(runDir)).toEqual([]);
    const child = make();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(runDir)).toHaveLength(1);
    child.emit('close');
    expect(fs.readdirSync(runDir)).toEqual([]);
  });
});
