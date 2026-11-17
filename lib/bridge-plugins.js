// Bridge plugins: operator-installed ES modules that add RPC methods.
//
// MATRON_BRIDGE_PLUGINS is a comma-separated list of absolute module paths,
// empty by default and read once at startup. A plugin runs inside the bridge
// process with every privilege the bridge has, so the loader is strict about
// where a module may live: it refuses a relative path, a file under a
// session folder, a file the bridge's user does not own, and a file that
// group or others can write, or one inside a directory they could replace it
// from. The checks run on the resolved file (symlinks
// followed), and that same resolved path is the one imported.
//
// A module's default export is `register(api)`, returning
// `{ name, handlers: { x_<name>_<method>: fn(params, { request }) } }`.
// `name` is lowercase letters and digits. Handlers return the result (or a
// promise of it); lib/journal-rpc.js answers, wraps and collision-checks them.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const NAME_RE = /^[a-z][a-z0-9]{0,31}$/;
const METHOD_TAIL_RE = /^[a-z0-9_]+$/;

const DEFAULT_TIMEOUT_MS = 10_000;

// Rejects if `promise` has not settled within `ms`. The plugin keeps running in
// the background (a module cannot be cancelled), but the bridge stops waiting.
const withTimeout = (promise, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isUnder = (file, dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// Checks `file`: {real} (the resolved path, the one to import) or {refusal}.
// `forbiddenDirs`: the default folder and every session folder.
export function checkPluginPath(file, { forbiddenDirs = [], uid = process.getuid?.() } = {}) {
  if (!path.isAbsolute(file)) return { refusal: 'path is not absolute' };
  if (uid === undefined) return { refusal: 'cannot check file ownership on this platform' };
  let link;
  let real;
  try {
    link = fs.lstatSync(file);
    real = fs.realpathSync(file);
  } catch (e) {
    return { refusal: `cannot read the file (${e.code || e.message})` };
  }
  if (link.isSymbolicLink() && link.uid !== uid) return { refusal: 'symlink is not owned by the bridge user' };
  const st = fs.statSync(real);
  if (!st.isFile()) return { refusal: 'not a regular file' };
  if (st.uid !== uid) return { refusal: 'file is not owned by the bridge user' };
  if (st.mode & 0o022) return { refusal: 'file is writable by group or others' };
  for (const dir of forbiddenDirs) {
    const dirs = [path.resolve(dir), realOrNull(dir)].filter(Boolean);
    if (dirs.some((d) => isUnder(real, d) || isUnder(path.resolve(file), d))) return { refusal: `file is under a session folder (${dir})` };
  }
  // Every directory above the file: replacing the file or a parent needs
  // write access to one of them. Group/world-writable is refused unless
  // sticky and root-owned (like /tmp); an owner other than root or the
  // bridge's user is refused.
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const d = fs.statSync(dir);
    if (d.uid !== 0 && d.uid !== uid) return { refusal: `directory ${dir} is owned by another user` };
    const sticky = (d.mode & 0o1000) !== 0 && d.uid === 0;
    if (d.mode & 0o022 && !sticky) return { refusal: `directory ${dir} is writable by group or others` };
    if (dir === path.dirname(dir)) break;
  }
  return { real };
}

// Loads every module named in env.MATRON_BRIDGE_PLUGINS. A refused or broken
// plugin (including one whose import or register() takes longer than 10 s) is
// logged and skipped; the bridge still starts. Returns
// [{name, file, handlers}].
export async function loadBridgePlugins({ env = process.env, forbiddenDirs = [], log = console, uid, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const list = (env.MATRON_BRIDGE_PLUGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const loaded = [];
  for (const file of list) {
    const refuse = (why) => log.warn?.(`[bridge-plugins] refused ${file}: ${why}`);
    try {
      // Inside the catch: a file or parent that vanishes mid-check skips this
      // plugin rather than aborting startup.
      const checked = checkPluginPath(file, { forbiddenDirs, ...(uid === undefined ? {} : { uid }) });
      if (checked.refusal) { refuse(checked.refusal); continue; }
      const mod = await withTimeout(import(pathToFileURL(checked.real).href), timeoutMs, 'import');
      if (typeof mod.default !== 'function') { refuse('no default export register(api)'); continue; }
      const out = await withTimeout(Promise.resolve().then(() => mod.default({ log })), timeoutMs, 'register()');
      const name = out?.name;
      if (typeof name !== 'string' || !NAME_RE.test(name)) { refuse('name must be lowercase letters and digits'); continue; }
      if (loaded.some((p) => p.name === name)) { refuse(`plugin name ${name} already loaded`); continue; }
      const prefix = `x_${name}_`;
      const methods = out.handlers && typeof out.handlers === 'object' ? Object.entries(out.handlers) : [];
      const badMethod = methods.find(([m, fn]) => !m.startsWith(prefix) || !METHOD_TAIL_RE.test(m.slice(prefix.length)) || typeof fn !== 'function');
      if (badMethod) { refuse(`method ${badMethod[0]} must be a function named ${prefix}<method>`); continue; }
      loaded.push({ name, file, handlers: Object.fromEntries(methods) });
    } catch (e) {
      refuse(`failed to load: ${e?.message ?? String(e)}`);
    }
  }
  return loaded;
}
