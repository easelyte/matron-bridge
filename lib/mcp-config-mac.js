// Rewrite MCP server entries that wrap their real command with a virtual-
// framebuffer launcher — the repo's hooks/xvfb-wrap.sh, or legacy `xvfb-run`
// — so they can run on macOS, which has no virtual framebuffer. The Linux
// baseline `mcp-config.json` uses the wrapper so chrome-devtools gets a
// display under systemd. On macOS the wrapper is missing entirely (Xvfb is
// Linux-only), so we unwrap to the real command. Any Linux `--no-sandbox`
// flags a local overlay still carries are dropped too: Chrome's sandbox
// works on macOS without them.
//
// Pure / side-effect free so it can be unit tested without faking
// process.platform.

const LINUX_CHROME_SANDBOX_FLAGS = new Set([
  '--no-sandbox',
  '--disable-setuid-sandbox',
]);

const LINUX_CHROME_SANDBOX_ARGS = new Set([
  '--chromeArg=--no-sandbox',
  '--chromeArg=--disable-setuid-sandbox',
]);

// The repo's own leak-proof xvfb-run replacement (hooks/xvfb-wrap.sh). By the
// time macify runs, buildMcpServers may already have resolved the command to
// an absolute path, so match on the basename — anchored so a command that
// merely contains the name (e.g. not-xvfb-wrap.sh) is left alone.
const XVFB_WRAP_RE = /(?:^|\/)xvfb-wrap\.sh$/;

function macifyServer(server) {
  if (!server || typeof server.command !== 'string') return server;

  let newCommand;
  let newArgs;
  if (XVFB_WRAP_RE.test(server.command)) {
    // xvfb-wrap.sh invocation shape: [realCommand, ...realArgs] — no wrapper
    // flags, the Xvfb configuration is baked into the script.
    const wrappedArgs = Array.isArray(server.args) ? server.args : [];
    if (wrappedArgs.length === 0) return server;
    newCommand = wrappedArgs[0];
    newArgs = wrappedArgs.slice(1).filter((a) => !LINUX_CHROME_SANDBOX_ARGS.has(a));
  } else if (server.command === 'xvfb-run') {
    const wrappedArgs = Array.isArray(server.args) ? server.args : [];
    // xvfb-run invocation shape: [--auto-servernum, --server-args=..., realCommand, ...realArgs]
    // The first arg that doesn't start with `--` is the real command.
    let i = 0;
    while (i < wrappedArgs.length && wrappedArgs[i].startsWith('--')) i++;
    if (i >= wrappedArgs.length) return server;
    newCommand = wrappedArgs[i];
    newArgs = wrappedArgs
      .slice(i + 1)
      .filter((a) => !LINUX_CHROME_SANDBOX_ARGS.has(a));
  } else {
    return server;
  }

  const newEnv = { ...(server.env || {}) };
  if (typeof newEnv.PUPPETEER_LAUNCH_OPTIONS === 'string') {
    try {
      const opts = JSON.parse(newEnv.PUPPETEER_LAUNCH_OPTIONS);
      if (Array.isArray(opts.args)) {
        opts.args = opts.args.filter((a) => !LINUX_CHROME_SANDBOX_FLAGS.has(a));
        if (opts.args.length === 0) delete opts.args;
      }
      newEnv.PUPPETEER_LAUNCH_OPTIONS = JSON.stringify(opts);
    } catch {
      // Leave the env var alone if it isn't valid JSON; we'd rather pass
      // through unchanged than silently mangle an operator override.
    }
  }

  const out = { ...server, command: newCommand, args: newArgs };
  if (Object.keys(newEnv).length > 0) out.env = newEnv;
  else delete out.env;
  return out;
}

export function macifyMcpServers(config) {
  if (!config || typeof config !== 'object' || !config.mcpServers) return config;
  const next = { ...config, mcpServers: { ...config.mcpServers } };
  for (const name of Object.keys(next.mcpServers)) {
    next.mcpServers[name] = macifyServer(next.mcpServers[name]);
  }
  return next;
}
