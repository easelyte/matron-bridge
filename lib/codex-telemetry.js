import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_TAIL_BYTES = 512 * 1024;
const count = value => Number.isFinite(value) && value >= 0 ? value : null;

// Local rollouts supplement exec JSONL, which reports turn totals but no
// current context size. Treat this internal format as optional telemetry;
// missing/changed records never prevent execution or replace good readings.
export function parseCodexTelemetry(text) {
  const result = {};
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload;
    if (event.type === 'turn_context') {
      if (typeof payload?.model === 'string') result.model = payload.model;
      if (typeof payload?.effort === 'string') result.effort = payload.effort;
    }
    if (event.type !== 'event_msg' || payload?.type !== 'token_count' || !payload.info) continue;
    const info = payload.info;
    const total = info.total_token_usage;
    if (count(total?.input_tokens) !== null && count(total?.output_tokens) !== null) {
      result.usage = {
        input_tokens: total.input_tokens,
        output_tokens: total.output_tokens,
        cache_read: count(total.cached_input_tokens) ?? 0,
        reasoning_tokens: count(total.reasoning_output_tokens) ?? 0,
        cache_create: 0, cost_usd: 0,
      };
    }
    // Input already includes cached input. Never add cache_read again, and
    // never use the cumulative thread/turn total as the context footprint.
    const input = count(info.last_token_usage?.input_tokens);
    const window = count(info.model_context_window);
    if (input !== null && window > 0) result.context = { tokens: input, window };
  }
  return result;
}

export class CodexTelemetryReader {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
    this.codexHome = codexHome;
    this.files = new Map();
  }

  async read(threadId) {
    if (!UUID.test(threadId || '')) return {};
    try {
      let file = this.files.get(threadId);
      if (!file) {
        // Native filenames end in the exact UUID. No conversation contents or
        // credentials are searched, and descendants have different UUIDs.
        for (const folder of ['sessions', 'archived_sessions']) {
          const root = path.join(this.codexHome, folder);
          const names = await fs.readdir(root, { recursive: true }).catch(() => []);
          const name = names.find(n => n.endsWith(`-${threadId}.jsonl`));
          if (name) { file = path.join(root, name); break; }
        }
        if (!file) return {};
        if (this.files.size >= 1000) this.files.delete(this.files.keys().next().value);
        this.files.set(threadId, file);
      }
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        const length = Math.min(stat.size, MAX_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
        let text = buffer.subarray(0, bytesRead).toString('utf8');
        if (stat.size > length) text = text.slice(text.indexOf('\n') + 1);
        // An unfinished record belongs to a future poll.
        text = text.slice(0, text.lastIndexOf('\n') + 1);
        return parseCodexTelemetry(text);
      } finally { await handle.close(); }
    } catch {
      this.files.delete(threadId);
      return {};
    }
  }
}

export function codexUsageFor(session) {
  // Native totals cover the whole resumed thread, including CLI turns while
  // the bridge was down. Cached/reasoning counts are subsets of input/output.
  return session._codexNativeUsage || session.totalUsage;
}
