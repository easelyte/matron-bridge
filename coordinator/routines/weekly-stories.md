## Routine: weekly-stories — The Projects timeline's weekly stories

Fires once a day (07:10 in the user's zone by default). The Projects timeline shows one story-card list per week; you write it from what the journal recorded. The user does not see this turn, only the timeline.

1. Read the current week with `timeline_week_read` (no `week`): the result is `{ week, quiet }`: `week.week` is the current Monday, and `quiet` is the Went quiet list. Then freeze the weeks before it. Read last week (the Monday seven days earlier). If its `week.stored` is null, or `week.stored.final` is false, write it first, the way step 3 says, with `final: true`. Leave it alone only when `week.stored.final` is true (the top-level `week.final` just says the week has ended, so do not go by it). Then walk back week by week, at most 10 weeks from last week, and freeze each earlier week that has a `stored` row with `stored.final` false. Stop at the first week that is frozen or has no `stored` row (older unwritten weeks are only written by a back-fill), and stop if the journal says a week is out of range.
2. Write the current week the same way, not final: it is rewritten each day until the week ends.
3. How to write a week, with `timeline_week_write`:
   - 3 to 6 stories, each the work that mattered. Group related projects into one story; leave out what was only housekeeping. A short human title, and one sentence on what got done, in plain words a person would say to a colleague. No PR numbers, tracker numbers, links or tool names. Name a story's projects in `project_ids`.
   - A `next` line from the projects' statuses, when there is one.
   - `item_ids` only for items still waiting on the user, taken from `week.projects[].needs_you` (every item on that project still waiting on the user, whether or not it moved that week), so the story shows what needs them.
   - A `media_blob_id` when a picture or video from the week's media shows the work well.
   - A `lede` of 2 to 3 sentences for the whole week, ending with how many things wait on the user, if any: count that from `week.projects[].needs_you`, each item once.
   - In the current week, a one-sentence note in `notes` for each project on the Went quiet list, saying where it was left.
4. Never name private work: the journal refuses a story that does. If a write comes back naming a project or item as unknown or private, drop it and write again.
5. Reply with one line, for example "Wrote the week of <Monday> (4 stories)." Post nothing else.

### Back-fill

When asked to back-fill, write the eight weeks before the current one, oldest first, each with `final: true`, the same way as step 3. For each week, read it with `timeline_week_read` passing its Monday, then write it. If the journal says a week is out of range, skip it and say so. Then report one line per week.
