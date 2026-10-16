// Compact rendering of the journal's GET /search/all response (spec
// 2026-10-12 unified search) for the `search` MCP tool. Pure and defensive,
// like lib/missions-format.js: a journal a version ahead, or a chats row
// missing a field, degrades to a duller line, never throws.

const str = (v) => (typeof v === 'string' ? v : '');
// Collapse runs of whitespace (a title or snippet should never carry a
// newline into a one-line tool result) to a single space, then trim.
const collapse = (v) => str(v).replace(/\s+/g, ' ').trim();

const SNIPPET_MAX = 160;

// Cut a snippet to at most SNIPPET_MAX code points — Array.from splits on
// code points, not UTF-16 units, so a surrogate pair is never torn in
// half — append `…` only when it was actually cut, and drop a dangling
// `**` the cut left unmatched: the journal wraps matches in `**…**`, and a
// cut mid-match would otherwise ship a stray opening marker with no close.
function truncateSnippet(text) {
  const codePoints = Array.from(text);
  if (codePoints.length <= SNIPPET_MAX) return text;
  let cut = codePoints.slice(0, SNIPPET_MAX).join('');
  if ((cut.match(/\*\*/g) || []).length % 2 !== 0) {
    const idx = cut.lastIndexOf('**');
    cut = cut.slice(0, idx) + cut.slice(idx + 2);
  }
  return `${cut}…`;
}

// One tracker result, best match first. `why` is one of exact/words/
// stemmed/similar/some_words — the journal's own rank order, so the label
// is shown verbatim rather than re-worded.
function label(r) {
  const ref = r.kind === 'memory' ? `memory ${str(r.name)}` : `${str(r.kind) || 'result'} #${r.num ?? '?'}`;
  const meta = [str(r.state) || null, r.mission_num ? `mission #${r.mission_num}` : null].filter(Boolean).join(', ');
  const title = collapse(r.title);
  const snippet = collapse(r.snippet);
  return `[${str(r.why) || '?'}] ${ref}${meta ? ` (${meta})` : ''} ${title}${snippet ? ` — ${truncateSnippet(snippet)}` : ''}`;
}

// One chats row (same shape as GET /search mode=chats). `top` and
// `mission_num` are both optional on the wire — a row with neither must
// still render a usable line, not throw.
function chatLine(c) {
  const mission = c?.mission_num ? `mission #${c.mission_num}, ` : '';
  const seq = Number.isInteger(c?.top?.seq) ? ` seq ${c.top.seq}` : '';
  const title = collapse(c?.title) || '(untitled)';
  return `- ${title} (${mission}${Number(c?.count) || 0} matches) convo ${str(c?.convo_id) || '?'}${seq}`;
}

export function formatSearchAll({ results = [], chats = [], semantic } = {}) {
  const rows = Array.isArray(results) ? results : [];
  const chatRows = Array.isArray(chats) ? chats : [];
  const lines = rows.length || chatRows.length
    ? rows.map(label)
    : ['No match. Describe it differently, or put an exact name or number in quotes.'];
  if (chatRows.length) {
    lines.push('', 'Chats:');
    for (const c of chatRows) lines.push(chatLine(c));
  }
  if (semantic === 'off') lines.push('', '(meaning-based matching is off on this journal; only word matches are shown)');
  if (semantic === 'indexing') lines.push('', '(meaning-based matching is still indexing; results may be incomplete)');
  return lines.join('\n');
}
