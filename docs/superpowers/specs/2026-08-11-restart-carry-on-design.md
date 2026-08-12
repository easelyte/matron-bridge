# Restart carry-on prompts

**Date:** 2026-08-11
**Status:** Approved, ready for implementation planning

## Problem

A bridge restart kills in-flight turns. `restart.sh` sends a plain `kill`
(SIGTERM), and both signal handlers (`index.js:8969-8984`) loop over every
live session calling `killSession`. A session that was mid-turn is destroyed,
not orphaned.

This happens silently. Nothing is published into the affected conversation, so
the user does not find out that work stopped until they next open that chat and
notice it never finished. The loss of the turn is recoverable — the sessions are
resumable — but the *silence* is not: you cannot resume what you do not know
died.

Nothing in the bridge currently records which conversations were mid-turn.
`session.busy` is in-memory only (`index.js:2946`, `4074`, `7676`); the persisted
session record carries workdir, sessionId, agent and history, but no turn state.
So "which chats were interrupted" is not a question the system can answer today.

## Goals

- After a restart, every conversation that was genuinely mid-turn surfaces a
  prompt offering to carry on.
- The prompt appears inside the affected chat, so it rides Matron's existing
  unread/bubble-up behaviour rather than needing a new notification surface.
- Only genuinely interrupted conversations are surfaced. Idle-reaped sessions,
  sessions that were merely alive between turns, and old persisted conversations
  are never touched.
- Detection survives a crash, OOM, or `kill -9`, not just a clean shutdown.
- Nothing resumes automatically. The user taps.

## Non-goals

- Detecting conversations that are *conceptually* unfinished — where the agent
  completed its turn but the underlying work is incomplete. Those are "at an
  end" by this design's definition and get no prompt. Anything broader requires
  judgement about what "finished" means and would generate noise.
- Automatic resumption without a tap.
- Expiring a card that has already been published but not yet tapped. The card
  states when the interruption happened, so the user can judge staleness.

## Design

### 1. Detection — the in-flight marker

A new `lib/inflight-marker.js`: pure, with injected fs seams, following the
house pattern set by `lib/busy-queue.js` and `lib/picker-dispatch.js`. Backed by
`inflight.json`, written through `lib/atomic-write.js` for the same reason
`savePersistedSessions` is atomic — a truncating write that dies mid-rewrite
would silently drop every record.

One record per in-flight turn:

```json
{
  "<convoId>": {
    "roomId": "...",
    "bootId": "...",
    "startedAt": 0,
    "touchedAt": 0
  }
}
```

`bootId` is a `randomUUID()` generated once per bridge process. At boot, any
record carrying a *different* bootId belongs to a run that no longer exists —
that is the entire detection mechanism. No transcript scanning, no inference
about what a partial transcript means.

The marker is written at turn start and removed at turn end. Wiring goes at the
turn boundaries that already exist rather than at the ~15 scattered
`session.busy =` assignment sites.

Turn start — the three sites where `busy` transitions to true, one per execution
mode: `index.js:2946` (iv), `index.js:4074` (print), `index.js:7676` (codex).

Turn end — the three existing authoritative seams:

- `session.onTurnEnd` — iv-mode's authoritative turn-end signal (`index.js:2203`)
- the print-mode `result` handler (`index.js:3512`)
- `finishCodexTurn` (`index.js:1798`)

The implementer should confirm these six sites are exhaustive for the current
tree before wiring; the design assumption is one start and one end per mode, and
a missed end site would leave a stale marker that produces a spurious card.

`touchedAt` refreshes as the turn makes progress, debounced to at most once per
minute. The debounce precedent is `lib/journal-publisher.js:178`, which already
debounces its seq persistence for the same reason.

**Why turn-start and not shutdown.** Snapshotting the busy set in the SIGTERM
handler would be cheaper — one write per restart instead of one per turn
boundary. It is rejected because it only fires on a clean exit. An OOM, a crash,
or a `kill -9` would write nothing, and those are precisely the cases where the
user has no other signal that anything happened. Writing at turn start means
nothing has to run at shutdown for the record to survive.

### 2. Boot reconciliation

In `main()`, after `loadPersistedSessions()`:

1. Load `inflight.json`.
2. For each record whose `bootId` differs from the current process's, compute
   `now - touchedAt`.
3. Older than `MATRON_RESTART_CARRY_ON_MAX_AGE_MS` (default 6h, `parseInt`
   env override following the `SESSION_IDLE_TIMEOUT_MS` pattern at
   `index.js:159`) → drop silently with a log line.
4. Within the window → publish a card into that conversation.
5. Clear all previous-run records.

Step 5 is what stops the feature becoming its own source of noise. A given
interruption is offered exactly once; without it, the same dangling turn from
three restarts ago would resurface on every subsequent boot.

**Why age is measured from `touchedAt`, not `startedAt`.** The relevant quantity
is how long the conversation has been dangling, not how long the turn ran. A
legitimate three-hour turn that was still actively working one minute before the
crash should be carded; measuring from turn start would suppress it as ancient.

Worked examples:

- Crashed at 14:00, restarted 14:05 → 5 minutes → card.
- Crashed Friday afternoon, box back Monday → ~67 hours → dropped silently.

**Why 6h and not the idle reaper's 1h.** `SESSION_IDLE_TIMEOUT_MS` answers a
different question — how long to hold memory for an idle session. Reusing it
would mean restarting the bridge before a long meeting silently loses the card.
Six hours covers "restarted, went to lunch, came back" while excluding anything
overnight or over a weekend.

### 3. The card and the tap

Published per-chat, single button, through the existing picker path:

> ⚠️ The bridge restarted while this chat was mid-turn — interrupted about 4
> minutes ago. The work stopped where it was.
>
> `[ Carry on ]`

Button value is `resume:<convoId>`. Dispatch extends `handlePickerValue` in
`lib/picker-dispatch.js` with a `resume:` namespace, validated against the convo
ids actually offered — the same defence-in-depth that module already applies to
`model:` and `effort:` values.

On tap:

1. `journalResumeConvo(convoId)` (`index.js:7127`) respawns the session through
   the same helper the ordinary auto-resume path uses.
2. `journalRouteTextToSession(session, 'carry on')` delivers the text.

Delivery safety is already handled: `sendToSession` holds input in
`_resumeOutbox` until the resumed TUI is ready, and print mode's stdin buffers.

**Router carve-out (added during planning).** The above does not work unaided.
`lib/journal-input-router.js:456` deliberately refuses to auto-resume on a
`prompt_reply` — *"its pending prompt died with the process, so there's nothing
valid to answer"* — and a carry-on card is published into a convo whose session
is dead by construction, so a tap would dead-end at the unknown-convo notice.

The rule is correct for ordinary prompts and stays in force. The implementation
adds one narrow exception: auto-resume on a `prompt_reply` when `target_seq`
names a picker frame whose chosen value is a `resume:` value that frame itself
offered. Provenance is what makes it safe — value shape alone is never trusted,
so an AskUserQuestion option labelled `resume:whatever` cannot wake a session.

Two supporting changes fall out of this: `PICKER_OPTION_ID`
(`journal-input-router.js:52`) gains a `resume-` prefix, without which the frame
is not classified as a picker at all, and `PICKER_VALUE`
(`picker-dispatch.js:38`) gains the `resume` namespace. Frame registration
itself needs no new code — `pickerFrames.set` is driven by observing outbound
frames.

Also stricter than described below: the router consumes a picker frame before
dispatch (`pickerFrames.delete`, `journal-input-router.js:596`), so a second tap
on the same card is refused as stale rather than re-injecting `carry on`.

**Injected text: accepted trade-off.** The injected message is the literal string
`carry on`, chosen deliberately by the user over a longer interruption-aware
prompt.

The risk being accepted: SIGTERM often lands mid-tool-call, so the transcript can
end without the result event for an action that did in fact execute. The agent
cannot distinguish "the `git push` never ran" from "it ran and the result was
never recorded", and `carry on` reads as permission to proceed. The plausible
failure is re-running a side-effecting operation.

An alternative was considered and declined: injecting wording that tells the
agent not to assume its last action completed, at the cost of a few verification
tool calls. Recorded here so the choice is visible rather than looking like an
oversight. Revisiting it is a wording change in one place.

### 4. Error handling

| Case | Behaviour |
|---|---|
| Corrupt `inflight.json` | Treated as `{}`, matching `loadPersistedSessions`' existing stance |
| Marker for a convo with no persisted session record | Dropped |
| `journalResumeConvo` returns null (workdir gone, unresumable) | Existing "can't be found or resumed" notice |
| Double tap | Refused as stale — the router consumes the picker frame before dispatch |
| Marker write fails | Logged, not propagated; a lost marker means a missed card, never a broken turn |

### 5. Testing

Unit tests for the pure module, against the existing `test/` suite:

- bootId discrimination — current-run records are never carded
- age window at both edges (just inside, just outside)
- fire-once clearing — a second boot after carding produces nothing
- corrupt-file tolerance
- `resume:` value validation, including rejection of convo ids that were not
  offered

### 6. Cost

One extra atomic write per turn boundary, plus a touch debounced to once a
minute. The sessions file is already rewritten on every message, so this sits
within existing I/O behaviour rather than adding a new class of load.
