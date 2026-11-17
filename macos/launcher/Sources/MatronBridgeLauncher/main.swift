// matron-bridge-launcher: the executable inside "Matron Bridge.app".
//
//   matron-bridge-launcher <repo-dir>
//       Run the bridge: start `/bin/sh <repo-dir>/bin/run-named-node
//       matron-bridge <repo-dir>/index.js` as a child process, stay its
//       parent, pass on signals, and exit the way the child exited.
//   matron-bridge-launcher --request-permissions   (also: no arguments)
//       Ask macOS for Accessibility and Screen Recording, so "Matron Bridge"
//       shows up in System Settings ready to switch on. Run it through
//       `open -a "Matron Bridge" --args --request-permissions`; started from
//       a terminal, the terminal would be the one asking.
//   matron-bridge-launcher --status
//       Print whether this process has Accessibility and Screen Recording.
//   matron-bridge-launcher --version
//
// Why a child and not exec: macOS charges a permission check (Accessibility,
// Screen Recording, Apple Events) to the process responsible for the caller.
// A launchd job is responsible for itself, and every process it starts
// inherits that unless it is spawned with the "disclaim" attribute, which
// nothing here sets. If this binary exec'd node, the responsible code would
// be node again. Spawning keeps it this signed bundle, so the bridge, the
// sessions it starts and the commands they run (osascript, screencapture)
// all count as "Matron Bridge", and node itself needs no permission at all.
//
// The exit status is passed through unchanged, so launchd's KeepAlive
// (restart after an unsuccessful exit) and the bridge's code-update restart
// (exit 75) behave exactly as when launchd ran node directly.

import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch
import Foundation

let toolName = "matron-bridge-launcher"

func log(_ message: String) {
  FileHandle.standardError.write(Data("\(toolName): \(message)\n".utf8))
}

// sysexits(3), as the bridge already uses EX_TEMPFAIL (75) for its restart.
let exUsage: Int32 = 64
let exSoftware: Int32 = 70
let exOSErr: Int32 = 71
let exConfig: Int32 = 78

// MARK: - Permissions

func accessibilityTrusted(prompt: Bool) -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

func printStatus() {
  let ax = accessibilityTrusted(prompt: false)
  let screen = CGPreflightScreenCaptureAccess()
  print("accessibility=\(ax)")
  print("screen-recording=\(screen)")
}

func requestPermissions() -> Never {
  _ = accessibilityTrusted(prompt: true)
  _ = CGRequestScreenCaptureAccess()
  printStatus()
  exit(0)
}

// MARK: - Running the bridge

// Signals launchd, restart.sh or a terminal send to stop or nudge the
// bridge. Each is passed on to the child, which has its own handlers.
let forwardedSignals: [Int32] = [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2]

// Signals the child gets with their default action whatever this process
// does with them (spawned children otherwise inherit SIG_IGN).
let defaultedSignals: [Int32] = forwardedSignals + [SIGPIPE]

// After a child dies of one of these, this process dies of it too, so launchd
// sees the same kind of exit. Any other signal becomes exit 128+signal
// rather than this process faking a crash of its own.
let reraisedSignals: Set<Int32> = [SIGTERM, SIGINT, SIGHUP, SIGKILL]

func cStrings(_ strings: [String]) -> [UnsafeMutablePointer<CChar>?] {
  strings.map { strdup($0) } + [nil]
}

func spawnChild(_ argv: [String]) -> pid_t {
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }

  var defaults = sigset_t()
  sigemptyset(&defaults)
  for sig in defaultedSignals { sigaddset(&defaults, sig) }
  posix_spawnattr_setsigdefault(&attr, &defaults)
  var noMask = sigset_t()
  sigemptyset(&noMask)
  posix_spawnattr_setsigmask(&attr, &noMask)
  // Only stdin, stdout and stderr cross into the child.
  let flags = POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT
  posix_spawnattr_setflags(&attr, Int16(flags))

  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  for fd: Int32 in 0...2 { posix_spawn_file_actions_addinherit_np(&actions, fd) }

  let args = cStrings(argv)
  defer { args.forEach { free($0) } }

  var pid: pid_t = 0
  // No disclaim attribute: the child must stay attributed to this app.
  let rc = posix_spawn(&pid, argv[0], &actions, &attr, args, environ)
  if rc != 0 {
    log("could not start \(argv[0]): \(String(cString: strerror(rc)))")
    exit(exOSErr)
  }
  return pid
}

func runBridge(repoDir: String) -> Never {
  guard repoDir.hasPrefix("/") else {
    log("the repo directory must be an absolute path (got '\(repoDir)')")
    exit(exUsage)
  }
  let repo = repoDir.hasSuffix("/") && repoDir.count > 1 ? String(repoDir.dropLast()) : repoDir
  let runner = "\(repo)/bin/run-named-node"
  guard FileManager.default.fileExists(atPath: runner) else {
    log("\(runner) not found: is \(repo) a matron-bridge checkout?")
    exit(exConfig)
  }
  let argv = ["/bin/sh", runner, "matron-bridge", "\(repo)/index.js"]

  // Signals are handled on one serial queue. One that arrives before the
  // child exists is kept and passed on as soon as it does.
  let queue = DispatchQueue(label: "\(toolName).signals")
  var child: pid_t = 0
  var early: [Int32] = []
  var sources: [DispatchSourceSignal] = []
  for sig in forwardedSignals {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
    source.setEventHandler {
      if child > 0 { kill(child, sig) } else { early.append(sig) }
    }
    source.resume()
    sources.append(source)
  }

  let pid = spawnChild(argv)
  queue.sync {
    child = pid
    for sig in early { kill(pid, sig) }
    early.removeAll()
  }

  var status: Int32 = 0
  while true {
    let r = waitpid(pid, &status, 0)
    if r == pid { break }
    if r == -1 && errno == EINTR { continue }
    log("waitpid failed: \(String(cString: strerror(errno)))")
    exit(exSoftware)
  }
  sources.forEach { $0.cancel() }

  let termsig = status & 0x7f
  if termsig == 0 {
    exit((status >> 8) & 0xff)
  }
  log("bridge (pid \(pid)) was killed by signal \(termsig)")
  if reraisedSignals.contains(termsig) {
    signal(termsig, SIG_DFL)
    var unblock = sigset_t()
    sigemptyset(&unblock)
    sigaddset(&unblock, termsig)
    sigprocmask(SIG_UNBLOCK, &unblock, nil)
    kill(getpid(), termsig)
  }
  exit(128 + termsig)
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())
  // Very old LaunchServices passed a process serial number; ignore it.
  .filter { !$0.hasPrefix("-psn_") }

switch args.first {
case nil, "--request-permissions":
  requestPermissions()
case "--status":
  printStatus()
  exit(0)
case "--version":
  let info = Bundle.main.infoDictionary
  print(info?["CFBundleShortVersionString"] as? String ?? "unknown")
  exit(0)
case "-h", "--help":
  print("usage: \(toolName) <repo-dir> | --request-permissions | --status | --version")
  exit(0)
case let first? where first.hasPrefix("-"):
  log("unknown option \(first)")
  exit(exUsage)
case let repo?:
  guard args.count == 1 else {
    log("usage: \(toolName) <repo-dir>")
    exit(exUsage)
  }
  runBridge(repoDir: repo)
}
