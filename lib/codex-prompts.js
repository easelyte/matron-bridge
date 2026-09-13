import { randomUUID } from 'node:crypto';
import { resolvePermissionTimeoutMs } from './permission-prompt.js';

const clean = value => String(value ?? '').replace(/[؜‎‏‪-‮⁦-⁩]/g, '');
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);

// Serial presentation binds each answer to one server request and one question.
// Opaque values also prevent old buttons answering a newer prompt with the same
// option labels. The journal router separately checks target_seq provenance.
export class CodexPromptQueue {
  constructor({ respond, reject, publish, submitAsync, notice = () => {}, onPending = () => {}, timeoutMs } = {}) {
    Object.assign(this, { respond, reject, publish, submitAsync, notice, onPending });
    this.timeoutMs = resolvePermissionTimeoutMs(timeoutMs);
    this.entries = [];
    this.asyncSeen = new Set();
  }

  get active() { return this.entries[0] || null; }

  add(request, { planMode = false } = {}) {
    if (this.entries.some(entry => entry.request.id === request.id)) return;
    if (this.entries.length >= 32) { this.reject(request.id, 'Too many pending requests.'); return; }
    const { method, params = {} } = request;
    const entry = { request, nonce: randomUUID(), index: 0, answers: {}, content: {} };
    if (APPROVALS.has(method)) {
      entry.kind = 'approval';
      if (planMode) { this.respond(request.id, this.denial(entry)); return; }
      entry.questions = [{ question: [
        'Codex requests permission', params.command, params.reason,
        params.cwd ? `Directory: ${params.cwd}` : '',
        params.networkApprovalContext ? JSON.stringify(params.networkApprovalContext) : '',
        params.fileChanges ? JSON.stringify(params.fileChanges, null, 2) : '',
        params.permissions ? JSON.stringify(params.permissions, null, 2) : '',
        params.grantRoot ? `Allow changes under: ${params.grantRoot}` : '',
      ].filter(Boolean).join('\n'), options: [{ label: 'Allow once' }, { label: 'Allow for session' }, { label: 'Deny' }] }];
    } else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
      entry.kind = 'question';
      entry.questions = params.questions;
      if (!Array.isArray(entry.questions) || !entry.questions.length || entry.questions.length > 10
          || entry.questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string')) {
        this.respond(request.id, { answers: {} }); return;
      }
      // Secrets use Matron's dedicated secure web forms, never journal text.
      if (entry.questions.some(q => q.isSecret)) {
        this.respond(request.id, { answers: {} });
        this.notice('Codex requested sensitive input. Use Matron’s request_secret tool to open the secure form.');
        return;
      }
    } else if (method === 'mcpServer/elicitation/request') {
      entry.kind = 'elicitation';
      if (params.mode === 'url') {
        let url;
        try { url = new URL(params.url); } catch { this.respond(request.id, this.denial(entry)); return; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          this.respond(request.id, this.denial(entry)); return;
        }
        entry.questions = [{ question: `${params.message}\n${url.href}`, options: [{ label: 'Done' }, { label: 'Cancel' }] }];
      } else {
        const schema = params.requestedSchema;
        if (!schema || schema.type !== 'object' || !schema.properties || Object.keys(schema.properties).length > 10) {
          this.respond(request.id, this.denial(entry));
          this.notice('This tool requested a form Matron cannot display.'); return;
        }
        entry.questions = Object.entries(schema.properties).map(([id, field]) => ({
          id, question: `${params.message}\n${field?.title || id}${field?.description ? ` — ${field.description}` : ''}`,
          field, required: schema.required?.includes(id),
          options: field?.type === 'boolean' ? [{ label: 'Yes' }, { label: 'No' }]
            : Array.isArray(field?.enum) ? field.enum.map(value => ({ label: String(value) })) : [],
        }));
        if (!entry.questions.length || entry.questions.some(q => !q.field || !['string', 'number', 'integer', 'boolean'].includes(q.field.type)
            || q.field.oneOf || q.field.anyOf || q.field.pattern || q.field.format
            || /password|secret|token|credential/i.test(q.id) || q.field.format === 'password')) {
          this.respond(request.id, this.denial(entry));
          this.notice('This form needs a secure or richer input interface. Use Matron’s secure-input tools for secrets.'); return;
        }
      }
    } else {
      this.reject(request.id);
      return;
    }
    // Blocking requests take priority over optional async questions, otherwise
    // an unanswered preference could hide a permission request indefinitely.
    const firstAsync = this.entries.findIndex(e => e.kind === 'async-question');
    this.enqueue(entry, firstAsync < 0 ? this.entries.length : firstAsync);
  }

  addAsync(id, questions) {
    if (this.asyncSeen.has(id) || this.entries.length >= 32) return;
    if (!Array.isArray(questions) || !questions.length || questions.length > 10
        || questions.some(q => !q || typeof q.title !== 'string' || !q.title.trim()
          || (q.options != null && (!Array.isArray(q.options) || q.options.some(o => typeof o !== 'string'))))) return;
    if (this.asyncSeen.size >= 128) this.asyncSeen.delete(this.asyncSeen.values().next().value);
    this.asyncSeen.add(id);
    this.enqueue({ kind: 'async-question', request: { id, params: {} }, nonce: randomUUID(), index: 0, answers: {},
      questions: questions.map((q, index) => ({ id: String(index), question: q.title,
        options: (q.options || []).map(label => ({ label })) })),
    }, this.entries.length);
  }

  cancel(entry) {
    if (entry.kind !== 'async-question') this.respond(entry.request.id, this.denial(entry));
  }

  enqueue(entry, index) {
    entry.timer = setTimeout(() => {
      this.cancel(entry);
      this.remove(entry.request.id);
      this.notice('Codex’s pending request expired.');
    }, this.timeoutMs);
    entry.timer.unref?.();
    this.entries.splice(index, 0, entry);
    if (index === 0) this.show();
  }

  denial(entry) {
    if (entry.request.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (entry.kind === 'approval') return { decision: 'decline' };
    if (entry.kind === 'elicitation') return { action: 'cancel', content: null };
    return { answers: {} };
  }

  show() {
    const entry = this.active;
    this.onPending(Boolean(entry && entry.kind !== 'async-question'));
    if (!entry) return;
    const q = entry.questions[entry.index];
    const questionIndex = entry.index;
    const options = (q.options || []).map((o, index) => ({ id: `prompt-opt-${entry.nonce}-${entry.index}-${index}`,
      label: clean(o.label), value: `codex:${entry.nonce}:${entry.index}:${index}` }));
    entry.options = options;
    const question = clean(`${entry.questions.length > 1 ? `(${entry.index + 1}/${entry.questions.length}) ` : ''}${q.question}`);
    const descriptions = (q.options || []).map((o, i) => o.description ? `${i + 1}. ${clean(o.description)}` : '').filter(Boolean);
    Promise.resolve().then(() => this.active === entry && entry.index === questionIndex
      ? this.publish({ question: [question, ...descriptions].join('\n'), options, mode: 'pick_one' }) : true)
      .then(sent => { if (sent === false || sent === null) throw new Error('Prompt delivery failed'); })
      .catch(() => {
        if (!this.entries.includes(entry)) return;
        this.cancel(entry);
        this.remove(entry.request.id);
      });
  }

  answer({ choice, text } = {}) {
    const entry = this.active;
    if (!entry) return null;
    const q = entry.questions[entry.index];
    let selected = -1;
    let answer = null;
    if (choice != null) {
      selected = entry.options.findIndex(o => o.value === String(choice) || o.id === String(choice));
      if (selected < 0) return null; // never turn an unrelated button into a typed approval
    }
    const typed = typeof text === 'string' ? text.trim() : '';
    if (selected < 0 && typed) {
      if (/^[1-9]\d*$/.test(typed) && Number(typed) <= entry.options.length) selected = Number(typed) - 1;
      else selected = entry.options.findIndex(o => o.label.toLowerCase() === typed.toLowerCase());
    }
    if (selected >= 0) answer = q.options[selected].label;
    else if (typed && entry.kind !== 'approval' && entry.request.params.mode !== 'url') answer = typed;
    if (answer === null) return null;
    if (entry.kind === 'async-question') {
      entry.answers[q.id] = answer;
      if (entry.index + 1 < entry.questions.length) {
        entry.index++;
        this.show();
        return String(answer);
      }
      // Async questions have no RPC to resolve. Return their answers as normal
      // user input, with question context, through the bridge's delivery queue.
      const body = entry.questions.map(question => `${question.question}\n${entry.answers[question.id]}`).join('\n\n');
      if (this.submitAsync?.(body) !== true) return null;
      this.remove(entry.request.id);
      return String(answer);
    }
    let result;
    if (entry.kind === 'approval') {
      const approved = selected === 0 || selected === 1;
      result = entry.request.method === 'item/permissions/requestApproval'
        ? { permissions: approved ? entry.request.params.permissions || {} : {}, scope: selected === 1 ? 'session' : 'turn' }
        : { decision: ['accept', 'acceptForSession', 'decline'][selected] };
    } else if (entry.kind === 'elicitation' && entry.request.params.mode === 'url') {
      result = { action: selected === 0 ? 'accept' : 'cancel', content: null };
    } else {
      if (entry.kind === 'question') entry.answers[q.id] = { answers: [answer] };
      else {
        let value = answer;
        if (q.field.type === 'boolean') value = selected === 0 ? true : selected === 1 ? false : null;
        if (q.field.type === 'number' || q.field.type === 'integer') {
          value = Number(answer);
          if (!Number.isFinite(value) || (q.field.type === 'integer' && !Number.isInteger(value))) return null;
        }
        if (value === null || (q.field.enum && !q.field.enum.includes(value))) return null;
        if (typeof value === 'number' && ((q.field.minimum != null && value < q.field.minimum)
          || (q.field.maximum != null && value > q.field.maximum))) return null;
        if (typeof value === 'string' && ((q.field.minLength != null && value.length < q.field.minLength)
          || (q.field.maxLength != null && value.length > q.field.maxLength))) return null;
        entry.content[q.id] = value;
      }
      entry.index++;
      if (entry.index < entry.questions.length) { this.show(); return String(answer); }
      result = entry.kind === 'question' ? { answers: entry.answers } : { action: 'accept', content: entry.content };
    }
    const sent = this.respond(entry.request.id, result);
    this.remove(entry.request.id);
    return sent ? String(answer) : null;
  }

  remove(id) {
    const index = this.entries.findIndex(entry => entry.request.id === id);
    if (index < 0) return;
    clearTimeout(this.entries[index].timer);
    this.entries.splice(index, 1);
    if (index === 0) this.show();
  }

  clear({ preserveAsync = false } = {}) {
    const entries = this.entries.filter(entry => !preserveAsync || entry.kind !== 'async-question');
    const previous = this.active;
    this.entries = this.entries.filter(entry => !entries.includes(entry));
    for (const entry of entries) {
      clearTimeout(entry.timer);
      this.cancel(entry);
    }
    if (!preserveAsync) this.asyncSeen.clear();
    if (this.active !== previous) this.show();
    else this.onPending(Boolean(this.active && this.active.kind !== 'async-question'));
  }
}
