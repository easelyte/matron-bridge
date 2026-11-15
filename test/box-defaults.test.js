import { describe, it, expect } from 'vitest';
import {
  createBoxDefaultsStore,
  resolveDefaultAgent,
  boxModelFor,
  boxEffortFor,
  usableCodexModel,
  usableCodexEffort,
  codexEnvDefaults,
  createBoxDefaultsSetter,
} from '../lib/box-defaults.js';

const quiet = { warn() {} };

describe('createBoxDefaultsStore', () => {
  it('starts unknown and empty', () => {
    const store = createBoxDefaultsStore({ log: quiet });
    expect(store.snapshot()).toEqual({ known: false, agent: null, model: null, effort: null });
  });

  it('takes hello_ok values before identity is known', () => {
    const store = createBoxDefaultsStore({ identity: () => null, log: quiet });
    expect(store.apply({ device_id: 7, default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: 'high' }, { fromHello: true })).toBe(true);
    expect(store.snapshot()).toEqual({ known: true, agent: 'codex', model: 'gpt-5.1-codex', effort: 'high' });
  });

  it('applies a live frame for this box and drops one for another box', () => {
    const store = createBoxDefaultsStore({ identity: () => ({ deviceId: 7, name: 'box-a' }), log: quiet });
    expect(store.apply({ device_id: 8, default_agent: 'codex' })).toBe(false);
    expect(store.snapshot().known).toBe(false);
    expect(store.apply({ device_id: 7, default_agent: 'CODEX', default_model: null, default_effort: null })).toBe(true);
    expect(store.snapshot()).toEqual({ known: true, agent: 'codex', model: null, effort: null });
  });

  it('drops a live frame while its own id is unknown', () => {
    const store = createBoxDefaultsStore({ identity: () => null, log: quiet });
    expect(store.apply({ device_id: 7, default_agent: 'codex' })).toBe(false);
  });

  it('clears with nulls and refuses junk types', () => {
    const store = createBoxDefaultsStore({ identity: () => ({ deviceId: 1 }), log: quiet });
    store.apply({ device_id: 1, default_agent: 'claude', default_model: 'opus' });
    expect(store.apply({ device_id: 1, default_model: 5 })).toBe(false);
    expect(store.snapshot().model).toBe('opus');
    store.apply({ device_id: 1, default_agent: null, default_model: null, default_effort: null });
    expect(store.snapshot()).toEqual({ known: true, agent: null, model: null, effort: null });
  });

  it('reads an unknown agent name as no box agent', () => {
    const store = createBoxDefaultsStore({ identity: () => ({ deviceId: 1 }), log: quiet });
    store.apply({ device_id: 1, default_agent: 'gemini' });
    expect(store.snapshot().agent).toBe(null);
  });
});

describe('resolveDefaultAgent', () => {
  const yes = () => true;
  const no = () => false;

  it('box beats env beats claude', () => {
    expect(resolveDefaultAgent({ box: { agent: 'codex' }, envAgent: 'claude', codexAvailable: yes })).toEqual({ agent: 'codex', configured: 'codex', source: 'box' });
    expect(resolveDefaultAgent({ box: { agent: null }, envAgent: 'codex', codexAvailable: yes })).toEqual({ agent: 'codex', configured: 'codex', source: 'env' });
    expect(resolveDefaultAgent({ box: { agent: 'claude' }, envAgent: 'codex', codexAvailable: yes })).toEqual({ agent: 'claude', configured: 'claude', source: 'box' });
    expect(resolveDefaultAgent({ box: null, envAgent: null })).toEqual({ agent: 'claude', configured: 'claude', source: 'builtin' });
  });

  it('runs Claude when the Codex default cannot be spawned', () => {
    expect(resolveDefaultAgent({ box: { agent: 'codex' }, envAgent: 'claude', codexAvailable: no }))
      .toEqual({ agent: 'claude', configured: 'codex', source: 'box', codexUnavailable: true });
    expect(resolveDefaultAgent({ box: { agent: 'codex' }, codexAvailable: () => { throw new Error('x'); } }).agent).toBe('claude');
  });
});

describe('boxModelFor / boxEffortFor', () => {
  it('applies the box model only to the default agent', () => {
    const box = { agent: 'claude', model: 'Opus', effort: 'high' };
    expect(boxModelFor('claude', { box, defaultAgent: 'claude' })).toBe('opus');
    expect(boxEffortFor('claude', { box, defaultAgent: 'claude' })).toBe('high');
    expect(boxModelFor('codex', { box, defaultAgent: 'claude' })).toBe(null);
    expect(boxEffortFor('codex', { box, defaultAgent: 'claude' })).toBe(null);
  });

  it('checks a Codex box model with the Codex rules', () => {
    const box = { agent: 'codex', model: 'gpt-5.1-codex', effort: 'minimal' };
    expect(boxModelFor('codex', { box, defaultAgent: 'codex' })).toBe('gpt-5.1-codex');
    expect(boxEffortFor('codex', { box, defaultAgent: 'codex' })).toBe('minimal');
    expect(boxModelFor('claude', { box, defaultAgent: 'claude' })).toBe(null);
  });

  it('keeps a Codex box\'s values off the Claude it falls back to', () => {
    const box = { agent: 'codex', model: 'gpt-5.1-codex', effort: 'high' };
    const { agent, configured } = resolveDefaultAgent({ box, envAgent: 'claude', codexAvailable: () => false });
    expect(agent).toBe('claude');
    expect(boxEffortFor(agent, { box, defaultAgent: configured })).toBe(null);
    expect(boxModelFor(agent, { box, defaultAgent: configured })).toBe(null);
  });

  it('ignores a value the agent cannot start with', () => {
    expect(boxModelFor('claude', { box: { model: 'default' }, defaultAgent: 'claude' })).toBe(null);
    expect(boxModelFor('claude', { box: { model: 'not a model' }, defaultAgent: 'claude' })).toBe(null);
    expect(boxEffortFor('codex', { box: { effort: 'max' }, defaultAgent: 'codex' })).toBe(null);
    expect(boxModelFor('claude', { box: null, defaultAgent: 'claude' })).toBe(null);
  });
});

describe('usableCodexModel / usableCodexEffort', () => {
  it('accepts single-token ids and Codex levels', () => {
    expect(usableCodexModel(' gpt-5.1-codex ')).toBe('gpt-5.1-codex');
    expect(usableCodexModel('default')).toBe(null);
    expect(usableCodexModel('two words')).toBe(null);
    expect(usableCodexModel(null)).toBe(null);
    expect(usableCodexEffort('XHIGH')).toBe('xhigh');
    expect(usableCodexEffort('max')).toBe(null);
  });
});

describe('codexEnvDefaults', () => {
  it('runs Codex at xhigh with no env, and leaves the model to Codex', () => {
    expect(codexEnvDefaults({})).toEqual({ model: null, effort: 'xhigh' });
    expect(codexEnvDefaults()).toEqual({ model: null, effort: 'xhigh' });
  });

  it('takes the env model and effort when usable', () => {
    expect(codexEnvDefaults({ MATRON_CODEX_DEFAULT_MODEL: 'gpt-6-astra', MATRON_CODEX_DEFAULT_EFFORT: 'High' }))
      .toEqual({ model: 'gpt-6-astra', effort: 'high' });
  });

  it('ignores "default" and unknown levels', () => {
    expect(codexEnvDefaults({ MATRON_CODEX_DEFAULT_MODEL: 'default', MATRON_CODEX_DEFAULT_EFFORT: 'max' }))
      .toEqual({ model: null, effort: 'xhigh' });
  });
});

describe('createBoxDefaultsSetter', () => {
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  it('PUTs only the named keys, nulls included, and returns the journal state', async () => {
    const seen = [];
    const set = createBoxDefaultsSetter({
      baseUrl: 'https://j/', token: 't',
      fetchImpl: async (url, init) => { seen.push([url, init]); return res(200, { device_id: 4, default_agent: 'codex', default_model: null, default_effort: null }); },
    });
    const r = await set({ device_id: 4, agent: 'codex', model: null });
    expect(r).toEqual({ status: 200, body: { device_id: 4, default_agent: 'codex', default_model: null, default_effort: null } });
    expect(seen[0][0]).toBe('https://j/devices/4/defaults');
    expect(seen[0][1].method).toBe('PUT');
    expect(seen[0][1].headers.Authorization).toBe('Bearer t');
    expect(JSON.parse(seen[0][1].body)).toEqual({ default_agent: 'codex', default_model: null });
  });

  it('refuses bad input without calling the journal', async () => {
    const set = createBoxDefaultsSetter({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('called'); } });
    expect((await set({ device_id: 'x', agent: 'codex' })).status).toBe(400);
    expect((await set({ device_id: 4 })).status).toBe(400);
    expect((await set({ device_id: 4, agent: 5 })).status).toBe(400);
  });

  it('passes the journal\'s refusal through and names an old journal', async () => {
    const bad = createBoxDefaultsSetter({ baseUrl: 'https://j', token: 't', fetchImpl: async () => res(400, { error: 'bad_agent' }) });
    expect(await bad({ device_id: 4, agent: 'gemini' })).toEqual({ status: 400, body: { error: 'bad_agent' } });
    const old = createBoxDefaultsSetter({ baseUrl: 'https://j', token: 't', fetchImpl: async () => res(404, null) });
    expect((await old({ device_id: 4, agent: 'codex' })).body.error).toMatch(/no box defaults/);
    const down = createBoxDefaultsSetter({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await down({ device_id: 4, agent: 'codex' })).toEqual({ status: 502, body: { error: 'journal unreachable' } });
  });
});
