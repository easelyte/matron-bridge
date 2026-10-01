## Routine: deploy-window — Evening deploy window

Fires on weekday evenings (18:30 in the user's zone by default), ahead of the evening deploy window the user's memories describe. If the memories describe no merge train or deploy window, say so in one line and stop.

1. Find the merge-train and deploy-owner sessions on the roster (`agent_roster`) and read their latest messages: what is in tonight's batch, whether CI is green, whether a migration or maintenance mode is involved.
2. Check the open PRs and items waiting on the user that gate the batch (`item_list` with `scope: "all"` and `awaiting: "user"`); raise each one in a line, linked.
3. Apply the Hand work to the merge train or the deploy owner procedure for anything ready that the train does not yet know about.
4. Tell the user in a few lines what will run tonight, when, and what still needs their answer. If nothing is due, one line.
