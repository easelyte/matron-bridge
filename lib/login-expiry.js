// Recognise Claude Code telling a session that its login is gone, and say so
// in words the user can act on. When the stored OAuth session expires and
// cannot be refreshed, every turn on the box ends with a synthetic record
//   { type:'assistant', isApiErrorMessage:true, error:'authentication_failed',
//     message:{ model:'<synthetic>', content:[{ type:'text',
//       text:'Failed to authenticate: OAuth session expired and could not be refreshed' }] } }
// and, in print mode, a result event carrying the same text. A box that was
// never logged in (or was logged out) says "Not logged in · Please run
// /login" instead. Posted as they are, these read like a crash; the fix is
// always the same, so the bridge swaps them for one line with the login step
// and files one tracker notice per box per day.
//
// Only a message whose WHOLE text is one of these counts: a model that quotes
// the sentence mid-answer is not logged out. The structured fields alone are
// not enough either — an authentication_failed record for an organisation or
// permission problem is not fixed by logging in again, so the wording decides.
import { isSidechainEvent } from './session-status.js';
import { SYNTHETIC_MODEL } from './stall-detector.js';

export const LOGIN_EXPIRED_RE = /^(?:failed to authenticate[:.]?\s+oauth (?:session|token) (?:has )?expired\b[^\n]*|oauth token has expired\b[^\n]*|(?:not logged in|invalid api key)\s*·\s*please run \/login\.?)$/i;

export function isLoginExpiredText(text) {
  return typeof text === 'string' && text.length <= 300 && LOGIN_EXPIRED_RE.test(text.trim());
}

function soleText(event) {
  const content = event.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') return null;
  return blocks[0].text;
}

// True for the parent-session error record above. The wording is only
// trusted on a record Claude Code marked as an error (the flag, or the
// placeholder model it stamps on every synthetic record).
export function loginExpiredFromAssistantEvent(event) {
  if (!event || event.type !== 'assistant' || isSidechainEvent(event)) return false;
  const errorRecord = event.isApiErrorMessage === true || event.message?.model === SYNTHETIC_MODEL;
  return errorRecord && isLoginExpiredText(soleText(event));
}

// What the session posts instead of the raw error. Markdown, like any reply.
export function loginExpiredMessage(box) {
  const where = box ? `**${box}**` : 'this box';
  return `🔑 Claude's login on ${where} has expired, so this session can't reply. Send \`/login\` here to sign in again, then send your message again.`;
}

// The same message as a card with a one-tap Log in button, so the user does
// not have to type /login. Plain text: a card's question is not rendered as
// markdown. The tap comes back as a picker value (lib/picker-dispatch.js) and
// runs exactly what a typed /login runs.
export function loginExpiredCardText(box) {
  const where = box || 'this box';
  return `🔑 Claude's login on ${where} has expired, so this session can't reply. Tap Log in (or send /login) to sign in again, then send your message again.`;
}

// The `login-` id prefix makes the card a picker frame in
// lib/journal-input-router.js (isPickerFrame), and the value is the one
// lib/picker-dispatch.js accepts for it.
export function loginButtons() {
  return [{ id: 'login-start', label: '🔑 Log in', value: 'login:start' }];
}

function noticeBody(box) {
  const where = box ? `\`${box}\`` : 'this box';
  return [
    `Claude's login on ${where} has expired, so every Claude session there stops with an authentication error until someone logs in again.`,
    '',
    '**To fix:** send `/login` in any Claude conversation on this box and follow the sign-in link it posts. Or, on the box itself, run `claude` and then `/login`.',
    '',
    'Messages sent while it was logged out were not answered: send them again afterwards.',
  ].join('\n');
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// One notice per box per UTC day. The journal namespaces the Idempotency-Key
// by device and keeps it unique, so the dated key collapses every session and
// every bridge restart on this box that day into the one item (see
// lib/summary-model-nag.js); the in-process latch only saves round trips. A
// login that expires again on a later day gets a fresh notice.
// `client` is lib/items-client.js, or null when there is no journal. `box` is
// a string or a function returning one (the journal identity can arrive after
// boot).
export function createLoginExpiryNotice({ client, box, now = Date.now, log = () => {} }) {
  let filedDay = null;
  const boxName = () => (typeof box === 'function' ? box() : box) || '';

  return {
    // Never throws and never rejects: the turn that hit the error must not
    // care whether the notice landed.
    async maybeFile(convoId) {
      const day = utcDay(now());
      if (filedDay === day || !client || !convoId) return;
      const name = boxName();
      const item = {
        title: `Claude needs you to log in again on ${name || 'this box'}`,
        body: noticeBody(name),
        convo_id: convoId,
      };
      const idemKey = `claude-login-expired-${day}`;
      try {
        let res = await client.create({ kind: 'notice', ...item }, { idemKey });
        // A journal that predates notices answers 400 to the unknown kind and
        // stores no key, so the task fallback can reuse it.
        if (res && res.status === 400) {
          res = await client.create({ kind: 'task', ...item, awaiting: 'user' }, { idemKey });
        }
        if (res && (res.status === 200 || res.status === 201)) {
          filedDay = day;
          log(`login-expired notice filed (item #${res?.data?.item?.num ?? '?'})`);
        }
      } catch {
        // Fail open, like every other journal touch.
      }
    },
  };
}
