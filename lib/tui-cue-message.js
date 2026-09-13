// Turning a settled free-text TUI screen into the message(s) the user sees.
//
// Lives here rather than in index.js because the rules below were each
// bought with a live-test failure and need to stay under test: see
// test/tui-cue-message.test.js.
import {
  compactScreenText,
  AUTO_ENTER_COMPACT_RE,
  LOGIN_SUCCESS_COMPACT_RE,
} from './prompt-detector.js';

function escapeHtml(text) {
  // &quot; matters because escapeHtml output is interpolated into HTML
  // attributes (href="...") as well as element content.
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Undo the letter-spacing stripAnsi leaves on shimmer-animated TUI lines
// ("L o g i n   s u c c e s s f u l .") for display. Only rewrites lines that
// are mostly single-character tokens; normal prose is untouched. Runs of 2+
// spaces are word gaps, single spaces are letter gaps.
export function despaceTuiLine(line) {
  const trimmed = String(line || '').trim();
  const toks = trimmed.split(/\s+/);
  if (toks.length < 6) return trimmed;
  const singles = toks.filter(t => t.length === 1).length;
  if (singles / toks.length <= 0.6) return trimmed;
  return trimmed.split(/ {2,}/).map(word => word.replace(/ /g, '')).join(' ');
}

// Build a clean, purpose-built Matrix message from a settled free-text
// TUI screen instead of dumping the raw PTY content. Each cue type
// (OAuth flow, press-enter ack, etc) gets its own formatter so the user
// sees a focused message — no separator bars, status chrome, OSC title
// leaks, spinner ticks, task lists, etc. Returns null when nothing
// useful can be extracted (caller should not send anything in that
// case rather than dumping the raw screen).
export function formatTuiCueMessage(screen, urls, { hasNewUrls = true } = {}) {
  // All cue matching runs on the compact form (lowercased, whitespace and
  // apostrophes removed): the TUI shimmer-animates some of these lines with
  // per-character escapes, which stripAnsi renders letter-spaced ("P r e s s
  // E n t e r …") — word-spaced regexes never match those. See
  // compactScreenText in lib/prompt-detector.js.
  const compact = compactScreenText(screen);
  // Press-Enter acknowledgment (e.g. post-login "Login successful.
  // Press Enter to continue…") — checked BEFORE the OAuth branch: the
  // success screen still carries the wizard's "use the url below" text and
  // the OAuth URL in the scrollback above it, and oauth-first ordering
  // re-rendered a "sign in" card at the exact moment login succeeded
  // (live-test round 5's post-paste duplicate). The press-enter cue is the
  // actionable state; older wizard text above it is history.
  //
  // Result line: JUST ABOVE the cue line, and only on the strict
  // login-result tokens. The tail also contains the resumed session's
  // repainted chat transcript, and a whole-screen search with loose words
  // ("complete", "finished") kept matching the USER'S OWN old messages —
  // surfacing a random fragment of prior conversation as a "✅ …" card
  // (live-test rounds 1 and 2).
  if (AUTO_ENTER_COMPACT_RE.test(compact)) {
    const lines = screen.split('\n').map(l => l.trim()).filter(Boolean);
    const cueIdx = lines.findIndex(l => AUTO_ENTER_COMPACT_RE.test(compactScreenText(l)));
    const nearby = cueIdx >= 0 ? lines.slice(Math.max(0, cueIdx - 4), cueIdx + 1) : [];
    const resultLine =
      nearby.find(l => LOGIN_SUCCESS_COMPACT_RE.test(compactScreenText(l))) ||
      'Claude is continuing…';
    const display = despaceTuiLine(resultLine);
    const plain = `✅ ${display}`;
    const html = `<b>✅ ${escapeHtml(display)}</b>`;
    return { plain, html };
  }
  // OAuth / "open this URL to sign in" flow. Triggered by /login.
  // Screen layout: "Browser didn't open? Use the url below to sign in
  // (c to copy)" + URL + "Paste code here if prompted >".
  // Gated on hasNewUrls: the card's entire content is the URL, so a
  // re-render where every URL was already surfaced can only ever be a
  // duplicate of a card the user already has.
  const isOauth = /browserdidntopen|usetheurl|copytheurl|pastecodehere/.test(compact);
  if (isOauth && urls.length > 0 && hasNewUrls) {
    return { parts: urlCueParts(
      '🔗 Claude needs you to sign in.\n\nOpen this URL in your browser:',
      `<b>🔗 Claude needs you to sign in.</b><br/><br/>Open this URL in your browser:`,
      urls.slice(0, 1),
      'After authorising, paste the code (the long string after `#` in the callback URL) back here.',
      `After authorising, paste the code (the long string after <code>#</code> in the callback URL) back here.`,
    ) };
  }
  // Generic input cue we couldn't parse — surface a one-liner pointing
  // at the cue with any URLs, but don't dump the whole screen. Same
  // hasNewUrls gate as the OAuth card: all-stale URLs = duplicate.
  if (urls.length > 0 && hasNewUrls) {
    return { parts: urlCueParts(
      'Claude is asking you to act on this URL:',
      `<b>Claude is asking you to act on this URL:</b>`,
      urls,
    ) };
  }
  return null;
}

// A URL the user has to act on gets a message of its OWN, with the prose
// around it split off into separate messages. Long-pressing a chat bubble
// on iOS copies the WHOLE bubble, so a URL sharing a bubble with prose
// can't be copied cleanly — you get the surrounding sentences too and have
// to hand-trim a 400-character OAuth URL on a phone keyboard. One bubble
// per URL makes "copy message" yield exactly the URL.
export function urlCueParts(leadPlain, leadHtml, urls, tailPlain = null, tailHtml = null) {
  const parts = [{ plain: leadPlain, html: leadHtml }];
  for (const u of urls) {
    // Plain body is the bare URL and nothing else — that is what a copy
    // of this message yields.
    parts.push({ plain: u, html: `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>` });
  }
  if (tailPlain) parts.push({ plain: tailPlain, html: tailHtml });
  return parts;
}
