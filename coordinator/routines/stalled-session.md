## Routine: stalled-session — Session stalled on a usage limit

Fires the moment a session stalls on a usage limit whose reset is far off (2 hours by default) or unknown, once per session per stall. The turn lists the sessions under "Tripped by:" with the model and the reset time.

1. A session with a known reset carries on by itself when the limit resets; its box is woken for it. Switch it only if waiting is not acceptable for that work, following the user's memories on which model a maxed box should run: `session_set_model` (the Unstick a session procedure). Check usage live with `agent_boxes` first.
2. A session with no reset time cannot be waited for: `session_set_model` to a model that has allowance, or `session_carry_on` once the memories say the box is usable again.
3. Reply with one line per session: what you did and why, linked.
