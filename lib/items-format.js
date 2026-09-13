// Compact renderings of the journal's item JSON for the item_* MCP tools
// (spec: 2026-09-08 task-decision-tracker, "Agent tools"). Pure and
// dependency-free so ask-user.js stays a thin fetch + render shell and the
// wording is testable without a journal.
//
// The audience is a model reading a tool result, so every renderer is one
// line per fact, never raw JSON: an item is `#num title — state[, awaiting
// x][, resolution] (id …)`, which carries everything needed to act (the id
// for the next call, who is blocking) in the width of a sentence.
//
// Everything here is defensive about shape: a journal a version ahead (or
// behind) must degrade to a slightly duller line, never throw inside a tool
// handler where the failure would surface as an opaque `Error: …`.

const str = (v) => (typeof v === 'string' ? v : '');

export function itemLine(item) {
  if (!item || typeof item !== 'object') return '(unknown item)';
  const title = str(item.title) || '(untitled)';
  const bits = [str(item.state) || 'open'];
  if (item.awaiting) bits.push(`awaiting ${item.awaiting}`);
  if (item.resolution) bits.push(String(item.resolution));
  const id = str(item.id);
  return `#${item.num ?? '?'} ${title} — ${bits.join(', ')}${id ? ` (id ${id})` : ''}`;
}

export function formatItemList(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return '(none)';
  const lines = items.map(itemLine);
  // The cursor itself is deliberately not exposed as a tool argument — a
  // model that needs more should narrow, not paginate — but hiding the fact
  // that the page was cut would let it conclude "no other open questions".
  if (data.next_cursor) lines.push('(more items match — narrow the filters or raise limit)');
  return lines.join('\n');
}

const isoTime = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 'unknown time';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString();
};

// A status comment (close/reopen) usually carries no body — the change IS
// the content, and it lives in meta.
function statusText(meta) {
  const to = meta && typeof meta === 'object' ? meta.to : null;
  if (!to || typeof to !== 'object') return '(status change)';
  if (to.state === 'closed') return `(closed as ${to.resolution ?? 'closed'})`;
  if (to.state === 'open') return `(reopened${to.awaiting ? `, awaiting ${to.awaiting}` : ''})`;
  return '(status change)';
}

function attachmentLine(a) {
  const name = str(a?.name) || str(a?.blob_ref) || 'attachment';
  const mime = str(a?.mime) || 'unknown type';
  const transcript = str(a?.transcript);
  return `  · ${name} (${mime})${transcript ? ` — transcript: ${transcript}` : ''}`;
}

function commentLines(c) {
  const body = str(c?.body).trim();
  const text = body || (c?.kind === 'status' ? statusText(c.meta) : '(no text)');
  const lines = [`- [${str(c?.author) || 'unknown'}, ${isoTime(c?.created_at)}] ${text}`];
  for (const a of Array.isArray(c?.attachments) ? c.attachments : []) lines.push(attachmentLine(a));
  return lines;
}

export function formatItemDetail(data) {
  const lines = [itemLine(data?.item)];
  const body = str(data?.item?.body).trim();
  if (body) lines.push(body);
  lines.push('');
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  if (!comments.length) lines.push('(no comments)');
  else for (const c of comments) lines.push(...commentLines(c));
  return lines.join('\n');
}

// `awaiting` is the value the CALLER asked for (undefined = not requested);
// the comment response's item predates the separate awaiting PATCH, so it
// cannot be read off the body. When that PATCH failed the handler adds
// awaiting_error — report the failure rather than the requested value, or
// the model believes it handed the item over when it did not.
export function formatCommentAck(data, awaiting) {
  const item = data?.item;
  const head = item && typeof item === 'object'
    ? `Comment added to #${item.num ?? '?'} "${str(item.title) || 'untitled'}"`
    : 'Comment added.';
  if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'awaiting_error')) {
    return `${head} — but awaiting update failed: ${str(data.awaiting_error) || 'unknown error'}`;
  }
  if (awaiting === undefined) return head;
  return `${head} — awaiting now ${awaiting ?? 'nobody'}`;
}
