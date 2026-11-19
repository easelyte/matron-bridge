// How an "Allow once" ask (foreign_action_request) reads to the user.
//
// The agent names a tool and its exact input. The user should not have to
// read that input as JSON to know what they are allowing, so the item says
// it in plain words: what the call does, each field as a labelled block (a
// message as readable text, a command or a path as code, a room by its
// title). The exact JSON is still on the item, last, in a code block the
// apps fold away; it is the record of what runs. Nothing here changes what
// runs: the bridge hashes and replays the input exactly as the agent sent it
// (lib/foreign-session.js), and this module only reads it.
//
// Every value is the agent's, and the agent is acting on another person's
// words, so nothing may forge structure on the card: one-line values are
// flattened and escaped, multi-line text is quoted line by line with images
// and raw HTML neutralised, and code is fenced with a fence longer than any
// run of backticks inside it, so it shows exactly.
import { oneLine } from './peer-text.js';

const ASK = 'mcp__ask-user__';
// C0 control characters and DEL; the second keeps tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_LINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// What can open a tag or pull in an image in rendered markdown.
function neutralise(s) {
  return String(s ?? '').replace(/!+(?=\[)/g, '').replace(/</g, '‹');
}

// A value shown inside a sentence: one line, capped, markdown punctuation
// escaped so it reads as text and cannot open a link, bold or a heading.
export function plainText(s, max = 200) {
  const flat = oneLine(String(s ?? '')).replace(CONTROL_ALL, '').trim();
  const short = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return neutralise(short).replace(/[\\`*_[\]()#>~|]/g, '\\$&');
}

// The same, for the item title, which the apps show as plain text.
function titleText(s, max = 120) {
  const flat = oneLine(String(s ?? '')).replace(CONTROL_ALL, '').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Inline code: one line, capped, with a backtick run longer than any inside.
export function inlineCode(s, max = 300) {
  const flat = oneLine(String(s ?? '')).replace(CONTROL_ALL, '');
  const v = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  const ticks = '`'.repeat(Math.max(1, ...[...v.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const pad = v.startsWith('`') || v.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${v}${pad}${ticks}`;
}

// A fence that nothing inside the text can close: backticks or tildes,
// whichever needs the shorter run.
export function fenceFor(text) {
  const run = (ch) => Math.max(3, ...[...String(text).matchAll(ch === '`' ? /`+/g : /~+/g)].map((m) => m[0].length + 1));
  const ticks = run('`');
  const tildes = run('~');
  return ticks <= tildes ? '`'.repeat(ticks) : '~'.repeat(tildes);
}

// Characters a reader cannot see, or that a renderer may take as a line
// break or a change of text direction. Shown as their escape.
const UNSEEN = /[\r\u0085\u2028\u2029\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069\u061C]/g;
const escapeOf = (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

// Bidirectional controls: they reorder what a reader sees, so an input
// that carries them is refused rather than shown (as on the permission
// card).
export const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

// A fenced code block that shows the text exactly as it is. CRLF ends a
// line; any other character from UNSEEN shows as its escape, so nothing in
// the block reads differently from what the text holds.
export function codeBlock(text, lang = '') {
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(UNSEEN, escapeOf);
  const fence = fenceFor(s);
  return `${fence}${lang}\n${s}\n${fence}`;
}

// The exact JSON for audit. Those characters can only sit inside JSON
// strings, so writing them as \u escapes gives the same document: it
// parses to the same input, and the bridge hashes the parsed value.
export function exactJsonBlock(json, lang = 'json') {
  const s = String(json).replace(UNSEEN, escapeOf);
  const fence = fenceFor(s);
  return `${fence}${lang}\n${s}\n${fence}`;
}

// Readable text (a message, a comment): markdown kept, line breaks kept,
// every line quoted so the text stays inside its block.
export function quotedText(text) {
  return neutralise(String(text ?? ''))
    .replace(CONTROL_KEEP_LINES, '')
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// A room, by its title when the bridge knows it.
function roomRef(id, ctx) {
  if (!isStr(id) || !id) return null;
  const t = ctx.roomTitle?.(id);
  const here = ctx.turnRoomId && id === ctx.turnRoomId;
  if (t) return `“${plainText(t, 120)}”${here ? ' (the room this ask came from)' : ''}`;
  return here ? `the room this ask came from (${inlineCode(id)})` : `a room the bridge does not know (${inlineCode(id)})`;
}
const roomShort = (id, ctx) => {
  const t = isStr(id) && id ? ctx.roomTitle?.(id) : null;
  if (t) return `“${titleText(t, 60)}”`;
  return ctx.turnRoomId && id === ctx.turnRoomId ? 'this room' : 'another room';
};
const itemRef = (id) => (isStr(id) || isNum(id) ? inlineCode(String(id), 80) : 'an item');

// How each field is shown. `text`: quoted readable text. `code`: a code
// block (`lang` optional). `path`/`inline`: inline code. `room`: a room by
// its title. `value`: a short plain value. `list`: an array of inline codes.
const F = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra });

// The tools agents ask for. `title` is the plain sentence for the item's
// title, `lead` the same with markdown; both get (input, ctx).
const TOOLS = {
  agent_chat_send: {
    title: (i, c) => `Send a message in ${roomShort(i.room_id, c)}`,
    fields: [F('message', 'Message', 'text'), F('room_id', 'Room', 'room'), F('wait_seconds', 'Wait for a reply (seconds)', 'value')],
  },
  agent_chat_read: {
    title: (i, c) => `Read the messages in ${roomShort(i.room_id, c)}`,
    fields: [F('room_id', 'Room', 'room'), F('limit', 'How many', 'value')],
  },
  agent_chat_start: {
    title: (i) => (isStr(i.person) ? `Start a chat with ${titleText(i.person, 60)}` : 'Start a chat with another session'),
    fields: [F('message', 'Opening message', 'text'), F('justification', 'Why it wants to talk', 'text'),
      F('person', 'Person', 'inline'), F('target_convo_id', 'Session', 'inline'), F('topic', 'Topic', 'value'), F('mission', 'Mission', 'value')],
  },
  agent_chat_accept: { title: (i, c) => `Accept the chat request for ${roomShort(i.room_id, c)}`, fields: [F('room_id', 'Room', 'room')] },
  agent_chat_refuse: { title: (i, c) => `Refuse the chat request for ${roomShort(i.room_id, c)}`, fields: [F('room_id', 'Room', 'room'), F('reason', 'Reason', 'text')] },
  agent_chat_mute: { title: (i, c) => `Mute ${roomShort(i.room_id, c)}`, fields: [F('room_id', 'Room', 'room'), F('reason', 'Reason', 'text')] },
  item_comment: {
    title: (i) => `Comment on tracker item ${titleText(String(i.id ?? ''), 40) || '(none)'}`,
    lead: (i) => `Comment on tracker item ${itemRef(i.id)}`,
    fields: [F('body', 'Comment', 'text'), F('id', 'Item', 'inline'), F('attachments', 'Attachments', 'list'),
      F('actions', 'Buttons', 'list'), F('awaiting', 'Hands the item to', 'value'), F('shared_by', 'On the mission of', 'inline')],
  },
  item_create: {
    title: (i) => `File a tracker ${isStr(i.kind) ? titleText(i.kind, 20) : 'item'}${isStr(i.title) ? `: ${titleText(i.title, 80)}` : ''}`,
    fields: [F('title', 'Title', 'value'), F('kind', 'Kind', 'value'), F('body', 'Body', 'text'), F('actions', 'Buttons', 'list'),
      F('attachments', 'Attachments', 'list'), F('labels', 'Labels', 'list'), F('mission', 'Mission', 'value'), F('shared_by', 'On the mission of', 'inline')],
  },
  item_close: {
    title: (i) => `Close tracker item ${titleText(String(i.id ?? ''), 40)}${isStr(i.resolution) ? ` as ${titleText(i.resolution, 20)}` : ''}`,
    lead: (i) => `Close tracker item ${itemRef(i.id)}${isStr(i.resolution) ? ` as ${plainText(i.resolution, 20)}` : ''}`,
    fields: [F('comment', 'Closing comment', 'text'), F('id', 'Item', 'inline'), F('resolution', 'Resolution', 'value'), F('shared_by', 'On the mission of', 'inline')],
  },
  item_get: { title: (i) => `Read tracker item ${titleText(String(i.id ?? ''), 40)}`, lead: (i) => `Read tracker item ${itemRef(i.id)}`, fields: [F('id', 'Item', 'inline')] },
  mission_get: { title: (i) => (i.num != null ? `Read mission ${titleText(String(i.num), 20)}` : 'Read the mission'), fields: [F('num', 'Mission', 'value'), F('shared_by', 'Shared by', 'inline')] },
  milestone_post: {
    title: (i) => `Post a milestone${isStr(i.title) ? `: ${titleText(i.title, 80)}` : ''}`,
    fields: [F('title', 'Title', 'value'), F('body', 'Body', 'text'), F('kind', 'Kind', 'value'), F('mission', 'Mission', 'value'), F('shared_by', 'On the mission of', 'inline')],
  },
  mission_status: { title: () => 'Set the mission status', fields: [F('status', 'Status', 'text'), F('mission', 'Mission', 'value'), F('shared_by', 'On the mission of', 'inline')] },
  send_attachment: {
    title: (i, c) => `Send the file ${isStr(i.path) ? titleText(i.path.split('/').pop(), 60) : ''}${i.chat_room_id ? ` to ${roomShort(i.chat_room_id, c)}` : ' into your chat'}`,
    lead: (i, c) => `Send the file ${isStr(i.path) ? inlineCode(i.path.split('/').pop(), 80) : ''}${i.chat_room_id ? ` to ${roomRef(i.chat_room_id, c)}` : ' into your chat'}`,
    fields: [F('path', 'File', 'path'), F('caption', 'Caption', 'text'), F('chat_room_id', 'Room', 'room')],
  },
  Bash: {
    // The title quotes the command, never the agent's description of it.
    title: (i) => (isStr(i.command) && i.command.trim() ? `Run ${titleText(i.command, 80)}` : 'Run a shell command'),
    lead: () => 'Run a shell command',
    fields: [F('command', 'Command', 'code', { lang: 'sh' }), F('description', 'What the agent says it does', 'value'),
      F('timeout', 'Time limit (ms)', 'value'), F('run_in_background', 'In the background', 'value')],
  },
  Read: {
    title: (i) => `Read the file ${isStr(i.file_path) ? titleText(i.file_path.split('/').pop(), 60) : ''}`,
    lead: (i) => `Read the file ${isStr(i.file_path) ? inlineCode(i.file_path, 200) : ''}`,
    fields: [F('file_path', 'File', 'path'), F('offset', 'From line', 'value'), F('limit', 'Lines', 'value'), F('pages', 'Pages', 'value')],
  },
  Write: {
    title: (i) => `Write the file ${isStr(i.file_path) ? titleText(i.file_path.split('/').pop(), 60) : ''}`,
    lead: (i) => `Write the file ${isStr(i.file_path) ? inlineCode(i.file_path, 200) : ''} (replacing it if it exists)`,
    fields: [F('file_path', 'File', 'path'), F('content', 'New content', 'code')],
  },
  Edit: {
    title: (i) => `Change the file ${isStr(i.file_path) ? titleText(i.file_path.split('/').pop(), 60) : ''}`,
    lead: (i) => `Change the file ${isStr(i.file_path) ? inlineCode(i.file_path, 200) : ''}`,
    fields: [F('file_path', 'File', 'path'), F('old_string', 'Replace this', 'code'), F('new_string', 'With this', 'code'), F('replace_all', 'Every occurrence', 'value')],
  },
  Glob: { title: (i) => `List files matching ${titleText(i.pattern ?? '', 60)}`, lead: (i) => `List files matching ${inlineCode(i.pattern ?? '', 120)}`, fields: [F('pattern', 'Pattern', 'inline'), F('path', 'In', 'path')] },
  Grep: {
    title: (i) => `Search files for ${titleText(i.pattern ?? '', 60)}`,
    lead: (i) => `Search files for ${inlineCode(i.pattern ?? '', 120)}`,
    fields: [F('pattern', 'Pattern', 'inline'), F('path', 'In', 'path'), F('glob', 'Files', 'inline')],
  },
  WebFetch: { title: (i) => `Fetch the web page ${titleText(i.url ?? '', 80)}`, lead: (i) => `Fetch the web page ${inlineCode(i.url ?? '', 200)}`, fields: [F('url', 'Address', 'path'), F('prompt', 'What to look for', 'text')] },
  WebSearch: { title: (i) => `Search the web for ${titleText(i.query ?? '', 80)}`, lead: (i) => `Search the web for ${inlineCode(i.query ?? '', 200)}`, fields: [F('query', 'Search', 'inline')] },
};

// A label for a field the tool table does not name: `room_id` → "Room id".
const labelFor = (key) => {
  const s = String(key).replace(/[_-]+/g, ' ').trim();
  return plainText(s ? s[0].toUpperCase() + s.slice(1) : key, 60);
};

// One field, rendered as markdown lines. A value of a type the table did not
// expect is shown the generic way rather than guessed at.
function renderField(label, kind, value, ctx, lang = '') {
  const head = `**${label}**`;
  if (kind === 'text' && isStr(value)) return [`${head}`, '', value.trim() ? quotedText(value) : '> (empty)'];
  if (kind === 'code' && isStr(value)) return [`${head}`, '', codeBlock(value, lang)];
  if ((kind === 'path' || kind === 'inline') && (isStr(value) || isNum(value)) && !/\n/.test(String(value))) return [`${head}: ${inlineCode(String(value))}`];
  if (kind === 'room' && isStr(value)) return [`${head}: ${roomRef(value, ctx)}`];
  if (kind === 'value' && (isStr(value) || isNum(value) || typeof value === 'boolean') && !/\n/.test(String(value))) {
    const v = typeof value === 'boolean' ? (value ? 'yes' : 'no') : plainText(String(value), 300);
    return [`${head}: ${v}`];
  }
  if (kind === 'list' && Array.isArray(value) && value.every((v) => isStr(v) || isNum(v))) {
    return value.length ? [`${head}:`, ...value.map((v) => `- ${inlineCode(String(v))}`)] : [`${head}: (none)`];
  }
  return renderGeneric(label, value);
}

function renderGeneric(label, value) {
  const head = `**${label}**`;
  if (value === null || typeof value === 'boolean' || isNum(value)) return [`${head}: ${inlineCode(String(value))}`];
  if (isStr(value)) {
    if (!/[\n\r\u0085\u2028\u2029]/.test(value) && value.length <= 120) return [`${head}: ${inlineCode(value)}`];
    return [`${head}`, '', codeBlock(value)];
  }
  return [`${head}`, '', codeBlock(JSON.stringify(value, null, 2) ?? String(value), 'json')];
}

// What the call does, in plain words: a one-line title (plain text), a
// lead sentence (markdown) and the field blocks (markdown lines).
export function describeAction(toolName, toolInput, ctx = {}) {
  const bare = String(toolName ?? '').startsWith(ASK) ? String(toolName).slice(ASK.length) : String(toolName ?? '');
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput : {};
  const spec = Object.prototype.hasOwnProperty.call(TOOLS, bare) ? TOOLS[bare] : null;
  const blocks = [];
  const seen = new Set();
  let title;
  let lead;
  if (spec) {
    title = titleText(spec.title(input, ctx), 140);
    lead = spec.lead ? spec.lead(input, ctx) : plainText(title, 200);
    for (const f of spec.fields) {
      seen.add(f.key);
      if (input[f.key] === undefined) continue;
      blocks.push(renderField(f.label, f.kind, input[f.key], ctx, f.lang));
    }
  } else {
    const shown = titleText(bare, 80) || 'a tool';
    title = `Use the tool ${shown}`;
    lead = `Use the tool ${inlineCode(bare || '?', 120)}`;
  }
  for (const key of Object.keys(input).sort()) {
    if (seen.has(key) || input[key] === undefined) continue;
    blocks.push(renderGeneric(labelFor(key), input[key]));
  }
  return { title, lead, blocks: blocks.map((b) => b.join('\n')) };
}
