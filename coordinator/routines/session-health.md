## Routine: session-health — Session health check

Fires every 2 hours. Keep it short: act, then one line per action in the chat, or one line saying nothing needed doing.

1. `agent_roster`: for every live session that is still working, compare its context gauge with the compaction threshold in the user's memories (default: about 80%). Above it, `session_compact` with the gauge as the reason. Skip sessions marked done.
2. For every session stalled on a usage limit, decide with the Unstick a session procedure: if the user's memories say which model a maxed box should run and the reset is too far off, `session_set_model`; otherwise leave the automatic carry-on to it.
3. `agent_boxes`: for every box under the disk threshold the user's memories set (default 20% free), start a safe clean-up session on it with `agent_session_start`, following the user's memories on disk clean-up for that box. Do not start a second clean-up while one is running.
4. Sessions that look dead: ping their room with a short wait; only then `session_carry_on`, or a question item proposing a replacement.
