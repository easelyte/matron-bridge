// Role-based filtering of the ask-user MCP tool list.
//
// Every session gets the full ask-user tool set by default. With the bridge
// opt-in BRIDGE_TOOL_FILTER=1, lib/spawn-env.js hands each session a
// BRIDGE_TOOL_ROLE ('coordinator' or 'worker'); a worker then does not see the
// Coordinator-only tools, which keeps its tool prefix smaller and stops it
// reaching for tools that only make sense for the Coordinator.
//
// Fail open: an unset or unrecognised role registers every tool.

// Tools only the Coordinator session uses.
export const COORDINATOR_ONLY = Object.freeze([
  'project_create',
  'project_update',
  'project_status',
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
  'box_defaults_set',
]);

// Tools that register for every role. permission_request is the
// --permission-prompt-tool target: hiding it would deny every gated tool call.
export const ALWAYS = Object.freeze(['permission_request']);

export const ROLES = Object.freeze(['worker', 'coordinator', 'full']);

const HIDDEN_FOR_WORKER = new Set(COORDINATOR_ONLY);
const ALWAYS_SET = new Set(ALWAYS);

// True when `name` should be registered for `role`. Only the 'worker' role
// hides anything; ALWAYS tools register regardless.
export function shouldRegister(name, role) {
  if (ALWAYS_SET.has(name)) return true;
  if (role === 'worker') return !HIDDEN_FOR_WORKER.has(name);
  return true;
}
