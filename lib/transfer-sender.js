// The send half of agent-to-agent file transfer: send_attachment into a
// room hands the file to start(), which returns at once while a background
// job does the work (journal protocol, "Agent-to-agent file transfers"):
//
//   sha256 + secret scan (one pass each, run side by side), then sha256
//   again: the scan read the file separately, so the second digest proves
//   it read the same bytes the card's sha256 names
//   -> POST /transfers (the user's card is filed then)
//   -> PUT every chunk the journal does not have yet
//   -> POST /transfers/:id/complete
//
// The job is persisted after every step, so a bridge restart (or a journal
// reconnect: index.js calls resumeAll on every hello) carries on from the
// first missing chunk the status route reports, never from zero. A job
// stays in the state file after it has uploaded, until the journal says how
// it ended (declined / failed / expired / delivered frame, or the same
// read from the status route on resume); only then is it dropped.
//
// If the file's size or mtime changes after start (or its bytes between the
// two hashes), the bytes no longer match the sha256 the card shows, so the
// transfer is cancelled and the session told, rather than uploading
// something else under that name.
//
// A transient failure (journal unreachable, 5xx, 429, after the chunk
// retries) or an unexpected throw stops the job for now and schedules a
// relaunch, backing off 1, 5, then every 15 minutes. After 24 h with no
// progress, or 20 stops in a row, it gives up: the transfer is cancelled on
// the journal and the session told. A refusal (any other 4xx) ends it at
// once and tells the session why.
//
// At most MAX_CONCURRENT jobs upload at once (each holds a 32 MiB chunk
// buffer); the rest wait in state for a slot.

import crypto from 'crypto';
import nodeFs from 'fs';
import fsp from 'fs/promises';
import { atomicWriteFileSync } from './atomic-write.js';
import { scanFile } from './secret-scan.js';
import { lineSafeName } from './transfer-receiver.js';

export const TRANSFER_CHUNK_BYTES = 33554432;
const CHUNK_BACKOFF_MS = [2000, 8000, 30000];
const RELAUNCH_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const GIVE_UP_AFTER_STOPS = 20;
const MAX_CONCURRENT = 2;
// run()'s answer for "stopped on a transient failure; try again later".
const TRANSIENT = Symbol('transient');
// 409 hashing on complete: another complete is hashing the file. Wait,
// look at the status, and complete again; at most this many times.
const HASHING_WAIT_MS = 30_000;
const HASHING_MAX_WAITS = 40;
// What a refused create means, for the session (409 detail).
const NOT_STARTED = {
  too_many_awaiting: "too many files are already waiting for the user's approval; wait for those to be answered",
  no_recipients: 'no other session is in this room',
  multiple_recipients: 'this room has more than one other session; files go to one session at a time',
};
const TERMINAL = new Set(['declined', 'failed', 'expired', 'cancelled', 'delivered']);
const DEFAULT_REASONS = {
  declined: 'no reason given',
  failed: 'the uploaded bytes did not match',
  expired: 'not collected within 7 days',
  cancelled: 'cancelled',
};

const isHashing = (r) => r?.status === 409 && r.body?.detail === 'hashing';
const transient = (r) => !r || r.status === 0 || r.status === 429 || r.status >= 500;
const errorOf = (r) => (typeof r?.body?.error === 'string' && r.body.error) || `HTTP ${r?.status ?? 0}`;
const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = nodeFs.createReadStream(absPath);
    s.on('data', (b) => h.update(b));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function readSlice(absPath, offset, length) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === length ? buf : null;
  } finally {
    await fh.close();
  }
}

// notify({sessionKey, roomId, fromConvoId, name, text}): tell the sending
// session how its transfer ended (index.js: room delivery).
export function createTransferSender({
  client,
  scan = scanFile,
  stateFile,
  log = console,
  now = Date.now,
  notify = () => {},
  sleep = defaultSleep,
  chunkBytes = TRANSFER_CHUNK_BYTES,
  hashFile = sha256File,
} = {}) {
  const jobs = load();
  const running = new Map(); // jobId -> promise (queued for a slot or running)
  const retryTimers = new Map(); // jobId -> relaunch timer
  const slotWaiters = [];
  let slotsInUse = 0;

  function load() {
    try {
      const raw = JSON.parse(nodeFs.readFileSync(stateFile, 'utf-8'));
      return raw && typeof raw.jobs === 'object' && raw.jobs ? raw.jobs : {};
    } catch {
      return {};
    }
  }
  function save() {
    try {
      atomicWriteFileSync(stateFile, JSON.stringify({ jobs }), { mode: 0o600 });
    } catch (e) {
      try { log.warn(`[transfer] saving state failed: ${e.message}`); } catch { /* best effort */ }
    }
  }
  const live = (jobId, job) => jobs[jobId] === job;

  function tell(job, text) {
    try {
      notify({ sessionKey: job.sessionKey, roomId: job.roomId, fromConvoId: job.fromConvoId, name: job.name, text });
    } catch (e) {
      try { log.warn(`[transfer] notify failed: ${e.message}`); } catch { /* best effort */ }
    }
  }
  function drop(jobId) {
    clearRetry(jobId);
    if (!(jobId in jobs)) return;
    delete jobs[jobId];
    save();
  }
  function end(jobId, job, word, reason) {
    drop(jobId);
    tell(job, `[transfer of "${lineSafeName(job.name)}" ${word}: ${reason}]`);
  }
  function progressed(job) {
    job.stalls = 0;
    job.lastProgressAt = now();
  }
  async function cancelChanged(jobId, job) {
    if (job.transferId) await client.cancel(job.transferId).catch(() => null);
    if (live(jobId, job)) end(jobId, job, 'cancelled', 'the file changed while it was being sent; send it again once it is final');
  }
  async function unchanged(job) {
    try {
      const st = await fsp.stat(job.absPath);
      return st.isFile() && st.size === job.size && st.mtimeMs === job.mtimeMs;
    } catch {
      return false;
    }
  }

  async function putWithRetry(job, n, bytes, digest) {
    let r = await client.putChunk(job.transferId, n, bytes, digest);
    for (const wait of CHUNK_BACKOFF_MS) {
      if (r.ok || !transient(r)) break;
      await sleep(wait);
      r = await client.putChunk(job.transferId, n, bytes, digest);
    }
    return r;
  }

  async function run(jobId) {
    const job = jobs[jobId];
    if (!job) return;
    if (!(await unchanged(job))) return cancelChanged(jobId, job);

    if (!job.sha256) {
      const [digest, verdict] = await Promise.all([
        hashFile(job.absPath),
        Promise.resolve().then(() => scan(job.absPath)).catch((e) => {
          // The code only: an error message could quote the file.
          try { log.warn(`[transfer] scanning ${job.name} failed (${e?.code || e?.name || 'error'}); sending it as not scanned`); } catch { /* best effort */ }
          return { verdict: 'not_scanned', findings: [] };
        }),
      ]);
      if (!live(jobId, job)) return;
      if (!(await unchanged(job))) return cancelChanged(jobId, job);
      // The scan's read and the first hash's read were separate: a rewrite
      // in between (even one keeping size and mtime) shows as a new digest.
      const again = await hashFile(job.absPath);
      if (!live(jobId, job)) return;
      if (again !== digest || !(await unchanged(job))) return cancelChanged(jobId, job);
      job.sha256 = digest;
      job.scan = {
        verdict: verdict?.verdict || 'not_scanned',
        findings: Array.isArray(verdict?.findings) ? verdict.findings.map((f) => ({ kind: f.kind, line: f.line })) : [],
      };
      save();
    }

    if (!job.transferId) {
      const r = await client.create({
        room_id: job.roomId, from_convo_id: job.fromConvoId, name: job.name, size: job.size, sha256: job.sha256,
        ...(job.contentType ? { content_type: job.contentType } : {}),
        ...(job.caption ? { reason: job.caption } : {}),
        // What started the asking turn (lib/turn-cause.js), stamped at
        // start() and kept in state, so a create after a restart still names
        // the turn that asked rather than whatever runs now.
        ...(Array.isArray(job.causes) && job.causes.length ? { causes: job.causes } : {}),
        scan: job.scan || { verdict: 'not_scanned', findings: [] },
      });
      if (!live(jobId, job)) return;
      if (!r.ok || typeof r.body?.transfer_id !== 'string') {
        if (transient(r)) { log.warn(`[transfer] create for ${job.name} failed (${errorOf(r)}); will retry`); return TRANSIENT; }
        const why = r.status === 409 && NOT_STARTED[r.body?.detail];
        if (why) return end(jobId, job, 'not started', why);
        return end(jobId, job, 'failed', errorOf(r));
      }
      job.transferId = r.body.transfer_id;
      job.chunkBytes = chunkBytes;
      job.createdAt = now();
      progressed(job);
      save();
      // Every chunk but the last must be exactly the journal's size; a
      // journal on another size cannot take these chunks at all.
      const cb = r.body.chunk_bytes;
      if (cb !== undefined && cb !== chunkBytes) {
        await client.cancel(job.transferId).catch(() => null);
        if (live(jobId, job)) end(jobId, job, 'failed', `the journal expects ${cb}-byte chunks, this bridge sends ${chunkBytes}`);
        return;
      }
    }

    const st = await client.status(job.transferId);
    if (!live(jobId, job)) return;
    if (!st.ok) {
      if (transient(st)) return TRANSIENT;
      // 404: the journal no longer knows it (deleted, or never ours).
      drop(jobId);
      return;
    }
    if (TERMINAL.has(st.body.phase)) return settle(jobId, job, st.body.phase, null);
    const size = job.chunkBytes || chunkBytes;
    const count = Math.max(1, Math.ceil(job.size / size));
    if (st.body.upload !== 'uploaded') {
      const have = new Set(Array.isArray(st.body.received) ? st.body.received : []);
      for (let n = 0; n < count; n++) {
        if (have.has(n)) continue;
        if (!(await unchanged(job))) return cancelChanged(jobId, job);
        if (!live(jobId, job)) return;
        const offset = n * size;
        const bytes = await readSlice(job.absPath, offset, Math.min(size, job.size - offset));
        if (!bytes) return cancelChanged(jobId, job);
        const r = await putWithRetry(job, n, bytes, crypto.createHash('sha256').update(bytes).digest('hex'));
        if (!live(jobId, job)) return;
        if (!r.ok) {
          if (transient(r)) { log.warn(`[transfer] chunk ${n} of ${job.name} failed (${errorOf(r)}); will retry`); return TRANSIENT; }
          // 409 closed: declined or cancelled meanwhile; its frame says so.
          if (r.status === 409) return;
          await client.cancel(job.transferId).catch(() => null);
          return end(jobId, job, 'failed', errorOf(r));
        }
        progressed(job);
        save();
      }
    }

    if (!(await unchanged(job))) return cancelChanged(jobId, job);
    let done = await client.complete(job.transferId, { size: job.size });
    if (!live(jobId, job)) return;
    // Another complete is still hashing (a relaunch overlapping a slow
    // one): not a failure. Wait, see whether it has finished, and ask again.
    for (let waits = 0; isHashing(done) && waits < HASHING_MAX_WAITS; waits++) {
      await sleep(HASHING_WAIT_MS);
      if (!live(jobId, job)) return;
      const st2 = await client.status(job.transferId);
      if (!live(jobId, job)) return;
      if (st2.ok && TERMINAL.has(st2.body?.phase)) return settle(jobId, job, st2.body.phase, null);
      if (st2.ok && st2.body?.upload === 'uploaded') { done = st2; break; }
      if (!st2.ok && !transient(st2)) return end(jobId, job, 'failed', errorOf(st2));
      done = await client.complete(job.transferId, { size: job.size });
      if (!live(jobId, job)) return;
    }
    if (done.ok) { job.uploaded = true; progressed(job); save(); return; }
    if (transient(done) || isHashing(done)) return TRANSIENT;
    // 422 sha256_mismatch: the journal sends a failed frame too; whichever
    // arrives first ends the job, the other finds nothing.
    if (done.status === 422) return end(jobId, job, 'failed', errorOf(done));
    // 409 missing_chunks: a relaunch uploads them; 409 closed: a frame follows.
    if (done.status === 409) return [done.body?.error, done.body?.detail].includes('missing_chunks') ? TRANSIENT : undefined;
    end(jobId, job, 'failed', errorOf(done));
  }

  function settle(jobId, job, event, reason) {
    if (event === 'delivered' || event === 'cancelled') { drop(jobId); return; }
    end(jobId, job, event, reason || DEFAULT_REASONS[event] || event);
  }

  function acquire() {
    if (slotsInUse < MAX_CONCURRENT) { slotsInUse++; return Promise.resolve(); }
    return new Promise((resolve) => slotWaiters.push(resolve));
  }
  function release() {
    const next = slotWaiters.shift();
    if (next) next(); // the slot passes straight on
    else slotsInUse--;
  }
  function clearRetry(jobId) {
    const t = retryTimers.get(jobId);
    if (t) { clearTimeout(t); retryTimers.delete(jobId); }
  }

  // One go at a job: TRANSIENT when it should be tried again later. A throw
  // (a read failing, say) is a file that changed or went away when the file
  // says so, and a transient stop otherwise.
  async function attempt(jobId) {
    try {
      return await run(jobId);
    } catch (e) {
      try { log.warn(`[transfer] job ${jobId} stopped: ${e.message}`); } catch { /* best effort */ }
      const job = jobs[jobId];
      if (!job) return undefined;
      if (!(await unchanged(job))) { await cancelChanged(jobId, job); return undefined; }
      return TRANSIENT;
    }
  }

  async function stalled(jobId) {
    const job = jobs[jobId];
    if (!job) return;
    job.stalls = (job.stalls || 0) + 1;
    const since = now() - (job.lastProgressAt ?? job.startedAt ?? now());
    if (job.stalls >= GIVE_UP_AFTER_STOPS || since >= GIVE_UP_AFTER_MS) {
      if (job.transferId) await client.cancel(job.transferId).catch(() => null);
      if (live(jobId, job)) end(jobId, job, 'stopped', 'the journal could not be reached');
      return;
    }
    save();
    clearRetry(jobId);
    const wait = RELAUNCH_BACKOFF_MS[Math.min(job.stalls, RELAUNCH_BACKOFF_MS.length) - 1];
    const t = setTimeout(() => {
      retryTimers.delete(jobId);
      if (jobs[jobId]) launch(jobId);
    }, wait);
    t.unref?.();
    retryTimers.set(jobId, t);
  }

  function launch(jobId) {
    if (running.has(jobId)) return running.get(jobId);
    clearRetry(jobId);
    const p = (async () => {
      await acquire();
      let outcome;
      try { outcome = await attempt(jobId); } finally { release(); }
      return outcome;
    })()
      .catch((e) => {
        try { log.warn(`[transfer] job ${jobId} stopped: ${e.message}`); } catch { /* best effort */ }
        return TRANSIENT;
      })
      .then(async (outcome) => {
        running.delete(jobId);
        if (outcome === TRANSIENT) await stalled(jobId);
      });
    running.set(jobId, p);
    return p;
  }

  // Already uploaded: only asks the journal whether it has ended meanwhile
  // (a frame missed while offline).
  async function check(jobId) {
    const job = jobs[jobId];
    const st = await client.status(job.transferId);
    if (!live(jobId, job)) return;
    if (!st.ok) { if (!transient(st)) drop(jobId); return; }
    if (TERMINAL.has(st.body.phase)) settle(jobId, job, st.body.phase, null);
  }

  return {
    start({ sessionKey = null, roomId, fromConvoId, absPath, name, size, mtimeMs, contentType = null, caption = null, causes = null }) {
      const jobId = crypto.randomUUID();
      const at = now();
      jobs[jobId] = { transferId: null, absPath, size, mtimeMs, sha256: null, roomId, fromConvoId, sessionKey, name, contentType, caption: caption || null, causes: Array.isArray(causes) && causes.length ? causes : null, startedAt: at, lastProgressAt: at, stalls: 0 };
      save();
      // Next tick: the tool call answers before the first byte is read.
      setImmediate(() => { launch(jobId); });
      return { jobId };
    },
    resumeAll() {
      const work = [];
      for (const [jobId, job] of Object.entries(jobs)) {
        if (running.has(jobId)) { work.push(running.get(jobId)); continue; }
        if (job.uploaded && job.transferId) work.push(check(jobId).catch(() => null));
        else work.push(launch(jobId));
      }
      return Promise.all(work).then(() => undefined);
    },
    // Jobs whose bytes are still going up (an uploaded job awaiting its
    // outcome is not counted).
    active() {
      return Object.values(jobs).filter((j) => !j.uploaded).length;
    },
    // Resolves once every running job has stopped (tests, shutdown).
    async idle() {
      await new Promise((resolve) => setImmediate(resolve));
      while (running.size) await Promise.all([...running.values()]);
    },
    onFrame(frame) {
      if (!frame || frame.kind !== 'transfer' || typeof frame.transfer_id !== 'string') return false;
      if (!['declined', 'failed', 'expired', 'delivered'].includes(frame.event)) return false;
      const entry = Object.entries(jobs).find(([, j]) => j.transferId === frame.transfer_id);
      if (!entry) return false;
      const [jobId, job] = entry;
      const reason = typeof frame.reason === 'string' && frame.reason ? frame.reason.slice(0, 200) : null;
      settle(jobId, job, frame.event, reason);
      return true;
    },
  };
}
