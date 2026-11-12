## Routine: weekly-stories — The Projects timeline's weekly stories

Fires once a day (07:10 in the user's zone by default). Projects shows one card per project per week; you write them from what the journal recorded. The user does not see this turn, only Projects.

1. Read the current week in two reads with `timeline_week_read`, never page by page:
   - First its index: `index: true` (no `week`). The result is text, in this order:
     - For the current week only, a first line `quiet (n of total): …`: the Went quiet list.
     - A line `index: …`: the whole week as JSON. `week` is the Monday, `stored` is what is already written for the week, and `projects` lists every project that moved, most moves first, each with how much: `moved`, and counts of its milestones, things done, things waiting on the user and media.
     - A last line saying what to do next. A line before it says so when some of the least active projects did not fit and are not listed.
   - From the index choose the projects whose week mattered: up to 12 candidates. The counts say how much a project moved, not whether it mattered, so go by the titles as well.
   - Then read their detail: `timeline_week_read` with the same `week` and `projects: [...]`, their ids or numbers, up to 12 a call. The result is a line `week: …` with those projects only, each with its milestones, its status, its items and its media. If a last line says some were left out to fit, ask for those in another call.

   Never read a week a page at a time (with `offset`) for this routine: a week can have hundreds of projects. If a week's index cannot be read (the read is refused, or the journal predates the index), write nothing for that week, never freeze it, and say so in your reply.
2. Freeze the weeks before the current one. Read the index of last week (the Monday seven days earlier). If its `stored` is null, or `stored.final` is false, read the detail of the projects that mattered and write it first, the way step 4 says, with `final: true`. Leave it alone only when `stored.final` is true (the top-level `final` just says the week has ended, so do not go by it). Then walk back week by week, at most 10 weeks from last week, reading each week's index, and freeze each earlier week that has a `stored` row with `stored.final` false. Stop at the first week that is frozen or has no `stored` row (older unwritten weeks are only written by a rewrite), and stop if the journal says a week is out of range.
3. Write the current week the same way, not final: it is rewritten each day until the week ends.
4. How to write a week, with `timeline_week_write` (`week`, `entries`, and `final` and `notes` when they apply):
   - One entry per project, at most 8: the projects whose week mattered. Leave out a project whose week was only housekeeping. When more than 8 mattered, write the 8 that mattered most; the app lists the others by itself. A week in which nothing mattered is `entries: []`.
   - `project` is the project's id or its number, from the index or the detail.
   - `sentence` is one plain sentence on what got done in that project that week, in words a person would say to a colleague. The project's name is the card's title, so do not repeat it. No PR numbers, tracker numbers, links or tool names.
   - `next` only when the project's status gives a real next step. Leave it out otherwise.
   - `media_blob_id` when a picture or video from that project's media for the week shows the work well.
   - Nothing else. No summary of the whole week, no titles, and no lists of items: the app counts what waits on the user and what got done by itself.
   - In the current week, a one-sentence note in `notes` (`project_id` and `note`) for each project on the Went quiet list, saying where it was left.
5. Never name private work: the journal refuses an entry that does. If a write comes back naming a project as unknown or private, drop that entry and write again.
6. Reply with one line, for example "Wrote the week of <Monday> (4 projects)." When a week's index could not be read, add one more line saying which week and that it was left unwritten. Post nothing else.

### Rewrite

When asked to rewrite the weeks, go week by week, oldest first, from the oldest week the journal accepts (about ten weeks back) up to the current one. Before rewriting, the re-filing of projects into goals should be finished: weeks are told per project, so a week rewritten while projects are still being re-filed would have to be rewritten again. If it is still going on, say so and wait.

1. Read the week's index: `timeline_week_read` passing its Monday and `index: true`.
2. Rewrite it when its `stored` is null or its `stored.legacy` is true (a week written before there was one card per project). Leave any other week as it is.
3. For a week to rewrite, choose the projects that mattered from the index and read their detail with `projects: [...]`, as step 1 says. Write it the way step 4 says, with `final: true`, except the current week, which is written not final.
4. If the journal says a week is out of range, skip it and say so. If a week's index cannot be read, leave the week as it is and say so.
5. Then report one line per week: rewritten and how many projects, left as it was, or skipped and why.
