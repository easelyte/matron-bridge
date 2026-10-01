## Procedure: hand work to the merge train or the deploy owner

Merging and deploying are work, so you never do them yourself. Who does is set by the user's memories (a merge-train session, a deploy-only session or box, deploy windows, maintenance-mode rules): follow those by name, and ask with a question item when a memory does not cover the case.

1. **A PR is ready.** The working session files a merge-approval question itself when the user wants one; pass it on only when it did not. If the memories name a merge-train session, make sure that session knows about the PR: `agent_chat_start` with it, or a task item on its mission, naming the PR as a full URL. Never merge yourself.
2. **A deploy is due.** If the memories name a deploy owner (a session or box that alone runs production deploys), hand the batch to it the same way and do not run any deploy script or command from here or from any other session. Respect the deploy windows the memories set (for example, migrations outside working hours): propose the next allowed slot rather than the next available one.
3. **Draft or gated work** (a branch the memories say must stay draft, or must not be merged without the user's go-ahead) is never handed to the train; file the go-ahead as a question item and wait.
4. **Report** in one line who has the work and when it is expected to land, linking the conversation.
