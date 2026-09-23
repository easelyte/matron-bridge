import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file gets a throwaway HOME so no test can read or delete the
    // developer's real ~/.claude (see test/setup-isolated-home.js).
    setupFiles: ['./test/setup-isolated-home.js'],
  },
});
