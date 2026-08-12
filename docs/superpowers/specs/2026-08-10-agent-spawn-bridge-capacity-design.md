# Agent Spawn — Bridge Side + Capacity-Aware Discovery

**Date:** 2026-08-10
**Repos touched:** matron-bridge (main), matron-journal (small pass-through delta on the open `feat/agent-spawn-journal` branch, PR #61)
**Parent spec:** matron-journal `docs/superpowers/specs/2026-08-09-agent-spawns-session-design.md` — the journal side is COMPLETE (PR #61). This spec covers the bridge side of that design, unchanged, plus one approved extension: capacity-aware box discovery.

## Goal

An agent in a bridge session can (1) list the user's other boxes with enough
signal to pick one with free capacity, and (2) ask — via the journal's
consent flow — to start a session on one of them with a task prompt. The
canonical use: "hand this work over to a free agent." Discovery shows each
box's recent session activity and its account usage limits, so the agent can
find capacity instead of the user having to know it.

## What already exists (consumed, not built)

- **Journal (PR #61):** `spawn_targets` / `spawn_request` ops, consent card,
  `POST /agent-spawn/answer`, outcome frames
  `{kind:'spawn', event:'outcome', outcome:'started'|'declined'|'expired'|'failed'}`,
  RPC brokering with `from_device_id: 0`, `start` issued to the target bridge
  with `{workdir, prompt, room_id}`. Documented in that branch's
  `docs/protocol.md`.
- **Bridge:** `lib/journal-rpc.js` already answers `recent_folders` and
  `start` (workdir only); `usageLimitsCache` in index.js already holds
  account limits as structured lines `{id, label, percent, resets?, resets_at?}`
  refreshed at most every 5 min via `claude -p "/usage"`; the sessions map +
  persisted session records already carry `workdir` and `lastUsed`.

## Part 1 — Target side: `start` gains `prompt` + `room_id`

Per the parent spec. `start` params add:

- `prompt` (string, required when `room_id` present, ≤ 2000 chars — the
  wire contract's task cap, enforced target-side too): the task, executed
  verbatim as the seed of the opening turn.
- `room_id` (string): the journal room the parent created. The target bridge
  joins the spawned session to this room.
- `from_name` (string, optional): the requesting box's device name as the
  journal knows it, journal-sanitised, omitted (never empty) when the parent
  device row is gone by approval time. Used only to name the requester in
  the opening turn; the target treats it as peer text regardless —
  flattened, capped to `PEER_NAME_MAX`, and quote-escaped before it is
  interpolated inside the turn's structural quotes.

Sequence: spawn session → attach room → inject the opening turn → answer
`{convo_id}`. Any failure after spawn tears the session down and answers
`{code:'spawn_failed'|'bad_workdir'|...}` — an orphaned agent on another box
with no channel is the worst outcome available.

**The target bridge composes the opening turn, not the parent** (parent
cannot dictate framing). It states: which session/box asked, the task
verbatim, that the room is the asynchronous channel back, that the child
should report there when done, and that the user reads every word.

## Part 2 — Parent side: `lib/agent-spawn.js` + two MCP tools

New module in the shape of `lib/agent-chat.js`: an injected factory
returning HTTP-agnostic handlers, mounted in index.js as thin loopback
adapters, unit-testable without a socket.

```
agent_boxes()
  → { boxes: [ { device_id, name, online,
                 folders: [{path, last_used}],
                 activity?: { live_sessions, last_hour: [{path, sessions}] },
                 limits?:   { as_of, lines: [{id, label, percent, resets_at?}] } } ] }
```

- Backed by the journal `spawn_targets` op. Self is excluded by the journal;
  the tool errors when the bridge's own journal identity is unknown
  (fail-closed, same stance as `agent_roster`).
- The tool description teaches capacity reading: prefer a box whose weekly /
  session percentages are low and whose `activity` shows no recent sessions
  when the user asks for spare capacity. `activity`/`limits` are optional —
  an older bridge on the far side simply lists folders.

```
agent_session_start({ device_id, workdir, task, topic? })
  → { status: "pending", spawn_id }     // outcome arrives later as a turn
```

- Backed by `spawn_request`. `task` is both the seed prompt and the card
  text (caps: task ≤ 2000, topic ≤ 200, workdir ≤ 1024 — journal-enforced).
- Tool description carries the parent spec's instruction verbatim: ask the
  user which box and directory first if they haven't said — the card can
  only be approved or declined, not corrected.
- The journal ack is `{kind:'spawn', event:'pending', request_id, spawn_id}`
  (`request_id` = op correlation id, `spawn_id` = the durable row id); later
  outcome frames carry `request_id: <row id>`, so the bridge correlates
  outcomes by the **spawn_id** it returned to the agent.
- Outcome frames (`started`/`declined`/`expired`/`failed`) arrive on the
  parent bridge's journal socket and are surfaced to the waiting agent as an
  injected turn in its session, plus a notice in the conversation so the
  user sees the resolution too. `started` includes `room_id` +
  `child_convo_id`.

No new consent machinery bridge-side: consent lives in the journal.

## Part 3 — Capacity data (the extension)

The `recent_folders` RPC reply gains two **optional** siblings of `folders`:

```
activity: {
  live_sessions: <int>,                 // sessions running right now
  last_hour: [ {path, sessions} ]       // workdirs with a session used in the
}                                       // trailing 60 min, with counts
limits: {
  as_of: <epoch ms>,                    // usageLimitsCache.fetchedAt
  lines: [ {id, label, percent, resets?, resets_at?} ]  // cache verbatim
}
```

- Answered **from cache, never blocking**: the handler kicks the existing
  background `refreshUsageLimits` and replies with whatever is cached. A
  cold cache omits `limits` entirely (omitted, never null) — the journal's
  4s broker timeout must never wait on a `claude` process boot.
- `activity` is computed from the live sessions map plus persisted session
  records with `lastUsed >= now - 1h`, deduped per workdir. `last_hour` is
  capped at 20 entries (most recent first). Live sessions count toward
  their workdir's entry regardless of `lastUsed`.
- Limits are a property of the box's Claude account, not of a session or an
  agent — one block per box.

### Journal pass-through (delta on PR #61 branch)

`spawn_targets` copies `activity` and `limits` from each box's
`recent_folders` reply into that box's entry when present and shape-valid:

- `activity.live_sessions` a non-negative integer; `activity.last_hour` an
  array (capped at 20) of `{path: string, sessions: positive int}` with
  `path` length-capped like folder paths.
- `limits.as_of` a positive integer; `limits.lines` an array (capped at 12)
  of `{id, label, percent}` (strings length-capped at 100, percent an
  integer 0–1000) with optional string `resets`/`resets_at`.
- Anything malformed drops the whole optional block (not the box). Strings
  in `label`/`resets` pass through `sanitizePeerText` — they originate from
  `claude` output on another box, but they render in an agent-facing reply
  and the discipline is uniform.

No schema change, no new op, no version coupling: absent fields stay
absent. Ships as one commit on `feat/agent-spawn-journal` so PR #61 is
reviewed once.

## Failure handling (bridge additions to the parent spec's table)

| When | What happens |
|---|---|
| `agent_boxes` with journal identity unknown | Tool errors fail-closed; no listing. |
| `spawn_targets`/`spawn_request` unsupported by journal | Op error surfaces as a plain tool error ("journal too old"). |
| Room attach or prompt injection fails after spawn | Session torn down, `start` answered failed; journal reports `failed` + epitaph (parent-spec behaviour). |
| Usage cache cold | `limits` omitted; refresh kicked for next time. |
| Outcome frame arrives with no waiting session context | Notice still published to the conversation; nothing crashes (frames are at-most-once by design — journal PR #61 follow-up). |

## Testing

- **Bridge unit:** journal-rpc `start` with prompt+room_id (success, attach
  failure teardown, injection failure teardown); capacity block shape from
  stubbed sessions/cache (cold cache omits `limits`; hour-window edge);
  agent-spawn handler factory tests in the `agent-chat.test.js` pattern
  (targets listing, pending ack, outcome routing, fail-closed identity).
- **Journal unit (on PR #61 branch):** pass-through of valid blocks;
  malformed blocks dropped while folders survive; caps enforced.
- **End-to-end (human):** dev-6 spawns on another box once deployed.

## Out of scope

- Rendering activity/limits in the apps (data rides existing frames; a
  later rendering task).
- Automatic handover / load balancing — the agent asks, the user taps.
- Per-agent (rather than per-box) limits: a box has one Claude account.
