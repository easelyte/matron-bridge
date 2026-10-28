// Read a session's loopback API token header from its 0600 file
// (lib/api-auth.js). The file holds one `Name: value` line. Returns a headers
// object to spread into a fetch call, or {} when there is no usable file (the
// bridge then answers 401, which every caller already treats as a failure).
import fs from 'node:fs';

export function readApiHeaderFile(file) {
  if (typeof file !== 'string' || !file) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const m = /^([A-Za-z0-9-]+):\s*(\S+)\s*$/.exec(text.split('\n')[0] || '');
  return m ? { [m[1]]: m[2] } : {};
}
