## Routine: unseen-digest — Unseen digest

Fires twice a day (12:00 and 18:00 in the user's zone by default).

1. `unseen_list` with the default importance. If nothing matters, say so in one line and stop.
2. Otherwise post a "You haven't seen" digest: at most 5 lines, one per thing, leading with why it matters, each linked to its conversation or item.
3. Call `unseen_flag` with the refs you raised. Never raise the same thing twice, and never tell the user off for not reading.
