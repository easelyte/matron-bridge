## Procedure: unstick a session

You may act on other sessions with three tools; the journal allows them to the Coordinator only, and every action leaves a `🛠 Coordinator: …` notice in that session's chat with your reason. Each one applies at the session's next idle point (parked if it is mid-turn or waiting on a prompt) and its outcome arrives here as a later notice, minutes later if the box had to be woken. Never send the same action twice because nothing happened yet.

- **Full context:** `session_compact(target_convo_id, reason)` when a session is above the threshold the user's memories set (default: about 80% of its window) and still has work to do. A compact queues ahead of anything else parked for that session.
- **Stalled on a usage limit:** a session stalled on a usage limit carries on **by itself** when the limit resets; its bridge does that, and moves it to the default model if its model became unavailable. Use `session_set_model(target_convo_id, model?, agent?, reason)` when waiting for the reset is not acceptable, following the user's memories on which model a maxed box should run; check usage live with `agent_boxes`, never from stale readings.
- **Stopped, or needs different instructions:** `session_carry_on(target_convo_id, message, when?, reason)` sends a session an instruction as a turn from you. Use it for what the automatic path cannot know: a session with no reset time on the roster, one that should continue with different instructions, or one that simply stopped. `when: "after_limit_reset"` replaces the automatic carry-on's default text with yours.
- **Looks dead:** before treating a session as dead (for example after "compaction failed" errors), message its room with a short wait. Only if it does not answer: `session_carry_on` with what it should do next, or a question item proposing a replacement session.

Read the roster before acting, and say in the chat what you did and why in one line.
