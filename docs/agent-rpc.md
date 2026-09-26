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
| `read_file` | Read a file inside the pinned allowed roots, with its sha256 | `lib/read-file.js` |
| `edit_file` | Guarded edit of an existing file (optional sha256 CAS) | `lib/edit-file.js` |
| `ops_snapshot` | Read-only host / ops sections for the Ops page | `lib/ops-snapshot.js` |

## `ops_snapshot`

Request `params: { section: "host" | "timers" | "alerts" | "usage" | "posture" }`;
nothing else is read. Success:

```json
{ "section": "host", "generated_at_ms": 1790000000000, "truncated": false, "data": { } }
```

`JSON.stringify(result)` is held to 12,000 bytes: when over, trailing elements of
the longest array anywhere in `data` are dropped until it fits and `truncated`
becomes `true`; if nothing trimmable is left the answer is `too_large`.
Successful results are cached per section for 15 s.

- **`host`** is computed in the bridge from Linux `/proc`: hostname, cores,
  uptime, load, whole-host CPU % (a ~300 ms two-point sample taken per call),
  memory, swap, disk of the default workdir, `claude` / `codex` process counts
  (argv0 basename), live bridge sessions, and the top 12 processes by RSS
  (`pid`, `name`, `rss_bytes`, `cpu_pct`, `user`). A process `name` is never
  the command line: it is the argv0 basename, plus the script basename for
  interpreters (`node index.js`, `python3 watchdog.py`); inline code
  (`bash -c`, `node -e`, `python -c`) is never shown.
- **`timers`, `alerts`, `usage`, `posture`** run `MATRON_OPS_SNAPSHOT_CMD`
  (split on whitespace, no shell) with `--section <section>` appended, in
  `MATRON_OPS_SNAPSHOT_CWD` or the default workdir, with the journal token and
  bridge-only secrets stripped from its environment. It must print one JSON
  object `{"section": "<section>", "data": { ... }}` within 10 s and 256 KiB;
  stderr is discarded.

Errors (`error.code`):

| Code | When |
|---|---|
| `bad_request` | missing or unknown `section` |
| `not_configured` | an extras section while `MATRON_OPS_SNAPSHOT_CMD` is unset |
| `unavailable` | no `/proc` (host), or the command failed to start, exited non-zero, timed out, printed too much, or printed invalid JSON / the wrong shape. `detail` is a short reason and never contains the command's output |
| `too_large` | the result cannot be trimmed under 12,000 bytes |

The full wire contract, including each extras section's `data` shape, is
tracked with the matron-web Ops page (loop #542 phase B).
