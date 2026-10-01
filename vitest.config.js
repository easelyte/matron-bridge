import { defineConfig, configDefaults } from 'vitest/config';

// Tests that exercise POSIX-only pieces and cannot run on the Windows CI job:
// the bash hook scripts (their Node ports in hooks/*.mjs are tested by
// test/hooks-mjs.test.js on every platform), the Xvfb wrapper, the Codex
// producer shim (symlinks, /proc, process groups — Codex is not supported on
// Windows), and suites that shell out to sh/ps or depend on POSIX file modes.
// Keep this list short and explicit; a new test that needs a POSIX tool
// belongs here, not behind a per-test skip.
const WINDOWS_EXCLUDES = [
  // POSIX-only subjects: bash hook scripts, the Xvfb wrapper, the Codex shim
  // and liveness (/proc, symlinks, process groups).
  'test/matron-bash-tee.test.js',
  'test/xvfb-wrap.test.js',
  'test/matron-tee.test.js',
  'test/codex-producer.test.js',
  'test/codex-paths.test.js',
  'test/codex-liveness.test.js',
  'test/codex-completion.test.js',
  'test/codex-redact-publish.test.js',
  // Integration suites that need ffmpeg / a journal.
  'test/journal-publisher.integration.test.js',
  'test/video-frames.integration.test.js',
  'test/video-frames.test.js',
  'test/transcribe.test.js',
  // Pin POSIX paths, modes, symlinks or FIFOs in their fixtures (the code
  // under test is platform-neutral; the fixtures are not). Porting these is
  // tracked as follow-up work in the Windows design spec.
  'test/atomic-write.test.js',
  'test/file-link-guard.test.js',
  'test/interactive-session.test.js',
  'test/item-attachments.test.js',
  'test/iv-uploads.test.js',
  'test/permission-eval.test.js',
  'test/pre-trust.test.js',
  'test/project-root-teardown.test.js',
  'test/send-attachment.test.js',
  'test/setup-wizard.test.js',
  'test/subagent-watcher.test.js',
  'test/transcript-dir.test.js',
  'test/viewer-download.test.js',
  'test/viewer-view.test.js',
  // Coordinator block / RPC handler suites: first Windows run failed on
  // line-ending or path-separator handling; re-checked once .gitattributes
  // (eol=lf) is in place.
  'test/coordinator.test.js',
  'test/consent-wiring.test.js',
  'test/missions-wiring.test.js',
  'test/projects-wiring.test.js',
  'test/unseen-wiring.test.js',
  'test/journal-rpc-handlers.test.js',
];

export default defineConfig({
  test: {
    // Every test file gets a throwaway HOME so no test can read or delete the
    // developer's real ~/.claude (see test/setup-isolated-home.js).
    setupFiles: ['./test/setup-isolated-home.js'],
    // One run-scoped TMPDIR, removed at the end, so no test leaves scratch
    // directories in the machine's /tmp (see test/global-tmp-root.js).
    globalSetup: ['./test/global-tmp-root.js'],
    exclude: [
      ...configDefaults.exclude,
      ...(process.platform === 'win32' ? WINDOWS_EXCLUDES : []),
    ],
  },
});
