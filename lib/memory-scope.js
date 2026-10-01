// Memory scopes (spec 2026-10-01 memory scopes): who a memory is for, and
// whether a given session is in its audience. Pure and dependency-free so
// the spawn-time block (lib/coordinator.js) and the memory_list filter
// (lib/memory-tools.js) decide the same way.
//
//   global        every session — what every memory was before scopes
//   coordinator   the user's Coordinator only
//   repo:<name>   sessions whose working directory is a checkout of <name>
//
// The Coordinator is in every memory's audience: it hands work across
// repos (the merge train, deploy owners) and its playbook names those
// rules, so it reads the whole list, each line with its scope. An ordinary
// session gets the global memories and its repo's. A memory with no
// `scope` (an older journal) is global; a scope this bridge does not
// recognise (a journal a version ahead) is left out of an ordinary
// session's set rather than guessed at.
export const SCOPE_RE = /^(global|coordinator|repo:[A-Za-z0-9_.-]+)$/;
export const SCOPE_MAX = 128;
export const DEFAULT_SCOPE = 'global';

export const validScope = (v) => typeof v === 'string' && v.length <= SCOPE_MAX && SCOPE_RE.test(v);

export const scopeOf = (m) => (m && typeof m.scope === 'string' && m.scope ? m.scope : DEFAULT_SCOPE);

// The scopes a session is given, in the order the block names them.
export function audienceScopes({ coordinator = false, repo = null } = {}) {
  const out = [DEFAULT_SCOPE];
  if (typeof repo === 'string' && repo) out.push(`repo:${repo}`);
  if (coordinator) out.push('coordinator');
  return out;
}

// Repo names compare case-insensitively (GitHub's rule; the journal stores
// the name as saved).
export function memoryApplies(m, { coordinator = false, repo = null } = {}) {
  if (coordinator) return true;
  const scope = scopeOf(m);
  if (scope === DEFAULT_SCOPE) return true;
  if (scope.startsWith('repo:')) {
    return typeof repo === 'string' && repo !== '' && scope.slice('repo:'.length).toLowerCase() === repo.toLowerCase();
  }
  return false;
}

// { shown, omitted, omittedScopes } — omittedScopes sorted and unique, so
// a session can be told what it is not seeing (and how to see it).
export function splitByAudience(memories, audience) {
  const shown = [];
  const omitted = [];
  for (const m of Array.isArray(memories) ? memories : []) {
    if (!m || typeof m !== 'object') continue;
    (memoryApplies(m, audience) ? shown : omitted).push(m);
  }
  const omittedScopes = [...new Set(omitted.map(scopeOf))].sort();
  return { shown, omitted, omittedScopes };
}
