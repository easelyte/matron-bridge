import { describe, it, expect } from 'vitest';
import { promptCardQuestion, codexModelCardQuestion, codexEffortCardQuestion } from '../lib/button-card-text.js';

const buttons = (...labels) => labels.map((label, i) => ({ id: `prompt-opt-${i}`, label, value: `prompt-opt:${i}` }));

describe('promptCardQuestion', () => {
  it('is the bare question when no option has a description', () => {
    expect(promptCardQuestion({ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }, buttons('Yes', 'No')))
      .toBe('Proceed?');
  });

  it('lists the options with their descriptions when any has one', () => {
    const prompt = { question: 'Which database?', options: [
      { label: 'SQLite', description: 'One file, no server' },
      { label: 'Postgres' },
    ] };
    expect(promptCardQuestion(prompt, buttons('SQLite', 'Postgres')))
      .toBe('Which database?\n\n1. SQLite: One file, no server\n2. Postgres');
  });

  it('falls back to a generic header', () => {
    expect(promptCardQuestion({ options: [{ label: 'A' }] }, buttons('A'))).toBe('Claude is asking');
  });
});

describe('codex card questions', () => {
  it('names the current model, or the config default', () => {
    expect(codexModelCardQuestion({ model: 'gpt-x' }, {})).toBe('Current Codex model: gpt-x');
    expect(codexModelCardQuestion({}, {})).toBe('Current Codex model: Codex config default');
  });

  it('says why the model list is short when it could not be read', () => {
    expect(codexModelCardQuestion({ model: 'gpt-x' }, { modelsError: 'Could not list Codex models.' }))
      .toBe('Current Codex model: gpt-x\n\nCould not list Codex models.\nYou can still type /model <model-id>.');
  });

  it('names the current effort, or the config default', () => {
    expect(codexEffortCardQuestion({ effort: 'high' })).toBe('Codex effort: high');
    expect(codexEffortCardQuestion({})).toBe('Codex effort: config default');
  });
});
