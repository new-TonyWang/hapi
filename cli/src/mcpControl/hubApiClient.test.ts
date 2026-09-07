import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractMessageText, HubApiBridge, HubApiError } from './hubApiClient'

/**
 * Minimal fetch mock: routes (method, url) to canned responses.
 * Auth + one 401-retry path are exercised implicitly by every call.
 */
type Route = { match: (url: string, method: string, body?: unknown) => boolean; respond: () => Response }

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function createFetchMock(routes: Route[], calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []) {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        const rawBody = init?.body
        const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined
        const headers = Object.fromEntries(new Headers(init?.headers).entries())
        calls.push({ url, method, body, headers })

        for (const route of routes) {
            if (route.match(url, method, body)) {
                return route.respond()
            }
        }
        return jsonResponse({ error: `no route: ${method} ${url}` }, 404)
    }) as typeof fetch
}

describe('HubApiBridge', () => {
    let authCalls: number

    function standardRoutes(overrides?: Partial<Record<string, () => Response>>): Route[] {
        authCalls = 0
        const overrideOr = (key: keyof NonNullable<typeof overrides>, fallback: () => Response): (() => Response) =>
            () => overrides?.[key]?.() ?? fallback()

        return [
            {
                match: (url, method, body) => method === 'POST' && url.endsWith('/api/auth') && (body as { accessToken?: string })?.accessToken === 'tok',
                respond: () => {
                    authCalls++
                    return jsonResponse({ token: 'jwt-1', user: { id: 1 } })
                }
            },
            {
                match: (url, method) => method === 'GET' && url.endsWith('/api/machines'),
                respond: overrideOr('machines', () => jsonResponse({
                    machines: [
                        { id: 'mac-1', active: true, metadata: { displayName: 'box' } },
                        { id: 'mac-2', active: false, metadata: null }
                    ]
                }))
            },
            {
                match: (url, method, body) => method === 'POST' && url.endsWith('/api/machines/mac-1/spawn') && (body as { directory?: string })?.directory === '/repo',
                respond: overrideOr('spawn', () => jsonResponse({ type: 'success', sessionId: 'sess-1' }))
            },
            {
                match: (url, method) => method === 'GET' && /\/api\/sessions\/sess-1$/.test(url),
                respond: overrideOr('session', () => jsonResponse({
                    session: { id: 'sess-1', active: true, thinking: false, automationPaused: false, model: null, effort: null, updatedAt: 1700000000, metadata: { path: '/repo', flavor: 'claude', name: 'work' } }
                }))
            },
            {
                match: (url, method, body) => method === 'POST' && url.endsWith('/api/sessions/sess-1/automation/messages') && typeof (body as { text?: string })?.text === 'string',
                respond: overrideOr('send', () => jsonResponse({ ok: true }))
            },
            {
                match: (url, method) => method === 'GET' && /\/api\/sessions\/sess-1\/automation\/output\?limit=\d+&afterSeq/.test(url),
                respond: overrideOr('after', () => jsonResponse({
                    messages: [
                        { id: 'm3', seq: 3, createdAt: 3, content: { role: 'user', content: { type: 'text', text: 'again' } } }
                    ]
                }))
            },
            {
                match: (url, method) => method === 'GET' && /\/api\/sessions\/sess-1\/automation\/output\?limit/.test(url),
                respond: overrideOr('messages', () => jsonResponse({
                    messages: [
                        { id: 'm2', seq: 2, createdAt: 2, content: { role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'text', text: 'done' }] } } } } },
                        { id: 'm1', seq: 1, createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'hi' } } }
                    ],
                    page: {}
                }))
            },
            {
                match: (url, method) => method === 'POST' && url.endsWith('/api/sessions/sess-1/stop-automation'),
                respond: overrideOr('stop', () => jsonResponse({ ok: true, automationPaused: true, wasRunning: false }))
            },
            {
                match: (url, method) => method === 'POST' && url.endsWith('/api/sessions/sess-1/pause-automation'),
                respond: () => jsonResponse({ ok: true, automationPaused: true })
            },
            {
                match: (url, method) => method === 'POST' && url.endsWith('/api/sessions/sess-1/resume-automation'),
                respond: () => jsonResponse({ ok: true, automationPaused: false })
            },
            {
                match: (url, method) => method === 'GET' && url.endsWith('/api/machines/mac-1/codex-models'),
                respond: () => jsonResponse({
                    success: true,
                    profiles: ['xubao', 'default'],
                    providers: ['closeai', 'tokenmax', 'xubao']
                })
            },
            {
                match: (url, method) => method === 'GET' && url.endsWith('/api/machines/mac-2/codex-models'),
                respond: () => jsonResponse({ success: true })
            },
            {
                match: (url, method) => method === 'GET' && url.endsWith('/api/machines/mac-err/codex-models'),
                respond: () => jsonResponse({ success: false, error: 'runner offline' }, 503)
            },
            {
                match: (url, method) => method === 'POST' && url.endsWith('/api/sessions/sess-1/codex-provider'),
                respond: () => jsonResponse({ ok: true })
            },
            {
                match: (url, method) => method === 'POST' && url.endsWith('/api/sessions/sess-err/codex-provider'),
                respond: () => jsonResponse({ error: 'Session is not a Codex session' }, 409)
            }
        ]
    }

    function makeBridge(routes: Route[], calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []) {
        return {
            bridge: new HubApiBridge({ baseUrl: 'http://hub:3000/', accessToken: 'tok', fetchFn: createFetchMock(routes, calls) }),
            calls
        }
    }

    describe('auth', () => {
        it('authenticates once and reuses JWT for subsequent calls', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.getSession('sess-1')
            await bridge.getSession('sess-1')

            expect(authCalls).toBe(1)
            expect(calls.filter(c => c.url.endsWith('/api/auth'))).toHaveLength(1)
        })

        it('re-authenticates once on 401', async () => {
            let authIndex = 0
            let getSessionCalls = 0
            const routes: Route[] = [
                {
                    match: (url, method) => method === 'POST' && url.endsWith('/api/auth'),
                    respond: () => jsonResponse({ token: `jwt-${++authIndex}` })
                },
                {
                    match: (url, method) => method === 'GET' && /\/api\/sessions\/sess-1$/.test(url),
                    respond: () => {
                        getSessionCalls++
                        // First session call uses expired jwt-1 -> 401; second succeeds
                        return getSessionCalls === 1
                            ? jsonResponse({ error: 'expired' }, 401)
                            : jsonResponse({ session: { id: 'sess-1', active: true, updatedAt: 0 } })
                    }
                }
            ]
            const { bridge } = makeBridge(routes)

            const session = await bridge.getSession('sess-1')

            expect(authIndex).toBe(2)
            expect(session.id).toBe('sess-1')
        })

        it('fails with auth error message on invalid token', async () => {
            const routes: Route[] = [
                {
                    match: (url, method) => method === 'POST' && url.endsWith('/api/auth'),
                    respond: () => jsonResponse({ error: 'Invalid access token' }, 401)
                }
            ]
            const { bridge } = makeBridge(routes)

            await expect(bridge.getSession('sess-1')).rejects.toThrow(/Authentication failed \(401\): Invalid access token/)
        })
    })

    describe('createSession', () => {
        it('posts spawn request without model/effort', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            const result = await bridge.createSession('mac-1', '/repo')

            expect(result).toEqual({ sessionId: 'sess-1' })
            const spawnCall = calls.find(c => c.url.endsWith('/api/machines/mac-1/spawn'))
            expect(spawnCall).toBeDefined()
            expect(spawnCall!.body).toEqual({ directory: '/repo' })
            // Headers keys normalize to lowercase in the mock capture
            expect(spawnCall!.headers.authorization).toBe('Bearer jwt-1')
        })

        it('passes agent flavor when given', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.createSession('mac-1', '/repo', 'codex')

            expect(calls.find(c => c.url.endsWith('/api/machines/mac-1/spawn'))!.body).toEqual({
                directory: '/repo',
                agent: 'codex'
            })
        })

        it('throws hub error message on spawn failure', async () => {
            const { bridge } = makeBridge(standardRoutes({ spawn: () => jsonResponse({ type: 'error', message: 'machine offline' }) }))

            await expect(bridge.createSession('mac-1', '/repo')).rejects.toThrow('machine offline')
        })

        it('passes codexProfile/codexProvider in the spawn body for agent=codex', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            const result = await bridge.createSession('mac-1', '/repo', 'codex', undefined, 'xubao', 'tokenmax')

            expect(result).toEqual({ sessionId: 'sess-1' })
            expect(calls.find(c => c.url.endsWith('/api/machines/mac-1/spawn'))!.body).toEqual({
                directory: '/repo',
                agent: 'codex',
                codexProfile: 'xubao',
                codexProvider: 'tokenmax'
            })
        })

        it('passes model in the spawn body when given', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.createSession('mac-1', '/repo', 'codex', 'kimi-k3')

            expect(calls.find(c => c.url.endsWith('/api/machines/mac-1/spawn'))!.body).toEqual({
                directory: '/repo',
                agent: 'codex',
                model: 'kimi-k3'
            })
        })

        it('passes a different codexProvider for a second session', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.createSession('mac-1', '/repo', 'codex', undefined, undefined, 'xubao')

            expect(calls.find(c => c.url.endsWith('/api/machines/mac-1/spawn'))!.body).toEqual({
                directory: '/repo',
                agent: 'codex',
                codexProvider: 'xubao'
            })
        })

        it('rejects codexProfile/codexProvider for non-codex agents before any request', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await expect(bridge.createSession('mac-1', '/repo', 'claude', undefined, undefined, 'tokenmax'))
                .rejects.toThrow(/only valid with agent=codex.*claude/)
            await expect(bridge.createSession('mac-1', '/repo', 'cursor', undefined, 'p1'))
                .rejects.toThrow(/only valid with agent=codex.*cursor/)
            // Default agent (claude) is rejected too
            await expect(bridge.createSession('mac-1', '/repo', undefined, undefined, undefined, 'openai'))
                .rejects.toThrow(/only valid with agent=codex.*claude \(default\)/)

            expect(calls.filter(c => c.url.endsWith('/api/machines/mac-1/spawn'))).toHaveLength(0)
        })

        it('never sends effort or modelReasoningEffort fields alongside provider fields', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.createSession('mac-1', '/repo', 'codex', undefined, 'xubao', 'tokenmax')

            const spawnCall = calls.find(c => c.url.endsWith('/api/machines/mac-1/spawn'))!
            expect(spawnCall.body).not.toHaveProperty('effort')
            expect(spawnCall.body).not.toHaveProperty('modelReasoningEffort')
        })
    })

    describe('sendMessage', () => {
        it('posts text with localId to the automation messages endpoint', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.sendMessage('sess-1', 'hello')

            const sendCall = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/sessions/sess-1/automation/messages'))
            expect(sendCall).toBeDefined()
            expect((sendCall!.body as { text: string }).text).toBe('hello')
            expect((sendCall!.body as { localId: string }).localId).toMatch(/^mcp-/)
        })

        it('throws HubApiError with code automation_paused on 409', async () => {
            const { bridge } = makeBridge(standardRoutes({
                send: () => jsonResponse({ error: 'Automation is paused for this session', code: 'automation_paused' }, 409)
            }))

            const error = await bridge.sendMessage('sess-1', 'hello').then(
                () => null,
                (e: unknown) => e
            )

            expect(error).toBeInstanceOf(HubApiError)
            const hubError = error as HubApiError
            expect(hubError.status).toBe(409)
            expect(hubError.code).toBe('automation_paused')
            expect(hubError.message).toContain('Automation is paused')
        })
    })

    describe('getSession', () => {
        it('maps session fields', async () => {
            const { bridge } = makeBridge(standardRoutes())

            const session = await bridge.getSession('sess-1')

            expect(session).toEqual({
                id: 'sess-1',
                active: true,
                thinking: false,
                automationPaused: false,
                parentSessionId: null,
                path: '/repo',
                name: 'work',
                flavor: 'claude',
                model: null,
                effort: null,
                permissionMode: null,
                machineId: null,
                codexProfile: null,
                codexProvider: null,
                updatedAt: 1700000000
            })
        })

        it('maps automationPaused true', async () => {
            const { bridge } = makeBridge(standardRoutes({
                session: () => jsonResponse({
                    session: { id: 'sess-1', active: true, thinking: false, automationPaused: true, updatedAt: 1, metadata: null }
                })
            }))

            const session = await bridge.getSession('sess-1')

            expect(session.automationPaused).toBe(true)
        })
    })

    describe('readMessages', () => {
        it('returns messages oldest-first with roles and text', async () => {
            const { bridge } = makeBridge(standardRoutes())

            const messages = await bridge.readMessages('sess-1', 20)

            expect(messages).toHaveLength(2)
            expect(messages[0]).toMatchObject({ id: 'm1', role: 'user', text: 'hi' })
            expect(messages[1]).toMatchObject({ id: 'm2', role: 'agent', text: 'done' })
        })

        it('cursor mode passes afterSeq and returns only newer messages', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            const messages = await bridge.readMessages('sess-1', 50, 2)

            expect(calls.some(c => c.url.includes('/api/sessions/sess-1/automation/output') && c.url.includes('afterSeq=2') && c.url.includes('limit=50'))).toBe(true)
            expect(messages).toHaveLength(1)
            expect(messages[0]).toMatchObject({ id: 'm3', seq: 3, role: 'user', text: 'again' })
        })

        it('cursor mode returns empty at the tip', async () => {
            const { bridge } = makeBridge(standardRoutes({
                after: () => jsonResponse({ messages: [] })
            }))

            const messages = await bridge.readMessages('sess-1', 50, 99)

            expect(messages).toEqual([])
        })
    })

    describe('pauseAutomation / resumeAutomation', () => {
        it('posts pause and resume endpoints', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.pauseAutomation('sess-1')
            await bridge.resumeAutomation('sess-1')

            expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/sessions/sess-1/pause-automation'))).toBe(true)
            expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/sessions/sess-1/resume-automation'))).toBe(true)
        })
    })

    describe('interruptSession', () => {
        it('posts stop-automation and reports wasRunning', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            const result = await bridge.interruptSession('sess-1')

            expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/sessions/sess-1/stop-automation'))).toBe(true)
            expect(result.wasRunning).toBe(false)
        })
    })

    describe('listMachines', () => {
        it('maps machine fields', async () => {
            const { bridge } = makeBridge(standardRoutes())

            const machines = await bridge.listMachines()

            expect(machines).toEqual([
                { id: 'mac-1', active: true, displayName: 'box' },
                { id: 'mac-2', active: false, displayName: null }
            ])
        })
    })

    describe('listCodexOptions', () => {
        it('gets codex-models and maps profile/provider names', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            const options = await bridge.listCodexOptions('mac-1')

            expect(calls.some(c => c.method === 'GET' && c.url.endsWith('/api/machines/mac-1/codex-models'))).toBe(true)
            expect(options).toEqual({
                profiles: ['xubao', 'default'],
                providers: ['closeai', 'tokenmax', 'xubao']
            })
        })

        it('returns empty arrays when profiles/providers are missing', async () => {
            const { bridge } = makeBridge(standardRoutes())

            const options = await bridge.listCodexOptions('mac-2')

            expect(options).toEqual({ profiles: [], providers: [] })
        })

        it('throws hub error with status on failure', async () => {
            const { bridge } = makeBridge(standardRoutes())

            const error = await bridge.listCodexOptions('mac-err').then(
                () => null,
                (e: unknown) => e
            )

            expect(error).toBeInstanceOf(HubApiError)
            expect((error as HubApiError).status).toBe(503)
        })
    })

    describe('changeCodexProvider', () => {
        it('posts the provider name to the codex-provider endpoint', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.changeCodexProvider('sess-1', 'tokenmax')

            const changeCall = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/sessions/sess-1/codex-provider'))
            expect(changeCall).toBeDefined()
            expect(changeCall!.body).toEqual({ provider: 'tokenmax' })
            expect(changeCall!.headers.authorization).toBe('Bearer jwt-1')
        })

        it('posts an empty string to select the default provider', async () => {
            const { bridge, calls } = makeBridge(standardRoutes())

            await bridge.changeCodexProvider('sess-1', '')

            expect(calls.find(c => c.url.endsWith('/api/sessions/sess-1/codex-provider'))!.body).toEqual({ provider: '' })
        })

        it('throws hub error verbatim on 409', async () => {
            const { bridge } = makeBridge(standardRoutes())

            const error = await bridge.changeCodexProvider('sess-err', 'tokenmax').then(
                () => null,
                (e: unknown) => e
            )

            expect(error).toBeInstanceOf(HubApiError)
            const hubError = error as HubApiError
            expect(hubError.status).toBe(409)
            expect(hubError.message).toContain('Session is not a Codex session')
        })
    })
})

describe('extractMessageText', () => {
    it('extracts direct user text envelope', () => {
        expect(extractMessageText({ role: 'user', content: { type: 'text', text: 'hi' } })).toEqual({ role: 'user', text: 'hi' })
    })

    it('extracts user content as plain string', () => {
        expect(extractMessageText({ role: 'user', content: 'hi' })).toEqual({ role: 'user', text: 'hi' })
    })

    it('extracts agent text blocks', () => {
        expect(extractMessageText({ role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } } }))
            .toEqual({ role: 'agent', text: 'a\n\nb' })
    })

    it('extracts from a real CLI assistant envelope (acceptance shape)', () => {
        // Exact shape captured from a live Claude session on the 3010 env:
        // data.type === 'assistant', message.content is a block array.
        const envelope = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    parentUuid: 'p', isSidechain: false, userType: 'external',
                    type: 'assistant',
                    message: {
                        id: 'msg_1', type: 'message', role: 'assistant',
                        content: [{ type: 'text', text: 'PONG' }]
                    }
                }
            }
        }
        expect(extractMessageText(envelope)).toEqual({ role: 'agent', text: 'PONG' })
    })

    it('yields empty text for pure event records (ready/emitted)', () => {
        const envelope = {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'event', data: { type: 'ready' } }
            }
        }
        expect(extractMessageText(envelope)).toEqual({ role: 'agent', text: '' })
    })

    it('extracts agent string content', () => {
        expect(extractMessageText({ role: 'agent', content: { type: 'output', data: { message: { content: 'plain' } } } }))
            .toEqual({ role: 'agent', text: 'plain' })
    })

    it('marks tool-only agent turns with a stub', () => {
        expect(extractMessageText({ role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'tool_use', id: 't', name: 'Bash' }] } } } }))
            .toEqual({ role: 'agent', text: '(no text content)' })
    })

    it('stringifies unrecognized content', () => {
        const result = extractMessageText({ something: 'else' })
        expect(result.role).toBe('unknown')
        expect(result.text).toContain('something')
    })

    it('handles null content', () => {
        expect(extractMessageText(null)).toEqual({ role: 'unknown', text: '' })
    })
})
