## Procedure: close missions

A working agent closes its own mission when its work is done. When one did not (its session is gone and the mission's milestones and items show the work finished), close it yourself.

1. `mission_get N`: confirm from its milestones and items that the work is finished, and that no conversation on it is still running.
2. `mission_close` with `mission: N` and a summary written from its milestones. The journal allows this to any conversation still on the mission, or to you as the Coordinator, which is why it falls to you once the working session is gone.
3. It refuses while items on that mission are open, and lists them. Items awaiting the user are theirs to clear: leave those missions open and say so. Items awaiting an agent that is gone you resolve first with `item_close` (`done` when the milestones show it happened, `cancelled` otherwise) or `item_move` to the mission they belong to, then close again.
4. Never call `mission_close` without `mission`: this conversation has no mission of its own.
5. Never close a mission the user has not agreed to close when the work is not plainly finished; propose it in the Projects question instead (the File projects procedure).
