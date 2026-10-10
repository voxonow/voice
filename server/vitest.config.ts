import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    // Each signaling test file starts real mediasoup workers on fixed ports.
    fileParallelism: false,
  },
});
