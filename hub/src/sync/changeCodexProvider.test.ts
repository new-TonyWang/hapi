import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { WebAppEnv } from '../web/middleware/auth'
import { createCodexProviderRoutes } from '../web/routes/codexProvider'

/**
 * Runtime Codex provider switch: real Store + real SessionCache + real
 * SyncEngine; only rpcGateway.killSession / spawnSession are stubbed to drive
 * archive/reopen deterministically (the same hermetic pattern as
 * sessionModel.test.ts's reopen cases). The route test drives the same
 * engine through the real Hono route.
 *
 * Cases: active archive→persist→reopen, inactive no-spawn, default clears
 * profile, cross-namespace / non-codex / controlledByUser rejections,
 * archive failure persists nothing, reopen failure surfaces, and concurrent
 * switches never double-reopen.
 */

function createEngine(store?: Store): SyncEngine {
    const engine = new SyncEngine(
        store ?? new Store(':memory:'),
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    engine.stop()
    return engine
}

type SpawnStub = (...args: unknown[]) => Promise<{ type: string; sessionId?: string; message?: string }>

interface EngineHarness {
    engine: SyncEngine
    store: Store
    session: ReturnType<SyncEngine['getOrCreateSession']>
    spawnCalls: number
    killCalls: number
    spawnResult: { type: string; sessionId?: string; message?: string }
}

function createCodexHarness(label: string, options?: { active?: boolean; machineId?: string; controlledByUser?: boolean }): EngineHarness {
    const store = new Store(':memory:')
    const engine = createEngine(store)
    const machineId = options?.machineId ?? 'machine-1'
    const session = engine.getOrCreateSession(
        `codex-switch-${label}`,
        {
            path: '/tmp/project',
            host: 'localhost',
            machineId,
            flavor: 'codex',
            codexProfile: 'xubao',
            codexProvider: 'tokenmax',
            lifecycleState: 'running',
            ...(options?.active === false ? { lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Codex exited' } : {})
        },
        options?.controlledByUser ? { controlledByUser: true, requests: {}, completedRequests: {} } : null,
        'default'
    )
    engine.getOrCreateMachine(machineId, { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, { status: 'running' }, 'default')
    engine.handleMachineAlive({ machineId, time: Date.now() })
    if (options?.active !== false) {
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
    } else {
        engine.handleSessionEnd({ sid: session.id, time: Date.now() })
    }

    const harness: EngineHarness = {
        engine,
        store,
        session,
        spawnCalls: 0,
        killCalls: 0,
        spawnResult: { type: 'success', sessionId: session.id }
    }
    ;(engine as unknown as { rpcGateway: { killSession: () => Promise<void>; spawnSession: SpawnStub } }).rpcGateway = {
        killSession: async () => {
            harness.killCalls += 1
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })
        },
        spawnSession: async (...args: unknown[]) => {
            harness.spawnCalls += 1
            // The reopen path forwards the session id as existingSessionId (arg 12).
            const resumeId = args[12] as string | undefined
            if (resumeId === session.id) {
                engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                engine.handleSessionReady({ sid: session.id, time: Date.now() })
            }
            return harness.spawnResult
        }
    }
    return harness
}

describe('SyncEngine.changeCodexProvider', () => {
    it('active session: archive → persist → reopen, new provider visible', async () => {
        const h = createCodexHarness('active')
        try {
            const wasActiveBefore = h.engine.getSession(h.session.id)?.active
            expect(wasActiveBefore).toBe(true)

            await h.engine.changeCodexProvider(h.session.id, 'default', 'closeai')

            // Archive killed the old runner, reopen spawned a new one — exactly once.
            expect(h.killCalls).toBe(1)
            expect(h.spawnCalls).toBe(1)
            // Provider persisted; profile untouched (non-empty switch keeps it).
            const stored = h.store.sessions.getSession(h.session.id)
            expect(stored?.metadata).toMatchObject({ codexProvider: 'closeai', codexProfile: 'xubao' })
            // Reopen brought the row back to active.
            expect(h.engine.getSession(h.session.id)?.active).toBe(true)
        } finally {
            h.store.close()
        }
    })

    it('inactive session: config change only, never spawns', async () => {
        const h = createCodexHarness('inactive', { active: false })
        try {
            await h.engine.changeCodexProvider(h.session.id, 'default', 'litellm')

            expect(h.killCalls).toBe(0)
            expect(h.spawnCalls).toBe(0)
            const stored = h.store.sessions.getSession(h.session.id)
            expect(stored?.metadata).toMatchObject({ codexProvider: 'litellm' })
            // Still inactive — no unauthorized spawn.
            expect(h.engine.getSession(h.session.id)?.active).toBe(false)
        } finally {
            h.store.close()
        }
    })

    it('empty-string provider clears the profile along with the provider (default sentinel)', async () => {
        const h = createCodexHarness('default-clear', { active: false })
        try {
            await h.engine.changeCodexProvider(h.session.id, 'default', '')

            const metadata = h.store.sessions.getSession(h.session.id)?.metadata as Record<string, unknown> | null
            expect(metadata).toMatchObject({ codexProvider: '' })
            expect(metadata).not.toHaveProperty('codexProfile')
        } finally {
            h.store.close()
        }
    })

    it('null provider is the same default sentinel as empty string', async () => {
        const h = createCodexHarness('null-provider', { active: false })
        try {
            await h.engine.changeCodexProvider(h.session.id, 'default', null)

            const metadata = h.store.sessions.getSession(h.session.id)?.metadata as Record<string, unknown> | null
            expect(metadata).toMatchObject({ codexProvider: '' })
            expect(metadata).not.toHaveProperty('codexProfile')
        } finally {
            h.store.close()
        }
    })

    it('rejects cross-namespace access', async () => {
        const h = createCodexHarness('cross-ns', { active: false })
        try {
            await expect(h.engine.changeCodexProvider(h.session.id, 'tenant', 'closeai'))
                .rejects.toThrow('Session access denied')
            // Nothing changed.
            expect(h.store.sessions.getSession(h.session.id)?.metadata).toMatchObject({ codexProvider: 'tokenmax' })
        } finally {
            h.store.close()
        }
    })

    it('rejects unknown sessions', async () => {
        const h = createCodexHarness('unknown')
        try {
            await expect(h.engine.changeCodexProvider('no-such-row', 'default', 'closeai'))
                .rejects.toThrow('Session not found')
        } finally {
            h.store.close()
        }
    })

    it('rejects non-codex sessions', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession(
            'claude-switch',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        try {
            await expect(engine.changeCodexProvider(session.id, 'default', 'closeai'))
                .rejects.toThrow('only supported for Codex sessions')
            expect(engine.getSession(session.id)?.metadata).not.toHaveProperty('codexProvider')
        } finally {
            store.close()
        }
    })

    it('rejects human-controlled (local) sessions', async () => {
        const h = createCodexHarness('controlled', { controlledByUser: true })
        try {
            await expect(h.engine.changeCodexProvider(h.session.id, 'default', 'closeai'))
                .rejects.toThrow('only supported for remote sessions')
            expect(h.killCalls).toBe(0)
            expect(h.spawnCalls).toBe(0)
        } finally {
            h.store.close()
        }
    })

    it('archive failure aborts before any provider write', async () => {
        const h = createCodexHarness('archive-fail')
        try {
            // Make the kill RPC fail with a real (non-target-missing) error.
            ;(h.engine as unknown as { rpcGateway: { killSession: () => Promise<void> } }).rpcGateway = {
                ...((h.engine as unknown as { rpcGateway: Record<string, unknown> }).rpcGateway),
                killSession: async () => { throw new Error('kill RPC exploded') }
            }

            await expect(h.engine.changeCodexProvider(h.session.id, 'default', 'closeai'))
                .rejects.toThrow('kill RPC exploded')

            // Provider untouched — the persist step never ran.
            expect(h.store.sessions.getSession(h.session.id)?.metadata).toMatchObject({ codexProvider: 'tokenmax' })
            expect(h.spawnCalls).toBe(0)
        } finally {
            h.store.close()
        }
    })

    it('reopen failure surfaces as an error (provider IS persisted by design)', async () => {
        const h = createCodexHarness('reopen-fail')
        try {
            h.spawnResult = { type: 'error', message: 'runner refused spawn' }

            await expect(h.engine.changeCodexProvider(h.session.id, 'default', 'closeai'))
                .rejects.toThrow('runner refused spawn')

            // 3008 parity: the config change is durable even when reopen fails —
            // the next resume picks the new provider up.
            expect(h.store.sessions.getSession(h.session.id)?.metadata).toMatchObject({ codexProvider: 'closeai' })
        } finally {
            h.store.close()
        }
    })

    it('concurrent switches: first wins, second is rejected (no silent provider substitution)', async () => {
        const h = createCodexHarness('concurrent')
        try {
            const results = await Promise.allSettled([
                h.engine.changeCodexProvider(h.session.id, 'default', 'closeai'),
                h.engine.changeCodexProvider(h.session.id, 'default', 'litellm')
            ])

            // Deterministic first/second ordering: Promise.allSettled preserves
            // call order, and the engine synchronously claims the tail slot
            // before its first await — so the closeai call wins and the
            // litellm call is rejected outright.
            expect(results[0]?.status).toBe('fulfilled')
            expect(results[1]?.status).toBe('rejected')
            if (results[1]?.status === 'rejected') {
                expect(results[1].reason).toBeInstanceOf(Error)
                expect(results[1].reason.message).toBe('Provider switch already in progress')
            }

            // Exactly one archive+reopen pair; the persisted provider is the
            // winner's, never the rejected request's.
            expect(h.killCalls).toBe(1)
            expect(h.spawnCalls).toBe(1)
            const stored = h.store.sessions.getSession(h.session.id)?.metadata
            expect((stored as Record<string, unknown>)?.codexProvider).toBe('closeai')
            expect(h.engine.getSession(h.session.id)?.active).toBe(true)
        } finally {
            h.store.close()
        }
    })
})

describe('POST /api/sessions/:id/codex-provider route', () => {
    function createApp(engine: SyncEngine, namespace = 'default'): Hono<WebAppEnv> {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', namespace)
            await next()
        })
        app.route('/api', createCodexProviderRoutes(() => engine))
        return app
    }

    it('switches an active session end-to-end through the route', async () => {
        const h = createCodexHarness('route-active')
        try {
            const app = createApp(h.engine)
            const response = await app.request(`/api/sessions/${h.session.id}/codex-provider`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 'closeai' })
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ ok: true })
            expect(h.spawnCalls).toBe(1)
            expect(h.store.sessions.getSession(h.session.id)?.metadata).toMatchObject({ codexProvider: 'closeai' })
        } finally {
            h.store.close()
        }
    })

    it('rejects cross-namespace callers with 403', async () => {
        const h = createCodexHarness('route-ns', { active: false })
        try {
            const app = createApp(h.engine, 'tenant')
            const response = await app.request(`/api/sessions/${h.session.id}/codex-provider`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 'closeai' })
            })

            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Session access denied' })
        } finally {
            h.store.close()
        }
    })

    it('returns 409 with the engine message for non-codex sessions', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession(
            'route-claude',
            { path: '/tmp', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        try {
            const app = createApp(engine)
            const response = await app.request(`/api/sessions/${session.id}/codex-provider`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 'closeai' })
            })

            expect(response.status).toBe(409)
            const body = await response.json() as { error: string }
            expect(body.error).toContain('Codex')
        } finally {
            store.close()
        }
    })

    it('validates the body: provider must be a string or null, max 255', async () => {
        const h = createCodexHarness('route-body', { active: false })
        try {
            const app = createApp(h.engine)

            const badType = await app.request(`/api/sessions/${h.session.id}/codex-provider`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 42 })
            })
            expect(badType.status).toBe(400)

            const tooLong = await app.request(`/api/sessions/${h.session.id}/codex-provider`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 'x'.repeat(256) })
            })
            expect(tooLong.status).toBe(400)
        } finally {
            h.store.close()
        }
    })

    it('404 for an unknown session', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        try {
            const app = createApp(engine)
            const response = await app.request('/api/sessions/nope/codex-provider', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 'closeai' })
            })
            expect(response.status).toBe(404)
        } finally {
            store.close()
        }
    })
})
