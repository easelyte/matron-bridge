// Firewall-friendly process names on macOS.
//
// bin/run-named-node starts the bridge and the viewer from a copy of the node
// binary named for the process (e.g. $HOME/.matron/bin/matron-bridge), so a
// per-app firewall can tell them apart from every other Node program. These
// helpers let the bridge pass that name on to the Node children it starts,
// and still find the real node binary for children that look `node` up on
// PATH. On any other platform, or when the bridge runs under plain node, every
// helper returns its input unchanged.

import path from 'node:path';

// True when this process runs from a named copy made by bin/run-named-node.
export function isNamedNode(execPath = process.execPath, platform = process.platform) {
  return platform === 'darwin' && typeof execPath === 'string' && path.basename(execPath).startsWith('matron-');
}

// The node binary a named copy was made from (bin/run-named-node exports it as
// MATRON_REAL_NODE). The copy's own directory holds no `node`, so code that
// puts "the directory of the running node" on PATH must use this one instead.
export function realNodePath({ execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
  if (isNamedNode(execPath, platform) && env?.MATRON_REAL_NODE) return env.MATRON_REAL_NODE;
  return execPath;
}

// MCP servers whose command is exactly `node` run with the named copy, so
// they show under the bridge's name too. Returns `servers` itself when there
// is nothing to change.
export function withNamedNodeCommands(servers, { execPath = process.execPath, platform = process.platform } = {}) {
  if (!isNamedNode(execPath, platform)) return servers;
  const out = {};
  for (const [name, srv] of Object.entries(servers)) {
    out[name] = srv && srv.command === 'node' ? { ...srv, command: execPath } : srv;
  }
  return out;
}
