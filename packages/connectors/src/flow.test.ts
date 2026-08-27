import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { beginAuthorization, completeAuthorization, type ProviderConfig } from './oauth.js'
import { MemoryTokenStore } from './tokens.js'
import { buildConnectorTools } from './tools.js'

/**
 * The whole flow, over real HTTP, against a provider under our control.
 *
 * The unit tests stub `fetch`, which proves the logic and not the plumbing.
 * This runs an actual OAuth server on loopback and an actual API behind it,
 * so the request bodies, the content types and the header names are exercised
 * as they will be against Google and Slack. What it cannot prove is those
 * providers' own quirks — that needs credentials this environment does not
 * have, and the code paths either side of the network are the same ones.
 */

const servers: http.Server[] = []
afterEach(() => servers.splice(0).forEach((s) => s.close()))

async function stubProvider() {
  const issued: { code: string; verifier?: string }[] = []
  let lastAuthHeader: string | undefined

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        // A real provider verifies the challenge against the verifier. Recording
        // it is enough to prove ours was sent.
        issued.push({ code: params.get('code') ?? '', ...(params.get('code_verifier') ? { verifier: params.get('code_verifier')! } : {}) })

        if (!params.get('code_verifier')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_request', error_description: 'PKCE required' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'server-issued-access',
            refresh_token: 'server-issued-refresh',
            expires_in: 3600,
            scope: 'read',
          }),
        )
      })
      return
    }

    if (url.pathname.startsWith('/api/')) {
      lastAuthHeader = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messages: [{ user: 'U1', ts: '1', text: 'hello' }] }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  const port = (server.address() as { port: number }).port

  return { port, issued, authHeader: () => lastAuthHeader }
}

describe('the flow, over real HTTP', () => {
  it('authorizes, exchanges, stores encrypted, and calls an API', async () => {
    const stub = await stubProvider()

    const config: ProviderConfig = {
      id: 'slack',
      displayName: 'Stub Slack',
      authorizeUrl: `http://127.0.0.1:${stub.port}/authorize`,
      tokenUrl: `http://127.0.0.1:${stub.port}/token`,
      clientId: 'client',
      clientSecret: 'secret',
      scopes: ['read'],
    }

    // 1. Begin: the user would be sent here.
    const { url, pending } = beginAuthorization(config, `http://127.0.0.1:${stub.port}/cb`)
    expect(url).toContain('code_challenge=')

    // 2. The provider redirects back with a code and our state.
    const token = await completeAuthorization(config, pending, {
      code: 'the-code',
      state: pending.state,
    })

    expect(stub.issued).toHaveLength(1)
    expect(stub.issued[0]!.verifier).toBe(pending.verifier)
    expect(token.accessToken).toBe('server-issued-access')

    // 3. Stored, encrypted at rest.
    const store = new MemoryTokenStore('a-long-enough-test-passphrase')
    store.put(token)
    expect(JSON.stringify(store)).not.toContain('server-issued-refresh')
    expect(store.get('slack')?.refreshToken).toBe('server-issued-refresh')

    // 4. A tool call uses it, and sends it as a bearer token.
    const tools = buildConnectorTools({
      provider: config,
      tokens: store,
      confirm: async () => true,
      fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
        // Point Slack's fixed URL at the stub.
        const rewritten = String(input).replace(
          'https://slack.com/api/',
          `http://127.0.0.1:${stub.port}/api/`,
        )
        return fetch(rewritten, init)
      }) as unknown as typeof fetch,
    }) as Record<string, { execute: (a: unknown, o: unknown) => Promise<never> }>

    const result = (await tools.slackReadChannel!.execute(
      { channel: 'C1', maxResults: 5 },
      {},
    )) as { ok: boolean; messages: { content: string }[] }

    expect(result.ok).toBe(true)
    expect(result.messages[0]!.content).toBe('hello')
    expect(stub.authHeader()).toBe('Bearer server-issued-access')
  })

  it('fails the exchange when PKCE is missing, as a real provider would', async () => {
    // Proof the verifier is genuinely being sent rather than the stub being
    // lenient: the stub rejects an exchange without one.
    const stub = await stubProvider()
    const config: ProviderConfig = {
      id: 'stub',
      displayName: 'Stub',
      authorizeUrl: `http://127.0.0.1:${stub.port}/authorize`,
      tokenUrl: `http://127.0.0.1:${stub.port}/token`,
      clientId: 'client',
      scopes: ['read'],
    }

    const { pending } = beginAuthorization(config, 'http://127.0.0.1/cb')
    await expect(
      completeAuthorization(config, { ...pending, verifier: '' }, {
        code: 'c',
        state: pending.state,
      }),
    ).rejects.toThrow(/PKCE/)
  })
})
