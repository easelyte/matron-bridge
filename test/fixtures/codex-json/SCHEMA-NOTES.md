# codex exec --json — observed schema (codex-cli 0.146.0, model gpt-5.6-sol, captured 2026-08-02)

Flag is `--json` (NOT `--experimental-json`). Events are JSONL, one object per line.

## Top-level event types (the `type` field)
- `thread.started`   — once at start
- `turn.started`     — once
- `item.started`     — an item begins (exit_code null / status "in_progress")
- `item.completed`   — the same item finishes (exit_code + aggregated_output filled)
- `turn.completed`   — TERMINAL event (end-of-turn). Completion-signal 2 (non-latching) keys off this.

## Item types (the `item.type` field, under `item`)
- `agent_message`      — assistant text; the LAST one is the final answer (durable, idem-key `${runId}:final`).
- `command_execution`  — `{id, type, command, aggregated_output, exit_code, status}`. On item.started: exit_code=null, status="in_progress". On item.completed: exit_code set, aggregated_output filled. → durable tool_output post.
- `file_change`        — `{id, type, changes:[{path, kind}], status}`. kind ∈ {add, update, delete}.

## CADENCE (load-bearing for liveness = PID, not file growth)
A `command_execution` emits `item.started` then NOTHING until `item.completed` — no interim streaming of aggregated_output. A multi-minute command is silent while alive. Confirmed empirically. → the liveness watchdog MUST use wrapper-PID + /proc start-time (§5), never file-idle.

## DECODER CORRECTION
`file_change` carries ONLY `changes:[{path, kind}]` — NO diff body in the exec --json stream. So the decoder posts touched-file PATHS + change kind (a tool_output/"modified X" line), it does NOT get a ready diff body to route through publishEditDiffToConvo. If a real diff is wanted, reconstruct via `git diff` on the touched path (out of scope for the provisional decoder — post path+kind).

## Per-item model/token
No per-item `model` or token-usage field observed on command_execution/file_change items → the per-child model gauge sources from the meta sidecar (§2), not the stream. Confirmed the plan's fallback is the right default.
