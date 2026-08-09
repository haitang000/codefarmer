import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: { reporter: ['text', 'json', 'html'] },
    testTimeout: 15_000,
  },
});
