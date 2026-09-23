// The isolated-home variables test/setup-isolated-home.js installed in this
// worker. Spread into any child env a test builds from scratch (instead of
// inheriting process.env): a child with no HOME falls back to the OS account's
// passwd home, i.e. the developer's REAL home, and a tool like codex would then
// read and write the real ~/.codex.
const HOME_KEYS = [
  'HOME', 'USERPROFILE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
];

export function isolatedHomeEnv() {
  const out = {};
  for (const key of HOME_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}
