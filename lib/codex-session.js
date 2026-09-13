import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export function normalizeCodexSandbox(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SANDBOX_MODES.has(normalized) ? normalized : 'workspace-write';
}

// Unset means inherit the CLI's user/project configuration. Only explicit
// booleans override it, so existing bridge installations keep their policy.
export function normalizeCodexNetworkAccess(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

export function contentBlocksToCodexPrompt(contentBlocks = []) {
  return contentBlocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .filter(Boolean)
    .join('\n\n');
}

// Build argv without putting the user prompt on the command line. The prompt
// is written to stdin using "-", which avoids shell quoting, process-list
// exposure, and argv length limits for queued/merged messages.
export function buildCodexExecArgs({
  threadId = null,
  model = null,
  effort = null,
  sandbox = 'workspace-write',
  networkAccess = null,
  developerInstructions = '',
} = {}) {
  const args = ['exec'];
  if (threadId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  args.push('-c', 'approval_policy="never"');
  args.push('-c', `sandbox_mode=${JSON.stringify(normalizeCodexSandbox(sandbox))}`);
  const network = normalizeCodexNetworkAccess(networkAccess);
  if (normalizeCodexSandbox(sandbox) === 'workspace-write' && network !== null) {
    args.push('-c', `sandbox_workspace_write.network_access=${network}`);
  }
  if (developerInstructions) {
    args.push('-c', `developer_instructions=${JSON.stringify(developerInstructions)}`);
  }
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (threadId) args.push(threadId);
  args.push('-');
  return args;
}

// A logical Codex session is long-lived, but codex exec itself is one process
// per turn. This adapter owns those child processes and emits their JSONL
// events while retaining the thread ID needed by the next turn.
export class CodexExecSession extends EventEmitter {
  constructor({
    cwd,
    threadId = null,
    model = null,
    effort = null,
    sandbox = 'workspace-write',
    networkAccess = null,
    developerInstructions = '',
    env = process.env,
    spawnImpl = nodeSpawn,
    command = 'codex',
  } = {}) {
    super();
    this.cwd = cwd;
    this.threadId = threadId;
    this.model = model;
    this.effort = effort;
    this.sandbox = normalizeCodexSandbox(sandbox);
    this.networkAccess = normalizeCodexNetworkAccess(networkAccess);
    this.developerInstructions = developerInstructions;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.command = command;
    this.child = null;
    this.alive = true;
    this.busy = false;
    this.lastError = null;
  }

  send(contentBlocks) {
    if (!this.alive || this.busy) return false;
    const prompt = contentBlocksToCodexPrompt(contentBlocks);
    if (!prompt) return false;
    this.lastError = null;

    const args = buildCodexExecArgs({
      threadId: this.threadId,
      model: this.model,
      effort: this.effort,
      sandbox: this.sandbox,
      networkAccess: this.networkAccess,
      developerInstructions: this.developerInstructions,
    });

    let child;
    try {
      child = this.spawnImpl(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.lastError = error;
      queueMicrotask(() => this.emit('spawn-error', error));
      return false;
    }

    this.child = child;
    this.busy = true;
    this.emit('spawn', { child, args });

    let stdoutBuffer = '';
    let stderr = '';
    let sawTurnCompleted = false;

    // Decode across pipe chunks: a multibyte character can straddle any two
    // reads, including in JSON strings and diagnostics.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const emitLine = line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (error) {
        this.emit('parse-error', { line: trimmed, error });
        return;
      }
      if (event?.type === 'thread.started' && event.thread_id) this.threadId = event.thread_id;
      if (event?.type === 'turn.completed') sawTurnCompleted = true;
      // Listener failures are not malformed JSON; let them reach the caller.
      this.emit('event', event);
    };
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();
      for (const line of lines) emitLine(line);
    });
    // Keep recent diagnostics without accumulating an unbounded log for a
    // long turn. The end normally contains the actionable exit error.
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const inputError = error => {
      if (this.child !== child) return;
      this.lastError = error;
      this.emit('spawn-error', error);
    };
    // A CLI that rejects its configuration can exit before consuming stdin.
    // EPIPE is a turn error, not an unhandled stream error that kills Matron.
    child.stdin.on('error', inputError);
    child.on('error', error => {
      this.lastError = error;
      this.emit('spawn-error', error);
    });
    child.on('close', (code, signal) => {
      emitLine(stdoutBuffer);
      if (this.child === child) this.child = null;
      this.busy = false;
      this.emit('turn-exit', { code, signal, stderr: stderr.trim(), sawTurnCompleted });
    });

    try {
      child.stdin.end(prompt);
    } catch (error) {
      inputError(error);
      child.kill('SIGTERM');
      // The child exists: keep ownership until close, just like an async
      // input error. The bridge reports the failed turn through turn-exit.
    }
    return true;
  }

  interrupt(signal = 'SIGINT') {
    if (!this.child || !this.busy) return false;
    return this.child.kill(signal);
  }

  kill(signal = 'SIGTERM') {
    this.alive = false;
    if (!this.child) return true;
    return this.child.kill(signal);
  }
}
