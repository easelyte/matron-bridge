// How agents link tracker records (items, missions, milestones, projects) in
// what they write for the user.
//
// The journal resolves a shareable https link, `<origin>/u/<user>/<num>`
// (GET /lookup, and the apps claim /u/* as app links), for every kind of
// record: the four share one per-user number sequence. That form is
// unambiguous across users — a colleague's shared item is
// `/u/<their name>/<their number>` — where the older `matron://item/<num>`
// is read against whoever is looking at it.
//
// The instruction files carry two placeholders, rendered when a session's
// prompt is built:
//
//   {{TRACKER_URL}}        the link prefix a number is appended to:
//                          `https://chat.example/u/alice`, or `matron://item`
//   {{TRACKER_LINK_RULE}}  one sentence stating the rule for that form
//
// The https form needs both the journal's public https origin and the user's
// journal name. When either is unknown — no journal, a ws:// journal URL, or
// GET /me not answered yet — everything renders in the old matron:// form,
// so nothing that worked before breaks.

// The journal's own rule for a user name (it is a URL path segment).
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const FALLBACK_TRACKER_URL = 'matron://item';

// `<origin>[/<path prefix>]/u/<name>`, or null when the https form cannot be
// built. Only an https base qualifies: a link the user taps must reach the
// journal from their phone, not from this box.
export function trackerUrlBase({ httpBase, userName } = {}) {
  if (typeof userName !== 'string' || !USERNAME_RE.test(userName)) return null;
  if (typeof httpBase !== 'string' || !httpBase) return null;
  let url;
  try {
    url = new URL(httpBase);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const prefix = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${prefix}/u/${userName}`;
}

// The link for one number: the https form when `base` is known, the old
// matron://item form otherwise. Callers pass only positive integers.
export function trackerLink(num, base = null) {
  return `${base || FALLBACK_TRACKER_URL}/${num}`;
}

function linkRule(base) {
  if (!base) {
    return 'Link items by number, with the title: `[#12 Ship the release notes](matron://item/12)`.';
  }
  const origin = base.slice(0, base.lastIndexOf('/u/'));
  return 'Items, missions, milestones and projects share one per-user number sequence and all link the same way, '
    + 'with the title of what it points at after the number: '
    + `\`[#12 Ship the release notes](${base}/12)\`. `
    + 'Take the number and the title from the record itself (the tool result that made it, item_get, mission_get or search), never from memory: '
    + 'the bridge looks up every link in what you write through its tools (items, comments, milestones, statuses, briefings, room messages) '
    + 'and refuses the whole write when the title does not match the number, or when a link has no title. '
    + 'A shortened title is fine. '
    + 'Numbers are per-user: a link to another user\'s shared item or mission uses their name and their number, '
    + `\`${origin}/u/<their name>/<their number>\`, never yours.`;
}

// Fill both placeholders in an instruction text. Anything that is not a
// string passes through untouched (an absent block stays absent).
export function renderTrackerLinks(text, base = null) {
  if (typeof text !== 'string') return text;
  return text
    .replaceAll('{{TRACKER_URL}}', base || FALLBACK_TRACKER_URL)
    .replaceAll('{{TRACKER_LINK_RULE}}', linkRule(base));
}
