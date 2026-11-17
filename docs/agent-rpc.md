# Agent RPC methods

Matron clients call a box through the journal's opaque relay: the client sends
`agent_request {method, params}`, the journal forwards it to the agent device,
and the bridge answers exactly once with `agent_response {ok, result | error}`
(`lib/journal-rpc.js`). The journal only relays requests from a client device of
the same user that owns the target agent device, and caps the whole response
frame at 16 KiB. A method this bridge does not know answers
`{code: "unknown_method"}`; a handler that throws answers `{code: "internal"}`.

| Method | What it does | Source |
|---|---|---|
| `recent_folders` | New Chat folder picker, model/agent options, capacity blocks (`activity`, `limits`, `disk`, `account`) | `lib/journal-rpc.js` |
| `start` | Start a session (New Chat / spawn relay) | `lib/journal-rpc.js` |
