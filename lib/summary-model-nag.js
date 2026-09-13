// A bridge with neither OPENAI_API_KEY nor GEMINI_API_KEY has no summary
// model (lib/summary-model.js returns null), and maybeUpdatePinnedSummary
// returns immediately. Three things quietly stop working: conversations are
// named by their first user message instead of a written title, the roster
// summary other agents read stays empty, and no summary TOC events are ever
// published. Nothing surfaces that — a fleet survey on 2026-09-10 found ten
// of eleven boxes silently in this state, which is why the feature looked
// unused rather than unconfigured.
//
// So say it where Dan will actually see it: file one tracker task per box.
//
// Deduping is the journal's, not ours. POST /items namespaces the
// Idempotency-Key by device (items-http.js `idemKeyOf`) and enforces
// UNIQUE(user_id, idem_key), so the fixed key below collapses every reboot
// of every process on this box into the same single item — including after
// the user has closed it, which is the point. The in-process latch just
// saves the redundant round trips within one run.

const IDEM_KEY = 'no-summary-model';

function bodyFor(box) {
  const where = box ? `\`${box}\`` : 'this box';
  return [
    `This bridge has no summary model configured, so three things are off on ${where}:`,
    '',
    '- conversations are titled from their first user message, not a written title',
    '- the roster summary other agents read stays empty',
    '- no summary events are published',
    '',
    'Fix: set `OPENAI_API_KEY` (or `GEMINI_API_KEY`) in the bridge `.env` and restart it — `.env` is only read at boot.',
  ].join('\n');
}

// `client` is lib/items-client.js (or null when the journal is not
// configured at all, in which case there is nowhere to file anything).
export function createSummaryModelNag({ client, box, log = () => {} }) {
  let filed = false;

  return {
    // Call whenever a turn ends on a bridge with no summary model. Needs a
    // convo id because every item is created against one; the first turn on
    // this box provides it. Never throws and never rejects: the turn that
    // triggered this must not care whether it worked.
    async maybeFile(convoId) {
      if (filed || !client || !convoId) return;
      try {
        const res = await client.create(
          {
            kind: 'task',
            title: `No summary model on ${box || 'this box'} — titles and summaries are off`,
            body: bodyFor(box),
            awaiting: 'user',
            convo_id: convoId,
          },
          { idemKey: IDEM_KEY },
        );
        // 201 filed it, 200 is the idempotent replay of one already filed.
        // Anything else (including status 0, "journal unreachable", which is
        // what a bridge that started before its tunnel settled sees) leaves
        // the latch open so the next turn tries again.
        if (res && (res.status === 200 || res.status === 201)) {
          filed = true;
          log(`summary-model nag filed (item #${res?.data?.item?.num ?? '?'})`);
        }
      } catch {
        // Same stance as every other journal touch here: fail open.
      }
    },
  };
}
