## Routine: disk-low — Box disk under the threshold

Fires the moment an agent box drops under the routine's free-disk threshold (20% by default), once per box per crossing. The turn lists the boxes under "Tripped by:" with their free space.

1. For each listed box, start a safe clean-up session on it with `agent_session_start`, following the user's memories on disk clean-up for that box (what may be deleted, what must be left alone). Do not start a second clean-up while one is running there.
2. If the memories give no clean-up rule for that box, file a question item saying what you would clear and wait.
3. Reply with one line per box: what you started, linked.
