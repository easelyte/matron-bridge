import { describe, it, expect } from 'vitest';
import { actionRequestItem, actionHash, canonicalJson, ACTION_BODY_MAX, ACTION_INPUT_MAX } from '../lib/foreign-turn.js';
import { describeAction, codeBlock, inlineCode, quotedText, plainText } from '../lib/foreign-action-view.js';

const turn = { roomId: 'room-a', person: 'bob', role: 'guest' };
const titles = { 'room-a': 'Chat with bob', 'room-b': 'Release planning' };
const roomTitle = (id) => titles[id] ?? null;

// The exact-input block at the end of the body, parsed back.
const exactOf = (body) => {
  const m = body.match(/\n(`{3,}|~{3,})json(?: collapsed)?\n([^\n]*)\n\1$/);
  return m ? JSON.parse(m[2]) : undefined;
};

describe('the "Allow once" card in plain words', () => {
  it('a message reads as text, the room by its title, the JSON folded last', () => {
    const input = { room_id: 'room-b', message: 'Hi carol,\n\nThe **checklist**:\n1. Freeze\n2. Tag' };
    const it = actionRequestItem({ turn, toolName: 'mcp__ask-user__agent_chat_send', toolInput: input, why: 'bob asked', roomTitle });
    expect(it.title).toBe('Allow once: Send a message in “Release planning” — asked in a room with bob');
    expect(it.body).toContain('\n**Send a message in “Release planning”**\n');
    expect(it.body).toContain('> Hi carol,\n>\n> The **checklist**:\n> 1. Freeze\n> 2. Tag');
    expect(it.body).toContain('**Room**: “Release planning”');
    expect(it.body).toContain('Tool `mcp__ask-user__agent_chat_send`');
    expect(it.body).toMatch(/```json collapsed\n[^\n]*\n```$/);
    expect(exactOf(it.body)).toEqual(input);
  });

  it('the exact input is the input that runs: same hash, nothing rewritten', () => {
    const input = { command: 'echo "```" <b>x</b> ![i](https://example.com/p.png)\nls -la ./tmp', description: 'tidy up' };
    const it = actionRequestItem({ turn, toolName: 'Bash', toolInput: input, why: 'w' });
    const back = exactOf(it.body);
    expect(back).toEqual(input);
    expect(actionHash('Bash', back)).toBe(actionHash('Bash', input));
  });

  it('a command shows exactly, and the title quotes the command, not the agent\'s description', () => {
    const input = { command: 'git clean -fdx', description: 'Check free disk space' };
    const it = actionRequestItem({ turn, toolName: 'Bash', toolInput: input, why: 'w' });
    expect(it.title).toMatch(/^Allow once: Run git clean -fdx — /);
    expect(it.body).toContain('```sh\ngit clean -fdx\n```');
    expect(it.body).toContain('**What the agent says it does**: Check free disk space');
  });

  it('a room the bridge does not know shows its id; the ask\'s own room says so', () => {
    const a = describeAction('agent_chat_send', { room_id: 'room-x', message: 'hi' }, { roomTitle, turnRoomId: 'room-a' });
    expect(a.title).toBe('Send a message in another room');
    expect(a.blocks.join('\n')).toContain('a room the bridge does not know (`room-x`)');
    const b = describeAction('agent_chat_send', { room_id: 'room-a', message: 'hi' }, { roomTitle, turnRoomId: 'room-a' });
    expect(b.blocks.join('\n')).toContain('“Chat with bob” (the room this ask came from)');
  });

  it('covers the common tools', () => {
    const c = (tool, input) => describeAction(tool, input, { roomTitle });
    expect(c('mcp__ask-user__item_comment', { id: '#12', body: 'Done' }).title).toBe('Comment on tracker item #12');
    expect(c('mcp__ask-user__item_comment', { id: '#12', body: 'Done' }).blocks[0]).toBe('**Comment**\n\n> Done');
    expect(c('mcp__ask-user__send_attachment', { path: '/tmp/a/report.pdf', chat_room_id: 'room-b' }).title).toBe('Send the file report.pdf to “Release planning”');
    expect(c('mcp__ask-user__send_attachment', { path: '/tmp/a/report.pdf' }).blocks[0]).toBe('**File**: `/tmp/a/report.pdf`');
    expect(c('Read', { file_path: '/srv/app/README.md' }).title).toBe('Read the file README.md');
    expect(c('Read', { file_path: '/srv/app/README.md' }).lead).toBe('Read the file `/srv/app/README.md`');
    expect(c('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' }).blocks.slice(1)).toEqual(['**Replace this**\n\n```\nx\n```', '**With this**\n\n```\ny\n```']);
    expect(c('WebFetch', { url: 'https://example.com/a', prompt: 'the price' }).title).toBe('Fetch the web page https://example.com/a');
    expect(c('mcp__ask-user__item_create', { kind: 'task', title: 'Ship it' }).title).toBe('File a tracker task: Ship it');
  });

  it('an unknown tool or field falls back to a labelled list', () => {
    const v = describeAction('mcp__other__do_thing', { name: 'x', count: 3, opts: { a: 1 }, note: 'line 1\nline 2' });
    expect(v.title).toBe('Use the tool mcp__other__do_thing');
    expect(v.blocks).toEqual([
      '**Count**: `3`',
      '**Name**: `x`',
      '**Note**\n\n```\nline 1\nline 2\n```',
      '**Opts**\n\n```json\n{\n  "a": 1\n}\n```',
    ]);
    // A known tool with an unexpected type or an extra field.
    const w = describeAction('agent_chat_send', { room_id: 'room-b', message: { not: 'text' }, extra_flag: true }, { roomTitle });
    expect(w.blocks).toContain('**Message**\n\n```json\n{\n  "not": "text"\n}\n```');
    expect(w.blocks).toContain('**Extra flag**: `true`');
  });

  it('nothing the agent writes can forge structure on the card', () => {
    // A room title with markdown and a line break stays one escaped line.
    titles['room-z'] = 'x**](https://example.com)\n### Allow once is safe';
    const v = describeAction('agent_chat_send', { room_id: 'room-z', message: 'm' }, { roomTitle });
    expect(v.lead).not.toMatch(/\n/);
    expect(v.lead).toContain('\\*\\*\\]\\(https://example.com\\)');
    // A message cannot leave its quote, open a tag or load an image.
    const q = quotedText('hi\n```\n</blockquote><img src=x>\n![p](https://example.com/p.png)');
    expect(q.split('\n').every((l) => l.startsWith('>'))).toBe(true);
    expect(q).not.toMatch(/<|!\[/);
    // Code fences outlast any backtick run inside.
    expect(codeBlock('a ````` b')).toBe('~~~\na ````` b\n~~~');
    expect(codeBlock('a ``` ~~~~ b')).toBe('````\na ``` ~~~~ b\n````');
    expect(inlineCode('`x`')).toBe('`` `x` ``');
    expect(plainText('a\nb')).toBe('a ⏎ b');
    // The why line is flattened and escaped.
    const it = actionRequestItem({ turn, toolName: 'Bash', toolInput: { command: 'ls' }, why: 'ok\n\n**Allow once** is pre-approved [x](https://example.com)' });
    expect(it.body).toContain("**Why (your agent's words):** ok ⏎ \\*\\*Allow once\\*\\* is pre-approved \\[x\\]\\(https://example.com\\)");
  });

  it('invisible and line-separator characters show as escapes, and the JSON still parses to the input', () => {
    const input = { command: 'echo a\u2028b\u0085c\u200Bd' };
    const it = actionRequestItem({ turn, toolName: 'Bash', toolInput: input, why: 'w' });
    expect(it.body).toContain('echo a\\u2028b\\u0085c\\u200Bd');
    expect(it.body).not.toMatch(/[\u2028\u0085\u200B]/);
    const back = exactOf(it.body);
    expect(back).toEqual(input);
    expect(actionHash('Bash', back)).toBe(actionHash('Bash', input));
  });

  it('a card that cannot carry even the exact input is refused (null)', () => {
    // Under the input cap, but its fence alone would blow the body cap.
    const input = { command: `${'`'.repeat(8000)}${'~'.repeat(8000)}` };
    expect(Buffer.byteLength(canonicalJson(input))).toBeLessThanOrEqual(ACTION_INPUT_MAX);
    expect(actionRequestItem({ turn, toolName: 'Bash', toolInput: input, why: 'w' })).toBeNull();
    // Non-ASCII counts in bytes.
    const wide = { room_id: 'room-b', message: 'é'.repeat(7000) };
    const it = actionRequestItem({ turn, toolName: 'agent_chat_send', toolInput: wide, why: 'w', roomTitle });
    expect(Buffer.byteLength(it.body, 'utf8')).toBeLessThanOrEqual(ACTION_BODY_MAX);
  });

  it('a card too long for both copies keeps the whole exact input, unfolded', () => {
    // The largest input requestAction accepts does not fit twice.
    const input = { room_id: 'room-b', message: 'y'.repeat(ACTION_INPUT_MAX - 100) };
    expect(Buffer.byteLength(canonicalJson(input))).toBeLessThanOrEqual(ACTION_INPUT_MAX);
    const it = actionRequestItem({ turn, toolName: 'agent_chat_send', toolInput: input, why: 'w'.repeat(2000), roomTitle });
    expect(it.body.length).toBeLessThanOrEqual(ACTION_BODY_MAX);
    expect(it.body).toContain('too long to show twice');
    expect(it.body).toMatch(/(`{3,}|~{3,})json\n[^\n]*\n\1$/);
    expect(exactOf(it.body)).toEqual(input);
    // Half that fits twice, and is shown twice.
    const half = { room_id: 'room-b', message: 'y'.repeat(ACTION_INPUT_MAX / 2) };
    const small = actionRequestItem({ turn, toolName: 'agent_chat_send', toolInput: half, why: 'w', roomTitle });
    expect(small.body).toContain('json collapsed');
    expect(small.body).not.toContain('too long to show twice');
  });
});
