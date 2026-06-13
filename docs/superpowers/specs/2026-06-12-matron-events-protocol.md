# Matron custom-event protocol — bridge contract (Phase 5 companion spec)

> Companion to matron-iOS-app
> `docs/superpowers/plans/2026-05-02-matron-ios-phase-5-custom-events.md`.
> Drafted 2026-06-12 from the Phase 5 implementation session. Status:
> **proposal** — nothing here is required for the apps to keep working;
> Matron iOS/Mac ship graceful fallback for everything below.

## Where things stand today

The bridge already speaks two custom surfaces, both of which Matron
iOS/Mac (Phase 5) and Matron X consume natively:

| Surface | Direction | Shape |
|---|---|---|
| `chat.matron.buttons` | bridge → client | Content key on an ordinary `m.room.message` (`msgtype: m.text`, plaintext fallback in `body`): `{ mode: "pick_one"\|"pick_many", prompt, buttons: [{id, label, value}] }` |
| `chat.matron.button_response` | client → bridge | Content key `{ selected_values: [String] }` + `m.relates_to: { rel_type: "chat.matron.button_answer", event_id: <buttons event> }`; `body` carries the values joined with `", "` as fallback |
| `chat.matron.live_output` | bridge → client | Existing live-output viewer-link event (see 2026-05-13 spec) |

Canonical constants: matron-web `src/matron/EventTypes.ts`. Any change
here must stay byte-compatible with that file.

**No bridge changes are needed for question/answer flows** — Matron
iOS/Mac renders buttons prompts as a native sheet (radio/checkbox) and
answers with structured `button_response`, exactly like Matron X.

## Proposed additions (the Phase 5 forward contract)

Three new **event types** (not content keys). The apps already parse and
render all three shapes (Matron iOS/Mac ≥ Phase 5); older clients show
nothing for them unless a plaintext fallback is also sent, so adoption
can be incremental.

### 1. `chat.matron.tool_call` — collapsible tool-call cards

One event per tool invocation, updated in place via `m.replace` when the
result lands.

```jsonc
{
  "type": "chat.matron.tool_call",
  "content": {
    "tool": "Read",                  // REQUIRED — tool name
    "args": { "file_path": "/etc/hosts" },  // object; rendered pretty-printed
    "status": "running",             // REQUIRED — "running" | "ok" | "error"
    "result": "127.0.0.1 localhost", // string or object; omit while running
    "result_truncated": false,       // bool, default false
    "started_at": 1745000000000,     // REQUIRED — ms since epoch
    "ended_at": 1745000001000        // ms since epoch; omit while running
  }
}
```

Client rendering: collapsed card (status icon + tool name + one-line arg
summary), tap/click to expand into pretty-printed Arguments + Result
blocks. Push body: "🔧 Tool call".

Update flow: send the `running` event, then `m.replace` it (same shape,
`status: ok|error`, `result`, `ended_at`) — the apps key the card on the
original event ID.

### 2. `chat.matron.ask_user` — structured questions

Alternative to the buttons surface with richer input kinds (free text,
multi-choice with "other", boolean) and expiry:

```jsonc
{
  "type": "chat.matron.ask_user",
  "content": {
    "prompt": "Which file should I edit?",   // REQUIRED
    "input": {
      "kind": "choice",          // REQUIRED — "text" | "choice" | "multi_choice" | "boolean"
      "allow_other": true,        // choice/multi_choice only, default false
      "options": [                // choice/multi_choice only
        { "id": "a", "label": "src/main.rs" },
        { "id": "b", "label": "src/lib.rs" }
      ]
    },
    "expires_at": 1745000600000   // optional, ms since epoch
  }
}
```

The user's answer comes back as a **normal `m.room.message`** with
`m.relates_to.m.in_reply_to.event_id` pointing at the prompt event;
the reply body is the chosen option's `label`, the free text, comma-
joined labels (multi), or `Yes`/`No` (boolean). Correlate by the reply
relation, not by parsing the body.

Note the asymmetry with buttons: `ask_user` answers are plain replies
(visible in the timeline as the user's message); `button_response`
events are hidden by clients. If the bridge adopts `ask_user`, expect
answers to read as chat messages.

Push body: "❓ Question — needs your answer". Buttons-protocol prompts
get "❓ <prompt>".

### 3. `chat.matron.session_meta` — session header (BLOCKED client-side)

State event (`state_key: ""`) describing the running session:

```jsonc
{
  "type": "chat.matron.session_meta",
  "content": {
    "session_id": "abc",            // REQUIRED
    "model": "claude-fable-5",      // optional
    "workdir": "~/yearbook-app",    // optional
    "started_at": 1745000000000     // REQUIRED — ms since epoch
  }
}
```

The bridge can start emitting this any time (`sendStateEventRaw` /
`m.room.state`), but **the apps cannot read it yet**: v26 of
`matrix-rust-components-swift` exposes no arbitrary state-event read
API on `Room` (write-only). The client-side header UI is deferred until
the SDK adds a reader or the apps grow a raw-HTTP fallback — see the
doc-comment at the bottom of `MatronShared/Sources/Chat/ChatService.swift`.
Emitting early is harmless and gives the apps data to render the moment
the gap closes.

## Compatibility matrix

| Event | Matron iOS/Mac (Phase 5) | Matron X | matron-web | older clients |
|---|---|---|---|---|
| buttons / button_response | native sheet | native buttons | native | plaintext `body` fallback |
| tool_call | card | — (not yet) | — | invisible (no fallback body) — consider also sending an `m.notice` until adoption is broad |
| ask_user | sheet | — (not yet) | — | invisible (same caveat) |
| session_meta | blocked (SDK gap) | — | — | n/a (state event) |
