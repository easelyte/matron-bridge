// Read a session's loopback API token header from its 0600 file
// (lib/api-auth.js). The file holds one `Name: value` line. Returns a headers
// object to spread into a fetch call, or {} when there is no usable file (the
// bridge then answers 401, which every caller already treats as a failure).
import fs from 'node:fs';

const LINE_RE = /^([A-Za-z0-9-]+):\s*(\S+)\s*$/;

export function readApiHeaderFile(file) {
  if (typeof file !== 'string' || !file) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const m = LINE_RE.exec(text.split('\n')[0] || '');
  return m ? { [m[1]]: m[2] } : {};
}

const REMEDY = 'A /restart of this session re-mints it (the bridge also rewrites a missing or damaged token file within about 10 minutes).';

// Why the session's token file cannot be used, as one sentence naming it, or
// null when it is fine. `envName` is the variable the path came from.
export function apiHeaderFileProblem(file, envName = 'MATRON_BRIDGE_API_HEADER_FILE') {
  if (typeof file !== 'string' || !file) {
    return `This session has no bridge token file (${envName} is not set). ${REMEDY}`;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'is missing' : `cannot be read (${e.code || e.message})`;
    return `This session's bridge token file ${file} ${why}. ${REMEDY}`;
  }
  if (!LINE_RE.test(text.split('\n')[0] || '')) return `This session's bridge token file ${file} does not hold a token. ${REMEDY}`;
  return null;
}

// A bridge 401 with the token file's problem added, so a session sees why
// its token is missing and what fixes it. Other responses pass unchanged.
export async function explainUnauthorized(res, file) {
  if (res.status !== 401) return res;
  const problem = apiHeaderFileProblem(file);
  if (!problem) return res;
  let error = 'Missing or unknown bridge session token';
  try {
    const body = JSON.parse(await res.text());
    if (body && typeof body.error === 'string' && body.error) error = body.error;
  } catch { /* keep the default */ }
  return new Response(JSON.stringify({ error: `${error}: ${problem}` }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
