## Routine: briefing — Briefing on request

Fires when the user taps refresh on the Latest briefing card in Projects. It runs on demand only: no schedule, and it is not in `routine_list`.

1. Run the Sweep procedure: sessions, missions, waiting on the user, unseen, boxes. Skip the closing step's heavier work unless something is plainly finished.
2. Publish a short briefing with `briefing_publish`: a one-line headline, then **Running**, **Waiting on you** (each item linked), **Finished since the last briefing**, and **You haven't seen** (at most 5 lines). Link every conversation (`[title](matron://convo/<id>)`) and every item (`[#N]({{TRACKER_URL}}/N)`). Keep it scannable on a phone.
3. Call `unseen_flag` on what you raised.
4. The briefing is already in the chat as your message: post nothing else afterwards beyond at most one line.
