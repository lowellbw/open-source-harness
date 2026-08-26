import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // DockerWorkspace conformance pulls an image and starts a container.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
