import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file gets a throwaway HOME so no test can read or delete the
    // developer's real ~/.claude (see test/setup-isolated-home.js).
    setupFiles: ['./test/setup-isolated-home.js'],
    // One run-scoped TMPDIR, removed at the end, so no test leaves scratch
    // directories in the machine's /tmp (see test/global-tmp-root.js).
    globalSetup: ['./test/global-tmp-root.js'],
  },
});
