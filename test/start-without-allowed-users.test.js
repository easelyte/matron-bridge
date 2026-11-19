import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (top-level sockets and services), so
// this runs the real handleCommand source against a stub scope. Every name
// the function reads resolves through `scope`; the first thing /start,
// /resume <id> and /workdir do with their arguments is extractBypassFlag,
// which the stub turns into a marker so the test stops there.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function handleCommandSource() {
  const start = indexSource.indexOf('async function handleCommand(');
  const end = indexSource.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end + 2);
}

const REACHED = new Error('reached argument parsing');

function loadHandleCommand() {
  const values = {
    sessions: new Map(),
    approvalGate: { enabled: false },
    runCodexControl: async () => false,
    extractBypassFlag: () => { throw REACHED; },
  };
  const scope = new Proxy(values, { has: (_t, key) => typeof key === 'string' });
  // Sloppy-mode function body, so `with` can supply the module's globals.
  return new Function('scope', `with (scope) { ${handleCommandSource()}\nreturn handleCommand; }`)(scope);
}

// A box with no ALLOWED_USER_IDS (the shipped default) has no user identity
// to pass along with a typed command.
async function runAsUnnamedUser(text) {
  const replies = [];
  const reply = async (msg) => { replies.push(msg); };
  let reached = false;
  try {
    await loadHandleCommand()('room-a', text, reply, reply);
  } catch (err) {
    if (err !== REACHED) throw err;
    reached = true;
  }
  return { replies, reached };
}

describe('session commands on a box with no allowed-users list', () => {
  for (const text of ['!start', '!resume 1', '!workdir $HOME/project']) {
    it(`${text.split(' ')[0]} is not refused for want of a sender`, async () => {
      const { replies, reached } = await runAsUnnamedUser(text);
      expect(replies).toEqual([]);
      expect(reached).toBe(true);
    });
  }
});
