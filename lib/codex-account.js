import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Read-only app-server queries. Never starts/resumes a thread or reads auth.json.
// A short-lived stdio server keeps its lifecycle independent of executing turns.
export async function withCodexAppServer(callback, {
  cwd, env = process.env, command = 'codex', spawnImpl = spawn, timeoutMs = 15_000,
} = {}) {
  const child = spawnImpl(command, ['app-server', '--listen', 'stdio://'], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 0;
  let failure = null;
  const fail = error => {
    failure = error;
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { write({ id, method, params }); }
    catch { fail(new Error('Could not write to Codex app server.')); }
  });
  child.on('error', () => fail(new Error('Could not start Codex app server. Check that Codex CLI is installed.')));
  child.on('close', () => fail(new Error('Codex app server exited before responding.')));
  child.stdin.on('error', () => fail(new Error('Codex app server closed its input.')));
  // Drain diagnostics, but do not forward config, credentials or server error data.
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > 4 * 1024 * 1024) {
      fail(new Error('Codex account response exceeded the size limit.'));
      child.kill('SIGTERM');
      return;
    }
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method) {
        // These queries require no server-initiated actions. Explicitly refuse
        // unexpected requests instead of leaving an approval hanging.
        if (message.id != null) write({ id: message.id, error: { code: -32601, message: 'Read-only client' } });
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error('Codex could not provide this information. Check CLI login and account support.'));
      else entry.resolve(message.result);
    }
  });
  // Bound the whole transaction, including initialization and pagination.
  const deadline = setTimeout(() => {
    fail(new Error('Codex account query timed out.'));
    child.kill('SIGTERM');
  }, timeoutMs);
  try {
    await request('initialize', { clientInfo: { name: 'matron_bridge', version: '1.0.0' } });
    write({ method: 'initialized', params: {} });
    return await callback(request);
  } finally {
    clearTimeout(deadline);
    fail(new Error('Codex account query closed.'));
    child.stdin.end();
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    killTimer.unref?.();
    child.once('close', () => clearTimeout(killTimer));
  }
}

export function codexLimitLines(response) {
  const buckets = response?.rateLimitsByLimitId;
  const entries = buckets && Object.keys(buckets).length
    ? Object.entries(buckets)
    : response?.rateLimits ? [[response.rateLimits.limitId || 'codex', response.rateLimits]] : [];
  const lines = [];
  for (const [id, bucket] of entries) {
    for (const name of ['primary', 'secondary']) {
      const window = bucket?.[name];
      if (!Number.isFinite(window?.usedPercent)) continue;
      const minutes = window.windowDurationMins;
      const label = minutes === 10080 ? 'Weekly' : minutes > 0
        ? (minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`)
        : (name === 'primary' ? 'Primary' : 'Secondary');
      const line = {
        id: `codex:${id}:${name}`,
        label: `${bucket.limitName || (id === 'codex' ? 'Codex' : id)} · ${label}`,
        // Matron's Apple/Android wire models use integer percentages.
        percent: Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      };
      const reset = Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : null;
      if (reset && Number.isFinite(reset.getTime())) {
        line.resets_at = reset.toISOString();
        line.resets = reset.toLocaleString([], { timeZoneName: 'short' });
      }
      lines.push(line);
    }
  }
  return lines;
}

export function codexModelOptions(models = []) {
  return models.filter(m => !m.hidden && typeof m.model === 'string' && m.model)
    .map(m => ({ value: m.model, label: m.displayName || m.model }));
}

export function codexEffortOptions(models = [], model) {
  const selected = models.find(m => m.model === model);
  return (selected?.supportedReasoningEfforts || [])
    .filter(e => typeof e.reasoningEffort === 'string' && e.reasoningEffort)
    .map(e => ({ value: e.reasoningEffort, label: e.reasoningEffort }));
}

export function codexSessionOptions(session) {
  const metadata = session._codexMetadata || {};
  const model = session.codex?.model || session._codexObservedModel || metadata.model || metadata.models?.find(m => m.isDefault)?.model || null;
  const effort = session.codex?.effort || session._codexObservedEffort || metadata.effort || null;
  return {
    model, effort,
    modelOptions: [...codexModelOptions(metadata.models), { value: 'default', label: 'Config default' }],
    effortLevels: [...codexEffortOptions(metadata.models, model), { value: 'default', label: 'Config default' }],
  };
}

export function createCodexAccountReader({ query = withCodexAppServer, ttlMs = 60_000, now = Date.now } = {}) {
  const cache = new Map();
  return {
    async read(cwd, { force = false } = {}) {
      let entry = cache.get(cwd);
      if (entry?.inflight) return entry.inflight;
      if (!force && entry && now() - entry.at < ttlMs) return entry.value;
      if (!entry) {
        // Bound inactive workdir entries on long-lived bridges.
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        entry = { at: 0, value: null };
        cache.set(cwd, entry);
      }
      entry.inflight = query(async request => {
        const modelsPromise = (async () => {
          const models = [];
          let cursor;
          const seen = new Set();
          do {
            const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
            models.push(...(page.data || []));
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error('Codex model pagination repeated a cursor.');
            seen.add(cursor);
            if (seen.size > 100) throw new Error('Codex model list exceeded the page limit.');
          } while (cursor);
          return models;
        })();
        const [models, config, limits] = await Promise.allSettled([
          modelsPromise, request('config/read', { cwd, includeLayers: false }), request('account/rateLimits/read'),
        ]);
        // Copy only display fields. Effective config can contain secrets.
        return {
          models: models.status === 'fulfilled' ? models.value : [],
          model: config.status === 'fulfilled' ? config.value?.config?.model || null : null,
          effort: config.status === 'fulfilled' ? config.value?.config?.model_reasoning_effort || null : null,
          limits: limits.status === 'fulfilled' ? codexLimitLines(limits.value) : [],
          modelsError: models.status === 'rejected' ? models.reason.message : null,
          limitsError: limits.status === 'rejected' ? limits.reason.message : null,
        };
      }, { cwd }).catch(() => ({
        models: [], model: null, effort: null, limits: [],
        modelsError: 'Codex app server is unavailable. Check the installed CLI and login.',
        limitsError: 'Codex app server is unavailable. Check the installed CLI and login.',
      })).then(value => {
        entry.value = value;
        entry.at = now();
        return value;
      }).finally(() => { entry.inflight = null; });
      return entry.inflight;
    },
  };
}
