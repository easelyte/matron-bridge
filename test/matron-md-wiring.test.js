import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process, so the MATRON.md wiring is pinned
// by source inspection, as in test/memory-wiring.test.js. What gets read and
// how it renders is unit-tested in test/matron-md.test.js, and where the
// block sits in the prompt in test/coordinator.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

const SPAWNS = [
  ['print', 'function createSession(', 'const printCoord = claudeCoordinatorArgs('],
  ['codex', 'function createCodexSessionForRoom(', 'const codexCoord = codexCoordinatorOptions('],
  ['interactive', 'function createInteractiveSessionForRoom(', 'const ivCoord = claudeCoordinatorArgs('],
];

describe('MATRON.md wiring (source inspection)', () => {
  for (const [label, start, builder] of SPAWNS) {
    it(`the ${label} spawn reads MATRON.md for its own workdir afresh and passes the block to the prompt builder`, () => {
      const fn = body(start, '\nfunction ');
      const read = fn.indexOf('const matronMd = loadMatronMd(cwd);');
      expect(read, 'loadMatronMd(cwd) missing').toBeGreaterThan(-1);
      const build = fn.indexOf(builder);
      expect(build).toBeGreaterThan(read);
      expect(fn.slice(build, fn.indexOf('\n', build))).toContain('matronMdBlock: matronMd.block });');
      expect(fn).toContain('matronMd: { files: matronMd.files, truncated: matronMd.truncated },');
    });
  }

  it('the start, resume, workdir, restart and status messages say which files were loaded', () => {
    const start = body("case '!start': {", "case '!stop': {");
    expect(start).toContain('${matronMdNote(session)}');
    const restart = body("${agentLabel(existing.agent)} session restarted.", '\n      break;');
    expect(restart).toContain('${matronMdNote(restarted)}');
    expect(index).toContain('Workdir: ${session.workdir}${matronMdNote(session)}${resumeModelLine}');
    expect(index).toContain('Workdir: ${resolved}${matronMdNote(session)}${workdirModelLine}');
    expect(index).toContain('Session active\\nAgent: ${agentLabel(session.agent)}\\nWorkdir: ${session.workdir}${matronMdNote(session)}');
    expect(index).toContain('<tr><td>MATRON.md</td><td>${escapeHtml(matronMdFileList(session.matronMd))}</td></tr>');
  });
});
