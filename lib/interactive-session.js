import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { ensureWorkspaceTrusted } from './pre-trust.js';
import { bracketedPaste, keystroke, SUBMIT_DELAY_MS } from './pty-input.js';
import { TranscriptTail } from './transcript-tail.js';
import { PromptDetector } from './prompt-detector.js';

// How much recent raw PTY output to retain for preamble extraction. The
// spinner/redraw animation emits a lot of escape bytes, so the prose above a
// menu can sit well beyond the detector's 16KB classification buffer; 256KB
// comfortably covers a normal explanation + the animation between it and the
// menu.
const RECENT_OUTPUT_LIMIT = 262144;

// Maps an absolute workdir path to claude's transcript directory name.
// claude encodes the path by replacing both `/` and `.` with `-`.
function encodeProjectDir(workdir) {
  return workdir.replace(/[/.]/g, '-');
}

export function transcriptPathFor(workdir, sessionId) {
  const encoded = encodeProjectDir(path.resolve(workdir));
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

export class InteractiveSession extends EventEmitter {
  constructor({ roomId, workdir, sessionId, ptyHandle, tail }) {
    super();
    this.roomId = roomId;
    this.workdir = workdir;
    this.sessionId = sessionId;
    this.pty = ptyHandle;
    this.tail = tail;
    this.alive = true;

    // Recent raw PTY output, kept larger than the detector's classification
    // buffer so the prose claude renders above an AskUserQuestion menu (pushed
    // up by spinner animation) is still present when we extract the preamble.
    this._recent = '';

    this.detector = new PromptDetector();
    this.detector.on('prompt', p => this.emit('prompt', p));
    this.detector.on('screen-update', s => this.emit('screen-update', s));
    this.detector.on('unclassified-prompt', u => this.emit('unclassified-prompt', u));
    // TEMP DEBUG: dump raw PTY bytes for diagnosing prompt-detector misses.
    // Enable with MATRON_DUMP_PTY=1; writes to /tmp/iv-pty-<roomId>.log.
    if (process.env.MATRON_DUMP_PTY === '1') {
      try {
        const safeRoom = String(roomId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50);
        this._dumpPath = `/tmp/iv-pty-${safeRoom}.log`;
        fs.writeFileSync(this._dumpPath, `--- iv session ${sessionId} ---\n`);
      } catch (_) { /* ignore */ }
    }
    this.pty.onData(data => {
      this.detector.feed(data);
      this._recent += data;
      if (this._recent.length > RECENT_OUTPUT_LIMIT) {
        this._recent = this._recent.slice(-RECENT_OUTPUT_LIMIT);
      }
      if (this._dumpPath) {
        try { fs.appendFileSync(this._dumpPath, data); } catch (_) { /* ignore */ }
      }
      this.emit('pty-data', data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      // Give the tail one more tick to drain anything written just before
      // process exit, then stop it and emit.
      setTimeout(() => {
        this.tail.stop().finally(() => this.emit('exit', exitCode));
      }, 150);
    });
    this.tail.on('event', e => this.emit('event', e));
    this.tail.on('parseError', e => this.emit('parseError', e));
  }

  // Type a user message into the prompt. Uses bracketed paste then a delayed
  // Enter — sending \r immediately after the paste close sequence is silently
  // dropped by claude's TUI (see Phase 0.4 finding in
  // docs/superpowers/plans/2026-05-14-interactive-mode-migration.md).
  sendText(text) {
    if (!this.alive) return false;
    this.pty.write(bracketedPaste(text));
    // Cancel any prior pending Enter so back-to-back sendText calls
    // (e.g. queue flushes that don't consolidate) don't fire two Enters
    // and submit garbled or empty input on top of the latest paste.
    if (this._enterTimer) clearTimeout(this._enterTimer);
    this._enterTimer = setTimeout(() => {
      this._enterTimer = null;
      if (this.alive) this.pty.write(keystroke('enter'));
    }, SUBMIT_DELAY_MS);
    return true;
  }

  sendKeystroke(name) {
    if (!this.alive) return false;
    this.pty.write(keystroke(name));
    return true;
  }

  // Recent raw PTY output (up to RECENT_OUTPUT_LIMIT), for preamble extraction.
  recentOutput() {
    return this._recent;
  }

  sendRaw(bytes) {
    if (!this.alive) return false;
    this.pty.write(bytes);
    return true;
  }

  // Send a response to a previously-detected interactive prompt. `kind` is
  // the prompt kind from the detector (yes-no, numbered, lettered, arrow-
  // menu); `key` is the option key (or index for arrow menus).
  //
  // resetDetector (default true) clears the detector's dedup so the SAME prompt
  // can fire again later. Pass false when answering a best-effort
  // `unclassified-prompt`: resetting would clear lastUnclassifiedSig and let the
  // still-visible screen immediately re-emit, duplicating the warning right
  // after a valid answer.
  respondToPrompt({ kind, key }, { resetDetector = true } = {}) {
    if (!this.alive) return false;
    if (kind === 'yes-no' || kind === 'numbered' || kind === 'lettered') {
      // Multi-digit numbered keys ("10", "11", …) would crash `keystroke`
      // (single-char or named keys only). Send each digit individually so
      // menus with 10+ options work.
      for (const ch of String(key)) this.pty.write(keystroke(ch));
      setTimeout(() => {
        if (this.alive) this.pty.write(keystroke('enter'));
      }, 50);
      if (resetDetector) this.detector.reset();
      return true;
    }
    if (kind === 'arrow-menu') {
      const idx = parseInt(key, 10);
      if (!Number.isFinite(idx) || idx < 0) return false;
      // Naive: assume cursor starts at the topmost option. The detector
      // marks options[0] as `selected` so callers should match that. We send
      // `idx` down-arrow keystrokes, then Enter.
      for (let i = 0; i < idx; i++) this.pty.write(keystroke('down'));
      setTimeout(() => {
        if (this.alive) this.pty.write(keystroke('enter'));
      }, 50);
      if (resetDetector) this.detector.reset();
      return true;
    }
    return false;
  }

  kill(signal = 'SIGTERM') {
    if (this.alive) this.pty.kill(signal);
  }

  // Force-read any transcript content appended since the last poll. Used by
  // the Stop-hook turn-end handler to close the race between the hook firing
  // and the next scheduled tail poll (the assistant event is guaranteed to
  // have been written before the Stop hook ran, but the tail may not have
  // ticked yet).
  drainTranscript() {
    this.tail.drain();
  }

}

export function createInteractiveSession({
  roomId,
  workdir,
  sessionId,
  claudeBin = 'claude',
  claudeArgs = [],
  env = process.env,
  transcriptPath,
  cols = 120,
  rows = 40,
  claudeJsonPath,
}) {
  ensureWorkspaceTrusted(workdir, claudeJsonPath);
  const txPath = transcriptPath || transcriptPathFor(workdir, sessionId);

  const tail = new TranscriptTail(txPath);
  tail.start(); // begin polling before spawn so first events aren't missed

  const ptyHandle = pty.spawn(claudeBin, claudeArgs, {
    name: 'xterm-256color',
    cwd: workdir,
    env: Object.fromEntries(Object.entries(env).filter(([_, v]) => v !== undefined)),
    cols,
    rows,
  });

  return new InteractiveSession({ roomId, workdir, sessionId, ptyHandle, tail });
}
