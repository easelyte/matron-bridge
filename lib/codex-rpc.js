import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

// A private stdio connection per Matron conversation. No listening socket,
// shared daemon, or automatic replay of requests after a connection failure.
export class CodexRpcClient extends EventEmitter {
  constructor({ cwd, env = process.env, command = 'codex', args = [], spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
    super();
    Object.assign(this, { cwd, env, command, args, spawnImpl, timeoutMs });
    this.child = null;
    this.pending = new Map();
    this.serverRequests = new Set();
    this.nextId = 0;
    this.connecting = null;
    this.closed = false;
  }

  connect() {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed.'));
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    return this.connecting;
  }

  async initialize() {
    try {
      const child = this.spawnImpl(this.command, ['app-server', '--listen', 'stdio://', ...this.args], {
        cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.stdout.setEncoding('utf8');
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
          this.fail(new Error('Codex response exceeded the size limit.'));
          return;
        }
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim() || this.closed) continue;
          let message;
          try { message = JSON.parse(line); }
          catch { this.fail(new Error('Invalid JSON from Codex app server.')); return; }
          this.receive(message);
        }
      });
      // Runtime diagnostics can contain local configuration. Drain them without
      // publishing them to chat; protocol errors carry the useful failure.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => this.fail(new Error('Codex closed its input pipe.')));
      child.on('error', error => this.fail(new Error(`Could not start Codex: ${error.code || 'process error'}`)));
      child.once('close', (code, signal) => this.fail(new Error(`Codex app server exited (${signal || code}).`)));
      const result = await this.request('initialize', {
        clientInfo: { name: 'matron_bridge', title: 'Matron', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: 'initialized', params: {} });
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  receive(message) {
    if (this.closed) return;
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      if (message.id != null) {
        if (this.serverRequests.has(message.id)) return;
        this.serverRequests.add(message.id);
        this.emit('request', message);
      } else this.emit('notification', message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'Codex request failed.');
      error.code = message.error.code;
      entry.reject(error);
    } else entry.resolve(message.result);
  }

  write(message) {
    if (this.closed || !this.child) throw new Error('Codex connection is closed.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child) return reject(new Error('Codex connection is closed.'));
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex ${method} timed out.`);
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { this.fail(error); }
    });
  }

  respond(id, result) {
    if (this.closed || !this.serverRequests.has(id)) return false;
    try { this.write({ id, result }); }
    catch (error) { this.fail(error); return false; }
    this.serverRequests.delete(id);
    return true;
  }

  rejectRequest(id, message = 'Unsupported request in Matron.') {
    if (this.closed || !this.serverRequests.has(id)) return false;
    try { this.write({ id, error: { code: -32601, message } }); }
    catch (error) { this.fail(error); return false; }
    this.serverRequests.delete(id);
    return true;
  }

  fail(error) {
    if (this.closed) return;
    this.close(error);
    this.emit('disconnect', error);
  }

  close(error = new Error('Codex connection closed before replying.')) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* broken pipe */ }
    if (child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGTERM'); } catch { /* process already gone */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  }
}
