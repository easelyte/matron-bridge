// Format a subagent tool_use block as a plain journal-text body for the
// child convo. Extracted from index.js (where it lived untested) and widened
// (Dan, 2026-07-16): the old whitelist surfaced only WebSearch/WebFetch/
// Task/TodoWrite and silently dropped everything else — and subagents
// overwhelmingly run Bash/Read/Grep, so sub-chat panels showed nothing but
// the subagent's prose. The child conversation IS the subagent's own
// dedicated surface, so unlike the parent's key-event gating every tool call
// formats to something; unknown tools get a generic `🔧 Name` line rather
// than vanishing.
//
// No 🔀[label] prefix on any line: the child conversation is the subagent,
// so its label lives in the convo title, not on every message.
//
// Edit/Write/MultiEdit return null on purpose — the caller publishes a
// structured diff card for those (publishEditDiffToConvo), and a text line
// here would duplicate it.

// Same display truncation the parent's `🔧` indicator applies to a Bash
// command (index.js) and truncateActivityDetail applies to the activity
// ephemeral — the surfaces show the same command text.
const BASH_COMMAND_MAX_CHARS = 100;

export function formatSubagentToolBody(toolName, input = {}) {
  if (toolName === 'Bash' && input.command) {
    const command = String(input.command);
    const trimmed = command.length > BASH_COMMAND_MAX_CHARS
      ? command.slice(0, BASH_COMMAND_MAX_CHARS) + '…'
      : command;
    return `🔧 \`${trimmed}\``;
  }
  if (toolName === 'Read' && input.file_path) return `📖 ${input.file_path}`;
  if ((toolName === 'Glob' || toolName === 'Grep') && input.pattern) {
    return `🔍 ${input.pattern}`;
  }
  if (toolName === 'WebSearch' && input.query) return `🌐 ${input.query}`;
  if (toolName === 'WebFetch' && input.url) return `🌐 ${input.url}`;
  if (toolName === 'Task' || toolName === 'Agent') {
    const desc = (input.description || input.prompt || '').slice(0, 80);
    return `🔀 Nested subtask: ${desc}`;
  }
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const lines = input.todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
      return `${icon} ${t.content || t.text || ''}`;
    });
    return `📋 Todos:\n${lines.join('\n')}`;
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return null;
  }
  if (typeof toolName === 'string' && toolName) return `🔧 ${toolName}`;
  return null;
}

// The same tool call as structured data, published alongside the text body as
// `payload.step` so a client can describe the step in plain words ("Reading
// paths.py…", "Ran the tests") without parsing the emoji line — and tell a real
// tool call from agent prose that happens to start with the same emoji. Shape
// (flat, every field optional except tool):
//   { tool, command?, path?, pattern?, url?, description? }
// Field values never carry more than the body already shows: the command is cut
// at the same 100 characters, the description at the same 80. Returns null
// exactly when formatSubagentToolBody does (no text line is published then).
const STEP_TOOL_NAME = /^[A-Za-z_][\w.:-]{0,79}$/;

export function subagentToolStep(toolName, input = {}) {
  if (formatSubagentToolBody(toolName, input) === null) return null;
  if (typeof toolName !== 'string' || !STEP_TOOL_NAME.test(toolName)) return null;
  const step = { tool: toolName };
  if (toolName === 'Bash' && input.command) {
    const command = String(input.command);
    step.command = command.length > BASH_COMMAND_MAX_CHARS
      ? command.slice(0, BASH_COMMAND_MAX_CHARS) + '…'
      : command;
  } else if (toolName === 'Read' && input.file_path) {
    step.path = String(input.file_path);
  } else if ((toolName === 'Glob' || toolName === 'Grep') && input.pattern) {
    step.pattern = String(input.pattern);
  } else if (toolName === 'WebSearch' && input.query) {
    step.pattern = String(input.query);
  } else if (toolName === 'WebFetch' && input.url) {
    step.url = String(input.url);
  } else if (toolName === 'Task' || toolName === 'Agent') {
    const desc = String(input.description || input.prompt || '').slice(0, 80);
    if (desc) step.description = desc;
  }
  return step;
}
