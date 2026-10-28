import { watch as fsWatch, fstatSync, readSync, closeSync } from 'fs';
import { openOwnLiveLogSync } from './live-log-dir.js';
import path from 'path';

// Per-command tail pump for journal-native tool-output streaming: the code
// viewer's proven fs.watch + offset-read loop (viewer/server.js handleLiveWs)
// lifted into a testable module, in the style of lib/live-output.js — a plain
// factory index.js wires in. One pump per running Bash command; it tails the
// matron-tee log at `logPath` and feeds `streamAppend(convoId, messageRef,
// offset, chunk, meta)` — lib/journal-publisher.js's ephemeral stream_append.
// See docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md
// (matron-journal repo) §5.1/§9 for the wire contract this drives.
//
// Offsets are LOG-FILE BYTE positions, and the server accounts in bytes of
// the chunk it receives — so every chunk this module emits must satisfy
// Buffer.byteLength(chunk) === raw bytes consumed from the file. Command
// output is arbitrary bytes (a `cat` of a binary is legal), and a naive
// buf.toString('utf-8') breaks that invariant: each invalid byte becomes
// U+FFFD (1 byte -> 3), offsets drift, and every later frame trips a
// stream_resync loop. decodeByteExact below is the whole fix.

// Decode a buffer as UTF-8 preserving byte length exactly: every valid
// sequence decodes as itself; every invalid byte becomes one '?' (1 byte);
// a valid-but-incomplete multi-byte sequence at the tail is HELD BACK
// (not consumed) so the next read completes it. Invariant:
// Buffer.byteLength(text) === consumed, always.
export function decodeByteExact(buf) {
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      // ASCII run fast path — latin1 is byte-identical for < 0x80.
      let j = i + 1;
      while (j < n && buf[j] < 0x80) j++;
      out += buf.toString('latin1', i, j);
      i = j;
      continue;
    }
    let need = 0;
    if ((b & 0xe0) === 0xc0) need = 2;
    else if ((b & 0xf0) === 0xe0) need = 3;
    else if ((b & 0xf8) === 0xf0) need = 4;
    if (!need) { // stray continuation byte or invalid lead
      out += '?';
      i += 1;
      continue;
    }
    if (i + need > n) {
      // Possibly-incomplete tail. Hold it back only if what's present is a
      // valid prefix — otherwise it will never complete, replace and move on.
      let validPrefix = true;
      for (let k = i + 1; k < n; k++) {
        if ((buf[k] & 0xc0) !== 0x80) { validPrefix = false; break; }
      }
      if (validPrefix) return { text: out, consumed: i, held: n - i };
      out += '?';
      i += 1;
      continue;
    }
    let valid = true;
    for (let k = i + 1; k < i + need; k++) {
      if ((buf[k] & 0xc0) !== 0x80) { valid = false; break; }
    }
    if (!valid) {
      out += '?';
      i += 1;
      continue;
    }
    const s = buf.toString('utf-8', i, i + need);
    // Overlong/surrogate/out-of-range sequences decode to U+FFFD and change
    // byte length — replace those with need x '?' to keep the invariant.
    out += Buffer.byteLength(s) === need ? s : '?'.repeat(need);
    i += need;
  }
  return { text: out, consumed: n, held: 0 };
}

// The durable completion event's snippet (spec §5.3): the last <= maxLines
// lines, further capped at maxBytes UTF-8 bytes, never splitting a
// multi-byte character (walk the cut past continuation bytes, the same
// boundary rule as the server's buffer head-drop).
export function toolOutputSnippet(text, { maxLines = 50, maxBytes = 4096 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let snip = text.split('\n').slice(-maxLines).join('\n');
  const buf = Buffer.from(snip, 'utf-8');
  if (buf.length > maxBytes) {
    let cut = buf.length - maxBytes;
    while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut++;
    snip = buf.toString('utf-8', cut);
  }
  return snip;
}

export function createToolStreamPump({
  logPath,
  convoId,
  messageRef,
  meta,
  streamAppend,
  throttleMs = 250,
  chunkBytes = 65536,
  // Per-pass byte budget (Item 1, fast-follow brief): a pass reads and
  // publishes at most ~this many bytes even when the backlog is far bigger
  // (e.g. 200MB written during one throttle window) — without this, a single
  // pass reads the ENTIRE backlog into one Buffer and fires a WS frame per
  // chunkBytes slice in one tight synchronous loop: transient heap spike,
  // event-loop head-of-line blocking, WS frame flood. When a pass ends still
  // short of EOF, pump() self-schedules the next pass (see below) so the
  // remaining backlog keeps draining without requiring another fs.watch
  // event — a huge backlog can finish being WRITTEN well before the pump
  // catches up, and no new write means no new watch event, ever.
  maxBytesPerPass = 1024 * 1024,
}) {
  // Clamp chunkBytes to the max UTF-8 character width (4 bytes). A window
  // narrower than one complete character can never make progress if a
  // multi-byte sequence spans the boundary: decodeByteExact returns
  // consumed: 0, pump breaks, and the next pass sees the identical slice.
  chunkBytes = Math.max(chunkBytes, 4);
  // Same reasoning applies to the per-pass read cap: it bounds how many
  // bytes readFrom() returns, so it must also be at least one full
  // multi-byte character wide, or a character landing at the cap boundary
  // could never complete (held back forever, offset never advances, and the
  // self-scheduled next pass reads the identical too-small window again).
  maxBytesPerPass = Math.max(maxBytesPerPass, 4);

  let offset = 0; // log bytes confirmed sent (== the logical stream offset)
  let lastPumpAt = 0;
  let timer = null;
  let watcher = null;
  let stopped = false;
  const basename = path.basename(logPath);

  // Reads up to `maxLen` bytes starting at `pos` (the whole remainder if
  // maxLen is omitted — used by flushFinal, which is bounded by its own
  // separate cap argument instead). Returns null if there's nothing new.
  // `capped` is true only when `maxLen` itself was the reason fewer than
  // all available bytes were read (maxLen < avail) — i.e. there is MORE
  // already-on-disk backlog beyond this read, as opposed to `size` simply
  // being ahead of the caller's `offset` because a held-back torn
  // multi-byte tail hasn't advanced it yet. That distinction is exactly
  // what pump() needs to decide whether self-scheduling another pass can
  // make progress (see pump() below) — conflating the two would spin the
  // pump forever re-reading the same incomplete tail while waiting on a
  // write that hasn't happened yet.
  function readFrom(pos, maxLen) {
    // Not created yet, GC'd, or not this user's own file at that name
    // (lib/live-log-dir.js openOwnLiveLogSync): nothing to read.
    const fd = openOwnLiveLogSync(logPath);
    if (fd == null) return null;
    try {
      const st = fstatSync(fd);
      if (st.size <= pos) return null;
      const avail = st.size - pos;
      const want = maxLen != null ? Math.min(maxLen, avail) : avail;
      const buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, buf.length, pos);
      return { buf: n === buf.length ? buf : buf.subarray(0, n), size: st.size, capped: want < avail };
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  // Reads at most `maxLen` bytes from the current `offset` and publishes
  // each chunkBytes slice as a stream_append frame, advancing `offset` by
  // however much was actually consumed (torn multi-byte tails are held
  // back, same as always). Shared by pump() (bounded per-pass reads while
  // live) and flushFinal() (one bounded read after stop()). Returns the
  // readFrom() result (or null/empty) so pump() can decide whether to
  // self-schedule another pass.
  function publishWindow(maxLen) {
    const res = readFrom(offset, maxLen);
    if (!res || res.buf.length === 0) return res;
    const raw = res.buf;
    let pos = 0;
    while (pos < raw.length) {
      const slice = raw.subarray(pos, Math.min(pos + chunkBytes, raw.length));
      const { text, consumed } = decodeByteExact(slice);
      if (consumed === 0) break; // torn multi-byte tail — the next write completes it
      const at = offset + pos;
      streamAppend(convoId, messageRef, at, text, at === 0 ? meta : undefined);
      pos += consumed;
    }
    offset += pos;
    return res;
  }

  function pump() {
    if (stopped) return;
    lastPumpAt = Date.now();
    const res = publishWindow(maxBytesPerPass);
    if (res && res.capped) {
      // The budget (not a torn tail) is why this pass didn't reach true
      // EOF — more already-on-disk backlog remains and read/publishing it
      // doesn't depend on any future write. Self-schedule the next pass
      // rather than waiting on fs.watch, which may never fire again once
      // the writer is done.
      schedulePump();
    }
  }

  function schedulePump() {
    if (stopped || timer) return;
    const wait = throttleMs - (Date.now() - lastPumpAt);
    // Always defer through setTimeout, even when the throttle window has
    // already elapsed (wait <= 0) — an inline synchronous pump() call here
    // was the recursion this replaced: a budget-capped drain re-enters
    // schedulePump() from within pump() (see the `res.capped` branch above),
    // and calling pump() inline chains synchronous stack frames one per
    // pass — depth roughly backlog/maxBytesPerPass — until a large enough
    // backlog overflows the stack. Math.max(wait, 0) keeps every pass on a
    // fresh macrotask instead, which is unbounded backlog-safe regardless of
    // throttleMs.
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, Math.max(wait, 0));
    if (typeof timer.unref === 'function') timer.unref();
  }

  // Bounded final flush (Item 3, fast-follow brief): stop() closes the
  // watcher and cancels timers SYNCHRONOUSLY (bytes written after the last
  // pass never stream as live appends — live viewers only converge once the
  // durable finalize retires the overlay). flushFinal is the fix: one
  // bounded read from the pump's last published offset to EOF (capped,
  // default 1 MiB), publishing byte-exact stream_append frames for whatever
  // it reads. Safe to call after stop() — it only touches `offset` and does
  // a fresh readFrom/streamAppend, neither of which depend on the watcher or
  // timer. Deliberately ONE pass, not a self-scheduling drain like pump():
  // if the cap is hit, flushing just stops there — this is a live-view
  // convergence nicety, not a correctness mechanism, since the durable
  // finalize (index.js finalizeToolStreamEntry) carries the full tail
  // regardless. Must never throw: caller code order (await flushFinal()
  // BEFORE publishing finalizeToolOutput) is what makes flush-then-finalize
  // ordering a guarantee rather than timing luck, so a throw here must not
  // skip the finalize publish.
  async function flushFinal(maxBytes = 1024 * 1024) {
    try {
      // Same >=4 clamp as chunkBytes/maxBytesPerPass above: a cap narrower
      // than the widest UTF-8 character can flush zero bytes when a pending
      // multi-byte char is sitting at the read boundary (decodeByteExact
      // holds it back, publishWindow consumes nothing).
      const cap = Math.max(Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 1024 * 1024, 4);
      publishWindow(cap);
    } catch {
      /* flushFinal must never throw */
    }
  }

  return {
    start() {
      if (stopped) return;
      try {
        // Watch the PARENT directory filtered by basename (the viewer's
        // done-sentinel pattern) rather than the file: the tee log usually
        // doesn't exist yet when the tool_use event arrives.
        watcher = fsWatch(path.dirname(logPath), { persistent: false }, (event, filename) => {
          if (filename && filename !== basename) return; // filename can be null on some platforms — pump anyway
          schedulePump();
        });
      } catch {
        watcher = null; // no watcher -> initial content still goes out; resync still works
      }
      pump();
    },
    // Server said "I only have `have` bytes" (stream_resync): rewind to that
    // byte and re-send. Bypasses the throttle — this is the recovery path for
    // bridge reconnects, server restarts, and dropped frames.
    resync(have) {
      if (stopped) return;
      if (Number.isInteger(have) && have >= 0 && have < offset) offset = have;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pump();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { watcher?.close(); } catch { /* best effort */ }
      watcher = null;
    },
    flushFinal,
  };
}
