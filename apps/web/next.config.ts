import type { NextConfig } from 'next'

const config: NextConfig = {
  // The agent core is a workspace package compiled from TypeScript source.
  transpilePackages: [
    '@workspace/core',
    '@workspace/protocol',
    '@workspace/workspace',
    '@workspace/gateway-model',
    '@workspace/mcp',
  ],
  // The workspace seam shells out and touches the filesystem; it must never be
  // bundled for the browser.
  serverExternalPackages: ['ai'],
}

export default config
