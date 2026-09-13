import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexPromptQueue } from '../lib/codex-prompts.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
const approval = (id = 1, method = 'item/commandExecution/requestApproval') => ({ id, method, params: { command: 'gh pr create', threadId: 'parent', turnId: 'turn' } });
function setup() {
  const respond = vi.fn(() => true), reject = vi.fn(), publish = vi.fn(() => true), notice = vi.fn(), submitAsync = vi.fn(() => true), onPending = vi.fn();
  const queue = new CodexPromptQueue({ respond, reject, publish, notice, submitAsync, onPending, timeoutMs: 1000 });
  return { queue, respond, reject, publish, notice, submitAsync, onPending, choose: index => queue.answer({ choice: queue.active.options[index].value }) };
}
afterEach(() => vi.useRealTimers());
describe('native Codex approval and question cards', () => {
  it('requires a matching explicit answer before allowing a GitHub command', async () => {
    const h = setup(); h.queue.add(approval()); await settle();
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.publish.mock.calls[0][0].question).toContain('gh pr create');
    expect(h.queue.answer({ choice: 'codex:unknown:0:0' })).toBeNull();
    expect(h.choose(0)).toBe('Allow once');
    expect(h.respond).toHaveBeenCalledWith(1, { decision: 'accept' });
    expect(h.queue.active).toBeNull();
  });
  it('serializes requests and rejects an old button on a newer card', async () => {
    const h = setup(); h.queue.add(approval(1)); h.queue.add(approval(2)); await settle();
    const old = h.queue.active.options[0].value;
    const oldId = h.queue.active.options[0].id;
    h.choose(2); await settle();
    expect(h.queue.answer({ choice: old })).toBeNull();
    expect(h.queue.answer({ choice: oldId })).toBeNull();
    expect(h.queue.answer({ choice: oldId, text: 'Allow once' })).toBeNull();
    expect(h.queue.answer({ choice: 'prompt-opt-0' })).toBeNull();
    h.choose(1);
    expect(h.respond.mock.calls).toEqual([[1, { decision: 'decline' }], [2, { decision: 'acceptForSession' }]]);
  });
  it('binds option IDs to individual questions and accepts only the current ID', async () => {
    const h = setup(); h.queue.add({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'first', question: 'First?', options: [{ label: 'Yes' }] },
      { id: 'second', question: 'Second?', options: [{ label: 'Yes' }] },
    ] } }); await settle();
    const oldId = h.queue.active.options[0].id;
    expect(h.queue.answer({ choice: oldId })).toBe('Yes');
    expect(h.queue.answer({ choice: oldId })).toBeNull();
    expect(h.queue.answer({ choice: h.queue.active.options[0].id })).toBe('Yes');
    expect(h.respond).toHaveBeenCalledTimes(1);
  });
  it('denies permissions in plan mode and scopes approved permissions', () => {
    const h = setup(); const request = approval(1, 'item/permissions/requestApproval');
    request.params.permissions = { network: { enabled: true } };
    h.queue.add(request, { planMode: true });
    expect(h.respond).toHaveBeenCalledWith(1, { permissions: {}, scope: 'turn' });
    h.queue.add({ ...request, id: 2 }); h.choose(1);
    expect(h.respond).toHaveBeenCalledWith(2, { permissions: request.params.permissions, scope: 'session' });
  });
  it('maps multiple questions back to their own IDs and accepts free text', async () => {
    const h = setup(); h.queue.add({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'first', question: 'Where?', options: [{ label: 'Here', description: 'current folder' }] },
      { id: 'second', question: 'Name?' },
    ] } }); await settle(); h.choose(0);
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.queue.answer({ text: 'Matron' })).toBe('Matron');
    expect(h.respond).toHaveBeenCalledWith(1, { answers: { first: { answers: ['Here'] }, second: { answers: ['Matron'] } } });
  });
  it('keeps secret questions out of journal forms and rejects unsupported server requests', async () => {
    const h = setup(); h.queue.add({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'secret', question: 'Password?', isSecret: true }] } });
    h.queue.add({ id: 2, method: 'unknown', params: {} }); await settle();
    expect(h.publish).not.toHaveBeenCalled(); expect(h.notice).toHaveBeenCalled(); expect(h.reject).toHaveBeenCalledWith(2);
  });
  it('cancels unsupported MCP forms and validates simple form bounds', async () => {
    const h = setup(); const request = { id: 1, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'Settings', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 4 } } } } };
    h.queue.add(request); await settle();
    expect(h.queue.answer({ text: '5' })).toBeNull(); expect(h.queue.answer({ text: '2' })).toBe('2');
    expect(h.respond).toHaveBeenCalledWith(1, { action: 'accept', content: { count: 2 } });
    request.id = 2; request.params.requestedSchema.properties = { password: { type: 'string' } };
    h.queue.add(request); expect(h.respond).toHaveBeenCalledWith(2, { action: 'cancel', content: null });
  });
  it('denies pending approvals on timeout and shutdown', async () => {
    vi.useFakeTimers(); const h = setup(); h.queue.add(approval());
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.respond).toHaveBeenCalledWith(1, { decision: 'decline' });
    h.queue.add(approval(2)); h.queue.clear();
    expect(h.respond).toHaveBeenCalledWith(2, { decision: 'decline' });
    expect(h.queue.answer({ text: 'Allow once' })).toBeNull();
  });
  it('fails closed if the card cannot be delivered', async () => {
    const h = setup(); h.publish.mockReturnValue(false); h.queue.add(approval()); await settle();
    expect(h.queue.active).toBeNull(); expect(h.respond).toHaveBeenCalledWith(1, { decision: 'decline' });
  });
});

describe('asynchronous Codex question cards', () => {
  it('renders string options and delivers all answers as contextual user input', async () => {
    const h = setup();
    h.queue.addAsync('message-1', [{ title: 'Which feature?', options: ['Tokens', 'Models'] }, { title: 'Any details?', options: null }]);
    await settle();
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      question: '(1/2) Which feature?', options: [expect.objectContaining({ label: 'Tokens' }), expect.objectContaining({ label: 'Models' })],
    }));
    expect(h.onPending).toHaveBeenLastCalledWith(false);
    const oldChoice = h.queue.active.options[0].value;
    expect(h.choose(1)).toBe('Models');
    expect(h.submitAsync).not.toHaveBeenCalled();
    expect(h.queue.answer({ choice: oldChoice })).toBeNull();
    await settle();
    expect(h.publish).toHaveBeenLastCalledWith({ question: '(2/2) Any details?', options: [], mode: 'pick_one' });
    expect(h.queue.answer({ text: 'Show all models' })).toBe('Show all models');
    expect(h.submitAsync).toHaveBeenCalledWith('Which feature?\nModels\n\nAny details?\nShow all models');
    expect(h.respond).not.toHaveBeenCalled();
    h.queue.addAsync('message-1', [{ title: 'Duplicate?' }]);
    expect(h.queue.active).toBeNull();
  });
  it('keeps async answers separate from approval decisions and resumes their cards', async () => {
    const h = setup(); h.queue.addAsync('message-1', [{ title: 'Continue?', options: ['Allow once'] }]); await settle();
    const asyncChoice = h.queue.active.options[0].value;
    h.queue.add(approval()); await settle();
    expect(h.queue.active.kind).toBe('approval');
    expect(h.queue.answer({ choice: asyncChoice, text: 'Allow once' })).toBeNull();
    expect(h.respond).not.toHaveBeenCalled();
    h.choose(2); await settle();
    expect(h.respond).toHaveBeenCalledWith(1, { decision: 'decline' });
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ question: 'Continue?' }));
    h.queue.clear({ preserveAsync: true });
    expect(h.choose(0)).toBe('Allow once');
    expect(h.submitAsync).toHaveBeenCalledWith('Continue?\nAllow once');
    expect(h.respond).toHaveBeenCalledTimes(1);
  });
  it('retains an answer for retry when the delivery path refuses it', () => {
    const h = setup(); h.queue.addAsync('message-1', [{ title: 'Name?' }]);
    h.submitAsync.mockReturnValueOnce(false);
    expect(h.queue.answer({ text: 'Matron' })).toBeNull();
    expect(h.queue.active).not.toBeNull();
    expect(h.queue.answer({ text: 'Matron' })).toBe('Matron');
    expect(h.queue.active).toBeNull();
  });
  it('expires or clears async cards without responding to a nonexistent RPC', async () => {
    vi.useFakeTimers(); const h = setup(); h.queue.addAsync('message-1', [{ title: 'Name?' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.queue.active).toBeNull(); expect(h.notice).toHaveBeenCalled();
    h.queue.addAsync('message-2', [{ title: 'Name?' }]); h.queue.clear();
    expect(h.queue.active).toBeNull(); expect(h.respond).not.toHaveBeenCalled(); expect(h.submitAsync).not.toHaveBeenCalled();
  });
  it('ignores malformed questions and removes undeliverable cards', async () => {
    const h = setup();
    for (const questions of [null, [], [{ title: 7 }], [{ title: 'Where?', options: 'Here' }], [{ title: 'Where?', options: [null] }]]) {
      h.queue.addAsync('invalid', questions);
    }
    expect(h.queue.active).toBeNull();
    h.publish.mockReturnValue(false); h.queue.addAsync('message-1', [{ title: 'Where?' }]); await settle();
    expect(h.queue.active).toBeNull(); expect(h.respond).not.toHaveBeenCalled(); expect(h.submitAsync).not.toHaveBeenCalled();
  });
});
