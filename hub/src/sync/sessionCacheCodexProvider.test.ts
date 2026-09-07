import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import type { SyncEvent } from '@hapi/protocol/types'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

/**
 * SessionCache.setCodexProvider port tests (real Store + real cache, no mocks
 * beyond the publisher sink):
 *   - non-empty provider persists to metadata.codexProvider, profile kept
 *   - empty string clears provider AND profile via the null explicit-clear
 *     sentinel (a '' write would survive CODEX_LAUNCH_FIELDS carry-forward)
 *   - unknown session / cross-namespace access is rejected
 *   - other metadata fields, model, pause flag, and history survive
 *   - durable across cache (and store) refresh
 */
function createHarness(label: string, namespace: string = 'default') {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, createPublisher(events))
    const session = cache.getOrCreateSession(
        `codex-provider-${label}`,
        {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            name: 'work session'
        },
        null,
        namespace
    )
    return { store, events, cache, session }
}

describe('SessionCache.setCodexProvider', () => {
    it('persists a non-empty provider and keeps the existing profile', () => {
        const { store, cache, session } = createHarness('non-empty')
        // Seed an initial profile + provider through the same write path.
        store.sessions.updateSessionMetadata(
            session.id,
            { ...session.metadata!, codexProfile: 'xubao', codexProvider: 'tokenmax' },
            session.metadataVersion,
            'default'
        )
        cache.refreshSession(session.id)

        cache.setCodexProvider(session.id, 'closeai')

        const updated = cache.getSession(session.id)
        expect(updated?.metadata?.codexProvider).toBe('closeai')
        // Non-empty provider: profile is an independent knob, kept as-is.
        expect(updated?.metadata?.codexProfile).toBe('xubao')
        // Durable in the store row.
        const stored = store.sessions.getSession(session.id)
        expect(stored?.metadata).toMatchObject({ codexProvider: 'closeai', codexProfile: 'xubao' })
        store.close()
    })

    it('empty string clears the provider AND the profile (null sentinel, not falsy-empty)', () => {
        const { store, cache, session } = createHarness('empty')
        store.sessions.updateSessionMetadata(
            session.id,
            { ...session.metadata!, codexProfile: 'xubao', codexProvider: 'tokenmax' },
            session.metadataVersion,
            'default'
        )
        cache.refreshSession(session.id)

        cache.setCodexProvider(session.id, '')

        const updated = cache.getSession(session.id)
        // Provider: the row keeps the explicit empty-string default sentinel…
        expect(updated?.metadata?.codexProvider).toBe('')
        // …and the profile key is GONE — not '' and not carried forward from
        // the prior row by CODEX_LAUNCH_FIELDS.
        expect(updated?.metadata).not.toHaveProperty('codexProfile')
        const stored = store.sessions.getSession(session.id)
        expect(stored?.metadata).toMatchObject({ codexProvider: '' })
        expect(stored?.metadata).not.toHaveProperty('codexProfile')
        store.close()
    })

    it('profile stays deleted across a later sparse metadata write (no carry-forward resurrection)', () => {
        const { store, cache, session } = createHarness('no-resurrect')
        store.sessions.updateSessionMetadata(
            session.id,
            { ...session.metadata!, codexProfile: 'xubao', codexProvider: 'tokenmax' },
            session.metadataVersion,
            'default'
        )
        cache.refreshSession(session.id)
        cache.setCodexProvider(session.id, '')

        // Simulate a later sparse lifecycle write (e.g. archive transition) that
        // says nothing about codex fields: CODEX_LAUNCH_FIELDS carry-forward
        // must not resurrect the deleted profile.
        const afterClear = cache.getSession(session.id)!
        store.sessions.updateSessionMetadata(
            session.id,
            { ...afterClear.metadata!, lifecycleState: 'archived' },
            afterClear.metadataVersion,
            'default'
        )
        cache.refreshSession(session.id)

        const stored = store.sessions.getSession(session.id)
        const storedMetadata = stored?.metadata as Record<string, unknown> | null | undefined
        expect(storedMetadata).not.toHaveProperty('codexProfile')
        expect(storedMetadata?.codexProvider).toBe('')
        store.close()
    })

    it('throws for an unknown session id', () => {
        const { store, cache } = createHarness('unknown')
        expect(() => cache.setCodexProvider('no-such-session', 'closeai')).toThrow('Session not found')
        store.close()
    })

    it('writes use the row\'s own namespace; caller authorization is NOT this setter\'s job', () => {
        const { store, cache, session } = createHarness('ns', 'tenant')
        // The setter has no namespace parameter and refreshSession is not
        // namespace-scoped, so the cache CANNOT police tenants — that is
        // the engine/route layer's job (resolveSessionAccess /
        // requireSessionFromParam, covered by the engine tests). What the
        // setter does guarantee: the store write goes out with the ROW's
        // namespace, so the update can never land on a different row.
        expect(() => cache.setCodexProvider(session.id, 'closeai')).not.toThrow()
        const stored = store.sessions.getSession(session.id)
        expect(stored?.metadata).toMatchObject({ codexProvider: 'closeai' })
        expect(stored?.namespace).toBe('tenant')
        store.close()
    })

    it('preserves other metadata fields, model, and the automation pause flag', () => {
        const { store, cache, session } = createHarness('preserve')
        const before = cache.getSession(session.id)!
        store.sessions.setSessionAutomationPaused(session.id, true, 'default')

        cache.setCodexProvider(session.id, 'litellm')

        const updated = cache.getSession(session.id)
        // Other metadata survived the spread-merge write.
        expect(updated?.metadata).toMatchObject({
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            name: 'work session',
            codexProvider: 'litellm'
        })
        // Server-owned flag untouched by the metadata write.
        expect(updated?.automationPaused).toBe(true)
        // Model column untouched (metadata write never touches model).
        expect(updated?.model).toBe(before.model)
        const stored = store.sessions.getSession(session.id)
        expect(stored?.automationPaused).toBe(true)
        store.close()
    })

    it('provider survives a full cache refresh and a cold store re-open', () => {
        const { store, cache, session } = createHarness('durable')
        cache.setCodexProvider(session.id, 'tokenmax')

        // Warm-cache refresh.
        const refreshed = cache.refreshSession(session.id)
        expect(refreshed?.metadata?.codexProvider).toBe('tokenmax')

        // Cold-cache hydrate over the same store (as after a hub restart).
        const events: SyncEvent[] = []
        const coldCache = new SessionCache(store, createPublisher(events))
        const hydrated = coldCache.refreshSession(session.id)
        expect(hydrated?.metadata?.codexProvider).toBe('tokenmax')
        store.close()
    })

    it('emits a session-updated broadcast after the write', () => {
        const { store, events, cache, session } = createHarness('emit')
        events.length = 0

        cache.setCodexProvider(session.id, 'closeai')

        const emitted = events.filter((event) => event.type === 'session-updated')
        expect(emitted.length).toBeGreaterThanOrEqual(1)
        const last = emitted[emitted.length - 1] as Extract<SyncEvent, { type: 'session-updated' }>
        // Full-session refresh broadcast carries the new metadata value. The
        // patch data is a union (structured patch | full session), so narrow
        // through a Record read rather than assuming one arm.
        const lastData = last.data as Record<string, unknown> | undefined
        expect((lastData?.metadata as Record<string, unknown> | undefined)?.codexProvider).toBe('closeai')
        store.close()
    })

    it('trims the provider value before persisting', () => {
        const { store, cache, session } = createHarness('trim')
        cache.setCodexProvider(session.id, '  tokenmax  ')

        const stored = store.sessions.getSession(session.id)
        expect(stored?.metadata).toMatchObject({ codexProvider: 'tokenmax' })
        // Whitespace-only input is the default-provider sentinel after trim.
        cache.setCodexProvider(session.id, '   ')
        expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ codexProvider: '' })
        store.close()
    })
})
