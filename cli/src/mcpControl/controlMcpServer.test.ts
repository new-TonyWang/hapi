import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HubApiBridge } from './hubApiClient'
import { createControlMcpServer, type ParentSessionDefaults } from './controlMcpServer'

/**
 * Drives the MCP server through a real Client over in-memory transport,
 * exercising tool registration + JSON-RPC round-trips (no network: bridge
 * fetch is mocked).
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map(block => block.type === 'text' ? (block.text ?? '') : '').join('\n')
}

describe('controlMcpServer tools', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    function setup(routes: Array<(url: string, method: string, body: any) => Response | null>, defaults?: ParentSessionDefaults) {
        fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = String(input)
            const method = (init?.method ?? 'GET').toUpperCase()
            const body = typeof init?.body === 'string' ? JSON.parse(init!.body as string) : undefined
            for (const route of routes) {
                const response = route(url, method, body)
                if (response) return response
            }
            return new Response(JSON.stringify({ error: `no route: ${method} ${url}` }), { status: 404 })
        })

        const bridge = new HubApiBridge({ baseUrl: 'http://hub:3000', accessToken: 'tok', fetchFn: fetchMock as unknown as typeof fetch })
        const server = createControlMcpServer(bridge, 'parent-1', defaults)

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })

        return {
            client,
            connect: async () => {
                await Promise.all([
                    server.connect(serverTransport),
                    client.connect(clientTransport)
                ])
            },
            fetchMock
        }
    }

    function json(data: unknown, status = 200): Response {
        return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    }

    const authRoute = (url: string, method: string, body: any): Response | null =>
        method === 'POST' && url.endsWith('/api/auth') && body?.accessToken === 'tok'
            ? json({ token: 'jwt-1' })
            : null

    it('lists all registered tools', async () => {
        const { client, connect } = setup([authRoute])
        await connect()

        const tools = await client.listTools()

        const names = tools.tools.map(tool => tool.name)
        expect(names).toEqual(expect.arrayContaining([
            'create_session', 'send_message', 'get_session', 'read_messages', 'interrupt_session',
            'pause_automation', 'resume_automation', 'list_machines',
            'list_codex_options', 'change_codex_provider', 'set_permission_mode'
        ]))
        expect(names).toHaveLength(11)
    })

    it('create_session returns session id', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn') && body?.directory === '/repo'
                ? json({ type: 'success', sessionId: 'sess-9' })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'create_session', arguments: { machineId: 'mac-1', directory: '/repo' } })

        expect(textOf(result as never)).toBe('sess-9')
        expect((result as { isError?: boolean }).isError).toBeFalsy()
    })

    it('create_session reports hub errors as tool errors', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn')
                ? json({ type: 'error', message: 'machine offline' })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'create_session', arguments: { machineId: 'mac-1', directory: '/repo' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('machine offline')
    })

    it('create_session passes codexProvider through to the spawn body', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn') && body?.agent === 'codex'
                ? json({ type: 'success', sessionId: 'sess-codex-a' })
                : null
        ])
        await connect()

        const result = await client.callTool({
            name: 'create_session',
            arguments: { machineId: 'mac-1', directory: '/repo', agent: 'codex', codexProvider: 'tokenmax' }
        })

        expect(textOf(result as never)).toBe('sess-codex-a')
        const spawnCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-1/spawn')
        )
        expect(JSON.parse((spawnCall![1] as RequestInit).body as string)).toEqual({
            directory: '/repo',
            agent: 'codex',
            codexProvider: 'tokenmax',
            parentSessionId: 'parent-1'
        })
    })

    it('create_session passes a second, different codexProvider through', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn') && body?.codexProvider === 'xubao'
                ? json({ type: 'success', sessionId: 'sess-codex-b' })
                : null
        ])
        await connect()

        const result = await client.callTool({
            name: 'create_session',
            arguments: { machineId: 'mac-1', directory: '/repo', agent: 'codex', codexProvider: 'xubao' }
        })

        expect(textOf(result as never)).toBe('sess-codex-b')
        const spawnCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-1/spawn')
        )
        expect(JSON.parse((spawnCall![1] as RequestInit).body as string)).toEqual({
            directory: '/repo',
            agent: 'codex',
            codexProvider: 'xubao',
            parentSessionId: 'parent-1'
        })
    })

    it('create_session passes codexProfile and codexProvider together', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn')
                ? json({ type: 'success', sessionId: 'sess-codex-c' })
                : null
        ])
        await connect()

        const result = await client.callTool({
            name: 'create_session',
            arguments: { machineId: 'mac-1', directory: '/repo', agent: 'codex', codexProfile: 'xubao', codexProvider: 'xubao' }
        })

        expect(textOf(result as never)).toBe('sess-codex-c')
        const spawnCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-1/spawn')
        )
        expect(JSON.parse((spawnCall![1] as RequestInit).body as string)).toEqual({
            directory: '/repo',
            agent: 'codex',
            codexProfile: 'xubao',
            codexProvider: 'xubao',
            parentSessionId: 'parent-1'
        })
    })

    it('create_session rejects codexProfile/codexProvider for non-codex agents', async () => {
        const { client, connect, fetchMock } = setup([authRoute])
        await connect()

        const result = await client.callTool({
            name: 'create_session',
            arguments: { machineId: 'mac-1', directory: '/repo', agent: 'claude', codexProvider: 'tokenmax' }
        })

        expect((result as { isError?: boolean }).isError).toBe(true)
        const text = textOf(result as never)
        expect(text).toContain('only valid with agent=codex')
        expect(text).toContain('claude')
        // Rejected before the request goes out: no spawn call was made
        expect(fetchMock.mock.calls.filter(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-1/spawn')
        )).toHaveLength(0)
    })

    it('create_session never sends model or effort fields', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn')
                ? json({ type: 'success', sessionId: 'sess-plain' })
                : null
        ])
        await connect()

        await client.callTool({
            name: 'create_session',
            arguments: { machineId: 'mac-1', directory: '/repo', agent: 'codex', codexProfile: 'p1', codexProvider: 'openai' }
        })
        await client.callTool({
            name: 'create_session',
            arguments: { machineId: 'mac-1', directory: '/repo' }
        })

        const spawnBodies = fetchMock.mock.calls
            .filter((call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-1/spawn'))
            .map((call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string))
        expect(spawnBodies).toHaveLength(2)
        for (const body of spawnBodies) {
            expect(body).not.toHaveProperty('model')
            expect(body).not.toHaveProperty('effort')
            expect(body).not.toHaveProperty('modelReasoningEffort')
        }
    })

    it('create_session inherits parent defaults when args are omitted', async () => {
        const defaults: ParentSessionDefaults = {
            machineId: 'mac-parent',
            directory: '/parent/repo',
            flavor: 'codex',
            model: 'kimi-k3',
            codexProfile: 'xubao',
            codexProvider: 'glmproxy',
            permissionMode: 'safe-yolo'
        }
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/machines/mac-parent/spawn')
                ? json({ type: 'success', sessionId: 'sess-defaulted' })
                : null
        ], defaults)
        await connect()

        const result = await client.callTool({ name: 'create_session', arguments: {} })

        expect(textOf(result as never)).toBe('sess-defaulted')
        const spawnCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-parent/spawn')
        )
        expect(JSON.parse((spawnCall![1] as RequestInit).body as string)).toEqual({
            directory: '/parent/repo',
            agent: 'codex',
            model: 'kimi-k3',
            codexProfile: 'xubao',
            codexProvider: 'glmproxy',
            permissionMode: 'safe-yolo',
            parentSessionId: 'parent-1'
        })
    })

    it('create_session explicit args override parent defaults', async () => {
        const defaults: ParentSessionDefaults = {
            machineId: 'mac-parent',
            directory: '/parent/repo',
            flavor: 'codex',
            model: 'kimi-k3',
            codexProfile: 'xubao',
            codexProvider: 'glmproxy',
            permissionMode: 'safe-yolo'
        }
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/machines/mac-parent/spawn')
                ? json({ type: 'success', sessionId: 'sess-override' })
                : null
        ], defaults)
        await connect()

        await client.callTool({
            name: 'create_session',
            arguments: { model: 'z-ai/glm-5.3', directory: '/other/dir' }
        })

        const spawnCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-parent/spawn')
        )
        expect(JSON.parse((spawnCall![1] as RequestInit).body as string)).toEqual({
            directory: '/other/dir',
            agent: 'codex',
            model: 'z-ai/glm-5.3',
            codexProfile: 'xubao',
            codexProvider: 'glmproxy',
            permissionMode: 'safe-yolo',
            parentSessionId: 'parent-1'
        })
    })

    it('create_session errors clearly when no defaults and machineId/directory missing', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.includes('/spawn')
                ? json({ type: 'success', sessionId: 'should-not-happen' })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'create_session', arguments: {} })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('machineId')
        expect(textOf(result as never)).toContain('directory')
    })

    it('create_session requires machineId when defaults lack it but directory is given', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.includes('/spawn')
                ? json({ type: 'success', sessionId: 'should-not-happen' })
                : null
        ], { machineId: null, directory: '/d', flavor: null, model: null, codexProfile: null, codexProvider: null, permissionMode: null })
        await connect()

        const result = await client.callTool({ name: 'create_session', arguments: { directory: '/d' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('machineId')
        expect(textOf(result as never)).not.toContain('directory')
    })

    it('create_session passes an explicit permissionMode overriding the parent default', async () => {
        const defaults: ParentSessionDefaults = {
            machineId: 'mac-parent',
            directory: '/parent/repo',
            flavor: 'codex',
            model: 'kimi-k3',
            codexProfile: 'xubao',
            codexProvider: 'glmproxy',
            permissionMode: 'default'
        }
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/machines/mac-parent/spawn')
                ? json({ type: 'success', sessionId: 'sess-perm' })
                : null
        ], defaults)
        await connect()

        await client.callTool({
            name: 'create_session',
            arguments: { permissionMode: 'safe-yolo' }
        })

        const spawnCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-parent/spawn')
        )
        expect(JSON.parse((spawnCall![1] as RequestInit).body as string)).toEqual({
            directory: '/parent/repo',
            agent: 'codex',
            model: 'kimi-k3',
            codexProfile: 'xubao',
            codexProvider: 'glmproxy',
            permissionMode: 'safe-yolo',
            parentSessionId: 'parent-1'
        })
    })

    it('set_permission_mode posts the mode to the permission endpoint', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/sessions/s2/permission-mode') && body?.mode === 'safe-yolo'
                ? json({ ok: true })
                : null
        ])
        await connect()

        const result = await client.callTool({
            name: 'set_permission_mode',
            arguments: { sessionId: 's2', mode: 'safe-yolo' }
        })

        expect(textOf(result as never)).toContain('safe-yolo')
        expect((result as { isError?: boolean }).isError).toBeFalsy()
        const permCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/sessions/s2/permission-mode')
        )
        expect(JSON.parse((permCall![1] as RequestInit).body as string)).toEqual({ mode: 'safe-yolo' })
    })

    it('set_permission_mode reports hub errors', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s2/permission-mode')
                ? json({ error: 'Invalid permission mode for session flavor' }, 400)
                : null
        ])
        await connect()

        const result = await client.callTool({
            name: 'set_permission_mode',
            arguments: { sessionId: 's2', mode: 'yolo' }
        })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('Invalid permission mode')
    })

    it('send_message confirms delivery via the automation endpoint', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/sessions/s1/automation/messages') && body?.text === 'hi'
                ? json({ ok: true })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'send_message', arguments: { sessionId: 's1', text: 'hi' } })

        expect(textOf(result as never)).toBe('Message sent')
        expect(fetchMock).toHaveBeenCalled()
    })

    it('send_message reports automation_paused with explicit resume guidance, never implicit resume', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/sessions/s1/automation/messages') && body?.text === 'hi'
                ? json({ error: 'Automation is paused for this session', code: 'automation_paused' }, 409)
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'send_message', arguments: { sessionId: 's1', text: 'hi' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        const text = textOf(result as never)
        expect(text).toContain('automation is paused')
        expect(text).toContain('human has taken over')
        expect(text).toContain('explicitly allow')
        expect(text).toContain('do not resume on your own')
        expect(text).toContain('resume_automation')
        // The rejected send must not trigger a second request (no implicit resume)
        expect(fetchMock).toHaveBeenCalledTimes(2) // auth + one rejected send
    })

    it('get_session reports session status', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'GET' && url.endsWith('/api/sessions/s1')
                ? json({ session: { id: 's1', active: true, thinking: true, automationPaused: true, updatedAt: 1700000000, metadata: { path: '/repo', flavor: 'codex' } } })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'get_session', arguments: { sessionId: 's1' } })

        const text = textOf(result as never)
        expect(text).toContain('active: true')
        expect(text).toContain('thinking: true')
        expect(text).toContain('automationPaused: true')
        expect(text).toContain('path: /repo')
        expect(text).toContain('flavor: codex')
    })

    it('read_messages returns lines oldest-first', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'GET' && /\/api\/sessions\/s1\/automation\/output/.test(url)
                ? json({
                    messages: [
                        { id: 'b', seq: 2, createdAt: 2, content: { role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'text', text: 'reply' }] } } } } },
                        { id: 'a', seq: 1, createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'hi' } } }
                    ]
                })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'read_messages', arguments: { sessionId: 's1' } })

        const text = textOf(result as never)
        expect(text.split('\n')).toEqual(['1 | user | hi', '2 | agent | reply'])
    })

    it('read_messages cursor mode returns gap-free newer messages with seq', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'GET' && url.includes('/api/sessions/s1/automation/output') && url.includes('afterSeq=2')
                ? json({
                    messages: [
                        { id: 'c', seq: 3, createdAt: 3, content: { role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'text', text: 'new1' }] } } } } },
                        { id: 'd', seq: 4, createdAt: 4, content: { role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'text', text: 'new2' }] } } } } }
                    ]
                })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'read_messages', arguments: { sessionId: 's1', afterSeq: 2 } })

        const text = textOf(result as never)
        expect(text.split('\n')).toEqual(['3 | agent | new1', '4 | agent | new2'])
    })

    it('read_messages cursor mode reports caught up on empty page', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'GET' && url.includes('/api/sessions/s1/automation/output') && url.includes('afterSeq=99')
                ? json({ messages: [] })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'read_messages', arguments: { sessionId: 's1', afterSeq: 99 } })

        expect(textOf(result as never)).toBe('(caught up)')
    })

    it('pause_automation confirms pause', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s1/pause-automation')
                ? json({ ok: true, automationPaused: true })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'pause_automation', arguments: { sessionId: 's1' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        expect(textOf(result as never)).toContain('Automation paused')
        expect(textOf(result as never)).toContain('resume_automation')
        expect(textOf(result as never)).toContain('explicit permission')
    })

    it('resume_automation confirms resume', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s1/resume-automation')
                ? json({ ok: true, automationPaused: false })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'resume_automation', arguments: { sessionId: 's1' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        expect(textOf(result as never)).toBe('Automation resumed')
    })

    it('interrupt_session confirms abort of a running session', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s1/stop-automation')
                ? json({ ok: true, automationPaused: true, wasRunning: true })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'interrupt_session', arguments: { sessionId: 's1' } })

        expect(textOf(result as never)).toBe('Interrupt requested')
    })

    it('interrupt_session reports idle pause without abort RPC', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s1/stop-automation')
                ? json({ ok: true, automationPaused: true, wasRunning: false })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'interrupt_session', arguments: { sessionId: 's1' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        expect(textOf(result as never)).toBe('Session was idle; automation paused, no abort needed')
    })

    it('interrupt_session surfaces real hub failures', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s1/stop-automation')
                ? json({ error: 'abort RPC failed' }, 500)
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'interrupt_session', arguments: { sessionId: 's1' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('abort RPC failed')
    })

    it('auth failure surfaces as tool error, not crash', async () => {
        const { client, connect } = setup([
            (url, method) => method === 'POST' && url.endsWith('/api/auth')
                ? json({ error: 'Invalid access token' }, 401)
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'get_session', arguments: { sessionId: 's1' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('Authentication failed')
    })

    it('list_codex_options lists profile and provider names', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method) => method === 'GET' && url.endsWith('/api/machines/mac-1/codex-models')
                ? json({ success: true, models: [{ id: 'gpt-5.5' }, { id: 'kimi-k3' }], profiles: ['xubao', 'default'], providers: ['closeai', 'tokenmax', 'xubao'] })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'list_codex_options', arguments: { machineId: 'mac-1' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        expect(textOf(result as never)).toBe(
            'models:\n  gpt-5.5\n  kimi-k3\nprofiles:\n  xubao\n  default\nproviders:\n  closeai\n  tokenmax\n  xubao'
        )
        // Names only: response body never serialized into tool output, and the
        // only machine-scoped request is the codex-models GET itself
        const codexModelsCalls = fetchMock.mock.calls.filter(
            (call: unknown[]) => String(call[0]).endsWith('/api/machines/mac-1/codex-models')
        )
        expect(codexModelsCalls).toHaveLength(1)
    })

    it('list_codex_options tolerates missing profiles/providers arrays', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'GET' && url.endsWith('/api/machines/mac-1/codex-models')
                ? json({ success: true })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'list_codex_options', arguments: { machineId: 'mac-1' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        expect(textOf(result as never)).toBe('models:\nprofiles:\nproviders:')
    })

    it('list_codex_options surfaces hub errors', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'GET' && url.endsWith('/api/machines/mac-1/codex-models')
                ? json({ success: false, error: 'runner offline' }, 503)
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'list_codex_options', arguments: { machineId: 'mac-1' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('runner offline')
    })

    it('change_codex_provider posts provider and reports the reopen', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/sessions/s1/codex-provider') && body?.provider === 'tokenmax'
                ? json({ ok: true })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'change_codex_provider', arguments: { sessionId: 's1', provider: 'tokenmax' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        const text = textOf(result as never)
        expect(text).toContain('tokenmax')
        expect(text).toContain('reopened')
        const changeCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/sessions/s1/codex-provider')
        )
        expect(JSON.parse((changeCall![1] as RequestInit).body as string)).toEqual({ provider: 'tokenmax' })
    })

    it('change_codex_provider sends empty string for the default provider', async () => {
        const { client, connect, fetchMock } = setup([
            authRoute,
            (url, method, body) => method === 'POST' && url.endsWith('/api/sessions/s1/codex-provider') && body?.provider === ''
                ? json({ ok: true })
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'change_codex_provider', arguments: { sessionId: 's1', provider: '' } })

        expect((result as { isError?: boolean }).isError).toBeFalsy()
        const text = textOf(result as never)
        expect(text).toContain('default')
        expect(text).toContain('reopened')
        const changeCall = fetchMock.mock.calls.find(
            (call: unknown[]) => String(call[0]).endsWith('/api/sessions/s1/codex-provider')
        )
        expect(JSON.parse((changeCall![1] as RequestInit).body as string)).toEqual({ provider: '' })
    })

    it('change_codex_provider reports hub errors as-is', async () => {
        const { client, connect } = setup([
            authRoute,
            (url, method) => method === 'POST' && url.endsWith('/api/sessions/s1/codex-provider')
                ? json({ error: 'Session is not a Codex session' }, 409)
                : null
        ])
        await connect()

        const result = await client.callTool({ name: 'change_codex_provider', arguments: { sessionId: 's1', provider: 'tokenmax' } })

        expect((result as { isError?: boolean }).isError).toBe(true)
        expect(textOf(result as never)).toContain('Session is not a Codex session')
    })
})
