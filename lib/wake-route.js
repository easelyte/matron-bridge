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

import { timingSafeEqual } from 'node:crypto';

export const WAKE_COALESCE_MS = 30_000;

// The header a caller presents the optional wake token in.
export const WAKE_TOKEN_HEADER = 'x-matron-wake-token';

// Whether a request may wake at all. The loopback port is open to every
// local user, so an operator can set MATRON_WAKE_TOKEN and have the
// scheduled job present it; with no token configured the route stays open
// to any local caller, as before. Constant-time compare, on bytes.
export function wakeTokenOk(expected, presented) {
  if (typeof expected !== 'string' || expected === '') return true;
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
 * @param {() => boolean} [deps.unavailable] true while the bridge is shutting down or a restart is latched (answers 503)
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
  unavailable = () => false,
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
    if (unavailable()) return { status: 503, body: { error: 'the bridge is shutting down or restarting' } };

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

// Named wake targets: one bridge can run several conversations that each need
// their own wake (a desk session and a second session beside it on the same
// box). MATRON_WAKE_TARGETS lists the names; each name's conversation and text
// come from MATRON_WAKE_CONVO_ID_<NAME> and MATRON_WAKE_TEXT_<NAME>, with the
// name upper-cased and dashes made underscores ("chat-2" reads
// MATRON_WAKE_CONVO_ID_CHAT_2). POST /wake/<name> wakes that target; the bare
// POST /wake keeps waking MATRON_WAKE_CONVO_ID. As with the bare route, the
// request picks only which configured target, never a conversation or a text.
export const WAKE_TARGET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WAKE_TARGET_NAME_MAX = 32;

function envSuffix(name) {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * The named targets the environment configures. A listed name that is
 * malformed, repeated, or missing its conversation or text is left out and
 * reported in `problems`, so a typo leaves that one target off (404) rather
 * than stopping the bridge.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{targets: Map<string, {convoId: string, text: string}>, problems: string[]}}
 */
export function wakeTargetsFromEnv(env) {
  const targets = new Map();
  const problems = [];
  const names = String(env.MATRON_WAKE_TARGETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (name.length > WAKE_TARGET_NAME_MAX || !WAKE_TARGET_NAME.test(name)) {
      problems.push(`wake target "${name}" is not a valid name (lowercase letters, digits and single dashes)`);
      continue;
    }
    if (targets.has(name)) {
      problems.push(`wake target "${name}" is listed twice`);
      continue;
    }
    const convoId = String(env[`MATRON_WAKE_CONVO_ID_${envSuffix(name)}`] ?? '').trim();
    const text = String(env[`MATRON_WAKE_TEXT_${envSuffix(name)}`] ?? '');
    if (!convoId || !text.trim()) {
      problems.push(`wake target "${name}" needs MATRON_WAKE_CONVO_ID_${envSuffix(name)} and MATRON_WAKE_TEXT_${envSuffix(name)}`);
      continue;
    }
    targets.set(name, { convoId, text });
  }
  return { targets, problems };
}

/**
 * Which wake a request path asks for: '' for the bare /wake, the target name
 * for /wake/<name>, or null when the path is not a wake route at all. Whether
 * a named target is configured is the caller's lookup (unknown = 404).
 *
 * @param {string} pathname
 * @returns {string|null}
 */
export function wakeRouteName(pathname) {
  if (pathname === '/wake') return '';
  if (!pathname.startsWith('/wake/')) return null;
  const name = pathname.slice('/wake/'.length);
  return name.length <= WAKE_TARGET_NAME_MAX && WAKE_TARGET_NAME.test(name) ? name : null;
}
