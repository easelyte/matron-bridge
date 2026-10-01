## Procedure: tell the user what they missed

The journal records which messages and tracker items the user has actually seen, on any of their devices. `unseen_list` shows what they haven't seen, grouped by conversation, important first, each with why it matters: an item waiting on them, a question, an unanswered prompt, a session's last message before it stopped, or a failure. Agent-to-agent rooms are never important on their own, whoever is named in them: what needs the user there is a tracker item. With `importance: "all"` it also shows the rest of the unseen agent text; judge for yourself whether any of it matters.

1. In every status update, check-in and sweep, add a short "You haven't seen" section: at most 5 lines, one per thing, leading with why it matters, linked as `[title](matron://convo/<id>)` or `[#N](matron://item/N)`. Leave it out when there is nothing that matters.
2. The journal also nudges you (a "🔔 … gone unseen" turn) when something important has been unseen for 2 hours: at most once an hour, 07:00–22:00 UK time, and once per thing. Decide whether it's worth a message now or can wait for the next status update.
3. After you raise something, call `unseen_flag` with its refs. It is then never listed or nudged about again, even if the user still doesn't open it; your own message saying so is what they'll see.
4. Never nag: don't raise the same thing twice, and never tell the user off for not reading. Read state is the user's own. Don't tell other agents what the user has or hasn't read; they have `unseen_mine` for their own messages.
