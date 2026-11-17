# Matron Bridge.app (macOS launcher)

On macOS, a permission such as Accessibility or Screen Recording belongs to
the program asking for it. Without this app the bridge runs as Homebrew's
`node`, so a grant for the bridge is a grant for every script that node
binary ever runs, and a node upgrade can silently drop it.

`Matron Bridge.app` is a tiny signed app that the bridge's launchd service
runs instead. It starts the bridge as its child and stays its parent. macOS
charges a permission check to the process *responsible* for the caller, and
children inherit that responsibility. So the bridge, the sessions it starts
and the commands they run (`osascript`, `screencapture`) all show up in
System Settings as **Matron Bridge**, and node needs no permission at all.

Linux and Windows are unchanged.

## What is in here

| File | What it is |
|---|---|
| `Sources/MatronBridgeLauncher/main.swift` | The launcher. |
| `Package.swift` | Swift package that builds it. |
| `Info.plist` | The bundle's Info.plist: identifier `chat.matron.bridge`, `LSUIElement` (no Dock icon), `NSAppleEventsUsageDescription`. |
| `launcher.entitlements` | Hardened-runtime entitlements: only `com.apple.security.automation.apple-events`. |
| `build-sign-notarize.sh` | Builds a universal binary, assembles the bundle, signs it and optionally notarises it. |

`setup/install-launcher-macos.sh` installs a built app, and
`setup/service-macos.sh` points the bridge service at it.

## How the launcher behaves

`matron-bridge-launcher <repo-dir>` runs
`/bin/sh <repo-dir>/bin/run-named-node matron-bridge <repo-dir>/index.js`
with the environment and working directory launchd gives it, then:

- **Spawns, never execs.** After an exec the process's code would be node
  again, and macOS would ask about node.
- **Never disclaims.** The child is spawned without the "disclaim
  responsibility" attribute, so its checks land on the app.
- **Passes signals on.** SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 and
  SIGUSR2 go to the child, which has its own handlers. The child stays in the
  launcher's process group, so launchd still cleans up stray processes when
  the job stops.
- **Exits the way the child did.** The child's exit code is passed through,
  and if the child dies of SIGTERM, SIGINT, SIGHUP or SIGKILL the launcher
  dies of the same signal (any other signal becomes exit 128+signal).
  launchd's `KeepAlive { SuccessfulExit = false }` and the bridge's
  code-update restart (exit 75) therefore work exactly as before.

Other modes:

- `--request-permissions` (also: no arguments) asks macOS for Accessibility
  and Screen Recording, so the app's rows appear in System Settings ready to
  switch on. Start it with `open`, not from a terminal: from a terminal, the
  terminal is the responsible process.
- `--status` prints whether this process has both permissions.
- `--version` prints the app version.

## Building

```sh
# Local test build, signed ad hoc. macOS ties grants for an ad hoc app to
# that exact build, so each rebuild needs them granted again.
macos/launcher/build-sign-notarize.sh --identity -

# Release build: Developer ID signature, notarised and stapled.
security find-identity -v -p codesigning     # pick the Developer ID Application line
xcrun notarytool store-credentials matron-notary \
  --key /path/to/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-uuid>
macos/launcher/build-sign-notarize.sh \
  --identity <40-character fingerprint> --version 1.0.0 \
  --notarize --keychain-profile matron-notary
```

Pass the identity as its fingerprint when the keychain holds two
certificates with the same name. Notarising needs an App Store Connect API
key with the Developer role or higher; `store-credentials` keeps it in the
keychain, so it is never typed on a command line again.

The output is `macos/launcher/build/Matron Bridge.app` and
`macos/launcher/build/Matron-Bridge-<version>.zip`.

## Installing and switching the service over

```sh
bash setup/install-launcher-macos.sh macos/launcher/build/Matron-Bridge-1.0.0.zip --team-id <team id>
bash setup/service.sh
open -a "$HOME/Applications/Matron Bridge.app" --args --request-permissions
```

Then, in System Settings ▸ Privacy & Security, switch on **Matron Bridge**
under Accessibility and Screen Recording, and remove the old `node` (or
`matron-bridge`) rows.

The team ID is the 10-character code in brackets after the signing
certificate's name, also shown as `TeamIdentifier` by
`codesign -dv "Matron Bridge.app"`. A first
install needs it, because Gatekeeper accepts an app signed by any Developer
ID team; updates may leave it out and must then match the installed app.

The installer checks the app's signature, bundle identifier and Gatekeeper
verdict, and that its team matches `--team-id` or the app already installed,
before it swaps the new app in by rename. Between the two renames there is a
moment with no app at the path; a bridge starting in that moment fails and
launchd's KeepAlive starts it again. `setup/service.sh` uses the app
only when it is installed at `$HOME/Applications/Matron Bridge.app` (or
`MATRON_LAUNCHER_APP`) and its signature verifies; otherwise it writes the
plain node service as before. `MATRON_LAUNCHER=0` opts out. Only the bridge
service (`SCOPE=user`) runs under the app; the viewer and `SCOPE=system`
installs are unchanged.

The launchd plist runs the app's executable directly. Never use
`open -a` there: `open` returns at once, so launchd would lose the process,
and with it KeepAlive and the code-update restart.

## Updates and grants

- **Bridge code updates** don't touch the app: the JS stays in the git
  checkout, and the code-update restart works as before.
- **App updates** are needed only when the launcher itself changes. Install
  the new zip with `setup/install-launcher-macos.sh`; the running bridge
  switches over at its next restart.
- **Grants survive app updates** as long as the bundle identifier and the
  signing team stay the same: macOS stores each grant with the app's
  designated requirement, which names the identifier and the team, not one
  build. Changing either, or signing ad hoc, loses them.
- **Node upgrades no longer matter** for permissions, since node is never the
  responsible process.

## Scope of a grant

Everything the bridge starts inherits the app's permissions, including every
agent session on that Mac. That is much narrower than granting node, but it
is still every session on the machine.

macOS 15 and later may ask from time to time to re-confirm Screen Recording;
a signed app does not avoid that.
