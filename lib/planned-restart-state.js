// Durable state of a planned restart: the requests waiting for a quiet moment,
// the restart id, and how far the restart has got. One JSON file, replaced
// atomically on every change. Every write throws on failure, so a caller can
// never acknowledge a request that the file does not hold.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from './atomic-write.js';

const STATES = new Set(['pending', 'restarting', 'back']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;

function emptyState() {
  return {
    id: null, state: null, requests: [], pending_since: null,
    first_request_at: null, last_request_at: null,
    // The sha this process booted on; `previous_sha` and `expected_sha` are
    // set when the restart latches.
    boot_sha: null, previous_sha: null, expected_sha: null,
    participants: [], notified: {}, restarting_at: null, verdicts: {}, results: null,
  };
}

export function createPlannedRestartState({
  fs = nodeFs,
  file = path.join(os.homedir(), '.matron-bridge-restart-state.json'),
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
      || !Array.isArray(data.requests) || !Array.isArray(data.participants)) {
      throw new Error('Invalid restart state');
    }
    // Files written before notices existed have no `notified` map.
    if (data.notified === undefined) data.notified = {};
    if (!object(data.notified)) throw new Error('Invalid restart state');
    return data;
  }

  const save = data => { atomicWriteFileSync(file, JSON.stringify(data), { fs, mode: 0o600 }); return data; };

  return {
    getState: read,

    patch(patch) {
      if (!object(patch)) throw new Error('Invalid restart state patch');
      return save({ ...read(), ...patch });
    },

    setState(state, patch = {}) {
      if (!STATES.has(state) || !object(patch)) throw new Error('Invalid restart state');
      const current = read();
      const next = save({ ...current, ...patch, state });
      if (state === 'pending' && current.state !== 'pending') onPending(next);
      return next;
    },

    // One notice per session per restart: remember who has been told.
    markNotified(id, convoId) {
      const current = read();
      if (!text(id) || current.id !== id || current.state !== 'pending' || !text(convoId)) throw new Error('Invalid restart notice');
      if (Object.hasOwn(current.notified, convoId)) return current;
      return save({ ...current, notified: { ...current.notified, [convoId]: { at: now() } } });
    },

    // Persist, then acknowledge: `ack` runs only after the file holds the
    // request. A request joins the pending restart; with none pending it starts
    // one. While the restart is latched nothing is accepted: the caller retries
    // after the bridge is back.
    addRequest(request, { ack = () => {} } = {}) {
      if (!object(request) || !text(request.request_key)) throw new Error('Invalid restart request key');
      const current = read();
      if (current.state === 'restarting') return { busy: 'restarting', id: current.id };
      const pending = current.state === 'pending';
      if (pending && current.requests.some(prior => prior.request_key === request.request_key)) {
        const result = { id: current.id, state: current.state };
        ack(result);
        return result;
      }
      const at = now();
      const next = pending ? current : {
        ...emptyState(), id: makeId(), state: 'pending', boot_sha: current.boot_sha,
        pending_since: at, first_request_at: at,
      };
      next.requests.push({ ...request, at });
      next.last_request_at = at;
      save(next);
      if (!pending) onPending(next);
      const result = { id: next.id, state: next.state };
      ack(result);
      return result;
    },

    // The bridge supplies its module-load sha once per boot; later calls in the
    // same process cannot replace it with a newer checkout HEAD.
    persistBootSha(sha) {
      if (sha !== null && !text(sha)) throw new Error('Invalid restart boot sha');
      if (bootSha !== undefined) return read();
      const saved = save({ ...read(), boot_sha: sha });
      bootSha = sha;
      return saved;
    },
  };
}
