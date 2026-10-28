// The receive half of agent-to-agent file transfer. When the journal
// releases a room file (approved and fully uploaded) it sends this device a
// `ready` frame; a bridge that was asleep finds the same transfers with
// GET /transfers?for=me on hello (catchUp). For each one:
//
//   download into <inbox>/<name>.<id>.part, resuming from the .part's length
//   -> sha256 over the whole file, against the sha256 the card showed
//   -> link (or copy) to <inbox>/<name> (or <name>-1, -2 ... if taken; never
//      replaced), the name made safe to save on every platform
//   -> POST /transfers/:id/received {sha256}
//   -> one room line to each bound session that did not send it, each with
//      its own copy (a hard link, or a copy) in its own inbox
//
// At most MAX_CONCURRENT downloads run at once; the rest wait for a slot.
// A failure on this side that waiting will not fix (a name too long, no
// permission, the inbox not a directory, a symlink in the way, a full disk
// after the retries) ends the transfer with a "could not be saved" line, and
// tells the journal (POST /transfers/:id/failed) so the sender hears too,
// as does a second sha mismatch.
//
// The inbox is the session's download dir (index.js: sessionDownloadDir +
// /inbox), outside any working tree, so a received file is never committed.
//
// A transfer is persisted in the state file from the moment it is seen
// until it is confirmed and delivered, so a restart picks it up again; the
// .part file stays across retries and restarts, so a resume never starts
// from zero. A sha mismatch deletes the .part and starts over once; a
// second mismatch is reported to the room and nothing is kept. Every saved
// path is recorded with its arrival time for the inbox sweep (sweep(),
// lib/inbox-sweep.js), which deletes it 7 days later.

import crypto from 'crypto';
import nodeFs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFileSync } from './atomic-write.js';
import { safeAttachmentFilename } from './item-attachments.js';
import { sweepInboxState, INBOX_MAX_AGE_MS } from './inbox-sweep.js';

const RETRY_BACKOFF_MS = [2000, 8000, 30000];
// After the short retries, a stalled download is relaunched on a timer, as
// the sender does: 1, 5, then every 15 minutes, until it is saved or the
// journal says it is gone (a 404 or 410). A journal hello (catchUp) or a
// ready frame runs it at once.
const RELAUNCH_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
// No bytes for this long aborts the download (a transient failure: the
// retry resumes from the .part).
const STALL_MS = 2 * 60_000;
const MAX_ARRIVED = 2000;
const MAX_CONCURRENT = 2;

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const transientStatus = (s) => s === 0 || s === 429 || s >= 500;

export function humanSize(bytes) {
  const units = ['KB', 'MB', 'GB', 'TB'];
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(1)} ${units[u]}`;
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = nodeFs.createReadStream(absPath);
    s.on('data', (b) => h.update(b));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// The .part's length to resume from: 0 for anything but a regular file (a
// symlink or directory planted there is refused when it is opened).
async function sizeOf(p) {
  try {
    const st = await fsp.lstat(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}
async function unlinkQuiet(p) {
  try { await fsp.unlink(p); } catch { /* already gone, or not a file */ }
}

// Leave room under NAME_MAX (255 bytes) for the -N suffix and the .part's
// `.<id>.part`.
const NAME_MAX_BYTES = 200;
const PART_NAME_MAX_BYTES = 150;
const MAX_SUFFIX = 10_000;

// Cut a name to at most `max` UTF-8 bytes on a character boundary, keeping
// a sensible extension.
export function capNameBytes(name, max = NAME_MAX_BYTES) {
  if (Buffer.byteLength(name) <= max) return name;
  let ext = path.extname(name);
  if (Buffer.byteLength(ext) > 32) ext = '';
  const room = max - Buffer.byteLength(ext);
  let base = '';
  for (const ch of ext ? name.slice(0, -ext.length) : name) {
    if (Buffer.byteLength(base + ch) > room) break;
    base += ch;
  }
  return `${base}${ext}`;
}

// A name every platform can save as given, so every session sees the same
// saved name: the characters Windows refuses (<>:"|?*) become `_`, and the
// trailing dots and spaces it would silently drop are cut. `:` matters most:
// on NTFS `name:x` writes into a hidden stream of `name`.
export function portableFileName(name, fallback = 'file') {
  const out = String(name).replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  return out === '' ? fallback : out;
}

// A file name as it appears inside a `[... "<name>" ...]` room line: no `"`
// to end the quote early and no `]` to end the line.
export function lineSafeName(name) {
  return String(name).replace(/"/g, "'").replace(/]/g, ')');
}

// Place a file at <dir>/<name>, or <base>-1<ext>, -2 ... when taken, without
// ever replacing one: `place(target)` must throw EEXIST for a taken name.
async function placeNoClobber(dir, filename, place) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let i = 0; i <= MAX_SUFFIX; i++) {
    const target = path.join(dir, i === 0 ? filename : `${base}-${i}${ext}`);
    try {
      await place(target);
      return target;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  throw Object.assign(new Error('no free file name'), { code: 'EEXIST' });
}

// A local file-system failure, said in a few words for the room line.
const LOCAL_REASONS = {
  ENAMETOOLONG: 'the file name is too long',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ENOSPC: 'the disk is full',
  EDQUOT: 'over the disk quota',
  EROFS: 'the disk is read-only',
  ENOTDIR: 'the inbox is not a directory',
  EISDIR: 'a directory is in the way',
  ELOOP: 'a symlink is in the way',
  EEXIST: 'no free file name',
};
const localReason = (e) => LOCAL_REASONS[e?.code] || (e?.code ? `local error ${e.code}` : 'a local error');
// Worth waiting for: space can be freed.
const RETRYABLE_LOCAL = new Set(['ENOSPC', 'EDQUOT']);

function validTransfer(t) {
  return !!t && typeof t === 'object'
    && typeof t.id === 'string' && t.id !== ''
    && typeof t.room_id === 'string' && t.room_id !== ''
    && typeof t.name === 'string' && t.name !== ''
    && Number.isSafeInteger(t.size) && t.size > 0
    && typeof t.sha256 === 'string' && /^[0-9a-f]{64}$/.test(t.sha256);
}

// Thrown inside a download attempt: `transient` retries (from the .part),
// otherwise the transfer is gone (404, refused) and is dropped.
class DownloadError extends Error {
  constructor(message, { transient }) { super(message); this.transient = transient; }
}
// A failure writing on this side: deterministic unless RETRYABLE_LOCAL.
class LocalError extends Error {
  constructor(cause) { super(cause?.message || String(cause)); this.code = cause?.code; }
}

// client: lib/transfer-client.js. dirFor(session) -> abs inbox dir.
// sessionsForRoom(roomId, fromConvoId) -> the bound sessions that should
// receive it (the first one's inbox gets the download; the rest a link).
// keyFor(session) -> a stable key for a target (its binding's session key),
// so a saved copy and a delivered line are matched to the target even if
// its inbox dir changes (a sleeping session that comes back to life).
// isMuted(roomId, session) -> true: save and confirm, but no line.
// deliver(session, line, {roomId, fromName, transferId}) -> the room line.
export function createTransferReceiver({
  client,
  dirFor,
  deliver = () => {},
  sessionsForRoom,
  keyFor = (session) => session?.roomId ?? null,
  isMuted = () => false,
  stateFile,
  log = console,
  now = Date.now,
  sleep = defaultSleep,
  stallMs = STALL_MS,
  maxConcurrent = MAX_CONCURRENT,
  // The download roots every inbox lives under (the sweep deletes nothing
  // outside them): an array, or a function returning one.
  inboxRoots = [],
  // fs.promises.link, injectable for a file system without hard links.
  link = (existing, target) => fsp.link(existing, target),
  // fs.constants, injectable to stand in for a platform without O_NOFOLLOW.
  fsConstants = nodeFs.constants,
} = {}) {
  const state = load();
  const running = new Map(); // transfer id -> promise (queued for a slot or running)
  const relaunchTimers = new Map(); // transfer id -> relaunch timer
  const stalls = new Map(); // transfer id -> relaunches in a row so far
  const slotWaiters = [];
  let slotsInUse = 0;
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };

  function load() {
    try {
      const raw = JSON.parse(nodeFs.readFileSync(stateFile, 'utf-8'));
      const pending = raw && typeof raw.pending === 'object' && raw.pending ? raw.pending : {};
      for (const entry of Object.values(pending)) {
        if (Array.isArray(entry?.saved)) {
          entry.saved = entry.saved.map((x) => (typeof x === 'string' ? { key: null, path: x } : x)).filter((x) => x && typeof x.path === 'string');
        }
      }
      return { pending, arrived: Array.isArray(raw?.arrived) ? raw.arrived : [] };
    } catch {
      return { pending: {}, arrived: [] };
    }
  }
  function save() {
    try {
      atomicWriteFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    } catch (e) {
      warn(`[transfer] saving inbox state failed: ${e.message}`);
    }
  }
  function clearRelaunch(id) {
    const timer = relaunchTimers.get(id);
    if (timer) { clearTimeout(timer); relaunchTimers.delete(id); }
  }
  function scheduleRelaunch(id) {
    clearRelaunch(id);
    const n = (stalls.get(id) || 0) + 1;
    stalls.set(id, n);
    const timer = setTimeout(() => {
      relaunchTimers.delete(id);
      if (state.pending[id]) launch(id);
    }, RELAUNCH_BACKOFF_MS[Math.min(n, RELAUNCH_BACKOFF_MS.length) - 1]);
    timer.unref?.();
    relaunchTimers.set(id, timer);
  }
  function drop(id) {
    clearRelaunch(id);
    stalls.delete(id);
    if (!(id in state.pending)) return;
    delete state.pending[id];
    save();
  }
  function recordArrival(p, id) {
    state.arrived.push({ path: p, arrivedAt: now(), transferId: id });
    if (state.arrived.length > MAX_ARRIVED) state.arrived.splice(0, state.arrived.length - MAX_ARRIVED);
  }

  // Capped first: the cut can end in a space or a dot, which then goes too.
  const safeName = (t) => portableFileName(capNameBytes(safeAttachmentFilename(t.name, 'file')));
  const shownName = (t) => lineSafeName(safeName(t));
  // The id is in the .part name so two transfers of the same file name never
  // share one partial file.
  function partPathFor(dir, t) {
    const idSeg = String(t.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return path.join(dir, `${capNameBytes(safeName(t), PART_NAME_MAX_BYTES)}.${idSeg}.part`);
  }

  function targetsFor(t) {
    try {
      const list = sessionsForRoom(t.room_id, t.from_convo_id ?? null);
      return Array.isArray(list) ? list.filter(Boolean) : [];
    } catch (e) {
      warn(`[transfer] finding sessions for room ${t.room_id} failed: ${e.message}`);
      return [];
    }
  }

  function tell(t, session, line) {
    try {
      if (isMuted(t.room_id, session)) return;
      deliver(session, line, { roomId: t.room_id, fromName: t.from_name || null, transferId: t.id });
    } catch (e) {
      warn(`[transfer] delivering the line for ${t.id} failed: ${e.message}`);
    }
  }
  const notSavedLine = (t, e) => `[file "${shownName(t)}" could not be saved: ${localReason(e)}]`;

  // A deterministic failure on this side: every target is told, nothing is
  // kept, and the entry is not retried. Then the journal is told.
  async function failLocal(id, t, targets, e, part = null) {
    warn(`[transfer] ${t.id} could not be saved: ${e?.code || ''} ${e?.message ?? e}`);
    if (part) await unlinkQuiet(part);
    for (const session of targets) tell(t, session, notSavedLine(t, e));
    drop(id);
    await reportFailed(t, localReason(e));
  }

  // Tell the journal this side gave up on a transfer (it fails it and tells
  // the sender). Best effort, and always after the room line: a refusal or
  // a throw is logged, and a 404 or 409 (already closed) is no news.
  async function reportFailed(t, reason) {
    try {
      const r = await client.failed(t.id, reason);
      if (!r?.ok && r?.status !== 404 && r?.status !== 409) warn(`[transfer] telling the journal ${t.id} failed was refused (HTTP ${r?.status ?? 0})`);
    } catch (err) {
      warn(`[transfer] telling the journal ${t.id} failed did not work: ${err?.message ?? err}`);
    }
  }

  // Open the .part for writing, never through a symlink. Where the platform
  // has no O_NOFOLLOW (Windows), lstat it first: anything but a regular
  // file there is refused, a missing one is created exclusively, and the
  // file opened must be the one lstat saw (checked before it is truncated,
  // so a file swapped in meanwhile is left as it was).
  async function openPart(part, append) {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_APPEND, O_TRUNC } = fsConstants;
    if (O_NOFOLLOW !== undefined) return fsp.open(part, O_WRONLY | O_CREAT | O_NOFOLLOW | (append ? O_APPEND : O_TRUNC), 0o600);
    let flags = O_WRONLY | O_CREAT | (append ? O_APPEND : 0);
    const inTheWay = () => Object.assign(new Error('not a regular file at the .part path'), { code: 'ELOOP' });
    let before = null;
    try {
      before = await fsp.lstat(part);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    if (before && !before.isFile()) throw inTheWay();
    if (!before) flags |= O_EXCL;
    let fh;
    try {
      fh = await fsp.open(part, flags, 0o600);
    } catch (e) {
      // Something appeared at the path between the lstat and the open.
      throw e?.code === 'EEXIST' ? inTheWay() : e;
    }
    if (before) {
      let st = null;
      try { st = await fh.stat(); } catch { /* compared below as a mismatch */ }
      if (!st || st.dev !== before.dev || st.ino !== before.ino) {
        await fh.close().catch(() => {});
        throw inTheWay();
      }
      if (!append) {
        try { await fh.truncate(0); } catch (e) { await fh.close().catch(() => {}); throw e; }
      }
    }
    return fh;
  }

  // One request: append the body to `part` (or start it over on a 200).
  // Resolves when the .part holds exactly t.size bytes.
  async function fetchOnce(t, part) {
    let start = await sizeOf(part);
    if (start > t.size) { await unlinkQuiet(part); start = 0; }
    const controller = new AbortController();
    let timer = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, stallMs);
      timer.unref?.();
    };
    bump();
    let res = null;
    const cancelBody = async () => {
      try { await res?.body?.cancel(); } catch { /* locked or already closed */ }
      try { controller.abort(); } catch { /* best effort */ }
    };
    try {
      try {
        res = await client.download(t.id, { start, signal: controller.signal });
      } catch (e) {
        throw new DownloadError(`download failed: ${e?.message ?? e}`, { transient: true });
      }
      if (res.status === 416) {
        // The journal says the range starts past the end. If the .part is
        // already the whole file, that is a finished download.
        const m = /^bytes \*\/(\d+)$/.exec(String(res.headers.get('content-range') || '').trim());
        await cancelBody();
        if (m && Number(m[1]) === t.size && start === t.size) return;
        await unlinkQuiet(part);
        throw new DownloadError('range not satisfiable; starting over', { transient: true });
      }
      if (res.status === 206) {
        const m = /^bytes (\d+)-\d+\/\d+$/.exec(String(res.headers.get('content-range') || '').trim());
        if (!m || Number(m[1]) !== start) {
          await cancelBody();
          await unlinkQuiet(part);
          throw new DownloadError('unexpected content-range; starting over', { transient: true });
        }
      } else if (res.status !== 200) {
        await cancelBody();
        throw new DownloadError(`HTTP ${res.status}`, { transient: transientStatus(res.status) });
      }
      if (!res.body) throw new DownloadError('empty body', { transient: true });
      // A 200 is the whole file whatever was asked: never append it. Never
      // through a symlink either.
      const append = res.status === 206;
      let fh;
      try {
        fh = await openPart(part, append);
      } catch (e) {
        await cancelBody();
        throw new LocalError(e);
      }
      // Each chunk is awaited onto disk, so whatever arrived before a
      // dropped connection is in the .part for the resume.
      try {
        for await (const chunk of res.body) {
          bump();
          try { await fh.write(chunk); } catch (e) { throw new LocalError(e); }
        }
      } catch (e) {
        if (e instanceof LocalError) { await cancelBody(); throw e; }
        throw new DownloadError(`download interrupted: ${e?.message ?? e}`, { transient: true });
      } finally {
        await fh.close().catch(() => {});
      }
      const got = await sizeOf(part);
      if (got < t.size) throw new DownloadError(`short download (${got} of ${t.size} bytes)`, { transient: true });
      // Longer than declared: the sha check fails it.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -> {kind: 'done' | 'gone' | 'stalled' | 'local', error?}
  async function fetchWithRetries(t, part) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchOnce(t, part);
        return { kind: 'done' };
      } catch (e) {
        if (e instanceof LocalError) {
          if (!RETRYABLE_LOCAL.has(e.code) || attempt >= RETRY_BACKOFF_MS.length) return { kind: 'local', error: e };
        } else if (!(e instanceof DownloadError)) {
          throw e;
        } else if (!e.transient) {
          log.log?.(`[transfer] ${t.id} is no longer downloadable (${e.message})`);
          return { kind: 'gone' };
        } else if (attempt >= RETRY_BACKOFF_MS.length) {
          warn(`[transfer] download of ${t.id} stalled (${e.message}); kept, and tried again later`);
          return { kind: 'stalled' };
        }
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }

  async function receiptWithRetries(t) {
    let r = await client.received(t.id, t.sha256);
    for (const wait of RETRY_BACKOFF_MS) {
      if (r.ok || !transientStatus(r.status)) break;
      await sleep(wait);
      r = await client.received(t.id, t.sha256);
    }
    return r;
  }

  // Put `source` at `target` without ever replacing a file there: a hard
  // link, or an exclusive copy where linking is not possible (never a rename,
  // which replaces). EEXIST for a taken name; a half-written copy is removed.
  async function linkOrCopy(source, target) {
    try {
      await link(source, target);
      return;
    } catch (e) {
      if (e?.code === 'EEXIST') throw e;
    }
    try {
      await fsp.copyFile(source, target, nodeFs.constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if (copyErr?.code !== 'EEXIST') await unlinkQuiet(target);
      throw copyErr;
    }
  }

  // A copy of `source` in this session's own inbox.
  async function copyInto(source, session, t) {
    const dir = dirFor(session);
    await fsp.mkdir(dir, { recursive: true });
    return placeNoClobber(dir, safeName(t), (target) => linkOrCopy(source, target));
  }

  // Saved: confirm to the journal, then tell each target where its copy is.
  // Each step is recorded (per target for the lines), so a restart in
  // between repeats only what is left.
  async function finish(entry) {
    const t = entry.transfer;
    if (!entry.receipted) {
      const r = await receiptWithRetries(t);
      if (r.ok || !transientStatus(r.status)) {
        if (!r.ok) warn(`[transfer] receipt for ${t.id} refused (HTTP ${r.status}); the file is kept`);
        entry.receipted = true;
      } else {
        warn(`[transfer] receipt for ${t.id} failed (HTTP ${r.status}); will retry on the next catch-up`);
      }
      save();
    }
    if (!entry.delivered) {
      const caption = typeof (t.reason ?? t.caption) === 'string' ? (t.reason ?? t.caption).trim() : '';
      const saved = entry.saved || (entry.saved = []);
      const told = new Set(entry.told || []);
      for (const session of targetsFor(t)) {
        const key = keyFor(session);
        if (key == null || told.has(key)) continue;
        let rec = saved.find((x) => x.key === key && nodeFs.existsSync(x.path));
        let line;
        if (!rec) {
          const source = saved.find((x) => nodeFs.existsSync(x.path));
          if (!source) {
            line = `[file "${shownName(t)}" could not be saved: the saved copy is gone]`;
          } else {
            try {
              rec = { key, path: await copyInto(source.path, session, t) };
              saved.push(rec);
              recordArrival(rec.path, t.id);
            } catch (e) {
              warn(`[transfer] copying ${t.id} into another inbox failed: ${e?.message ?? e}`);
              line = notSavedLine(t, e);
            }
          }
        }
        if (rec) line = `[sent file "${shownName(t)}" — saved to ${rec.path} (${humanSize(t.size)}, sha256 ${t.sha256.slice(0, 12)}…)]${caption ? `: ${caption}` : ''}`;
        tell(t, session, line);
        told.add(key);
        entry.told = [...told];
        save();
      }
      entry.delivered = true;
      save();
    }
    if (entry.receipted) drop(t.id);
  }

  async function receive(id) {
    const entry = state.pending[id];
    if (!entry) return;
    if (entry.saved) {
      // Saved before a restart that came before the .part was removed.
      if (entry.dir) await unlinkQuiet(partPathFor(entry.dir, entry.transfer));
      return finish(entry);
    }
    const t = entry.transfer;
    const targets = targetsFor(t);
    if (targets.length === 0) {
      log.log?.(`[transfer] ${t.id}: no session in room ${t.room_id} to receive it`);
      drop(id);
      return;
    }
    let dir;
    try {
      dir = dirFor(targets[0]);
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      return failLocal(id, t, targets, e);
    }
    const part = partPathFor(dir, t);
    // Where the .part lives, so the inbox sweep knows this inbox (and leaves
    // this transfer's .part alone while the entry is pending).
    if (entry.dir !== dir) { entry.dir = dir; save(); }

    for (let mismatches = 0; ;) {
      const outcome = await fetchWithRetries(t, part);
      if (outcome.kind === 'gone') { await unlinkQuiet(part); drop(id); return; }
      if (outcome.kind === 'stalled') { scheduleRelaunch(id); return; }
      if (outcome.kind === 'local') return failLocal(id, t, targets, outcome.error, part);
      let digest;
      try { digest = await sha256File(part); } catch (e) { return failLocal(id, t, targets, e, part); }
      if (digest === t.sha256) break;
      await unlinkQuiet(part);
      mismatches += 1;
      if (mismatches > 1) {
        warn(`[transfer] ${t.id} failed verification twice; not saved`);
        for (const session of targets) tell(t, session, `[file "${shownName(t)}" failed verification and was not saved]`);
        drop(id);
        await reportFailed(t, 'sha256 mismatch after retry');
        return;
      }
    }

    // The saved path is recorded before the .part goes: a restart in between
    // then finds the entry saved, rather than a whole .part to verify and
    // place again under a -1 name.
    let finalPath;
    try {
      // The .part itself is removed below, once the saved path is recorded.
      finalPath = await placeNoClobber(dir, safeName(t), (target) => linkOrCopy(part, target));
    } catch (e) {
      return failLocal(id, t, targets, e, part);
    }
    recordArrival(finalPath, t.id);
    entry.saved = [{ key: keyFor(targets[0]), path: finalPath }];
    save();
    await unlinkQuiet(part);
    return finish(entry);
  }

  async function acquireSlot() {
    if (slotsInUse < maxConcurrent) { slotsInUse += 1; return; }
    await new Promise((resolve) => slotWaiters.push(resolve));
  }
  function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) next(); else slotsInUse -= 1;
  }

  function launch(id) {
    if (running.has(id)) return running.get(id);
    clearRelaunch(id);
    const p = (async () => {
      await acquireSlot();
      try { await receive(id); } finally { releaseSlot(); }
    })()
      .catch((e) => warn(`[transfer] receiving ${id} failed: ${e?.message ?? e}`))
      .finally(() => running.delete(id));
    running.set(id, p);
    return p;
  }

  const alreadyArrived = (id) => state.arrived.some((a) => a.transferId === id);

  function onReady(transfer) {
    if (!validTransfer(transfer)) {
      warn('[transfer] ignoring a ready transfer without id, room, name, size or sha256');
      return;
    }
    const id = transfer.id;
    if (running.has(id)) return;
    if (!state.pending[id]) {
      if (alreadyArrived(id)) return;
      state.pending[id] = { transfer };
      save();
    }
    launch(id);
  }

  // On every journal hello: whatever the journal says is waiting for this
  // device, plus whatever the state file still holds (a download a restart
  // or a long outage interrupted, or a receipt or line that never got out).
  // An unfinished download the journal no longer lists is tried anyway: a
  // just-delivered transfer is still served for a while, and a 404 drops it.
  async function catchUp() {
    let listed = null;
    try {
      const r = await client.listPending();
      if (r?.ok && Array.isArray(r.body?.transfers)) listed = r.body.transfers;
      else warn(`[transfer] catch-up list failed (HTTP ${r?.status ?? 0}); resuming local downloads only`);
    } catch (e) {
      warn(`[transfer] catch-up list failed: ${e.message}`);
    }
    const ids = new Set();
    for (const t of listed || []) {
      if (!validTransfer(t)) continue;
      ids.add(t.id);
      onReady(t);
    }
    for (const id of Object.keys(state.pending)) {
      if (ids.has(id) || running.has(id)) continue;
      launch(id);
    }
  }

  // Downloads in flight, queued for a slot, or waiting out a retry: what
  // keeps the box awake.
  // A download waiting on its relaunch timer is still work: it keeps the
  // box awake, or the unref'd timer would never fire on a sleeping box.
  const active = () => new Set([...running.keys(), ...relaunchTimers.keys()]).size;

  async function idle() {
    while (running.size) await Promise.all([...running.values()]);
  }

  // Delete what has been in the inboxes longer than 7 days (lib/inbox-sweep.js)
  // through this receiver's own state, so a later save never brings a
  // pruned record back.
  function sweep({ maxAgeMs = INBOX_MAX_AGE_MS } = {}) {
    const roots = typeof inboxRoots === 'function' ? inboxRoots() : inboxRoots;
    const { deleted, changed } = sweepInboxState(state, { now: now(), maxAgeMs, roots, log });
    if (changed) save();
    if (deleted.length) log.log?.(`[transfer] inbox sweep deleted ${deleted.length} file${deleted.length === 1 ? '' : 's'} older than 7 days`);
    return { deleted };
  }

  return { onReady, catchUp, active, idle, partPathFor, sweep };
}
