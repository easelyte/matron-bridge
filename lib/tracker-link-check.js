// Checks the tracker links an agent writes against what they point at.
//
// Agents link the wrong tracker record often, and almost always the number
// is a real one: it is just someone else's. A check that the number exists
// misses that, so every link carries the title the agent means, written
// next to the number:
//
//   [#12 Merge: release notes export…](https://chat.example/u/alice/12)
//
// Before a write leaves the bridge (an item, a comment, a milestone, a
// mission status, a room message), each such link is resolved through the
// journal's GET /lookup, and the written title is compared with the real
// one. A mismatch refuses the whole write, naming what the number really is
// and, when the journal's search finds it, the number the written title
// belongs to. A link with no title is refused too: without one there is
// nothing to check, and the refusal does not say what the number is, so it
// cannot be fixed by copying the title back without checking.
//
// The check is there to catch mistakes, not to stand between an agent and
// the journal: when the journal cannot be asked, or answers without a
// title, the write goes through.

const LINK_RE = /(!?)\[([^\]\n]{0,400})\]\(\s*<?([^()\s<>]+)>?\s*\)/g;
const MATRON_ITEM_RE = /^matron:\/\/(?:item|mission|project)\/([1-9]\d{0,14})$/;
const NAME_RE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
// "#12 Title", "item #12: Title", "**#12** — Title"
const TEXT_RE = /^(?:(?:item|mission|milestone|project|question|task|decision|notice)\s+)?#([1-9]\d{0,14})(?![\p{L}\p{N}])(.*)$/iu;
// More distinct tracker links than this in one write are refused rather than
// checked in part.
const MAX_LINKS = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKUP_CONCURRENCY = 8;
const CACHE_MAX = 500;

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'on', 'in', 'at', 'by', 'with', 'from', 'is', 'it', 'this', 'that', 'item', 'one', 'new']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The written title: emphasis, quotes and the separator after the number
// stripped.
function cleanTitle(s) {
  return s
    .replace(/[*_`~]+/g, ' ')
    .trim()
    .replace(/^[\s:–—\-·|,.(]+/u, '')
    .replace(/[)]+$/u, '')
    .trim()
    .replace(/^["'“‘«]+|["'”’»]+$/gu, '')
    .trim();
}

// The links in one text that point into the tracker. `base` is the
// session's own `<journal>/u/<name>` (lib/tracker-links.js), or null when
// the https form is not known: then only matron:// links are found,
// and they cannot be read (no user name), so they are skipped.
// Code is quoted, not linked: an agent showing the link form in a code span
// or a fenced block is not pointing at anything.
function withoutCode(text) {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/(`+)[^`\n]*?\1/g, '');
}

export function findTrackerLinks(text, { base } = {}) {
  if (typeof text !== 'string' || !text) return [];
  text = withoutCode(text);
  let prefix = null;
  let ownUser = null;
  if (typeof base === 'string' && base.includes('/u/')) {
    const at = base.lastIndexOf('/u/');
    prefix = base.slice(0, at);
    ownUser = base.slice(at + 3);
  }
  const httpsRe = prefix ? new RegExp(`^${escapeRe(prefix)}/u/(${NAME_RE})/([1-9]\\d{0,14})/?$`) : null;
  const out = [];
  for (const m of text.matchAll(LINK_RE)) {
    if (m[1]) continue; // an image
    const url = m[3];
    let user = null;
    let num = null;
    const mi = url.match(MATRON_ITEM_RE);
    if (mi) {
      user = ownUser;
      num = Number(mi[1]);
    } else if (httpsRe) {
      const mh = url.match(httpsRe);
      if (mh) { user = mh[1]; num = Number(mh[2]); }
    }
    if (!num) continue;
    const linkText = m[2].replace(/[*_`~]+/g, ' ').trim();
    // Link text that is a URL names no title: a bare link.
    if (/^[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(m[2].trim())) {
      out.push({ raw: m[0], user, num, textNum: null, title: '' });
      continue;
    }
    const mt = linkText.match(TEXT_RE);
    out.push({
      raw: m[0],
      user,
      num,
      textNum: mt ? Number(mt[1]) : null,
      title: cleanTitle(mt ? mt[2] : linkText),
    });
  }
  return out;
}

function tokens(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/(\.\.\.|…)\s*$/u, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function sameWord(a, b) {
  if (a === b) return true;
  // A stem or a cut-off word: "order"/"orders", "export"/"exp".
  return Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
}

// Does the title an agent wrote name this record? Generous on purpose: an
// abbreviation, a prefix or a paraphrase that keeps most of the title's
// words all pass. What fails is a title that is about something else.
export function titleMatches(written, actual) {
  const w = tokens(written);
  const a = tokens(actual);
  if (!w.length || !a.length) return false;
  // A prefix of the title, the last word possibly cut short.
  if (w.length <= a.length && w.every((t, i) => t === a[i] || (i === w.length - 1 && a[i].startsWith(t)))) return true;
  // Most of the written words appear in the title.
  const content = w.filter((t) => !STOPWORDS.has(t));
  const words = content.length ? content : w;
  const hits = words.filter((t) => a.some((x) => sameWord(t, x))).length;
  return hits >= Math.min(2, words.length) && hits / words.length >= 0.6;
}

const kindLabel = (k) => (typeof k === 'string' && k ? k : 'record');
const quote = (s) => `"${String(s).replace(/\s+/g, ' ').trim()}"`;

// lookup(user, num) -> {status, data:{kind, num, title}} (GET /lookup)
// search(q) -> {status, data:{results:[{kind, num, title}]}} (GET /search/all)
// base() -> the session's own `<journal>/u/<name>`, or null
export function createTrackerLinkChecker({ lookup, search = null, base, now = () => Date.now() }) {
  const cache = new Map();

  async function resolve(user, num) {
    const key = `${user}/${num}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    let r;
    try { r = await lookup(user, num); } catch { r = { status: 0 }; }
    // A missing number is not kept: the record may be made a moment later
    // (an item_create, then a link to it). Unknown is never kept or refused.
    if (r?.status === 404) return { missing: true };
    if (!(r?.status === 200 && r.data && typeof r.data.title === 'string')) return null;
    const value = { kind: r.data.kind, title: r.data.title };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: now() + CACHE_TTL_MS });
    return value;
  }

  // The number the written title belongs to, from the user's own tracker.
  async function suggest(title, wrongNum) {
    if (typeof search !== 'function') return null;
    try {
      const r = await search(title);
      const results = Array.isArray(r?.data?.results) ? r.data.results : [];
      return results.find((x) => Number.isInteger(x?.num) && x.num !== wrongNum && typeof x.title === 'string' && titleMatches(title, x.title)) || null;
    } catch {
      return null;
    }
  }

  return async function check(texts) {
    const b = typeof base === 'function' ? base() : base;
    const links = [];
    for (const t of Array.isArray(texts) ? texts : [texts]) links.push(...findTrackerLinks(t, { base: b }));
    if (!links.length) return { ok: true };
    const distinct = new Set(links.map((l) => `${l.user}/${l.num}`)).size;
    if (distinct > MAX_LINKS) {
      return { ok: false, error: `Nothing was posted: this has ${distinct} different tracker links, more than the ${MAX_LINKS} that can be checked at once. Split it into smaller writes.` };
    }

    // Ask about each titled number once, a few at a time, before reading
    // the answers in order.
    const answers = new Map();
    const toAsk = [...new Set(links
      .filter((l) => l.user && l.title && (l.textNum === null || l.textNum === l.num))
      .map((l) => `${l.user}/${l.num}`))];
    for (let i = 0; i < toAsk.length; i += LOOKUP_CONCURRENCY) {
      await Promise.all(toAsk.slice(i, i + LOOKUP_CONCURRENCY).map(async (key) => {
        const at = key.lastIndexOf('/');
        answers.set(key, await resolve(key.slice(0, at), Number(key.slice(at + 1))));
      }));
    }

    const problems = [];
    const seen = new Set();
    for (const l of links) {
      if (!l.user) continue;
      const key = `${l.user}/${l.num}/${l.textNum}/${l.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (l.textNum !== null && l.textNum !== l.num) {
        problems.push(`- ${l.raw}: the text says #${l.textNum} but the link goes to #${l.num}.`);
        continue;
      }
      if (!l.title) {
        problems.push(`- ${l.raw} has no title. Write the title of the record you mean next to its number, as [#${l.num} <title>](…), so it can be checked.`);
        continue;
      }
      const target = answers.get(`${l.user}/${l.num}`);
      if (!target) continue;
      if (target.missing) {
        problems.push(`- ${l.raw}: #${l.num} does not exist, or this session cannot see it.${l.user === ownName(b) ? await suggestion(l) : ''}`);
        continue;
      }
      if (titleMatches(l.title, target.title)) continue;
      problems.push(`- ${l.raw}: #${l.num} is the ${kindLabel(target.kind)} ${quote(target.title)}, not ${quote(l.title)}.${l.user === ownName(b) ? await suggestion(l) : ''}`);
    }
    if (!problems.length) return { ok: true };
    return {
      ok: false,
      error: [
        'Nothing was posted: a tracker link does not match what it points at.',
        ...problems,
        'Check each number (item_get, mission_get or search), fix the link, then call again. Every tracker link carries the title of what it points at: [#12 Title](…).',
      ].join('\n'),
    };

    async function suggestion(l) {
      const s = await suggest(l.title, l.num);
      return s ? ` ${quote(l.title)} is #${s.num} (${kindLabel(s.kind)} ${quote(s.title)}).` : '';
    }
  };
}

function ownName(base) {
  if (typeof base !== 'string' || !base.includes('/u/')) return null;
  return base.slice(base.lastIndexOf('/u/') + 3);
}

// Wraps a loopback route handler ({status, body} contract) so the link
// check runs before it. 422, with the reason as `error`: every tool's
// failure path shows `error` to the model as it stands.
export function withTrackerLinkCheck(check, handler, pick) {
  return async (data) => {
    let r;
    try { r = await check(pick(data || {})); } catch { r = { ok: true }; }
    if (r && r.ok === false) return { status: 422, body: { error: r.error, code: 'tracker_link_mismatch' } };
    return handler(data);
  };
}

// The loopback routes whose text the user reads, and the fields of each
// that are checked.
const fields = (...names) => (d) => names.map((n) => d?.[n]);
export const LINK_CHECK_FIELDS = Object.freeze({
  'items/create': fields('title', 'body'),
  'items/comment': fields('body'),
  'items/close': fields('comment'),
  'items/reopen': fields('comment'),
  'items/handover': fields('note'),
  'missions/start': fields('title', 'body'),
  'missions/create': fields('title', 'body'),
  'missions/post': fields('title', 'body'),
  'missions/update': fields('title', 'body'),
  'missions/status': fields('status'),
  'missions/close': fields('summary'),
  'sharing/shared_post': fields('title', 'body'),
  'sharing/shared_status': fields('status'),
  'sharing/shared_item_create': fields('title', 'body'),
  'sharing/shared_item_comment': fields('body'),
  'sharing/shared_item_close': fields('comment'),
  'sharing/shared_item_reopen': fields('comment'),
  'briefing/publish': fields('body'),
  'agent-chat-start': fields('message'),
  'agent-chat-send': fields('message'),
});
