import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { connectServer, listServerTools, type ConnectedServer } from './client.js'
import { ToolApprovals, hashTool } from './registry.js'
import { McpToolset, SEARCH_TOOL_NAME, qualify } from './toolset.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/test-server.mjs', import.meta.url))

const spawnFixture = (variant: 'normal' | 'changed' = 'normal') =>
  connectServer({
    id: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, TOOL_VARIANT: variant } as Record<string, string>,
  })

describe('MCP client against a real server', () => {
  let server: ConnectedServer

  beforeAll(async () => {
    server = await spawnFixture()
  }, 60_000)

  afterAll(async () => {
    await server?.close()
  })

  it('connects and negotiates a protocol version', () => {
    expect(server.era).toBeTruthy()
    // Legacy negotiation is the expected outcome against most deployed servers
    // today, and is correct rather than a fallback failure.
    expect(['modern', 'legacy', 'unknown']).toContain(server.era)
  })

  it('lists the tools the server actually exposes', async () => {
    const tools = await listServerTools(server)
    expect(tools.map((t) => t.name).sort()).toEqual(['add', 'shout', 'weather'])
    expect(tools.find((t) => t.name === 'add')?.description).toContain('Add two numbers')
  })

  it('calls a tool and gets a real result back', async () => {
    const approvals = new ToolApprovals()
    const toolset = new McpToolset(approvals)
    const discovered = await toolset.discover([server])
    for (const tool of discovered) approvals.approve('fixture', tool)

    // Re-discover so statuses reflect the approvals.
    const approvedSet = new McpToolset(approvals)
    await approvedSet.discover([server])

    const tools = approvedSet.aiTools()
    const add = tools[qualify('fixture', 'add')]
    expect(add).toBeDefined()

    const result = await (add!.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      { a: 2, b: 40 },
      {},
    )
    expect(JSON.stringify(result)).toContain('42')
  }, 30_000)
})

describe('tool description pinning', () => {
  it('hashes name, description and schema together', () => {
    const base = { name: 'x', description: 'does a thing', inputSchema: { type: 'object' } }
    expect(hashTool(base)).toBe(hashTool({ ...base }))
    expect(hashTool(base)).not.toBe(hashTool({ ...base, description: 'does another thing' }))
    expect(hashTool(base)).not.toBe(hashTool({ ...base, inputSchema: { type: 'string' } }))
  })

  it('ignores key order, so reserialisation is not mistaken for drift', () => {
    // Otherwise every harmless reorder cries wolf and people learn to ignore it.
    const a = { name: 'x', inputSchema: { type: 'object', properties: { a: 1, b: 2 } } }
    const b = { name: 'x', inputSchema: { properties: { b: 2, a: 1 }, type: 'object' } }
    expect(hashTool(a)).toBe(hashTool(b))
  })

  it('reports an unseen tool as unapproved', () => {
    const approvals = new ToolApprovals()
    expect(approvals.status('s', { name: 'x' })).toBe('unapproved')
  })

  it('reports a tool whose description changed as changed, not unapproved', () => {
    // A different signal from "never seen", and it deserves different words in
    // the UI: something you trusted has moved.
    const approvals = new ToolApprovals()
    approvals.approve('s', { name: 'x', description: 'safe' })
    expect(approvals.status('s', { name: 'x', description: 'safe' })).toBe('approved')
    expect(approvals.status('s', { name: 'x', description: 'now malicious' })).toBe('changed')
  })

  it('survives a round trip through export/import', () => {
    const approvals = new ToolApprovals()
    approvals.approve('s', { name: 'x', description: 'safe' })
    const restored = new ToolApprovals(approvals.export())
    expect(restored.status('s', { name: 'x', description: 'safe' })).toBe('approved')
  })
})

describe('approval gating against a server that changes a tool underneath us', () => {
  it('quarantines a tool whose description was rewritten after approval', async () => {
    const approvals = new ToolApprovals()

    const before = await spawnFixture('normal')
    const original = await listServerTools(before)
    for (const tool of original) approvals.approve('fixture', tool)
    await before.close()

    // Same server, same tool names, one description rewritten to carry an
    // injected instruction. Nothing about the name changed.
    const after = await spawnFixture('changed')
    const toolset = new McpToolset(approvals)
    await toolset.discover([after])

    const quarantined = toolset.needingApproval()
    expect(quarantined.map((t) => t.name)).toEqual(['weather'])
    expect(quarantined[0]!.status).toBe('changed')

    // And it must not be callable while quarantined.
    expect(toolset.aiTools()[qualify('fixture', 'weather')]).toBeUndefined()
    expect(toolset.aiTools()[qualify('fixture', 'add')]).toBeDefined()

    await after.close()
  }, 60_000)
})

describe('deferred tool loading', () => {
  let server: ConnectedServer
  let approvals: ToolApprovals
  let toolset: McpToolset

  beforeAll(async () => {
    server = await spawnFixture()
    approvals = new ToolApprovals()
    for (const tool of await listServerTools(server)) approvals.approve('fixture', tool)
    toolset = new McpToolset(approvals)
    await toolset.discover([server])
  }, 60_000)

  afterAll(async () => {
    await server?.close()
  })

  it('exposes only the search tool before anything is searched', () => {
    // The whole point: schemas for every connected tool do not go into the
    // prompt before the model has asked for anything.
    expect(toolset.activeToolNames()).toEqual([SEARCH_TOOL_NAME])
  })

  it('registers every approved tool even though they are not active', () => {
    const registered = Object.keys(toolset.aiTools())
    expect(registered).toContain(qualify('fixture', 'add'))
    expect(registered).toContain(SEARCH_TOOL_NAME)
    expect(registered.length).toBeGreaterThan(toolset.activeToolNames().length)
  })

  it('activates matching tools after a search', async () => {
    const search = toolset.aiTools()[SEARCH_TOOL_NAME]!
    const result = (await (search.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      { query: 'weather city' },
      {},
    )) as { found: number; tools: { name: string }[] }

    expect(result.found).toBeGreaterThan(0)
    expect(result.tools.map((t) => t.name)).toContain(qualify('fixture', 'weather'))
    expect(toolset.activeToolNames()).toContain(qualify('fixture', 'weather'))
  })

  it('keeps the search tool active always, so the model can find its way back', () => {
    expect(toolset.activeToolNames()).toContain(SEARCH_TOOL_NAME)
  })

  it('reports honestly when nothing matches instead of guessing', async () => {
    const search = toolset.aiTools()[SEARCH_TOOL_NAME]!
    const result = (await (search.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      { query: 'quantum entanglement bookkeeping' },
      {},
    )) as { found: number }
    expect(result.found).toBe(0)
  })
})

describe('approving a tool takes effect immediately', () => {
  it('makes a tool callable without re-discovering the server', async () => {
    // Status is derived from approvals on every read rather than cached at
    // discovery. Caching it would mean an approval appeared to do nothing until
    // the connector was restarted.
    const server = await spawnFixture()
    const approvals = new ToolApprovals()
    const toolset = new McpToolset(approvals)
    await toolset.discover([server])

    expect(toolset.callable()).toHaveLength(0)
    expect(toolset.aiTools()[qualify('fixture', 'add')]).toBeUndefined()

    const pending = toolset.needingApproval().find((t) => t.name === 'add')!
    approvals.approve('fixture', pending)

    expect(toolset.callable().map((t) => t.name)).toEqual(['add'])
    expect(toolset.aiTools()[qualify('fixture', 'add')]).toBeDefined()

    await server.close()
  }, 60_000)
})

describe('name qualification', () => {
  it('namespaces by server so two servers can both offer "search"', () => {
    expect(qualify('a', 'search')).not.toBe(qualify('b', 'search'))
  })

  it('replaces characters providers reject in tool names', () => {
    expect(qualify('my server!', 'do.thing')).toBe('my_server___do_thing')
  })
})
