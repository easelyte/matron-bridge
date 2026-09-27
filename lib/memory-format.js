// Compact renderings of the journal's memory JSON for the memory_* MCP
// tools (spec: 2026-09-27 memories, "Bridge"). Pure and dependency-free so
// ask-user.js stays a thin fetch + render shell, in the items-format.js
// spirit: one line per fact, never raw JSON, and defensive about shape — a
// journal a version ahead must degrade to a duller line, never throw.

const str = (v) => (typeof v === 'string' ? v : '');

const isoTime = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 'unknown time';
  try { return new Date(n).toISOString(); } catch { return 'unknown time'; }
};

export function memoryLine(m) {
  if (!m || typeof m !== 'object') return '(unknown memory)';
  const name = str(m.name) || '(unnamed)';
  const type = str(m.type) || 'memory';
  const desc = str(m.description) || '(no description)';
  const by = str(m.updated_by);
  return `\`${name}\` (${type}): ${desc} — updated ${isoTime(m.updated_at)}${by ? ` by ${by}` : ''}`;
}

export function formatMemoryList(data) {
  const memories = Array.isArray(data?.memories) ? data.memories : [];
  if (!memories.length) return '(no memories yet)';
  return memories.map(memoryLine).join('\n');
}

export function formatMemoryDetail(data) {
  const m = data?.memory;
  if (!m || typeof m !== 'object') return '(unknown memory)';
  const lines = [
    `name: ${str(m.name) || '(unnamed)'}`,
    `type: ${str(m.type) || 'memory'}`,
    `description: ${str(m.description) || '(none)'}`,
    `created ${isoTime(m.created_at)} by ${str(m.created_by) || 'unknown'}; updated ${isoTime(m.updated_at)} by ${str(m.updated_by) || 'unknown'}`,
  ];
  if (m.origin_convo_id) lines.push(`origin conversation: ${str(m.origin_convo_id)}`);
  lines.push('', str(m.body) || '(no body)');
  return lines.join('\n');
}

export function formatSaveAck(data) {
  const m = data?.memory;
  if (!m || typeof m !== 'object') return 'Saved memory';
  const what = data.created === true ? 'created' : data.created === false ? 'updated' : 'saved';
  return `Saved memory \`${str(m.name) || '(unnamed)'}\` (${what}): ${str(m.description) || ''}`.trimEnd();
}

export function formatDeleteAck(data) {
  const m = data?.memory;
  return `Deleted memory \`${(m && str(m.name)) || '(unnamed)'}\``;
}
