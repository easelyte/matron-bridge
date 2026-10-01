import { describe, it, expect } from 'vitest';
import { processTableCommand, WINDOWS_PROCESS_TABLE_SCRIPT } from '../lib/process-table.js';
import { parseProcessTable, liveWorkChildren, mcpServerSignatures } from '../lib/work-hold.js';

describe('processTableCommand', () => {
  it('ps on POSIX', () => {
    expect(processTableCommand('linux')).toEqual({ file: 'ps', args: ['-axo', 'pid=,ppid=,args='] });
    expect(processTableCommand('darwin')).toEqual({ file: 'ps', args: ['-axo', 'pid=,ppid=,args='] });
  });

  it('a non-interactive PowerShell Get-CimInstance one-liner on win32', () => {
    const cmd = processTableCommand('win32');
    expect(cmd.file).toBe('powershell.exe');
    expect(cmd.args).toContain('-NoProfile');
    expect(cmd.args).toContain('-NonInteractive');
    expect(cmd.args.at(-1)).toBe(WINDOWS_PROCESS_TABLE_SCRIPT);
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toMatch(/Win32_Process/);
  });
});

describe('Windows process table output', () => {
  // What the PowerShell one-liner prints, CRLF line endings, a protected
  // process with no CommandLine, and backslash paths.
  const output = [
    '4 0 ',
    '100 4 C:\\WINDOWS\\system32\\services.exe',
    '2000 100 "C:\\Users\\u\\.local\\bin\\claude.exe" --print --session-id x',
    '2100 2000 "C:\\Program Files\\nodejs\\node.exe" C:\\bridge\\ask-user.js',
    '2200 2000 C:\\Program Files\\Git\\usr\\bin\\bash.exe -c "rake test"',
    '2300 2200 ruby.exe rake test',
  ].join('\r\n') + '\r\n';

  it('parses into the same rows ps gives', () => {
    const rows = parseProcessTable(output);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ pid: 4, ppid: 0, args: '' });
    expect(rows[3]).toEqual({ pid: 2100, ppid: 2000, args: '"C:\\Program Files\\nodejs\\node.exe" C:\\bridge\\ask-user.js' });
  });

  it('finds the work children under claude, minus the configured MCP server', () => {
    const table = parseProcessTable(output);
    const sigs = mcpServerSignatures({ 'ask-user': { command: 'node', args: ['C:\\bridge\\ask-user.js'] } });
    const work = liveWorkChildren(2000, table, sigs).map(p => p.pid);
    expect(work).toEqual([2200, 2300]);
  });

  it('treats node.exe as a launcher, so an absolute-node-path server is not work', () => {
    const table = parseProcessTable('1 0 x\r\n2 1 C:\\nodejs\\node.exe C:\\bridge\\ask-user.js\r\n3 1 C:\\work\\job.exe\r\n');
    const sigs = mcpServerSignatures({ s: { command: 'C:\\nodejs\\node.exe', args: ['C:\\bridge\\ask-user.js'] } });
    expect(liveWorkChildren(1, table, sigs).map(p => p.pid)).toEqual([3]);
  });

  it('matches a server by basename through a backslash path', () => {
    const table = parseProcessTable('1 0 x\r\n2 1 C:\\tools\\some-mcp.exe --flag\r\n3 1 C:\\work\\job.exe\r\n');
    const sigs = mcpServerSignatures({ s: { command: 'uvx', args: ['some-mcp.exe'] } });
    expect(liveWorkChildren(1, table, sigs).map(p => p.pid)).toEqual([3]);
  });
});
