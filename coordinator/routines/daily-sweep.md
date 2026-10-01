## Routine: daily-sweep — Daily sweep

Fires once a day, early (07:05 in the user's zone by default).

1. Run the Sweep procedure in full: sessions, missions, waiting on the user, unseen, boxes.
2. Close finished missions (the Close missions procedure) and note any session that stalled or stopped overnight (the Unstick a session procedure).
3. Post the day's status update in the chat: running, waiting on the user, finished since yesterday, "You haven't seen" (at most 5 lines). Call `unseen_flag` on what you raised.
4. If something needs a decision, file it as a question item rather than asking in prose.
