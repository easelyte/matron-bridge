import { randomUUID } from 'node:crypto';
import { withCodexAppServer } from './codex-account.js';

// Match authentication failures of the model turn, not generic permission or
// quota errors (which signing in again would not fix).
export function isCodexAuthError(message) {
  return typeof message === 'string' && /\b401\s+Unauthorized\b|\bMissing bearer or basic authentication\b|\brefresh_token_(?:expired|reused|invalidated)\b|\bnot logged in\b/i.test(message);
}

// Listing is read-only. Native CLI/desktop/exec threads are included; Codex's
// own subagents are intentionally not offered as resumable parent sessions.
export async function listCodexThreads(cwd, { query = withCodexAppServer, limit = 150 } = {}) {
  return query(async request => {
    const threads = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await request('thread/list', { ...(cwd ? { cwd } : {}),
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], archived: false,
        sortKey: 'updated_at', limit: Math.min(100, limit - threads.length), ...(cursor ? { cursor } : {}) });
      threads.push(...(page.data || []).map(t => ({ sessionId: t.id, workdir: t.cwd,
        summary: String(t.name || t.preview || '').slice(0, 200), modified: t.updatedAt * 1000,
        native: true })));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex repeated a thread-list cursor.');
      seen.add(cursor);
    } while (cursor && threads.length < limit);
    return threads.slice(0, limit);
  }, { cwd });
}

export function mergeCodexThreads(native, persisted) {
  const byId = new Map(native.map(t => [t.sessionId, t]));
  for (const entry of persisted) byId.set(entry.sessionId, { ...byId.get(entry.sessionId), ...entry });
  return [...byId.values()].sort((a, b) => Number(b.modified) - Number(a.modified));
}

export function offerCodexBuild(session) {
  if (!session.alive || session.busy || !session.codex?.planMode || !session._codexHadAssistantMessage || !session.sendButtonMessage) return;
  // A plan's unanswered async question remains actionable after turn end.
  // Publishing Build now would supersede its journal prompt sequence.
  if (session.codexPrompts?.active) return;
  const value = `codex-build:${randomUUID()}`;
  session._codexBuildValue = value;
  const message = 'Plan ready. Choose Build to leave read-only mode and implement it, or send changes to the plan.';
  return session.sendButtonMessage(message, [{ id: 'prompt-opt-0', label: 'Build', value }], 'pick_one', message, message);
}

export async function handleCodexControl(session, text, { reply, status = () => {}, persist = () => {}, send, beforeDispatch = () => {} } = {}) {
  if (session.codex?.transport !== 'app-server') return false;
  const [word, ...args] = text.trim().split(/\s+/);
  const cmd = word.toLowerCase().replace(/^!/, '/');
  const codex = session.codex;
  const recognized = ['/mcp', '/tools', '/mode', '/login', '/logout', '/plan', '/compact', '/show_bash', '/show_bash_output', '/bash_output'];
  if (!recognized.includes(cmd) && !(cmd === 'build' && args.length === 0 && codex.planMode && !session.codexPrompts?.active)) return false;
  if (cmd === '/compact' && session.busy) return false; // existing compact-priority queue
  beforeDispatch();
  try {
    if (['/mode', '/plan', 'build', '/compact', '/login', '/logout'].includes(cmd) && session.busy) {
      await reply('Finish or interrupt the current Codex turn first.');
      return true;
    }
    if (cmd === '/show_bash' || cmd === '/show_bash_output' || cmd === '/bash_output') {
      session.showBashOutput = !session.showBashOutput;
      persist({ showBashOutput: session.showBashOutput });
      await reply(`Command output: ${session.showBashOutput ? 'ON' : 'OFF'} (applies immediately).`);
    } else if (cmd === '/mode' || cmd === '/plan' || cmd === 'build') {
      const target = cmd === 'build' ? 'default' : cmd === '/plan' ? (args[0] === 'off' ? 'default' : 'plan') : args[0];
      if (!target) {
        await reply(`Codex mode: ${codex.planMode ? 'Plan (read-only)' : 'Build'} via app-server. Use /mode plan or /mode default.`);
      } else if (!['plan', 'default', 'build'].includes(target)) {
        await reply('Usage: /mode plan | /mode default. Codex uses native app-server controls, not a terminal UI.');
      } else {
        codex.planMode = target === 'plan';
        session._codexBuildValue = null;
        persist({ codexPlanMode: codex.planMode });
        status(session);
        if (cmd === 'build') send('Implement the agreed plan. Matron Build mode is now active.');
        else if (cmd === '/plan' && args.length && args[0] !== 'off') send(text.trim().slice(word.length).trim());
        else await reply(codex.planMode
          ? 'Plan mode enabled: read-only sandbox, no escalations, and MCP tools disabled. Send the task to plan; choose Build when ready.'
          : 'Build mode enabled. Normal sandbox rules and approval cards apply.');
      }
    } else if (cmd === '/compact') {
      if (args.length) await reply('Native Codex compaction does not accept custom instructions. Use /compact by itself.');
      else send('/compact');
    } else if (cmd === '/mcp' || cmd === '/tools') {
      if (!session.busy) await codex.ensureThread();
      const servers = [];
      let cursor;
      const seen = new Set();
      do {
        const page = await codex.rpc('mcpServerStatus/list', { threadId: codex.threadId, limit: 100,
          detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
        servers.push(...(page.data || []));
        cursor = page.nextCursor;
        if (seen.has(cursor) || seen.size >= 20) break;
        seen.add(cursor);
      } while (cursor);
      const lines = servers.map(s => cmd === '/tools'
        ? `${s.name}: ${Object.keys(s.tools || {}).join(', ') || '(no tools)'}`
        : `${s.name}: ${s.runtimeStatus?.status || s.runtimeStatus?.type || s.authStatus || 'unknown'} · ${Object.keys(s.tools || {}).length} tools`);
      await reply((cmd === '/tools' ? 'Codex native tools include shell, patches, search, and images when supported by the selected model.\n\nMCP tools:\n' : 'Codex MCP servers:\n')
        + (lines.join('\n') || '(none available)'));
    } else if (cmd === '/login') {
      if (args.length && (args.length !== 1 || args[0] !== 'cancel')) {
        await reply('Use /login or /login cancel. Enter the device code on the OpenAI sign-in page, not in this chat.');
        return true;
      }
      if (session._codexAccountCommandPending) {
        await reply('Codex is preparing sign-in. Please wait for the code, then use /login cancel if needed.');
        return true;
      }
      session._codexAccountCommandPending = true;
      try {
        if (args[0] === 'cancel') {
          const loginId = session._codexLoginId;
          session._codexLoginId = null;
          if (loginId) await codex.rpc('account/login/cancel', { loginId });
          await reply('Codex login cancelled.');
        } else {
          const previous = session._codexLoginId;
          session._codexLoginId = null;
          if (previous) await codex.rpc('account/login/cancel', { loginId: previous });
          const result = await codex.rpc('account/login/start', { type: 'chatgptDeviceCode' });
          if (!session.alive) {
            if (result.loginId) await codex.rpc('account/login/cancel', { loginId: result.loginId }).catch(() => {});
            return true;
          }
          session._codexLoginId = result.loginId;
          const url = new URL(result.verificationUrl);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Codex returned an invalid login URL.');
          if (typeof result.loginId !== 'string' || !result.loginId || typeof result.userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(result.userCode)) {
            throw new Error('Codex returned an invalid device code.');
          }
          await reply(`🔗 Sign in to Codex\n\n1. Open ${url.href}\n2. Enter the one-time code from the next message on that page.\n\nMatron will confirm when sign-in completes. You do not need to paste anything back here.\n\nIf asked, enable device-code login in ChatGPT security settings or ask your workspace admin. This signs in the bridge's OS user, shared by its Codex sessions.\n\nUse /login cancel to cancel, or /login for a new code.`);
          // iOS whole-message Copy uses the raw body, so keep Markdown fences out.
          await reply(result.userCode);
        }
      } catch (error) {
        const loginId = session._codexLoginId;
        session._codexLoginId = null;
        if (loginId) await codex.rpc('account/login/cancel', { loginId }).catch(() => {});
        throw error;
      } finally {
        session._codexAccountCommandPending = false;
      }
    } else if (cmd === '/logout') {
      if (session._codexAccountCommandPending) {
        await reply('Codex is preparing sign-in. Please wait, then use /logout again.');
        return true;
      }
      const loginId = session._codexLoginId;
      session._codexLoginId = null;
      if (loginId) await codex.rpc('account/login/cancel', { loginId });
      await codex.rpc('account/logout');
      session._codexLoginId = null;
      session._codexMetadata = null;
      status(session);
      await reply('Logged out of Codex for this OS user. Existing sessions share this account; use /login to sign in again.');
    }
  } catch (error) {
    await reply(`Codex ${cmd}: ${session.codexSafeOutput?.(error.message) || 'request failed'}`);
  }
  return true;
}
