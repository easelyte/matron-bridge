import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Tails a JSONL file emitted by `claude` (the on-disk session transcript at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl). Emits one `event` per
// parsed line and `parseError` for malformed lines (which are not fatal).
//
// Uses periodic stat polling rather than fs.watch / chokidar. The transcript
// is small (a few hundred KB max during a long session) and chokidar v4 has
// proven unreliable here — rapid appends to a not-yet-existent file are
// silently missed. Polling at 100ms is plenty for human-perceptible latency
// and uses negligible CPU.
//
// By default the tail starts from end-of-file: only lines appended after
// start() are emitted. Pass { readFromStart: true } to also replay anything
// already in the file — useful for resuming a session whose transcript file
// already exists.

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

export class TranscriptTail extends EventEmitter {
  constructor(filePath, {
    readFromStart = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    requireRegularFile = false,
    requireInitialFile = false,
    maxFileSizeBytes = Number.POSITIVE_INFINITY,
  } = {}) {
    super();
    this.filePath = filePath;
    this.readFromStart = readFromStart;
    this.intervalMs = intervalMs;
    this.requireRegularFile = requireRegularFile;
    this.requireInitialFile = requireInitialFile;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.offset = 0;
    this.lineBuf = '';
    this.decoder = new StringDecoder('utf8');
    this.timer = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      if (this.readFromStart) {
        this.offset = 0;
      } else if (fs.existsSync(this.filePath)) {
        this.offset = fs.statSync(this.filePath).size;
      }
      // Tick once immediately so existing readFromStart content is picked up
      // before start() resolves.
      this._tick({ throwOnFileError: this.readFromStart && this.requireInitialFile });
      this.timer = setInterval(() => this._tick(), this.intervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    } catch (error) {
      this.started = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      throw error;
    }
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Synchronously read any content that has been appended since the last
  // tick and emit events. Use this when a downstream signal (e.g. a Stop
  // hook firing via HTTP) tells us a turn is complete and we want to be
  // sure all transcript events for that turn have been processed before
  // running end-of-turn logic.
  async drain({ windowMs = this.intervalMs } = {}) {
    const boundedWindowMs = Number.isFinite(windowMs) && windowMs >= 0
      ? windowMs
      : this.intervalMs;
    this._tick({ throwOnFileError: true });
    if (boundedWindowMs === 0) return true;

    // Keep reading for the entire bounded window. Exit metadata and transcript
    // appends are separate filesystem writes, so one quiet polling interval is
    // not an EOF acknowledgement.
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearInterval(pollTimer);
        clearTimeout(windowTimer);
      };
      const tick = () => {
        if (settled) return;
        try {
          this._tick({ throwOnFileError: true });
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const pollTimer = setInterval(tick, this.intervalMs);
      const windowTimer = setTimeout(() => {
        tick();
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, boundedWindowMs);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      if (typeof windowTimer.unref === 'function') windowTimer.unref();
    });
    return true;
  }

  _tick({ throwOnFileError = false } = {}) {
    let fd;
    try {
      if (this.requireRegularFile && fs.lstatSync(this.filePath).isSymbolicLink()) {
        throw new Error('transcript path must not be a symbolic link');
      }
      const noFollow = this.requireRegularFile ? (fs.constants.O_NOFOLLOW ?? 0) : 0;
      fd = fs.openSync(this.filePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (throwOnFileError) throw error;
      return false; // file doesn't exist yet
    }

    try {
      const stat = fs.fstatSync(fd);
      if (this.requireRegularFile && !stat.isFile()) {
        throw new Error('transcript path must be a regular file');
      }
      if (stat.size < this.offset) {
        // Truncation or replacement — restart from the top.
        this.offset = 0;
        this.lineBuf = '';
        this.decoder = new StringDecoder('utf8');
      }
      if (stat.size === this.offset) return true;
      const unreadBytes = stat.size - this.offset;
      if (Number.isFinite(this.maxFileSizeBytes) && unreadBytes > this.maxFileSizeBytes) {
        const skippedBytes = unreadBytes - this.maxFileSizeBytes;
        this.offset += skippedBytes;
        this.lineBuf = '';
        this.decoder = new StringDecoder('utf8');
        const error = new Error(`transcript truncated: skipped ${skippedBytes} bytes`);
        error.code = 'TRANSCRIPT_TRUNCATED';
        this.emit('parseError', { line: '', error, skippedBytes });
      }
      while (this.offset < stat.size) {
        const len = Math.min(DEFAULT_READ_CHUNK_BYTES, stat.size - this.offset);
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = fs.readSync(fd, buf, 0, len, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.lineBuf += this.decoder.write(buf.subarray(0, bytesRead));
        this._emitCompleteLines();
        if (Number.isFinite(this.maxFileSizeBytes) &&
            this.lineBuf.length > this.maxFileSizeBytes) {
          const skippedBytes = this.lineBuf.length - this.maxFileSizeBytes;
          this.lineBuf = this.lineBuf.slice(-this.maxFileSizeBytes);
          const error = new Error(`transcript line truncated: skipped at least ${skippedBytes} bytes`);
          error.code = 'TRANSCRIPT_TRUNCATED';
          this.emit('parseError', { line: '', error, skippedBytes });
        }
      }
    } catch (error) {
      if (throwOnFileError) throw error;
      this.emit('parseError', { line: '', error });
      return false;
    } finally {
      fs.closeSync(fd);
    }
    this._emitCompleteLines();
    this._emitCompletePendingJson();
    return true;
  }

  _emitCompleteLines() {
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop(); // last fragment is incomplete (or empty)
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        this.emit('event', JSON.parse(line));
      } catch (error) {
        this.emit('parseError', { line, error });
      }
    }
    // Tolerate a complete final line that hasn't been newline-terminated yet.
    // A tool-call assistant record (e.g. ask_user awaiting an answer) is often
    // the last write before claude blocks, and its trailing newline isn't
    // flushed until the NEXT record is written — after the answer. Without this,
    // that line would sit stranded in lineBuf for the whole wait, so the bridge
    // never sees the ask_user event until after it's answered. If the remaining
    // buffer already parses as a complete JSON object, emit it now and clear it;
    // the eventual trailing newline then reads as an empty line (skipped), so
    // there is no double-emit. A genuinely partial write won't parse and stays
    // buffered as before.
  }

  _emitCompletePendingJson() {
    const pending = this.lineBuf.trim();
    if (pending) {
      try {
        const obj = JSON.parse(pending);
        this.lineBuf = '';
        this.emit('event', obj);
      } catch (_) {
        // incomplete line — keep buffering until more bytes / a newline arrive
      }
    }
  }
}
