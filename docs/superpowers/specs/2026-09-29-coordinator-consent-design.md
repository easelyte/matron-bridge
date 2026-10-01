# Coordinator consent approval: `consent_list` / `consent_decide`

**Date:** 2026-09-29
**Status:** approved by Dan as proposed (tracker question, 29 Sep); built in matron-journal (`feat/coordinator-consent`) and matron-bridge (this branch). Apps: follow-up tasks on mission #4990.
**Depends on:** 2026-08-07 agent-chat consent, 2026-08-09 agent spawns, 2026-09-22 consent items, 2026-09-23 Coordinator redesign, 2026-09-29 Coordinator session control (the permission model)

## Problem

Dan (29 Sep): "Can we make it that the coordinator can accept other chats,
spawns and requests". Every chat invite, join request and spawn parks as
`awaiting_user`, and only a *client* token may answer it — agents are
refused 403 by design. One requester box may hold at most 3 unanswered
asks (chat and spawn together). The Coordinator's own spawns hit that wall:
chats were refused with "too many requests awaiting user approval" and
spawns timed out at the journal.

## Design

The Coordinator may list and answer parked asks on the user's behalf. The
permission model is the session-control one: the journal checks the
calling conversation against `user_settings.coordinator_convo_id`;
nothing is trusted from the bridge alone.

### Journal

- `GET /consent/pending?convo_id=…` and `POST /consent/answer {convo_id,
  kind: chat|spawn, id, decision: approve|decline, reason}`, agent
  connections only. The answer logic is lifted out of the two client routes
  into `src/consent-answer.js`, so a Coordinator answer and a tap do exactly
  the same thing.
- Checks, in order: agent connection (403); `convo_id` is a top-level
  conversation this box owns **and** the Coordinator (404 / 403
  `not_coordinator`); the off switch is on (403 `consent_disabled`);
  `reason` 1–200 chars, required (400); the ask exists and is still
  `awaiting_user` (404 / 409); a **spawn approval** into a box that is
  offline and cannot be woken is refused (409 `target_offline`; an asleep
  box is woken exactly as a tap would); the **daily cap**: approvals by
  the Coordinator in the last 24 h at or above `MATRON_COORDINATOR_CONSENT_DAILY_CAP`
  (default 20) answer 409 `daily_cap` and the ask stays for the user.
  Declines are not capped. Every refusal leaves the ask as it was.
- Off switch: `user_settings.coordinator_consent` (default on);
  `GET/PUT /coordinator` gain `consent: true|false`, clients only.
- Not covered by construction: tool permission prompts and secret requests
  never exist as journal asks.
- Audit: the row records `answered_by: coordinator` + `answer_reason`; one
  row per decision in `consent_decisions`; the consent item closes with
  "Approved by the Coordinator — <reason>. …" / "Declined by the
  Coordinator — <reason>." attributed to the Coordinator's device as an
  agent; the spawn outcome (event and frame) carries `decided_by` +
  `reason`; the invite delivered to the target carries `approved_by:
  'coordinator'`; a client-only `consent_decision` event on the card's
  conversation is what the apps render as the badge with one-tap Stop
  session / Mute room.
- Nudge: when another agent's ask parks (not the Coordinator's own), the
  journal sends the Coordinator's box `{kind:'consent', event:'pending',
  ask}` after the card and item are journaled — the user is never second.

### Bridge

- `consent_list()` and `consent_decide(kind, id, decision, reason)` in
  ask-user.js, loopback routes `/consent/list|decide`, `lib/consent-tools.js`
  (Coordinator refused locally first, journal refusals rendered as
  sentences, every ask field peer-text sanitised) and `lib/consent-client.js`.
- The nudge frame becomes a turn in the Coordinator session
  (`journalHandleConsentFrame`: find the live Coordinator session, or resume
  it from its persisted record as a user's message would) plus a notice in
  its chat.
- `decided_by: coordinator` on a spawn outcome and `approved_by: coordinator`
  on a delivered invite change the wording: "declined on the user's behalf
  (decided by the user's Coordinator: <reason>)", "Your user's Coordinator
  approved this chat on their behalf".
- BRIDGE_COORDINATOR.md "Approve chats and spawns on the user's behalf":
  approve only what you understand and that follows the box rules from
  memory (never an offline box; last-resort boxes only when every other box
  is busy, checked live with `agent_boxes`); always give a reason; decline
  with a reason or leave it to the user when unsure; one line in chat per
  decision; on `daily_cap` or `consent_disabled` tell the user and stop.

### Apps (follow-up)

The setting "Let the Coordinator approve chats and spawns" (PUT /coordinator
{consent}), the "approved by the Coordinator" badge with the reason from
the `consent_decision` event, and the one-tap Stop session / Mute room on
that badge.

## Decisions (Dan, 29 Sep 2026)

1. Daily cap 20 approvals per rolling 24 h, env-tunable; declines uncapped.
   30 Sep: Dan removed the cap on his journal after a routine day hit 20 —
   `MATRON_COORDINATOR_CONSENT_DAILY_CAP=0` is no cap (journal PR #102);
   the reason and audit on every decision are the guardrail.
2. The Coordinator may approve its own spawns and invites.
3. Nudge turns for other agents' asks: yes.
4. Declines allowed, reason required; a declined chat still reads "refused"
   to the requester (it never learns who said no), a declined spawn says
   the Coordinator declined and why.
5. Default on once shipped, off switch in the apps.
