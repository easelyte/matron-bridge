import { describe, it, expect } from 'vitest';
import { validScope, scopeOf, audienceScopes, memoryApplies, splitByAudience } from '../lib/memory-scope.js';

const m = (name, scope) => ({ id: `me_${name}`, name, description: name, ...(scope === undefined ? {} : { scope }) });

describe('memory scopes', () => {
  it('validScope: the three forms, repo names in the canonical characters, at most 128 chars', () => {
    for (const ok of ['global', 'coordinator', 'repo:yearbook-app', 'repo:Matron_Journal.v2', `repo:${'a'.repeat(123)}`]) expect(validScope(ok), ok).toBe(true);
    for (const bad of ['', 'Global', 'repo', 'repo:', 'repo:a/b', 'repo:a b', 'team:ops', `repo:${'a'.repeat(124)}`, 42, null, undefined]) expect(validScope(bad), String(bad)).toBe(false);
  });

  it('scopeOf: a missing or empty scope is global', () => {
    expect(scopeOf(m('a'))).toBe('global');
    expect(scopeOf(m('a', ''))).toBe('global');
    expect(scopeOf(m('a', 'coordinator'))).toBe('coordinator');
    expect(scopeOf(null)).toBe('global');
  });

  it('audienceScopes names what a session is given, in order', () => {
    expect(audienceScopes({})).toEqual(['global']);
    expect(audienceScopes({ repo: 'yearbook-app' })).toEqual(['global', 'repo:yearbook-app']);
    expect(audienceScopes({ coordinator: true, repo: 'x' })).toEqual(['global', 'repo:x', 'coordinator']);
    expect(audienceScopes({ repo: '' })).toEqual(['global']);
  });

  it('an ordinary session gets global and its own repo (case-insensitively), never coordinator or another repo', () => {
    const a = { repo: 'yearbook-app' };
    expect(memoryApplies(m('g', 'global'), a)).toBe(true);
    expect(memoryApplies(m('g'), a)).toBe(true);
    expect(memoryApplies(m('r', 'repo:yearbook-app'), a)).toBe(true);
    expect(memoryApplies(m('r', 'repo:Yearbook-App'), a)).toBe(true);
    expect(memoryApplies(m('o', 'repo:yearbook-infra'), a)).toBe(false);
    expect(memoryApplies(m('c', 'coordinator'), a)).toBe(false);
    expect(memoryApplies(m('r', 'repo:yearbook-app'), { repo: null })).toBe(false);
    expect(memoryApplies(m('r', 'repo:yearbook-app'), {})).toBe(false);
  });

  it('an unrecognised scope is left out of an ordinary session; the Coordinator gets everything', () => {
    expect(memoryApplies(m('x', 'team:ops'), { repo: 'a' })).toBe(false);
    for (const scope of ['global', 'coordinator', 'repo:anything', 'team:ops', undefined]) {
      expect(memoryApplies(m('x', scope), { coordinator: true }), String(scope)).toBe(true);
    }
  });

  it('splitByAudience: shown and omitted, with the omitted scopes sorted and unique; junk skipped', () => {
    const list = [m('a', 'coordinator'), m('b', 'repo:infra'), m('c'), m('d', 'repo:app'), m('e', 'coordinator'), null, 'junk'];
    const r = splitByAudience(list, { repo: 'app' });
    expect(r.shown.map((x) => x.name)).toEqual(['c', 'd']);
    expect(r.omitted.map((x) => x.name)).toEqual(['a', 'b', 'e']);
    expect(r.omittedScopes).toEqual(['coordinator', 'repo:infra']);
    expect(splitByAudience(list, { coordinator: true }).omitted).toEqual([]);
    expect(splitByAudience(undefined, {})).toEqual({ shown: [], omitted: [], omittedScopes: [] });
  });
});
