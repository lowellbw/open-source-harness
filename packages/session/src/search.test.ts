import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { braveProvider, buildSearchWebTools, searchProviderFromEnv, type SearchProvider } from './search.js'

const servers: http.Server[] = []

afterEach(() => {
  servers.splice(0).forEach((s) => s.close())
})

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`
}

const call = (tools: ReturnType<typeof buildSearchWebTools>, args: unknown) =>
  (tools.webSearch!.execute as (a: unknown, o: unknown) => Promise<never>)(args, {})

describe('brave provider', () => {
  it('sends the key as a header and never in the query string', async () => {
    // A key in a URL is a key in access logs, in Referer headers and in
    // anything that caches by URL.
    let seen: { url: string; token: string | undefined } | undefined

    const endpoint = await serve((req, res) => {
      seen = { url: req.url ?? '', token: req.headers['x-subscription-token'] as string | undefined }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ web: { results: [] } }))
    })

    await braveProvider({ apiKey: 'secret-key', endpoint }).search('anything', { maxResults: 5 })

    expect(seen?.token).toBe('secret-key')
    expect(seen?.url).not.toContain('secret-key')
  })

  it('normalises results and strips the highlight markup', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'ECMA-376',
                url: 'https://example.org/a',
                description: 'The <strong>Office</strong> Open XML standard.',
                page_age: '2026-01-04T00:00:00Z',
              },
              { title: 'Second', url: 'https://example.org/b', description: 'No markup' },
            ],
          },
        }),
      )
    })

    const results = await braveProvider({ apiKey: 'k', endpoint }).search('ecma', { maxResults: 5 })

    expect(results).toEqual([
      {
        title: 'ECMA-376',
        url: 'https://example.org/a',
        snippet: 'The Office Open XML standard.',
        published: '2026-01-04T00:00:00Z',
      },
      { title: 'Second', url: 'https://example.org/b', snippet: 'No markup' },
    ])
  })

  it('caps count at the 20 Brave actually honours', async () => {
    // Asking for 50 and receiving 20 reads as the tool ignoring its argument.
    let count: string | null = null
    const endpoint = await serve((req, res) => {
      count = new URL(req.url ?? '', 'http://x').searchParams.get('count')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ web: { results: [] } }))
    })

    await braveProvider({ apiKey: 'k', endpoint }).search('q', { maxResults: 50 })
    expect(count).toBe('20')
  })

  it('reports an HTTP failure rather than returning nothing found', async () => {
    // "No results" and "the search never happened" are different answers, and
    // an agent told the former will confidently report the topic does not exist.
    const endpoint = await serve((_req, res) => {
      res.writeHead(429)
      res.end('slow down')
    })

    await expect(
      braveProvider({ apiKey: 'k', endpoint }).search('q', { maxResults: 5 }),
    ).rejects.toThrow(/429/)
  })
})

describe('the webSearch tool', () => {
  const stub = (results: unknown[] = []): SearchProvider => ({
    name: 'stub',
    search: async () => results as never,
  })

  it('returns results the model can act on', async () => {
    const tools = buildSearchWebTools({
      provider: stub([{ title: 'T', url: 'https://e.org', snippet: 'S' }]),
    })
    expect(await call(tools, { query: 'x', maxResults: 5 })).toMatchObject({
      ok: true,
      count: 1,
      engine: 'stub',
    })
  })

  it('reports a provider failure instead of ending the turn', async () => {
    const tools = buildSearchWebTools({
      provider: { name: 'stub', search: async () => { throw new Error('upstream down') } },
    })
    const result = (await call(tools, { query: 'x', maxResults: 5 })) as {
      ok: boolean
      reason: string
    }
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('upstream down')
  })

  it('counts a search only when one actually happened', async () => {
    // The counter drives the meter. Counting a failed call would bill for a
    // search the provider never charged for.
    let searches = 0
    const failing = buildSearchWebTools({
      provider: { name: 'stub', search: async () => { throw new Error('nope') } },
      onSearch: () => (searches += 1),
    })
    await call(failing, { query: 'x', maxResults: 5 })
    expect(searches).toBe(0)

    const working = buildSearchWebTools({ provider: stub(), onSearch: () => (searches += 1) })
    await call(working, { query: 'x', maxResults: 5 })
    expect(searches).toBe(1)
  })
})

describe('choosing a provider from the environment', () => {
  it('uses Brave when a key is present', () => {
    expect(searchProviderFromEnv({ BRAVE_API_KEY: 'k' } as NodeJS.ProcessEnv)?.name).toBe('brave')
  })

  it('returns nothing without a key, so the provider-native path takes over', () => {
    // Not an error: search still works, it just happens inside the model
    // request rather than as a call we make.
    expect(searchProviderFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined()
  })
})
