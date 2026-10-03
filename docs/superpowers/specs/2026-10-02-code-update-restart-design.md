# Self-restart onto new code

**Date:** 2026-10-02
**Status:** Built (lib/code-update-restart.js), awaiting merge

## Problem

A rollout (`deploy.sh` on a Mac, yearbook-infra's `update-bridges` on the
guests) pulls the new code onto disk and then defers the restart whenever
the bridge hosts a live agent session, because the restart kills that
session's process. The deferral message is "picks up on the next natural
restart". A bridge whose session is nearly always live has no natural
restart: on 2026-10-02 bev, the Coordinator's box, ran the 14:32 process
all evening with three newer commits on disk, so voice notes went through
local whisper although the journal already held the Azure transcript, and
the Coordinator could not call tools its bridge had on disk. Six other
bridges were in the same state and were restarted by hand.

## Design

The bridge watches its own checkout and restarts itself.

1. **Detect.** Every `MATRON_CODE_UPDATE_POLL_MS` (60 s) read the last line
   of `.git/logs/HEAD` (a worktree's `.git` file is followed to its gitdir).
   That is the newest reflog entry — the same test `update-bridges` uses to
   call a process stale — and gives the sha and the time HEAD moved. The sha
   the process booted on is read once at start. No `git` subprocess.
2. **Settle.** A pull is followed by `npm install` and a preflight. HEAD
   moves at the pull, so an update is not trusted until its reflog entry is
   `MATRON_CODE_UPDATE_SETTLE_MS` (5 min) old. A restart inside that window
   would boot onto half a `node_modules`.
3. **Preflight.** Once per new sha, run the two checks the deploy scripts
   run (`node --check index.js`; import `sharp` and `lib/inline-image.js`)
   in a child process. A failing tree is refused and warned about once; the
   refusal is forgotten when HEAD moves again (the deploy's own rollback).
   The bridge never restarts onto code that cannot boot.
4. **Wait for a quiet moment.** Restart at the first poll with no session
   mid-turn (`session.busy`, the flag `/sessions` reports and
   `restart_session` parks on). A session between turns is killed and
   resumes with its history on its next turn — what a bridge restart has
   always meant for it.
5. **Never mid-turn.** A running turn is never cut off. The first version
   forced the restart after a 30 min cap; on 2026-10-03 at 05:51 UTC that
   killed deploy-1's production deploy shell mid-`cap` (two sessions were
   mid-turn for 31 min). Now the watcher keeps waiting and warns every
   `MATRON_CODE_UPDATE_WARN_EVERY_MS` (30 min). A box can opt in to the old
   behaviour with `MATRON_CODE_UPDATE_FORCE_AFTER_MS`: after that long the
   restart goes ahead mid-turn and section 7 applies. The wait is counted
   from when the update settled, not from boot; a newer update on top
   restarts the clock.
6. **Restart.** The ordinary `gracefulShutdown` (kill every session, flush
   the journal outbox) with exit code 75 (`EX_TEMPFAIL`). Non-zero on
   purpose: launchd's `KeepAlive { SuccessfulExit = false }` relaunches only
   after a non-zero exit; systemd's `Restart=always` and the Windows task's
   restart-on-failure relaunch either way.

7. **Carry on by itself.** (Added the same evening; Dan asked for an
   option.) A forced restart (`MATRON_CODE_UPDATE_FORCE_AFTER_MS`, opt-in) writes `~/.matron-bridge-self-restart.json`
   (`bootId`, `sha`, `busy`) before it exits. The next boot takes the stamp
   (read and removed) and, for every stale inflight marker whose `bootId`
   is the stamp's, publishes a notice and resumes the session with
   `[auto-continue after bridge update] …` 15 s after boot, instead of the
   card. Markers from any other run (a crash, a deploy's own restart) keep
   the tap, and `MATRON_CODE_UPDATE_AUTO_CARRY_ON=0` keeps it for all.
   `takeStale` now returns each marker's `bootId` for this.

`MATRON_CODE_UPDATE_RESTART=0` switches the watcher off. It is also off,
with a log line, when the directory `index.js` runs from has no HEAD reflog.

## Non-goals

- Pulling code. The watcher only reacts to a checkout that moved; the
  deploy scripts still own fetch, install and rollback.
- Resuming every session eagerly at boot. Sessions resume lazily on their
  next turn as before; eager respawn would cost a claude process per idle
  conversation.
- Telling a branch switch from a deploy. HEAD moving by hand in the running
  checkout is a stale process by the fleet script's definition too, and the
  bridge runs from a master checkout; development happens in worktrees.
