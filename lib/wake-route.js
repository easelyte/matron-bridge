// POST /wake on the loopback API: lets a scheduled job on the same machine
// wake ONE configured conversation with ONE configured, fixed text.
//
// `/send` accepts any text but only reaches a session that is alive, so a
// wake sent after the idle reaper has taken the session down is lost. This
// route delivers the way a timer firing does instead: find the session,
// resume it if it is not running, then route the text through the same
// path a typed message takes (a busy session queues it).
//
// The conversation and the text come from the bridge's environment
// (MATRON_WAKE_CONVO_ID, MATRON_WAKE_TEXT) and never from the request: the
// handler takes no input at all. With either unset the route is off.
//
// Coalescing: a scheduler that fires twice in quick succession (a retry, two
// overlapping jobs) must not stack copies of the same text into a session
// that has not got round to the first one. A wake within COALESCE_MS of the
// last accepted delivery, while that session is still busy or holding queued
// input, answers ok without delivering again; so does one arriving while a
// delivery is still in progress.

export const WAKE_COALESCE_MS = 30_000;

/**
 * Build the /wake handler.
 *
 * @param {object} deps
 * @param {string} [deps.convoId] conversation to wake (unset/empty = route off)
 * @param {string} [deps.text] exact text to deliver (unset/empty = route off)
 * @param {(convoId: string) => object|null} deps.findSession running session for the convo, if any
 * @param {(convoId: string) => object|null} deps.resumeConvo resume a stopped session; null when it cannot
 * @param {(session: object, text: string) => Promise<unknown>} deps.routeText deliver as a typed message would; resolves false when the session refused it
 * @param {(message: string, session: object|null) => void} deps.publishNotice visible notice in the conversation
 * @param {(session: object) => boolean} deps.isPending session is busy or still holds undelivered input
 * @param {() => number} [deps.now] clock, injectable for tests
 * @returns {() => Promise<{status: number, body: object}>}
 */
export function createWakeHandler({
  convoId,
  text,
  findSession,
  resumeConvo,
  routeText,
  publishNotice,
  isPending,
  now = Date.now,
}) {
  const configured = typeof convoId === 'string' && convoId.trim() !== ''
    && typeof text === 'string' && text.trim() !== '';
  let lastDeliveredAt = null;
  let inFlight = null;

  async function deliver() {
    let session = findSession(convoId);
    if (lastDeliveredAt !== null && now() - lastDeliveredAt < WAKE_COALESCE_MS
      && session && session.alive && isPending(session)) {
      return { status: 200, body: { ok: true, coalesced: true } };
    }

    let resumed = false;
    if (!session || !session.alive) {
      session = resumeConvo(convoId);
      resumed = !!session;
    }
    if (!session) {
      publishNotice(`⏰ Wake fired, but this conversation's session can't be found or resumed — "${text}" was not delivered.`, null);
      return { status: 503, body: { error: "the conversation's session can't be found or resumed" } };
    }

    // The delivery path skips the journal mirror (it assumes the client
    // already shows the message), so the chat's visible record is this notice.
    publishNotice(`⏰ Wake: "${text}"`, session);
    let accepted;
    try {
      accepted = await routeText(session, text);
    } catch (e) {
      publishNotice(`⚠️ Wake: "${text}" could not be delivered: ${e?.message ?? e}`, session);
      return { status: 500, body: { error: 'wake delivery failed' } };
    }
    if (accepted === false) {
      publishNotice(`⚠️ Wake: the session did not accept "${text}".`, session);
      return { status: 503, body: { error: 'the session did not accept the text' } };
    }
    // Recorded only once the text was accepted, so a retry after a failure
    // is delivered rather than coalesced into nothing.
    lastDeliveredAt = now();
    return { status: 200, body: { ok: true, resumed } };
  }

  return async function handleWake() {
    if (!configured) return { status: 404, body: { error: 'wake is not configured' } };

    // A wake arriving while another is still being delivered (before the
    // session shows as busy) shares that delivery's outcome instead of
    // stacking a second copy; a failed delivery is reported to both.
    if (inFlight) {
      const first = await inFlight;
      return first.status === 200 ? { status: 200, body: { ok: true, coalesced: true } } : first;
    }
    inFlight = deliver();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
