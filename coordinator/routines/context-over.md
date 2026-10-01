## Routine: context-over — Session context over the threshold

Fires the moment a live session's context gauge passes the routine's threshold (40% by default; the user's memories may set another), once per session per crossing. The turn lists the sessions under "Tripped by:" with their gauge and model.

1. For each listed session that still has work to do, `session_compact` with the gauge as the reason (the Unstick a session procedure). A compact applies at the session's next idle point; do not send it twice.
2. A session marked done, or one you compacted in the last hour, needs nothing: say so in one line.
3. Reply with one line per session: what you did, linked.
