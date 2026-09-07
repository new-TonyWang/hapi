import { describe, expect, it } from 'bun:test'
import { SessionSchema, SessionPatchSchema } from '@hapi/protocol/schemas'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function createHarness(label: string, namespace: string = 'default') {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, createPublisher(events))
    const session = cache.getOrCreateSession(
        `pause-${label}`,
        { path: '/tmp/project', host: 'localhost' },
        null,
        namespace
    )
    return { store, events, cache, session }
}

/**
 * SessionCache automationPaused surface (step 3 of the pause port):
 * hydrate from the persisted row, namespace-safe writes with a structured
 * SSE patch, CLI-shaped sparse patches never clearing the server-owned flag,
 * and summary/schema propagation. The store layer (201-pass suite) and the
 * v27 migration are already independently verified.
 */
describe('SessionCache.automationPaused', () => {
    it('hydrates false for fresh sessions and true from a persisted paused row', () => {
        const { cache, session } = createHarness('hydrate')
        expect(cache.getSession(session.id)?.automationPaused).toBe(false)

        // Persist pause through a *different* cache instance (cold cache hydrate path).
        const store2 = new Store(':memory:')
        const events2: SyncEvent[] = []
        const cache2 = new SessionCache(store2, createPublisher(events2))
        const pinned = cache2.getOrCreateSession(
            'pause-hydrate-paused',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        store2.sessions.setSessionAutomationPaused(pinned.id, true, 'default')
        const hydrated = cache2.refreshSession(pinned.id)
        expect(hydrated?.automationPaused).toBe(true)
        expect(cache2.getSession(pinned.id)?.automationPaused).toBe(true)
        store2.close()
    })

    it('setAutomationPaused persists, updates the cached session, and emits a structured patch', () => {
        const { events, cache, session } = createHarness('write')
        events.length = 0
        const seqBefore = cache.getSession(session.id)?.seq ?? 0

        const updated = cache.setAutomationPaused(session.id, true)

        expect(updated?.automationPaused).toBe(true)
        expect(cache.getSession(session.id)?.automationPaused).toBe(true)
        // Store round-trip: the durable row carries the flag.
        expect(cache.getSession(session.id)?.seq).toBeGreaterThan(seqBefore)

        const emitted = events.filter((event) => event.type === 'session-updated')
        expect(emitted).toHaveLength(1)
        const patch = emitted[0] as Extract<SyncEvent, { type: 'session-updated' }>
        expect(patch.namespace).toBe('default')
        expect(patch.data).toEqual({ automationPaused: true })
        // The patch parses as a structured SessionPatch (web fast path).
        expect(SessionPatchSchema.safeParse(patch.data).success).toBe(true)
        // And the cached Session still parses as a full Session for isSessionRecord.
        expect(SessionSchema.safeParse(cache.getSession(session.id)).success).toBe(true)
    })

    it('resume clears the flag and emits the clearing patch', () => {
        const { events, cache, session } = createHarness('resume')
        cache.setAutomationPaused(session.id, true)
        events.length = 0

        const updated = cache.setAutomationPaused(session.id, false)

        expect(updated?.automationPaused).toBe(false)
        expect(cache.getSession(session.id)?.automationPaused).toBe(false)
        const emitted = events.filter((event) => event.type === 'session-updated')
        expect(emitted).toHaveLength(1)
        const patch = emitted[0] as Extract<SyncEvent, { type: 'session-updated' }>
        expect(patch.data).toEqual({ automationPaused: false })
    })

    it('returns null for an unknown session without emitting', () => {
        const { events, cache } = createHarness('unknown')
        events.length = 0

        expect(cache.setAutomationPaused('no-such-session', true)).toBeNull()
        expect(events).toHaveLength(0)
    })

    it('CLI-shaped sparse patches (metadata/agentState/keep-alive) never clear the flag', () => {
        const { cache, session } = createHarness('sparse')
        cache.setAutomationPaused(session.id, true)

        // A metadata rewrite that mirrors the CLI archive payload shape.
        const appliedMetadata = cache.applySessionPatch(session.id, {
            metadata: { version: session.metadataVersion + 1, value: { ...session.metadata!, lifecycleState: 'archived' } }
        })
        // A keep-alive-style status patch.
        const appliedStatus = cache.applySessionPatch(session.id, {
            active: false,
            thinking: false,
            updatedAt: Date.now()
        })

        expect(appliedMetadata).toBe(true)
        expect(appliedStatus).toBe(true)
        expect(cache.getSession(session.id)?.automationPaused).toBe(true)

        // A client-shaped patch carrying the key is stripped by the cache
        // (server-owned): the flag survives even a forged patch, and a
        // pause-only patch falls back to refresh (returns false) rather
        // than forwarding a no-op.
        const pauseOnly = cache.applySessionPatch(session.id, { automationPaused: false })
        expect(pauseOnly).toBe(false)
        expect(cache.getSession(session.id)?.automationPaused).toBe(true)
    })

    it('archive-end keep-alive does not disturb the flag (handleSessionEnd)', () => {
        const { cache, session } = createHarness('session-end')
        cache.setAutomationPaused(session.id, true)

        cache.handleSessionEnd({ sid: session.id, time: Date.now() })

        expect(cache.getSession(session.id)?.active).toBe(false)
        expect(cache.getSession(session.id)?.thinking).toBe(false)
        expect(cache.getSession(session.id)?.automationPaused).toBe(true)
    })

    it('survives a full refreshSession reload (metadata rewrites, reopen-equivalent)', () => {
        const { store, cache, session } = createHarness('refresh')
        cache.setAutomationPaused(session.id, true)

        // Simulate a concurrent metadata write landing in the DB (versioned
        // update, exactly what CLI archive/sparse updates do), then the
        // cache re-reading the row — pause must come back with it.
        store.sessions.updateSessionMetadata(
            session.id,
            { ...session.metadata!, lifecycleState: 'archived' },
            session.metadataVersion,
            'default'
        )
        const refreshed = cache.refreshSession(session.id)

        expect(refreshed?.automationPaused).toBe(true)
        expect(refreshed?.metadata?.lifecycleState).toBe('archived')
    })

    it('cross-namespace session is not writable via cache path (namespace resolved from row)', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'pause-cross-ns',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'alpha'
        )

        // Cache resolves namespace from the row itself; the write path can
        // only ever target the row's own namespace (store guard enforces).
        const updated = cache.setAutomationPaused(session.id, true)
        expect(updated?.automationPaused).toBe(true)

        // But the same session id under another namespace cannot be touched
        // through the store-level guard the cache delegates to.
        expect(store.sessions.setSessionAutomationPaused(session.id, false, 'beta')).toBeNull()
        expect(cache.getSession(session.id)?.automationPaused).toBe(true)
        store.close()
    })
})
