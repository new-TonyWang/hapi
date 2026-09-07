import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { WebAppEnv } from '../web/middleware/auth'
import type { Machine, Session } from './syncEngine'
import { createMachinesRoutes } from '../web/routes/machines'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'

/**
 * Parent-link spawn path: engine pre-RPC validation (existence in the
 * machine's namespace, self-reference, cycle), post-RPC stamp + refresh,
 * rpcGateway JSON passthrough, and the machines route's namespace guard +
 * parameter forwarding. Real Store + real SessionCache; only the gateway
 * spawn RPC is stubbed (no runner).
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

interface Harness {
    engine: SyncEngine
    store: Store
    machineId: string
    parent: Session
    spawnArgs: Array<unknown> | null
    spawnResult: { type: string; sessionId?: string }
    spawnCalls: number
    /** When false, a successful stub does NOT create the child row (for failure sims). */
    createChildRow: boolean
}

function createHarness(label: string, namespace = 'default'): Harness {
    const store = new Store(':memory:')
    const engine = createEngine(store)
    const machineId = `machine-${label}`
    engine.getOrCreateMachine(
        machineId,
        { host: 'localhost', platform: 'linux', happyCliVersion: '1.0.0', capabilities: [MACHINE_CAPABILITIES.AgentAvailability] },
        { status: 'running' },
        namespace
    )
    const parent = engine.getOrCreateSession(
        `parent-${label}`,
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        null,
        namespace
    )
    const harness: Harness = {
        engine,
        store,
        machineId,
        parent,
        spawnArgs: null,
        spawnResult: { type: 'success', sessionId: `child-${label}` },
        spawnCalls: 0,
        createChildRow: true
    }
    setSpawn(engine, async (...args: unknown[]) => {
        harness.spawnCalls += 1
        harness.spawnArgs = args
        // Production: the RPC resolves only after the child CLI has fully
        // spawned and created its hub row (create-or-load). Simulate that:
        // a successful stub creates the row the engine's stamp targets.
        if (harness.createChildRow && harness.spawnResult.type === 'success' && harness.spawnResult.sessionId) {
            store.sessions.getOrCreateSession(
                `spawned-${harness.spawnResult.sessionId}`,
                { path: '/tmp/project', host: 'localhost' },
                null,
                namespace,
                undefined,
                undefined,
                undefined,
                harness.spawnResult.sessionId
            )
        }
        return harness.spawnResult
    })
    return harness
}

function setSpawn(engine: SyncEngine, impl: (...args: unknown[]) => Promise<{ type: string; sessionId?: string }>): void {
    ;(engine as unknown as { rpcGateway: { spawnSession: typeof impl } }).rpcGateway = {
        spawnSession: impl
    } as never
}

describe('SyncEngine.spawnSession parentSessionId', () => {
    it('valid parent: RPC called with parentSessionId as the last arg, child stamped + refreshed', async () => {
        const h = createHarness('ok')
        try {
            const result = await h.engine.spawnSession(
                h.machineId, '/tmp/project', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined, // codexProfile, codexProvider
                h.parent.id
            )

            expect(result).toEqual({ type: 'success', sessionId: 'child-ok' })
            expect(h.spawnCalls).toBe(1)
            // RPC sees parentSessionId as the FINAL argument (after codexProvider).
            const args = h.spawnArgs!
            expect(args.length).toBeGreaterThanOrEqual(20)
            expect(args[args.length - 1]).toBe(h.parent.id)
            // Child row carries the durable link.
            const child = h.store.sessions.getSession('child-ok')
            expect(child?.parentSessionId).toBe(h.parent.id)
            // Cache refreshed: the live Session exposes the link.
            const cached = h.engine.getSession('child-ok')
            expect(cached?.parentSessionId).toBe(h.parent.id)
            // Children listing sees it.
            const children = h.store.sessions.getSessionChildren(h.parent.id, 'default')
            expect(children.map((child) => child.id)).toEqual(['child-ok'])
        } finally {
            h.store.close()
        }
    })

    it('parent in a different namespace is rejected before any RPC', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        try {
            // Machine in 'default'; parent row exists only in 'tenant'.
            engine.getOrCreateMachine('machine-ns', { host: 'h', platform: 'linux', happyCliVersion: '1.0.0' }, { status: 'running' }, 'default')
            const foreign = engine.getOrCreateSession('tenant-parent', { path: '/tmp', host: 'h' }, null, 'tenant')

            let calls = 0
            setSpawn(engine, async () => { calls += 1; return { type: 'success', sessionId: 'x' } })

            const result = await engine.spawnSession(
                'machine-ns', '/tmp/project', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined,
                foreign.id
            )

            expect(result.type).toBe('error')
            // Cross-namespace parent: invisible to this namespace. The
            // engine surfaces access-denied; the route maps both reasons
            // to a plain 404 for the caller.
            expect((result as { message: string }).message).toContain('Parent session access denied')
            expect(calls).toBe(0)
        } finally {
            store.close()
        }
    })

    it('unknown parent is rejected before any RPC', async () => {
        const h = createHarness('unknown')
        try {
            const result = await h.engine.spawnSession(
                h.machineId, '/tmp', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined,
                'no-such-parent'
            )
            expect(result.type).toBe('error')
            expect((result as { message: string }).message).toContain('Parent session not found')
            expect(h.spawnCalls).toBe(0)
        } finally {
            h.store.close()
        }
    })

    it('self-reference via existingSessionId is rejected before any RPC', async () => {
        const h = createHarness('self')
        try {
            const result = await h.engine.spawnSession(
                h.machineId, '/tmp', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined,
                h.parent.id, // existingSessionId == parentSessionId → self
                undefined, undefined, undefined,
                undefined, undefined,
                h.parent.id
            )
            expect(result.type).toBe('error')
            expect((result as { message: string }).message).toContain('cannot be the session being spawned')
            expect(h.spawnCalls).toBe(0)
        } finally {
            h.store.close()
        }
    })

    it('cyclic ancestor chain is rejected before any RPC', async () => {
        const h = createHarness('cycle')
        try {
            // Build a→b→a cycle directly through the store setter.
            const b = h.store.sessions.getOrCreateSession('cycle-b', { path: '/tmp', host: 'h' }, null, 'default')
            h.store.sessions.setSessionParent(h.parent.id, b.id, 'default')
            h.store.sessions.setSessionParent(b.id, h.parent.id, 'default')
            ;(h.engine as unknown as { sessionCache: { refreshSession: (id: string) => unknown } }).sessionCache.refreshSession(h.parent.id)

            const result = await h.engine.spawnSession(
                h.machineId, '/tmp', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined,
                h.parent.id
            )
            expect(result.type).toBe('error')
            expect((result as { message: string }).message).toContain('cycle')
            expect(h.spawnCalls).toBe(0)
        } finally {
            h.store.close()
        }
    })

    it('grandparent chain (no cycle) is accepted', async () => {
        const h = createHarness('grand')
        try {
            const mid = h.store.sessions.getOrCreateSession('mid', { path: '/tmp', host: 'h' }, null, 'default')
            h.store.sessions.setSessionParent(mid.id, h.parent.id, 'default')
            ;(h.engine as unknown as { sessionCache: { refreshSession: (id: string) => unknown } }).sessionCache.refreshSession(mid.id)

            const result = await h.engine.spawnSession(
                h.machineId, '/tmp', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined,
                mid.id
            )
            expect(result.type).toBe('success')
            expect(h.store.sessions.getSession('child-grand')?.parentSessionId).toBe(mid.id)
        } finally {
            h.store.close()
        }
    })

    it('runner returning the parent id as the child is rejected post-RPC', async () => {
        const h = createHarness('echo')
        try {
            // Malicious/buggy runner echoes the PARENT id as the child.
            h.spawnResult = { type: 'success', sessionId: h.parent.id }
            h.createChildRow = false // no new row; the parent row already exists

            const result = await h.engine.spawnSession(
                h.machineId, '/tmp', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined,
                h.parent.id
            )
            expect(result.type).toBe('error')
            expect((result as { message: string }).message).toContain('cannot be the session itself')
        } finally {
            h.store.close()
        }
    })

    it('stamp failure (child row in another namespace) surfaces as an error', async () => {
        const h = createHarness('stamp-fail')
        try {
            // RPC succeeds with a child id that has NO row in this namespace
            // (store stamp writes 0 rows).
            h.spawnResult = { type: 'success', sessionId: 'ghost-child' }
            h.createChildRow = false

            const result = await h.engine.spawnSession(
                h.machineId, '/tmp', 'claude',
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined,
                undefined, undefined,
                h.parent.id
            )
            expect(result.type).toBe('error')
            expect((result as { message: string }).message).toContain('failed to link parent session')
        } finally {
            h.store.close()
        }
    })

    it('no parentSessionId: behavior identical to before (no stamp, no validation)', async () => {
        const h = createHarness('plain')
        try {
            const result = await h.engine.spawnSession(h.machineId, '/tmp', 'claude')
            expect(result).toEqual({ type: 'success', sessionId: 'child-plain' })
            // The stub created the child row (production sim); no parent arg
            // → no stamp ran → link stays null.
            expect(h.store.sessions.getSession('child-plain')?.parentSessionId).toBeNull()
            // Old arg positions unchanged: the gateway still receives the
            // full tail with parentSessionId=undefined.
            expect(h.spawnArgs?.length).toBe(20)
            expect(h.spawnArgs?.[19]).toBeUndefined()
        } finally {
            h.store.close()
        }
    })
})

describe('machines spawn route parentSessionId', () => {
    function createApp(engine: SyncEngine, namespace = 'default'): Hono<WebAppEnv> {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', namespace)
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine))
        return app
    }

    it('forwards parentSessionId to the engine after the namespace guard', async () => {
        const h = createHarness('route')
        try {
            const app = createApp(h.engine)
            const response = await app.request(`/api/machines/${h.machineId}/spawn`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ directory: '/tmp/project', agent: 'claude', parentSessionId: h.parent.id })
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ type: 'success', sessionId: 'child-route' })
            // Engine (and thus the gateway payload) received the parent id.
            expect(h.spawnArgs?.[h.spawnArgs!.length - 1]).toBe(h.parent.id)
            expect(h.store.sessions.getSession('child-route')?.parentSessionId).toBe(h.parent.id)
        } finally {
            h.store.close()
        }
    })

    it('404s when the parent is unknown in the caller namespace', async () => {
        const h = createHarness('route-404')
        try {
            const app = createApp(h.engine)
            const response = await app.request(`/api/machines/${h.machineId}/spawn`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ directory: '/tmp/project', parentSessionId: 'no-such-parent' })
            })

            expect(response.status).toBe(404)
            expect(await response.json()).toEqual({ error: 'Parent session not found' })
            expect(h.spawnCalls).toBe(0)
        } finally {
            h.store.close()
        }
    })

    it('cross-namespace parent: 404 at the route layer', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        try {
            engine.getOrCreateMachine('machine-route-ns', { host: 'h', platform: 'linux', happyCliVersion: '1.0.0', capabilities: [MACHINE_CAPABILITIES.AgentAvailability] }, { status: 'running' }, 'default')
            const foreign = engine.getOrCreateSession('tenant-route-parent', { path: '/tmp', host: 'h' }, null, 'tenant')
            let calls = 0
            setSpawn(engine, async () => { calls += 1; return { type: 'success', sessionId: 'x' } })

            const app = createApp(engine)
            const response = await app.request('/api/machines/machine-route-ns/spawn', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ directory: '/tmp/project', parentSessionId: foreign.id })
            })

            expect(response.status).toBe(404)
            expect(calls).toBe(0)
        } finally {
            store.close()
        }
    })

    it('spawn without parentSessionId is unaffected', async () => {
        const h = createHarness('route-plain')
        try {
            const app = createApp(h.engine)
            const response = await app.request(`/api/machines/${h.machineId}/spawn`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ directory: '/tmp/project' })
            })

            expect(response.status).toBe(200)
            expect(h.store.sessions.getSession('child-route-plain')?.parentSessionId).toBeNull()
        } finally {
            h.store.close()
        }
    })
})
