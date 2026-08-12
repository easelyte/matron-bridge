import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { watch as fsWatch, existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { generateSignedUrl, verifyToken } from '../lib/viewer-tokens.js';
import { validateAndOpen, FileLinkDenied, MAX_DOWNLOAD_BYTES } from '../lib/file-link-guard.js';
export { generateSignedUrl, verifyToken };

// Port resolution with a legacy-name fallback: the Matrix→Matron rename left
// old .envs setting MATRIX_VIEWER_PORT, and the silent default fallback bound
// the viewer on 9803 while the Cloudflare tunnel forwarded to the configured
// port — a 502 with both services "active" (2026-08-10). Honour the stale
// name so an un-migrated .env keeps working, but warn loudly so it gets fixed.
export function resolveViewerPort(env = process.env, warn = console.warn) {
  if (env.MATRON_VIEWER_PORT) return env.MATRON_VIEWER_PORT;
  if (env.MATRIX_VIEWER_PORT) {
    warn('[viewer] MATRIX_VIEWER_PORT is the stale pre-rename name — rename it to MATRON_VIEWER_PORT in .env. Using its value for now.');
    return env.MATRIX_VIEWER_PORT;
  }
  return 9803;
}

const PORT = resolveViewerPort();
const SECRET = process.env.HMAC_SECRET;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Escape a value for interpolation into HTML text or attribute context.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Syntax highlighting via highlight.js CDN
function renderHtml(filename, content) {
  const escaped = escapeHtml(content);

  // Only [A-Za-z0-9_-] extensions make sense as a highlight.js language
  // class; anything else is dropped rather than interpolated into HTML.
  const ext = path.extname(filename).slice(1).replace(/[^A-Za-z0-9_-]/g, '');
  const langClass = ext ? `language-${ext}` : '';
  const safeFilename = escapeHtml(filename);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeFilename}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    .header { padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 14px; }
    .filename { font-weight: 600; }
    pre { margin: 0; padding: 16px 20px; overflow-x: auto; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="header"><span class="filename">${safeFilename}</span></div>
  <pre><code class="${langClass}">${escaped}</code></pre>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>hljs.highlightAll();</script>
</body>
</html>`;
}

function renderSecretForm(label, token) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enter Secret</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 32px; max-width: 480px; width: 100%; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    .label { color: #8b949e; margin-bottom: 20px; font-size: 14px; }
    input[type="password"] { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 14px; box-sizing: border-box; }
    input[type="password"]:focus { outline: none; border-color: #58a6ff; }
    button { margin-top: 16px; padding: 10px 24px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
    button:hover { background: #2ea043; }
    .note { margin-top: 12px; font-size: 12px; color: #8b949e; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔐 Enter Secret</h2>
    <div class="label">${escapeHtml(label)}</div>
    <form method="POST" action="/secret">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input type="password" name="value" placeholder="Paste secret here..." autofocus required>
      <button type="submit">Submit</button>
    </form>
    <div class="note">This value will be written to a secure file and auto-deleted after 1 hour. It will not appear in chat.</div>
  </div>
</body>
</html>`;
}

function renderSecretSuccess() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secret Submitted</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; padding: 40px; }
    h2 { color: #3fb950; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✅ Secret submitted</h2>
    <p>The secret has been securely saved. You can close this tab.</p>
  </div>
</body>
</html>`;
}

// Resolve the name the browser saves sensitive content under. Explicit
// filename wins; otherwise a filename-looking token in the label; otherwise
// a label slug. Always reduced to a safe basename (no separators, no leading
// dot) — the value comes from the bridge API but ends up in an <a download>
// attribute and on the user's disk.
export function sensitiveFilename(label, filename) {
  const sanitize = (name) =>
    String(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, 128);
  if (filename) {
    const clean = sanitize(filename);
    if (clean) return clean;
  }
  const inLabel = String(label ?? '').match(/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/);
  if (inLabel) {
    const clean = sanitize(inLabel[0]);
    if (clean) return clean;
  }
  const slug = String(label ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'sensitive-data'}.txt`;
}

// Shell page for one-time sensitive data. Deliberately contains NO secret:
// browsers, Safe Browsing, and Matrix URL previewers all GET links before or
// as the user clicks them, and with a one-time store the prefetch used to BE
// the view ("already been viewed" before the user ever saw it). The secret
// only moves on POST /sensitive/reveal, which nothing automated sends —
// mode 'view' shows it in-page, mode 'download' saves it straight to a file.
function renderSensitiveShell(label, token, mode, oneTime = true) {
  const labelEscaped = escapeHtml(label);
  const tokenJson = scriptJsonString(token);
  const modeJson = scriptJsonString(mode);
  // Must agree with what the chat notification promised: a share created with
  // one_time:false stays usable until it expires, and telling the user it is
  // one-time makes them treat a live secret as spent.
  const warning = oneTime
    ? '⚠️ This is a one-time link.'
    : '⚠️ This link can be used more than once, until it expires.';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${labelEscaped}</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; }
    .header { padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 20px; }
    .label { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .warning { color: #f85149; font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .note { color: #8b949e; font-size: 13px; margin-top: 8px; }
    .content { padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; position: relative; }
    .content pre { margin: 0; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
    .btns { position: absolute; top: 12px; right: 12px; display: flex; gap: 8px; }
    button { padding: 10px 24px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #2ea043; }
    .btns button { padding: 6px 12px; font-size: 12px; font-weight: 400; }
    .btns button.copied { background: #1f6feb; }
    .dl-btn { background: #1f6feb !important; }
    .dl-btn:hover { background: #388bfd !important; }
    .error { color: #f85149; }
  </style>
</head>
<body>
  <div class="header">
    <div class="label">🔐 ${labelEscaped}</div>
    <div class="warning">${warning}</div>
    <div class="note">Nothing has been revealed yet — the data is fetched only when you press the button below.</div>
  </div>
  <div class="content" id="box">
    <button id="go"></button>
  </div>
  <script>
    const TOKEN = ${tokenJson};
    const MODE = ${modeJson};
    const box = document.getElementById('box');
    const go = document.getElementById('go');
    go.textContent = MODE === 'download' ? 'Download' : 'Reveal';

    function saveBlob(content, filename) {
      const blob = new Blob([content], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    }

    function showRevealed(data) {
      box.textContent = '';
      const btns = document.createElement('div');
      btns.className = 'btns';
      const dl = document.createElement('button');
      dl.className = 'dl-btn';
      dl.textContent = 'Download';
      dl.onclick = () => saveBlob(data.content, data.filename);
      const cp = document.createElement('button');
      cp.className = 'copy-btn';
      cp.textContent = 'Copy';
      cp.onclick = () => navigator.clipboard.writeText(data.content).then(() => {
        cp.textContent = 'Copied!';
        cp.classList.add('copied');
        setTimeout(() => { cp.textContent = 'Copy'; cp.classList.remove('copied'); }, 2000);
      });
      btns.append(dl, cp);
      const pre = document.createElement('pre');
      pre.textContent = data.content;
      box.append(btns, pre);
    }

    go.onclick = async () => {
      go.disabled = true;
      try {
        const res = await fetch('/sensitive/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        });
        const data = await res.json();
        if (!res.ok) {
          box.textContent = '';
          const p = document.createElement('p');
          p.className = 'error';
          p.textContent = '⚠️ ' + (data.error || 'Failed to retrieve the data');
          box.append(p);
          return;
        }
        if (MODE === 'download') {
          saveBlob(data.content, data.filename);
          box.textContent = 'Saved as ' + data.filename + '. You can close this tab.';
        } else {
          showRevealed(data);
        }
      } catch (e) {
        go.disabled = false;
        alert('Failed to retrieve the data: ' + e.message);
      }
    };
  </script>
</body>
</html>`;
}

app.get('/view', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');

  try {
    // Serve-time boundary (lib/file-link-guard.js): fd-pinned symlink,
    // sensitivity, workdir-containment, and size checks. Legacy tokens
    // without a workdir still get everything but containment. Every
    // rejection — denied, missing, oversize — is a uniform 404 so the
    // response leaks nothing about why.
    const { content, realPath } = await validateAndOpen(data.path, { workdir: data.workdir });
    res.type('html').send(renderHtml(path.basename(realPath), content.toString('utf-8')));
  } catch (err) {
    if (!(err instanceof FileLinkDenied)) console.error('Error reading file:', err);
    res.status(404).send('File not found');
  }
});

// Bounds the disk reads a token holder — or a token guesser — can trigger.
// In-memory store is fine here: one viewer process, restart resets are
// harmless. Behind the Cloudflare tunnel every request shares the loopback
// IP, so this is effectively a global budget — right shape for a single-
// user deployment.
const downloadLimiter = rateLimit({
  windowMs: 60_000,
  limit: parseInt(process.env.DOWNLOAD_RATE_LIMIT || '30', 10),
  standardHeaders: false,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

app.get('/download', downloadLimiter, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  // dl is the route discriminator — a /view token must not turn into a raw
  // download with the larger size budget just by switching the path.
  if (!data || data.dl !== true) return res.status(403).send('Invalid or expired token');

  try {
    const { content, realPath } = await validateAndOpen(data.path, {
      workdir: data.workdir,
      maxBytes: MAX_DOWNLOAD_BYTES,
    });
    // Keep the header a plain quoted ASCII token: strip anything that could
    // splice the header or escape the quotes.
    const name = path.basename(realPath).replace(/[^A-Za-z0-9._ -]/g, '_');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(content);
  } catch (err) {
    if (!(err instanceof FileLinkDenied)) console.error('Error reading file:', err);
    res.status(404).send('File not found');
  }
});

const BRIDGE_API_PORT = process.env.MATRON_BRIDGE_API_PORT || 9802;

app.get('/action', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');

  const { action, roomId, index } = data;
  if (!action || !roomId) return res.status(400).send('Invalid action token');

  try {
    let endpoint, body, label;
    if (action === 'interrupt') {
      endpoint = '/interrupt';
      body = { roomId };
      label = '⚡ Sending queued messages';
    } else if (action === 'cancel') {
      endpoint = '/cancel-queued';
      body = { roomId, index };
      label = '✕ Cancelled';
    } else {
      return res.status(400).send('Unknown action');
    }

    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      const safeErr = err.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return res.type('html').send(`<!DOCTYPE html><html><body><h2>Action failed</h2><p>${safeErr}</p></body></html>`);
    }

    res.type('html').send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Action performed</title>
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}
.card{text-align:center;padding:40px;}</style></head>
<body><div class="card"><h2>${label}</h2><p>Action performed. You can close this tab.</p></div></body>
</html>`);
  } catch (err) {
    console.error('Action proxy error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});

app.get('/secret', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.secretId || !data.label) return res.status(400).send('Invalid secret token');

  res.type('html').send(renderSecretForm(data.label, token));
});

app.post('/secret', async (req, res) => {
  const { token, value } = req.body;
  if (!token || !value) return res.status(400).send('Missing token or value');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.secretId) return res.status(400).send('Invalid secret token');

  try {
    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}/secret/${data.secretId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      const safeErr = err.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return res.status(resp.status).type('html').send(
        `<!DOCTYPE html><html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div><h2>Submission failed</h2><p>${safeErr}</p></div></body></html>`
      );
    }

    res.type('html').send(renderSecretSuccess());
  } catch (err) {
    console.error('Secret submit proxy error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});

// Both sensitive GET routes serve only the no-secret shell page — the GET
// must be safe to repeat (prefetchers, Safe Browsing, URL previewers), so the
// one-time consumption happens exclusively in POST /sensitive/reveal below.
// They still answer "is this token valid?" though, so they stay rate-limited
// alongside the routes that move bytes: a guesser must not get unlimited
// probes just because this particular reply is only a shell page. What they
// no longer share is the reveal POST's budget — see revealLimiter below.
app.get('/sensitive', downloadLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.sensitiveId || !data.label) return res.status(400).send('Invalid sensitive data token');

  res.type('html').send(renderSensitiveShell(data.label, token, 'view', data.ot !== false));
});

// Direct-download variant: same shell, but the click saves straight to a file
// instead of rendering the content. Requires dl:true in the token (same
// discriminator pattern as /view vs /download) so the two link flavours stay
// distinct in chat even though both now land on a click-through page.
app.get('/sensitive-download', downloadLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data || data.dl !== true || !data.sensitiveId || !data.label) {
    return res.status(403).send('Invalid or expired token');
  }

  res.type('html').send(renderSensitiveShell(data.label, token, 'download', data.ot !== false));
});

// Own budget, deliberately not the GET one. Behind the tunnel every request
// arrives from the loopback IP, so a shared limiter is one global counter —
// and the shell GETs are the requests nobody controls: previewers, Safe
// Browsing, a refresh, a probe. Any of that could spend the window and 429
// the single POST the user actually pressed a button for. Separate counters
// keep both properties: guessing stays bounded per route, and cheap
// repeatable GETs can no longer starve the one action that matters.
const revealLimiter = rateLimit({
  windowMs: 60_000,
  limit: parseInt(process.env.REVEAL_RATE_LIMIT || '30', 10),
  standardHeaders: false,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// The only place the secret actually moves. POST-only so nothing automated
// triggers it (link previewers and browser prefetch send GETs); called by the
// shell page's button handler. Accepts both token flavours. Responds JSON —
// the shell renders content/errors client-side via textContent.
app.post('/sensitive/reveal', revealLimiter, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const data = verifyToken(token);
  if (!data || !data.sensitiveId) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}/sensitive/${data.sensitiveId}`);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ error: err.error || 'Unknown error' });
    }

    const { label, content, filename } = await resp.json();
    // sensitiveFilename output is [A-Za-z0-9._-] only — safe for the client
    // to hand to the browser's download attribute.
    res.json({ label, content, filename: sensitiveFilename(label, filename) });
  } catch (err) {
    console.error('Sensitive data fetch error:', err);
    res.status(500).json({ error: 'Failed to reach bridge API' });
  }
});

function scriptJsonString(value) {
  return JSON.stringify(String(value)).replace(/[<>&\u2028\u2029]/g, char => {
    switch (char) {
      case '<': return '\\u003c';
      case '>': return '\\u003e';
      case '&': return '\\u0026';
      case '\u2028': return '\\u2028';
      case '\u2029': return '\\u2029';
      default: return char;
    }
  });
}

function renderLiveHtml(token) {
  const safeToken = scriptJsonString(token);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  pre { margin: 0; padding: 12px; flex: 1; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; }
  .status { padding: 4px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 11px; color: #8b949e; }
</style>
</head>
<body>
<div class="status" id="status">running…</div>
<pre id="output"></pre>
<script>
(() => {
  const out = document.getElementById('output');
  const status = document.getElementById('status');
  let userScrolled = false;
  out.addEventListener('scroll', () => {
    userScrolled = (out.scrollTop + out.clientHeight) < (out.scrollHeight - 20);
  });
  const wsUrl = location.origin.replace(/^http/, 'ws') + '/live/ws?token=' + encodeURIComponent(${safeToken});
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'data') {
      out.textContent += msg.chunk;
      if (!userScrolled) out.scrollTop = out.scrollHeight;
    } else if (msg.type === 'complete') {
      const code = msg.exitCode;
      const denied = msg.denied;
      const trunc = msg.truncated;
      status.textContent = denied ? '✗ not executed' :
        (code === 0 ? '✓ exit 0' : '✗ exit ' + code) +
        (trunc ? ' · truncated' : '');
    }
  };
  ws.onerror = () => { status.textContent = '⚠ disconnected'; };
})();
</script>
</body>
</html>`;
}

app.get('/live', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.liveCmdId) return res.status(400).send('Invalid live token');
  res.type('html').send(renderLiveHtml(token));
});

// Plugin bundle directory — built by matron-web's packages/matron-live-output
// (`pnpm --filter @matron/live-output build`, output `dist/live-output.mjs`).
// Override at deploy time via MATRON_PLUGIN_DIR. Served unauthenticated: the
// bundle is the script the browser dynamic-imports for matron-web's plugin
// loader (see matron-web src/vector/init.tsx :: loadPlugins), so it has to be
// publicly fetchable. Adding HMAC here would just break loading; the contents
// are not secret.
const PLUGIN_DIR = process.env.MATRON_PLUGIN_DIR || path.join(process.cwd(), 'plugins');

app.use('/plugin', express.static(PLUGIN_DIR, {
  fallthrough: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
  },
}));

app.get('/health', (req, res) => res.send('ok'));

export { app };
export function startServer(port = PORT) {
  if (!SECRET) {
    console.error('HMAC_SECRET env var is required');
    process.exit(1);
  }
  const httpServer = app.listen(port, '127.0.0.1', () => {
    const addr = httpServer.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : port;
    console.log(`Code file viewer listening on 127.0.0.1:${actualPort}`);
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/live/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleLiveWs(ws, url));
  });
  return httpServer;
}

function handleLiveWs(ws, url) {
  const token = url.searchParams.get('token');
  const data = token ? verifyToken(token) : null;
  if (!data || !data.liveCmdId || !data.logPath) {
    ws.close(1008, 'invalid token');
    return;
  }
  const { logPath, doneSentinelPath } = data;

  let offset = 0;
  let watcher = null;
  let doneWatcher = null;
  let closed = false;

  function send(msg) {
    if (closed) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  function pump() {
    if (closed || !existsSync(logPath)) return;
    let st;
    try { st = statSync(logPath); } catch { return; }
    if (st.size <= offset) return;
    let data;
    try {
      const fd = openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(st.size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        data = buf;
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    offset = st.size;
    send({ type: 'data', chunk: data.toString('utf-8') });
  }

  function checkDone() {
    if (!existsSync(doneSentinelPath)) return;
    pump(); // final flush — synchronous, so any pending bytes are sent before complete
    let payload;
    try { payload = JSON.parse(readFileSync(doneSentinelPath, 'utf-8')); }
    catch { payload = { exitCode: null, denied: false, truncated: false }; }
    send({ type: 'complete', ...payload });
    closeAll();
  }

  function closeAll() {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch {}
    try { doneWatcher?.close(); } catch {}
    try { ws.close(1000, 'done'); } catch {}
  }

  pump();
  if (existsSync(logPath)) {
    watcher = fsWatch(logPath, { persistent: false }, () => pump());
  }
  const parentDir = path.dirname(logPath);
  const doneBasename = path.basename(doneSentinelPath);
  doneWatcher = fsWatch(parentDir, { persistent: false }, (event, filename) => {
    if (filename === doneBasename) checkDone();
  });

  ws.on('close', closeAll);
  ws.on('error', closeAll);
  checkDone();
}
