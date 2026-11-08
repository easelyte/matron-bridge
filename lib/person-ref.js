// A person, as the tools name one: a user's name on this journal ("bob"),
// or the address of a user on another Matron journal ("bob@b.example",
// journal federation). The address grammar is the journal's own
// (matron-journal src/federation-envelope.js), so a name the bridge lets
// through is one the journal can read.
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = `(?=.{1,253}(?::\\d{1,5})?$)${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?`;
export const NAME_RE = new RegExp(`^${NAME}$`);
const ADDRESS_RE = new RegExp(`^${NAME}@${HOST}$`);
// Longest a name or address can be: 64 + '@' + 253 + ':65535'.
export const PERSON_MAX = 324;

// The trimmed person, its host lower-cased (hosts are case-blind), or null.
export function personRef(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (NAME_RE.test(s)) return s;
  const at = s.indexOf('@');
  if (at < 1) return null;
  const addr = `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
  return ADDRESS_RE.test(addr) ? addr : null;
}

export const isAddress = (p) => typeof p === 'string' && p.includes('@');
