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

// A memory with no scope (an older journal) is global; one with no tier is
// always.
const scopeOf = (m) => str(m?.scope) || 'global';
const tierOf = (m) => (str(m?.tier) === 'on_demand' ? 'on demand' : 'always');
const tierText = (m) => `${tierOf(m)}${str(m?.topic) ? `, topic: ${str(m.topic)}` : ''}`;

export function memoryLine(m) {
  if (!m || typeof m !== 'object') return '(unknown memory)';
  const name = str(m.name) || '(unnamed)';
  const type = str(m.type) || 'memory';
  const desc = str(m.description) || '(no description)';
  const by = str(m.updated_by);
  return `\`${name}\` (${type}, ${scopeOf(m)}, ${tierText(m)}): ${desc} — updated ${isoTime(m.updated_at)}${by ? ` by ${by}` : ''}`;
}

// `scopes` (the audience listed) and `omitted` / `omitted_scopes` come from
// the bridge's filter (lib/memory-tools.js); a plain journal answer has
// neither and renders as the whole list.
export function formatMemoryList(data) {
  const memories = Array.isArray(data?.memories) ? data.memories : [];
  const omitted = Number.isInteger(data?.omitted) && data.omitted > 0 ? data.omitted : 0;
  const omittedScopes = Array.isArray(data?.omitted_scopes) ? data.omitted_scopes.filter((s) => typeof s === 'string' && s) : [];
  const tail = omitted
    ? `… ${omitted} more in other scopes${omittedScopes.length ? ` (${omittedScopes.join(', ')})` : ''} — memory_list with all: true lists them.`
    : '';
  if (!memories.length) return tail ? `(none in this session's scopes${Array.isArray(data?.scopes) ? `: ${data.scopes.join(', ')}` : ''})\n${tail}` : '(no memories yet)';
  const lines = memories.map(memoryLine);
  if (tail) lines.push(tail);
  return lines.join('\n');
}

export function formatMemoryDetail(data) {
  const m = data?.memory;
  if (!m || typeof m !== 'object') return '(unknown memory)';
  const lines = [
    `name: ${str(m.name) || '(unnamed)'}`,
    `type: ${str(m.type) || 'memory'}`,
    `scope: ${scopeOf(m)}`,
    `tier: ${tierText(m)}`,
    `description: ${str(m.description) || '(none)'}`,
    `created ${isoTime(m.created_at)} by ${str(m.created_by) || 'unknown'}; updated ${isoTime(m.updated_at)} by ${str(m.updated_by) || 'unknown'}`,
  ];
  if (m.origin_convo_id) lines.push(`origin conversation: ${str(m.origin_convo_id)}`);
  lines.push('', str(m.body) || '(no body)');
  return lines.join('\n');
}

// A save or delete the journal kept as a proposal (lib/memory-tools.js
// pendingAnswer): say plainly that nothing changed yet and what happens next.
export function formatPendingAck(data) {
  const name = str(data?.name) || '(unnamed)';
  const del = data?.action === 'delete';
  const item = Number.isInteger(data?.item_num) ? `item #${data.item_num}` : 'a tracker item';
  return [
    `NOT ${del ? 'deleted' : 'saved'} yet: memory \`${name}\` is a proposal waiting for the user's approval on ${item}.`,
    `A memory ${del ? 'delete' : 'save'} made outside a turn the user started themselves (and any made on some boxes) needs their OK. The user has been asked; nothing has changed${del ? ' and the memory still applies' : ''}.`,
    'Their answer will reach you as a later turn. Tell the user in one line that it is waiting for their approval, then carry on. Do not retry, and do not record the rule some other way instead.',
  ].join('\n');
}

// What the journal tells the proposing conversation when a proposal is
// settled (a `memory_proposal` event, sender `journal`), as a turn for the
// agent. Only the name travels, and a name is a slug; anything else is
// dropped rather than quoted. null for a payload that is not one.
const PROPOSAL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROPOSAL_OUTCOMES = new Set(['approved', 'declined', 'replaced', 'expired', 'stale']);
export function formatProposalOutcome(payload) {
  const p = payload && typeof payload === 'object' ? payload : null;
  if (!p || !PROPOSAL_NAME_RE.test(str(p.name))) return null;
  // Exactly a save or a delete: an event that does not say which is not
  // worded as either, and nothing is delivered.
  if (p.action !== 'save' && p.action !== 'delete') return null;
  if (!PROPOSAL_OUTCOMES.has(p.outcome)) return null;
  const del = p.action === 'delete';
  const item = Number.isInteger(p.item?.num) ? ` (item #${p.item.num})` : '';
  const head = `[Matron: memory proposal${item}]`;
  switch (p.outcome) {
    case 'approved': return `${head} The user approved it: memory \`${p.name}\` is now ${del ? 'deleted' : 'saved'}.`;
    case 'declined': return `${head} The user declined it: memory \`${p.name}\` was not ${del ? 'deleted' : 'saved'}. Do not propose it again unless they ask.`;
    case 'replaced': return `${head} A newer proposal for memory \`${p.name}\` took its place; this one was set aside and nothing changed.`;
    case 'expired': return `${head} Nobody answered within 7 days: memory \`${p.name}\` was not ${del ? 'deleted' : 'saved'}.`;
    case 'stale': return `${head} The user approved it, but memory \`${p.name}\` had changed since you proposed, so nothing was ${del ? 'deleted' : 'saved'}. Read it again with memory_get and, if the change is still wanted, propose it once more.`;
    default: return null;
  }
}

export function formatSaveAck(data) {
  if (data?.pending === true) return formatPendingAck(data);
  const m = data?.memory;
  if (!m || typeof m !== 'object') return 'Saved memory';
  const what = data.created === true ? 'created' : data.created === false ? 'updated' : 'saved';
  const line = `Saved memory \`${str(m.name) || '(unnamed)'}\` (${what}, scope ${scopeOf(m)}, ${tierText(m)}): ${str(m.description) || ''}`.trimEnd();
  return line;
}

// A recalled memory, whole, for the agent to read. The body is cut at
// `bodyMax` characters with a pointer to memory_get.
function recalledMemory(m, bodyMax) {
  const name = str(m.name) || '(unnamed)';
  const head = `### \`${name}\` (${scopeOf(m)}, ${tierText(m)})\n${str(m.description) || '(no description)'}`;
  const body = str(m.body).trim();
  if (!body) return head;
  return `${head}\n\n${body.length > bodyMax ? `${body.slice(0, bodyMax).trimEnd()}\n… (cut; memory_get ${name} for the rest)` : body}`;
}

// The `recall` tool's answer.
export function formatRecall(data) {
  const memories = Array.isArray(data?.memories) ? data.memories.filter((m) => m && typeof m === 'object') : [];
  if (!memories.length) {
    return 'No memory matched. Try other words, or memory_list to see every memory in this session\'s scopes.';
  }
  return memories.map((m) => recalledMemory(m, 4000)).join('\n\n');
}

// What the memory-recall hook adds to a Claude turn (additionalContext):
// the on-demand rules that matched the message, for the agent to apply.
// '' when nothing matched, so the hook adds nothing.
export function formatRecallContext(data) {
  const memories = Array.isArray(data?.memories) ? data.memories.filter((m) => m && typeof m === 'object' && str(m.name)) : [];
  if (!memories.length) return '';
  return [
    '[Matron: memories that may bear on this message]',
    'These on-demand memories (the user\'s standing rules) matched what this message is about. Follow them where they apply; ignore any that turn out not to.',
    '',
    memories.map((m) => recalledMemory(m, 1500)).join('\n\n'),
  ].join('\n');
}

export function formatDeleteAck(data) {
  if (data?.pending === true) return formatPendingAck(data);
  const m = data?.memory;
  return `Deleted memory \`${(m && str(m.name)) || '(unnamed)'}\``;
}
