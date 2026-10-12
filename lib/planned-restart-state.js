import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from './atomic-write.js';

const STATES = new Set(['pending', 'restarting', 'cancelling', 'back', 'cancelled', 'abandoned']);
const OUTCOMES = new Set(['resumed', 'failed', 'possibly_delivered', 'stale']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;

function emptyState() {
  return {
    id: null, state: null, requests: [], pending_since: null,
    first_request_at: null, last_request_at: null, boot_sha: null,
    previous_sha: null, expected_sha: null, participants: [], notified: {},
    verdicts: {}, history_appended: false, stamp_written: false,
  };
}

// Paths are resolved when the store is created, never during module import.
// All writes throw on failure; a caller cannot acknowledge uncommitted state.
export function createPlannedRestartState({
  fs = nodeFs,
  file = path.join(os.homedir(), '.matron-bridge-restart-state.json'),
  historyFile = path.join(os.homedir(), '.matron-bridge-restart-history.jsonl'),
  now = Date.now,
  makeId = randomUUID,
  onPending = () => {},
} = {}) {
  let bootSha;

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return emptyState();
      throw e;
    }
    const data = JSON.parse(raw);
    if (!object(data) || !(STATES.has(data.state) || (data.state === null && data.id === null))
      || !Array.isArray(data.requests) || (!Array.isArray(data.participants) && !(data.state === 'restarting' && data.participants === undefined))
      || !object(data.notified) || !object(data.verdicts)
      || typeof data.history_appended !== 'boolean' || typeof data.stamp_written !== 'boolean') {
      throw new Error('Invalid restart state');
    }
    return data;
  }

  function save(data) {
    atomicWriteFileSync(file, JSON.stringify(data), { fs, mode: 0o600 });
    return data;
  }

  return {
    getState: read,
    patch(patch) {
      if (!object(patch)) throw new Error('Invalid restart state patch');
      return save({ ...read(), ...patch });
    },
    markNotified(id, convoId) {
      const current = read();
      if (!text(id) || current.id !== id || current.state !== 'pending' || !text(convoId)) throw new Error('Invalid restart notice');
      if (Object.hasOwn(current.notified, convoId)) return current;
      return save({ ...current, notified: { ...current.notified, [convoId]: { at: now(), turnEnded: false } } });
    },

    markNoticeTurnEnded(id, convoId) {
      const current = read();
      if (!text(id) || current.id !== id || current.state !== 'pending' || !text(convoId)) throw new Error('Invalid restart notice');
      const notice = current.notified[convoId];
      if (!Object.hasOwn(current.notified, convoId) || notice.turnEnded) return current;
      return save({ ...current, notified: { ...current.notified, [convoId]: { ...notice, turnEnded: true } } });
    },

    addRequest(request, ack = () => {}, { supersede } = {}) {
      if (!object(request) || !text(request.request_key)) throw new Error('Invalid restart request key');
      const current = read();
      if (['restarting', 'cancelling'].includes(current.state)) return { busy: 'restarting', id: current.id };
      const count = current.requests.length;
      if (current.state === 'pending' && supersede) current.requests = current.requests.filter(r => !supersede(r));
      if (!current.requests.some(r => r.request_key === request.request_key)) {
        const at = now();
        const next = current.state === 'pending' ? current : {
          ...emptyState(), id: makeId(), state: 'pending', boot_sha: current.boot_sha,
          // Older pending deliveries still need their durable verdicts.
          ...(current.id ? { other_verdicts: { ...current.other_verdicts, [current.id]: current.verdicts } } : {}),
          pending_since: at, first_request_at: at,
        };
        next.requests.push({ ...request });
        next.last_request_at = at;
        save(next);
        if (current.state !== 'pending') onPending(next);
        const result = { id: next.id, state: next.state };
        ack(result);
        return result;
      }
      if (current.requests.length !== count) save(current);
      const result = { id: current.id, state: current.state };
      ack(result);
      return result;
    },

    setState(state, patch = {}) {
      if (!STATES.has(state) || !object(patch)) throw new Error('Invalid restart state');
      const current = read();
      const next = save({ ...current, ...patch, state });
      if (state === 'pending' && current.state !== 'pending') onPending(next);
      return next;
    },

    setBootPhase(phase) {
      if (!text(phase)) throw new Error('Invalid restart boot phase');
      const current = read();
      if (phase === 'booted') {
        if (current.state !== 'restarting' || current.booted_at != null) return current;
        current.booted_at = now();
      }
      return save({ ...current, boot_phase: phase });
    },

    recordVerdict(convoId, outcome) {
      if (!text(convoId) || !OUTCOMES.has(outcome)) throw new Error('Invalid restart verdict');
      const current = read();
      return save({ ...current, verdicts: { ...current.verdicts, [convoId]: { outcome, at: now() } } });
    },

    clearStampWritten() {
      return save({ ...read(), stamp_written: false });
    },

    // The bridge supplies its module-load SHA once per boot. Subsequent calls
    // in this process cannot replace it with a later checkout HEAD.
    persistBootSha(sha) {
      if (sha !== null && !text(sha)) throw new Error('Invalid restart boot sha');
      if (bootSha !== undefined) return read();
      const saved = save({ ...read(), boot_sha: sha, stamp_written: false });
      bootSha = sha;
      return saved;
    },

    appendHistoryOnce(id, line) {
      const current = read();
      if (!text(id) || current.id !== id || !object(line)) throw new Error('Invalid restart history id or line');
      let raw;
      try { raw = fs.readFileSync(historyFile, 'utf8'); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        raw = '';
      }
      const lines = raw.split('\n');
      let repair = false;
      const entries = lines.flatMap((s, index) => {
        if (!s.trim()) return [];
        let entry;
        try { entry = JSON.parse(s); }
        catch (e) {
          if (index !== lines.length - 1 || raw.endsWith('\n')) throw e;
          // A failed append can leave only a prefix of the final record.
          // Validate all completed lines before replacing that partial tail.
          raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
          repair = true;
          return [];
        }
        if (!object(entry) || !text(entry.id)) throw new Error('Invalid restart history entry');
        return [entry];
      });
      if (repair) atomicWriteFileSync(historyFile, raw, { fs, mode: 0o600 });
      // Scan even when the flag is set: the append may have committed before
      // a failed flag write, and a retry must preserve the original line.
      if (!entries.some(entry => entry.id === id)) {
        const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(historyFile, prefix + JSON.stringify({ ...line, id }) + '\n', { mode: 0o600, flush: true });
      }
      if (!current.history_appended) return save({ ...current, history_appended: true });
      return current;
    },
  };
}

// Watcher-sourced requests only describe the HEAD seen at settle time, so a
// newer watcher request supersedes older ones for other shas (a rolled-back
// update must not block the next one). Operator requests are never superseded.
export function supersedesWatcherRequests(request) {
  return prior => request.origin === 'watcher' && prior.origin === 'watcher' && prior.sha !== request.sha;
}
