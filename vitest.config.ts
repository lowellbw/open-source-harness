import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source, not dist, so tests run without a
    // build step and a failing test points at the line you edited.
    alias: {
      '@workspace/protocol': src('protocol'),
      '@workspace/workspace': src('workspace'),
      '@workspace/gateway-model': src('gateway-model'),
      '@workspace/core': src('core'),
      '@workspace/mcp': src('mcp'),
      '@workspace/session': src('session'),
      '@workspace/store': src('store'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // DockerWorkspace conformance starts real containers.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
