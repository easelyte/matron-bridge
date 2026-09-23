// Plan approvals mirrored into the task & decision tracker (item #2317,
// Dan 2026-09-22: "ok yes all good"; the journal does the same for spawn
// and agent-chat consent cards, matron-journal PR 83). A "📋 Plan Ready —
// reply build" card is a consent ask that can sit for hours in one
// conversation's timeline; the Decisions list is where the user looks. So
// every plan card also files a `question` item on the session's journal
// conversation, and whatever settles the plan closes it: `build` (in the
// conversation, or as a reply on the item itself) → decided; the iv-mode
// hook timing out → cancelled; a newer plan replacing it → cancelled; a
// restart that killed the hook → cancelled.
//
// The item is a mirror of the session's own pending-plan state
// (session.pendingPlan / pendingPlanDenialId / ivPendingPlanToolUseId),
// never a second source of truth. It is tied to the hook's tool_use_id
// (session.planToolUseId, persisted with the item id): a settle names the
// hook it belongs to, so a stale iv-mode timer firing after a restart can
// never close a NEWER plan's item. Everything I/O-shaped is injected, same
// discipline as lib/secret-requests.js; every method is best-effort and
// never throws — a tracker failure must never cost the plan flow.

import { isPlanBuildText } from './command-dispatch.js';

// A plan is the agent's own markdown for the user, so it renders as
// markdown — unlike another agent's peer text, which the journal fences.
// The tracker's body cap is 32 KiB; stay well under it and say when cut.
export const PLAN_BODY_MAX = 8000;

const HOW_TO_ANSWER = '**To answer:** reply `build` — here on this item, or in the conversation — to execute the plan. Anything else you reply in the conversation is feedback, and the agent will come back with a revised plan (which replaces this item).';

export function formatPlanItemBody({ plan }) {
  let text = typeof plan === 'string' ? plan : '';
  if (text.length > PLAN_BODY_MAX) {
    text = text.slice(0, PLAN_BODY_MAX);
    // A cut inside a code block would swallow everything after it as code.
    if (((text.match(/```/g) || []).length) % 2 === 1) text += '\n```';
    text += '\n\n_(plan truncated here — the conversation has the whole of it)_';
  }
  // The instructions come FIRST: they are the part the user must see, and
  // a plan is long.
  return [HOW_TO_ANSWER, '', '---', '', text].join('\n');
}

function closing(outcome) {
  switch (outcome) {
    case 'build': return { resolution: 'decided', comment: 'Approved — building.' };
    case 'timeout': return { resolution: 'cancelled', comment: 'The plan was not built before the approval window closed (29 min).' };
    case 'superseded': return { resolution: 'cancelled', comment: 'Replaced by a newer plan.' };
    case 'restarted': return { resolution: 'cancelled', comment: 'The session was restarted before an answer; the plan was not executed — ask for it again if still wanted.' };
    case 'settled': return { resolution: 'cancelled', comment: 'Settled in the conversation before this item was filed.' };
    default: return { resolution: 'cancelled', comment: `Closed — ${outcome}.` };
  }
}

export function createPlanApprovalItems({
  // The lib/items-client.js subset this needs: create + close.
  items,
  // (session) -> journal conversation id | null.
  journalConvoIdFor,
  // (session, planItemId | null, planToolUseId | null) -> void. index.js
  // persists both next to pendingPlanDenialId so a restart finds them.
  persist = () => {},
  now = () => Date.now(),
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function remember(session, planItemId, planToolUseId) {
    session.planItemId = planItemId;
    session.planToolUseId = planToolUseId;
    try { persist(session, planItemId, planToolUseId); } catch (e) { warn(`[plan-items] persist failed: ${e?.message ?? e}`); }
  }

  async function closeItem(id, outcome) {
    const { resolution, comment } = closing(outcome);
    try {
      const res = await items.close(id, { resolution, comment });
      if (res?.status !== 200 && res?.status !== 409) warn(`[plan-items] close of ${id} answered ${res?.status ?? '?'}: ${res?.data?.error ?? ''}`);
    } catch (e) {
      warn(`[plan-items] close of ${id} failed: ${e?.message ?? e}`);
    }
  }

  // Forget first, close second: a build and a timeout racing collapse to
  // one close, and a create still in flight (opened, below) sees the
  // ownership change and closes its own fresh item.
  async function closeOpen(session, outcome) {
    const id = session.planItemId;
    remember(session, null, null);
    if (id) await closeItem(id, outcome);
  }

  // Bounded memory of build comments this bridge already acted on, so a
  // journal replay of the same comment after the plan settled is not
  // handed to the agent as a stray turn (the item-turn router's own dedupe
  // never sees a comment we intercept).
  // Fallback hook ids for a caller that has none: unique per call, so two
  // hookless plans can never read as the same hook.
  let hookless = 0;
  const consumed = new Set();
  const markConsumed = (id) => {
    if (typeof id !== 'string' || !id) return;
    consumed.add(id);
    if (consumed.size > 200) consumed.delete(consumed.values().next().value);
  };

  return {
    // A plan card was just posted for hook `toolUseId` (the ExitPlanMode
    // tool_use_id — iv-mode's hook id, print-mode's denial id). Returns the
    // item number, or null when nothing was filed (no journal conversation
    // yet, journal refused).
    async opened(session, plan, { toolUseId = null } = {}) {
      // Claim the hook SYNCHRONOUSLY, before any await: a settle that lands
      // during the round trips below clears the claim, and we notice.
      const hookId = toolUseId || `t${now()}.${++hookless}`;
      // The same hook posted again (a re-rendered card, a duplicate event):
      // its item already exists and is the one to keep — superseding it
      // would leave the session pointing at a cancelled question.
      if (session.planItemId && session.planToolUseId === hookId) {
        return Number.isInteger(session.planItemNum) ? session.planItemNum : null;
      }
      const prevId = session.planItemId;
      session.planItemId = null;
      session.planToolUseId = hookId;
      try {
        if (prevId) await closeItem(prevId, 'superseded');
        const convoId = journalConvoIdFor(session);
        if (!convoId) {
          if (session.planToolUseId === hookId) remember(session, null, null);
          return null;
        }
        const res = await items.create({
          kind: 'question',
          title: 'Plan ready — reply build to execute it, or send feedback',
          body: formatPlanItemBody({ plan }),
          labels: ['plan'],
          convo_id: convoId,
        }, { idemKey: `plan:${session.roomId}:${hookId}` });
        const item = res?.data?.item;
        if (!((res?.status === 200 || res?.status === 201) && item?.id)) {
          warn(`[plan-items] create answered ${res?.status ?? '?'}: ${res?.data?.error ?? ''}`);
          if (session.planToolUseId === hookId) remember(session, null, null);
          return null;
        }
        if (session.planToolUseId !== hookId) {
          // The plan was settled (build/timeout/restart) while the item was
          // being filed: nothing will ever close it, so close it now.
          await closeItem(item.id, 'settled');
          return null;
        }
        remember(session, item.id, hookId);
        session.planItemNum = Number.isInteger(item.num) ? item.num : null;
        return session.planItemNum;
      } catch (e) {
        warn(`[plan-items] create failed: ${e?.message ?? e}`);
        if (session.planToolUseId === hookId) remember(session, null, null);
        return null;
      }
    },

    // The pending plan was settled: 'build' | 'timeout'. A `toolUseId`
    // names the hook the settle belongs to; a settle for another hook (a
    // stale iv-mode timer outliving a restart) touches nothing.
    async resolved(session, outcome, { toolUseId = null } = {}) {
      try {
        if (toolUseId && session.planToolUseId && session.planToolUseId !== toolUseId) return;
        await closeOpen(session, outcome);
      } catch (e) {
        warn(`[plan-items] resolve failed: ${e?.message ?? e}`);
      }
    },

    // After a restart restored planItemId: is the plan still buildable?
    // Print-mode persists pendingPlanDenialId and builds through a
    // tool_result, so yes. iv-mode's hook died with the old process (the
    // hook script auto-denies when the bridge goes away), so the item can
    // never be answered — close it rather than leave a zombie question.
    async reconcileRestored(session) {
      try {
        if (!session?.planItemId || session.pendingPlanDenialId) return;
        await closeOpen(session, 'restarted');
      } catch (e) {
        warn(`[plan-items] reconcile failed: ${e?.message ?? e}`);
      }
    },

    // Is this item marker the user replying `build` on THIS session's open
    // plan item? The caller then approves the plan exactly as a `build` in
    // the conversation would, instead of injecting the reply as a turn.
    isBuildReply(session, payload) {
      if (!session?.planItemId || !payload || typeof payload !== 'object') return false;
      if (payload.item_id !== session.planItemId) return false;
      if (payload.action !== 'commented' || payload.by !== 'user') return false;
      if (!isPlanBuildText(payload.comment?.body)) return false;
      markConsumed(payload.comment?.id);
      return true;
    },

    // A replay of a build comment already acted on (see `consumed`).
    consumedReply(payload) {
      const id = payload?.comment?.id;
      return typeof id === 'string' && consumed.has(id);
    },
  };
}
