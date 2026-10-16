import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions (index.js boots a bridge at import, so it has no
// unit harness): a session's establishing convo_upsert must carry the
// canonical repo, or the journal's per-org visibility never matches.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('session convo_upsert reports the repo', () => {
  const helper = index.slice(index.indexOf('function journalRepoField('), index.indexOf('function journalPublish('));

  it('derives it from the workdir through lib/repo-name.js, best-effort', () => {
    expect(helper).toContain('repoNames.repoFor(session?.workdir)');
    expect(helper).toMatch(/catch \{\s*return \{\};/);
  });

  it('adds it to both establishing upserts', () => {
    const publish = index.slice(index.indexOf('function journalPublish('), index.indexOf('function journalPublish(') + 2000);
    expect(publish).toMatch(/upsertConvo\(convoId, \{ title: session\._journalTitleHint, agentKind: session\.agent, \.\.\.journalRepoField\(session\) \}\)/);
    expect(publish).toMatch(/payload = \{ \.\.\.payload, \.\.\.journalRepoField\(session\) \}/);
    const flush = index.slice(index.indexOf('function journalFlushForSession('), index.indexOf('function journalFlushForSession(') + 800);
    expect(flush).toMatch(/upsertConvo\(convoId, \{ title: session\._journalTitleHint, \.\.\.journalRepoField\(session\) \}\)/);
  });
});
