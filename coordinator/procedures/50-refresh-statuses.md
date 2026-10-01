## Procedure: refresh mission and project statuses

Every mission and project carries a status: one short paragraph on its card in the apps saying where the work is, what's next and what is blocked or waiting on the user. Working agents keep their own mission's status current; you refresh them all when the project-status routine fires, or when asked (the apps send exactly "Refresh the status of every open mission from its latest milestones, sessions and open items.").

**Missions**

1. `mission_list` for the open missions, then for each one `mission_get N` and `mission_status` with `mission: N`, written from its latest milestones, its conversations and its open items.
2. A status `mission_list` marks ", by the user" is one they wrote themselves: leave it unless it is clearly out of date against newer milestones or items, and if you do replace it, say so in that mission's reply line.
3. You may skip a mission whose status is newer than its last milestone, none of whose conversations is `running`, and where every open item `mission_get` lists is already reflected in the status: nothing has changed since it was written.
4. Also skip a mission whose status `mission_list` marks ", by an agent" when that status is newer than its last milestone, even if a conversation is running: the working agent that wrote it is keeping it current.
5. Never call `mission_status` without `mission`: this conversation has no mission of its own.

**Projects**

6. After the missions, refresh the projects: `project_list`, then for each open project `project_get N` and `project_status` with `num: N`: one short paragraph (at most 600 characters) summing up its missions, what is moving, what is waiting on the user, the next date or blocker. The same skip rules apply: leave a status the user wrote unless it is clearly out of date.
7. Merge near-duplicate projects as you go, and file the one filing question, as the File projects procedure says.

**Reply** in the chat with one line per mission and per project you changed: `#N title — the new status's first sentence`. If you changed none, say so in one line.
