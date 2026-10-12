// The process table the idle reaper reads (lib/work-hold.js liveWorkChildren),
// as one `pid ppid args` line per process on every platform.
//
// POSIX: `ps -axo pid=,ppid=,args=` (Linux and macOS alike). Windows has no
// ps; `Get-CimInstance Win32_Process` has the same three columns and a
// `-f` format string prints them in the same shape, so parseProcessTable and
// everything downstream are untouched. It costs a few hundred milliseconds
// and runs at most once per reaper tick, only once some session has passed
// the idle timeout.
import { execFileSync } from 'node:child_process';
import { stripJournalCreds } from './journal-cred-scope.js';

export const WINDOWS_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }";

const WINDOWS_PROCESS_IDENTITY_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine }";

export function processTableCommand(platform = process.platform, identities = false) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', identities ? WINDOWS_PROCESS_IDENTITY_SCRIPT : WINDOWS_PROCESS_TABLE_SCRIPT],
    };
  }
  return { file: 'ps', args: ['-axo', identities ? 'pid=,ppid=,pgid=,sess=,lstart=,args=' : 'pid=,ppid=,args='] };
}

// The restart gate must distinguish a failed probe from a successful empty
// observation. The reaper retains its existing non-strict reader.
export function readProcessTableStrict({ exec = execFileSync } = {}) {
  try {
    const { file, args } = processTableCommand(process.platform, true);
    const timeout = process.platform === 'win32' ? 15000 : 5000;
    const text = exec(file, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: stripJournalCreds(), windowsHide: true });
    return { ok: true, table: parseProcessIdentities(text) };
  } catch {
    return { ok: false };
  }
}

// Preserve start identity separately from argv so PID reuse cannot retain work.
export function parseProcessIdentities(text, platform = process.platform) {
  const table = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pattern = platform === 'win32'
      ? /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/
      : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s*(.*)$/;
    const match = pattern.exec(line);
    if (!match) throw new Error('unavailable');
    const posix = platform !== 'win32';
    table.push({ pid: Number(match[1]), ppid: Number(match[2]),
      ...(posix ? { pgid: Number(match[3]), sid: /^\d+$/.test(match[4]) ? Number(match[4]) : match[4] } : {}),
      startTime: match[posix ? 5 : 3].replace(/\s+/g, ' '), args: match[posix ? 6 : 4].trim() });
  }
  return table;
}
