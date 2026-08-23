// The one place the bridge words a queue flush announcement.
//
// Four call sites announce a flush, and they had drifted: the turn-end flush
// (index.js flushPendingSessionQueue), the typed `send` magic word and the
// journal card tap (lib/busy-queue.js), and the /interrupt HTTP endpoint
// (index.js). Each built the same sentence by hand from the same parts, so
// #218 — which added the missing echo to the card-tap path — had to hand-copy
// the string a fourth time to keep them in step. Two of the four (turn-end,
// HTTP) live inside index.js and were therefore never string-asserted at all;
// pulling the wording here is what makes them testable.
//
// The two styles are NOT cosmetic variants of one another, so they stay as
// data rather than a boolean:
//
//   turnEnd — the flush the user did not ask for. It happens because the turn
//             ended, so it reads as a report: "📬 Sending 3 queued messages:".
//   sendNow — the flush the user explicitly triggered (magic word, card tap,
//             HTTP). It reads as an acknowledgement of that action, hence the
//             ⚡ and the trailing "now".
//
// deferredNoun is a wording difference the two styles already had before this
// module existed ("the other 2 queued messages" at turn end vs "the other 2
// messages" for an explicit send). It is preserved verbatim rather than
// silently normalised — this module was extracted to STOP the strings moving,
// so it may not move them on the way out. Unifying them is a one-line change
// here whenever that is wanted, and the golden tests will show it.
const STYLES = {
  turnEnd: {
    sigil: '📬',
    suffix: '',
    compactHead: 'Sending /compact first',
    deferredNoun: 'queued message',
  },
  sendNow: {
    sigil: '⚡',
    suffix: ' now',
    compactHead: 'Sending /compact now',
    deferredNoun: 'message',
  },
};

function plural(count, noun) {
  return `${count} ${noun}${count > 1 ? 's' : ''}`;
}

// Returns { plain, html } for a flush announcement. Callers that have no HTML
// channel (the journal tap posts plain notices) just read .plain.
//
// A compact split takes precedence over the batch echo, at every call site:
// when a leading /compact goes out alone, saying WHY the rest were held back
// matters more than listing what went — otherwise the held messages read as
// swallowed. That precedence is encoded here so a call site cannot get it
// wrong, which is the same order all four had independently.
//
// `summary` is the { plain, html } from index.js formatQueueSummary and is
// only read on the non-deferred branch; deferred announcements list nothing.
//
// `remaining` is the "send just this one" tail: that flush sends ONE message
// and deliberately leaves the rest queued with their cards live. It is NOT the
// same fact as `deferred` — deferred means "held back by a compact split and
// will go out automatically once compaction finishes", whereas these stay put
// until something else releases them — so it gets its own wording rather than
// reusing that noun. Every other call site leaves it at 0 and is unaffected.
export function queueFlushNotice(style, { queued = 0, deferred = 0, summary = null, remaining = 0 } = {}) {
  const s = STYLES[style];
  if (!s) throw new Error(`queueFlushNotice: unknown style ${JSON.stringify(style)}`);

  if (deferred > 0) {
    const tail = `— the other ${plural(deferred, s.deferredNoun)} will be sent once compaction finishes.`;
    return {
      plain: `${s.sigil} ${s.compactHead} ${tail}`,
      html: `<b>${s.sigil} ${s.compactHead}</b> ${tail}`,
    };
  }

  const head = `${s.sigil} Sending ${plural(queued, 'queued message')}${s.suffix}:`;
  // Without this the user sees "Sending 1 queued message now" and no sign that
  // the others are still waiting, which reads as though they were dropped.
  const held = remaining > 0
    ? `— the other ${plural(remaining, s.deferredNoun)} ${remaining > 1 ? 'stay' : 'stays'} queued.`
    : '';
  return {
    plain: `${head}\n${summary?.plain ?? ''}${held ? `\n${held}` : ''}`,
    html: `<b>${head}</b>${summary?.html ?? ''}${held ? ` ${held}` : ''}`,
  };
}
