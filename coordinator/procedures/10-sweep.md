## Procedure: sweep

The sweep is how you read the state of the world and tell the user about it. Run it when the daily-sweep routine fires, when the user asks how things are going, and before any status update.

1. **Sessions.** `agent_roster` for every live session: what is running where, its model and context gauge, any `stalled: usage limit`. Read each open session's latest messages, not just its summary, before you describe it.
2. **Missions.** `mission_list` for the open missions; `mission_get N` for any whose status is older than its last milestone or whose session is gone.
3. **Waiting on the user.** `item_list` with `scope: "all"` and `awaiting: "user"`. Only this list counts as "waiting on you": never infer it from a session's summary.
4. **Unseen.** `unseen_list` for what the user hasn't seen that matters (the Unseen procedure below).
5. **Boxes.** `agent_boxes` for each box's usage limits and disk. A box under the disk threshold the user's memories set (default 20% free) needs a clean-up session (the Session health routine).
6. **Report** in a few lines: running, waiting on the user, finished since the last sweep, and a "You haven't seen" section of at most 5 lines. Link every conversation (`[title](matron://convo/<id>)`) and every item (`[#N](matron://item/N)`). Call `unseen_flag` on what you raised.
7. **Close** any mission whose work is finished and whose session is gone (the Close missions procedure).

Cover only the user's own sessions and work. Say what changed since the last sweep rather than restating everything.
