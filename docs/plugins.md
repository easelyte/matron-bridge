# Bridge plugins

A plugin is an ES module that adds RPC methods to the bridge. **A plugin runs
inside the bridge process with full bridge privileges**: it can read the
bridge's files and tokens, run commands as the bridge's user and reach every
session. Install only code you have read and trust.

## Enabling

Set `MATRON_BRIDGE_PLUGINS` to a comma-separated list of absolute module
paths. It is empty by default and read once at startup; a change takes effect
the next time the bridge starts. The bridge refuses (logs, skips, and keeps
going) a plugin whose file:

- has a relative path;
- sits under `DEFAULT_WORKDIR` or any session folder;
- is not owned by the bridge's user;
- is writable by group or others;
- sits under a directory (any level up to `/`) that is writable by group or
  others, unless that directory is sticky and owned by root (like `/tmp`), or
  that is owned by someone other than root or the bridge's user.

A plugin whose import or `register()` has not finished after 10 seconds is
logged and skipped the same way; the bridge keeps starting.

Symlinks are followed and the checks apply to the resolved file, which is also
the file that gets imported.

## Writing one

```js
export default function register({ log }) {
  return {
    name: 'demo', // lowercase letters and digits
    handlers: {
      // Return the result (or a promise of it); do not answer yourself.
      x_demo_ping: async (params, { request }) => ({ pong: true }),
    },
  };
}
```

Every method must be named `x_<name>_<method>`. A plugin that names a method
the bridge already has is refused whole.

## Behaviour

The bridge answers every call exactly once: your return value is the result;
a throw or rejection becomes an `internal` error. While the account is locked,
or the box is in lockdown or locked mode with no unlock window open, calls are
refused (`account_locked`, `box_locked`) before your code runs.

At startup the bridge logs each loaded plugin and its methods, and the hello
and `box_status` frames carry `plugins: [{ name, methods }]`.
