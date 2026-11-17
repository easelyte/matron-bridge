// Role-based filtering of the ask-user MCP tool list.
//
// lib/spawn-env.js (Claude) and lib/codex-mcp.js (Codex) hand each session a
// BRIDGE_TOOL_ROLE ('coordinator', 'worker' or 'full'); a worker does not see
// the Coordinator-only tools, which keeps its tool prefix smaller (about a
// quarter of the ask-user definitions) and stops it reaching for tools the
// journal would refuse it anyway. On by default; BRIDGE_TOOL_FILTER=0 in the
// bridge's environment turns it off and every session gets every tool.
//
// Fail open: an unset or unrecognised role registers every tool, and a
// session whose role is not known yet (the journal has not said who the
// Coordinator is) is 'full'.

// Tools only the Coordinator session uses.
export const COORDINATOR_ONLY = Object.freeze([
  'project_close',
  'project_merge',
  'routine_list',
  'routine_update',
  'routine_run',
  'routine_create',
  'routine_delete',
  'consent_list',
  'consent_decide',
  'session_set_model',
  'session_compact',
  'session_carry_on',
  'briefing_publish',
  'unseen_list',
  'timeline_week_read',
  'timeline_week_write',
]);

// Tools that register for every role. permission_request is the
// --permission-prompt-tool target: hiding it would deny every gated tool call.
export const ALWAYS = Object.freeze(['permission_request']);

const HIDDEN_FOR_WORKER = new Set(COORDINATOR_ONLY);
const ALWAYS_SET = new Set(ALWAYS);

// The role a session's ask-user server gets, or null for none (filter off).
// `baseEnv` is the bridge's own environment.
export function toolRoleFor({ baseEnv = process.env, coordinator, roleKnown } = {}) {
  if (baseEnv?.BRIDGE_TOOL_FILTER === '0') return null;
  return coordinator === true ? 'coordinator' : roleKnown === true ? 'worker' : 'full';
}

// True when `name` should be registered for `role`. Only the 'worker' role
// hides anything; ALWAYS tools register regardless.
export function shouldRegister(name, role) {
  if (ALWAYS_SET.has(name)) return true;
  if (role === 'worker') return !HIDDEN_FOR_WORKER.has(name);
  return true;
}
