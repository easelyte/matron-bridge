import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  extractSummaryFromContent,
  readSessionSummary,
  listSessionSummaries,
  listSessionIdsByMtime,
  pathExists,
} from '../lib/session-summary.js';

// Bounded, async session-summary reads (review fast-follow on the /sessions
// command). The old index.js getSessionSummary readFileSync'd EVERY
// transcript in the history dir — whole files, all of them, sliced to 15
// only after reading everything — blocking the event loop for all rooms and
// the journal socket. These tests pin the extraction format byte-for-byte
// and prove the new read-bounding: stat-sort first, read only the newest
// `limit` files, and per-file only a bounded head chunk.

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

describe('extractSummaryFromContent (format pinned to the old sync implementation)', () => {
  it('returns the first user text, trimmed', () => {
    const content = [
      JSON.stringify({ type: 'summary', summary: 'not this' }),
      userLine('  fix the flaky test  '),
      userLine('second message'),
    ].join('\n');
    expect(extractSummaryFromContent(content)).toBe('fix the flaky test');
  });

  it('reads array-form content via the first text block', () => {
    const content = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'from a block' }] },
    });
    expect(extractSummaryFromContent(content)).toBe('from a block');
  });

  it('skips <local-command and <command-name> pseudo-messages', () => {
    const content = [
      userLine('<local-command-stdout>ok</local-command-stdout>'),
      userLine('<command-name>/help</command-name>'),
      userLine('the real first message'),
    ].join('\n');
    expect(extractSummaryFromContent(content)).toBe('the real first message');
  });

  it('strips tags and caps at 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(100);
    expect(extractSummaryFromContent(userLine(`<b>${long}</b>`))).toBe('x'.repeat(80) + '…');
    const exact = 'y'.repeat(80);
    expect(extractSummaryFromContent(userLine(exact))).toBe(exact);
  });

  it('skips blank lines and returns empty string when no user text exists', () => {
    expect(extractSummaryFromContent('\n\n' + JSON.stringify({ type: 'assistant' }) + '\n')).toBe('');
    expect(extractSummaryFromContent('')).toBe('');
  });

  it('aborts to empty string on a malformed line, exactly like the old whole-file try/catch', () => {
    const content = ['{not json', userLine('never reached')].join('\n');
    expect(extractSummaryFromContent(content)).toBe('');
  });
});

describe('readSessionSummary (bounded head read)', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'summary-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('reads a small file and returns the same summary the sync version did', async () => {
    const p = path.join(dir, 'a.jsonl');
    await fsp.writeFile(p, userLine('hello world') + '\n');
    expect(await readSessionSummary(p)).toBe('hello world');
  });

  it('finds a summary that sits within the head chunk of a file larger than the cap', async () => {
    const p = path.join(dir, 'b.jsonl');
    const head = userLine('early message') + '\n';
    const filler = (JSON.stringify({ type: 'assistant', pad: 'z'.repeat(200) }) + '\n').repeat(50);
    await fsp.writeFile(p, head + filler);
    expect(await readSessionSummary(p, { headBytes: 256 })).toBe('early message');
  });

  it('never reads past the cap: a first user message BEYOND the head chunk is not found', async () => {
    const p = path.join(dir, 'c.jsonl');
    const filler = (JSON.stringify({ type: 'assistant', pad: 'z'.repeat(200) }) + '\n').repeat(50);
    await fsp.writeFile(p, filler + userLine('too deep to see') + '\n');
    // The old unbounded version would have found it; the bounded read stops
    // at the cap — this is the accepted trade for not reading whole
    // transcripts on a listing command.
    expect(await readSessionSummary(p, { headBytes: 256 })).toBe('');
  });

  it('drops the truncated partial line at the cap boundary instead of mis-parsing it', async () => {
    const p = path.join(dir, 'd.jsonl');
    // First line fits fully inside the cap; second line straddles it.
    const line1 = userLine('within the cap');
    const line2 = userLine('straddles the boundary ' + 'w'.repeat(300));
    await fsp.writeFile(p, line1 + '\n' + line2 + '\n');
    expect(await readSessionSummary(p, { headBytes: line1.length + 50 })).toBe('within the cap');
  });

  it('returns empty string for a missing file, like the old catch-all', async () => {
    expect(await readSessionSummary(path.join(dir, 'nope.jsonl'))).toBe('');
  });
});

describe('listSessionSummaries (stat-sort first, read only the top limit)', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sessions-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  async function writeFixtures(count) {
    const base = Date.now() / 1000 - count * 60;
    for (let i = 0; i < count; i++) {
      const name = `session-${String(i).padStart(2, '0')}.jsonl`;
      const p = path.join(dir, name);
      await fsp.writeFile(p, userLine(`message ${i}`) + '\n');
      // Deterministic, distinct mtimes: higher i = newer.
      const t = base + i * 60;
      fs.utimesSync(p, t, t);
    }
  }

  it('with >15 files, reads the contents of ONLY the 15 newest', async () => {
    await writeFixtures(20);
    const readSummary = vi.fn((filePath) => readSessionSummary(filePath));

    const items = await listSessionSummaries(dir, { limit: 15, readSummary });

    expect(items).toHaveLength(15);
    expect(readSummary).toHaveBeenCalledTimes(15);
    // Only the 15 newest (i = 5..19) were read; the 5 oldest never were.
    const readBasenames = readSummary.mock.calls.map(([p]) => path.basename(p)).sort();
    const expected = Array.from({ length: 15 }, (_, k) => `session-${String(k + 5).padStart(2, '0')}.jsonl`);
    expect(readBasenames).toEqual(expected);
  });

  it('returns items newest-first with the exact {sessionId, modified, summary} shape the command formats', async () => {
    await writeFixtures(3);
    const items = await listSessionSummaries(dir, { limit: 15 });

    expect(items.map(i => i.sessionId)).toEqual(['session-02', 'session-01', 'session-00']);
    for (const [idx, item] of items.entries()) {
      expect(item).toEqual({
        sessionId: `session-${String(2 - idx).padStart(2, '0')}`,
        modified: expect.any(Number),
        summary: `message ${2 - idx}`,
      });
    }
    expect(items[0].modified).toBeGreaterThan(items[1].modified);
  });

  it('ignores non-.jsonl files', async () => {
    await writeFixtures(1);
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'not a session');
    const items = await listSessionSummaries(dir);
    expect(items).toHaveLength(1);
    expect(items[0].sessionId).toBe('session-00');
  });

  it('returns [] for an empty or missing directory', async () => {
    expect(await listSessionSummaries(dir)).toEqual([]);
    expect(await listSessionSummaries(path.join(dir, 'missing'))).toEqual([]);
  });
});

// Issue #102 (short-read nit): FileHandle.read() may return fewer bytes than
// asked for; the old single-read code never checked bytesRead, so a short
// read left the tail of the buffer NUL-filled and the NUL-padded line
// aborted the whole scan to ''.
describe('readSessionSummary — short reads', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shortread-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('assembles the full head chunk even when read() returns a few bytes per call', async () => {
    const p = path.join(dir, 'short.jsonl');
    await fsp.writeFile(p, userLine('short-read survivor') + '\n');
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fh = await realOpen(...args);
      const realRead = fh.read.bind(fh);
      // Clamp every read to at most 7 bytes, whatever was requested —
      // a worst-case short-reading file handle.
      fh.read = (buffer, offset, length, position) =>
        realRead(buffer, offset, Math.min(length, 7), position);
      return fh;
    });
    try {
      expect(await readSessionSummary(p)).toBe('short-read survivor');
    } finally {
      spy.mockRestore();
    }
  });

  it('a read that comes up short of the stat size drops the trailing partial line instead of mis-parsing it', async () => {
    const p = path.join(dir, 'eof.jsonl');
    const line1 = userLine('complete line');
    const line2 = userLine('cut off mid-record');
    await fsp.writeFile(p, line1 + '\n' + line2 + '\n');
    const realOpen = fsp.open.bind(fsp);
    const cutAt = line1.length + 1 + Math.floor(line2.length / 2);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fh = await realOpen(...args);
      const realRead = fh.read.bind(fh);
      let served = 0;
      // Serve bytes only up to `cutAt`, then report EOF (bytesRead 0) — as if
      // the file shrank between stat and read.
      fh.read = async (buffer, offset, length, position) => {
        const allowed = Math.max(0, Math.min(length, cutAt - served));
        if (allowed === 0) return { bytesRead: 0, buffer };
        const res = await realRead(buffer, offset, allowed, position);
        served += res.bytesRead;
        return res;
      };
      return fh;
    });
    try {
      // line2's half-record must be dropped, not JSON.parse-aborted (which
      // would return '' and lose line1's summary too).
      expect(await readSessionSummary(p)).toBe('complete line');
    } finally {
      spy.mockRestore();
    }
  });
});

// Issue #102: !resume's id resolution ran readdirSync + statSync INSIDE a
// sort comparator (O(n log n) stats, all on the event loop) plus existsSync
// checks. These pin the async replacement's semantics to the old chain:
// readdir -> filter .jsonl -> strip the extension -> sort newest-first by
// mtime (stat once per file, stable on ties).
describe('listSessionIdsByMtime (async !resume id resolution)', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'resume-ids-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  async function writeSession(name, mtimeSec) {
    const p = path.join(dir, name);
    await fsp.writeFile(p, userLine('m') + '\n');
    fs.utimesSync(p, mtimeSec, mtimeSec);
  }

  it('returns ids newest-first by mtime — the exact order the old statSync comparator produced', async () => {
    const base = Math.floor(Date.now() / 1000) - 3600;
    await writeSession('old-session.jsonl', base);
    await writeSession('newest-session.jsonl', base + 120);
    await writeSession('middle-session.jsonl', base + 60);
    expect(await listSessionIdsByMtime(dir)).toEqual([
      'newest-session', 'middle-session', 'old-session',
    ]);
  });

  it('ignores non-.jsonl entries, exactly like the old endsWith filter', async () => {
    const base = Math.floor(Date.now() / 1000) - 3600;
    await writeSession('real.jsonl', base);
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'nope');
    await fsp.mkdir(path.join(dir, 'subdir.d'));
    expect(await listSessionIdsByMtime(dir)).toEqual(['real']);
  });

  it('numbered selection semantics are preserved: files[n-1] picks the n-th newest', async () => {
    // /resume <n> indexes into this list 1-based; pin that the 2nd entry is
    // the 2nd-newest, matching what /sessions displays.
    const base = Math.floor(Date.now() / 1000) - 3600;
    await writeSession('aaa.jsonl', base + 30);
    await writeSession('bbb.jsonl', base + 90);
    await writeSession('ccc.jsonl', base + 60);
    const files = await listSessionIdsByMtime(dir);
    expect(files[2 - 1]).toBe('ccc');
  });

  it('propagates a missing-directory error (callers gate on pathExists first, like the old existsSync)', async () => {
    await expect(listSessionIdsByMtime(path.join(dir, 'missing'))).rejects.toThrow();
  });

  it('returns [] for a directory with no transcripts', async () => {
    expect(await listSessionIdsByMtime(dir)).toEqual([]);
  });
});

describe('pathExists (async replacement for the resume/sessions existsSync checks)', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pathexists-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('is true for an existing directory and file, false for a missing path', async () => {
    expect(await pathExists(dir)).toBe(true);
    const f = path.join(dir, 'f.jsonl');
    await fsp.writeFile(f, 'x');
    expect(await pathExists(f)).toBe(true);
    expect(await pathExists(path.join(dir, 'missing'))).toBe(false);
  });
});

// The other half of issue #102 lives in index.js's !resume / !sessions
// cases, which can't be imported in-process (top-level Matrix/express side
// effects — see showbashoutput.test.js for the precedent). Pin the fix by
// source inspection instead: the command blocks must contain no synchronous
// fs metadata calls.
describe('index.js resume/sessions paths — no sync fs calls (source inspection)', () => {
  const indexSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

  function commandBlock(startMarker, endMarker) {
    const start = indexSource.indexOf(startMarker);
    const end = indexSource.indexOf(endMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return indexSource.slice(start, end);
  }

  it("the !resume case runs no readdirSync/statSync/existsSync", () => {
    const block = commandBlock("case '!resume':", "case '!workdir':");
    expect(block).not.toMatch(/\b(?:readdirSync|statSync|existsSync)\b/);
  });

  it('the !resume case restores and re-persists the complete provider handoff state', () => {
    const block = commandBlock("case '!resume':", "case '!workdir':");

    expect(block).toContain('findPersistedAgentSession(selectedAgent, resumeSessionId)');
    expect(block).not.toMatch(/Object\.values\(loadPersistedSessions\(\)\)\.find\(e => e\.sessionId/);
    expect(block).toContain('codexMatches.length + claudeMatches.size > 1');
    expect(block).toContain('await rejectAmbiguousResume()');
    expect(block).toContain('journalConvoIdFor(activeSession) === resumeConvoId');
    expect(block).toContain('agentSessions: inheritedAgentSessions');
    expect(block).toContain('journalConvoId: resumePersisted?.journalConvoId');
    expect(block).toContain('journalConvoId: session.journalConvoId');
    // The persisted model is still what a plain /resume spawns on; an
    // explicit --model on the /resume overrides it.
    expect(block).toContain('model: resumeModelFlag.model || resumeState.model');
    expect(block).toContain('interactive: resumeState.interactiveMode');
    expect(block).toContain('mcpExtras: effectiveResumeExtras');
  });

  it("the !sessions case runs no readdirSync/statSync/existsSync", () => {
    const block = commandBlock("case '!sessions':", "case '!help':");
    expect(block).not.toMatch(/\b(?:readdirSync|statSync|existsSync)\b/);
  });
});
