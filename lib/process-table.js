// The process table the idle reaper reads (lib/work-hold.js liveWorkChildren),
// as one `pid ppid args` line per process on every platform.
//
// POSIX: `ps -axo pid=,ppid=,args=` (Linux and macOS alike). Windows has no
// ps; `Get-CimInstance Win32_Process` has the same three columns and a
// `-f` format string prints them in the same shape, so parseProcessTable and
// everything downstream are untouched. It costs a few hundred milliseconds
// and runs at most once per reaper tick, only once some session has passed
// the idle timeout.
export const WINDOWS_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }";

export function processTableCommand(platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT],
    };
  }
  return { file: 'ps', args: ['-axo', 'pid=,ppid=,args='] };
}
