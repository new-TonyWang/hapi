import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Store } from './index'

/**
 * automationPaused persistence at the store layer.
 *
 * The column landed via the v26→v27 migration (see migration-v27.test.ts);
 * these tests cover the read/write surface only: default-false on create,
 * pause/resume round-trip, reopen durability, namespace isolation, and the
 * not-found result shape. All databases are temp files; the production DB
 * is never touched.
 */

function tempStore(label: string): { store: Store; dbPath: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), `hapi-pause-store-${label}-`))
    const dbPath = join(dir, 'test.db')
    const store = new Store(dbPath)
    return {
        store,
        dbPath,
        cleanup: () => {
            store.close()
        }
    }
}

describe('Store automationPaused', () => {
    it('defaults to false for new sessions', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('pause-default', { path: '/p' }, null, 'default')
            expect(session.automationPaused).toBe(false)
            expect(store.sessions.getSession(session.id)?.automationPaused).toBe(false)
            expect(store.sessions.getSessionByNamespace(session.id, 'default')?.automationPaused).toBe(false)
        } finally {
            store.close()
        }
    })

    it('persists pause and resume, visible on reopen', () => {
        const { store, dbPath, cleanup } = tempStore('roundtrip')
        // Pin the row id so every reopen resolves the exact same row.
        const sessionId = randomUUID()
        try {
            const session = store.sessions.getOrCreateSession(
                'pause-roundtrip', { path: '/p' }, null, 'default',
                undefined, undefined, undefined, sessionId
            )
            expect(session.id).toBe(sessionId)

            const paused = store.sessions.setSessionAutomationPaused(session.id, true, 'default')
            expect(paused?.automationPaused).toBe(true)

            const resumed = store.sessions.setSessionAutomationPaused(session.id, false, 'default')
            expect(resumed?.automationPaused).toBe(false)

            const rePaused = store.sessions.setSessionAutomationPaused(sessionId, true, 'default')
            expect(rePaused?.id).toBe(sessionId)
            expect(rePaused?.automationPaused).toBe(true)
        } finally {
            cleanup()
        }

        const reopened = new Store(dbPath)
        try {
            expect(reopened.sessions.getSession(sessionId)?.automationPaused).toBe(true)

            reopened.sessions.setSessionAutomationPaused(sessionId, false, 'default')
        } finally {
            reopened.close()
        }

        const third = new Store(dbPath)
        try {
            expect(third.sessions.getSession(sessionId)?.automationPaused).toBe(false)
        } finally {
            third.close()
        }
        rmSync(dirname(dbPath), { recursive: true, force: true })
    })

    it('repeated writes to the same value are idempotent and still return the session', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('pause-idempotent', { path: '/p' }, null, 'default')
            const first = store.sessions.setSessionAutomationPaused(session.id, true, 'default')
            const second = store.sessions.setSessionAutomationPaused(session.id, true, 'default')
            expect(first?.automationPaused).toBe(true)
            expect(second?.automationPaused).toBe(true)
            expect(second?.id).toBe(session.id)
            expect(store.sessions.getSession(session.id)?.automationPaused).toBe(true)
        } finally {
            store.close()
        }
    })

    it('rejects writes from another namespace: null result, flag unchanged, seq not bumped', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('pause-isolated', { path: '/p' }, null, 'alpha')
            const before = store.sessions.getSession(session.id)

            const result = store.sessions.setSessionAutomationPaused(session.id, true, 'beta')

            expect(result).toBeNull()
            const after = store.sessions.getSession(session.id)
            expect(after?.automationPaused).toBe(false)
            // No write landed: seq and updatedAt untouched by the rejected call.
            expect(after?.seq).toBe(before?.seq)
            expect(after?.updatedAt).toBe(before?.updatedAt)
        } finally {
            store.close()
        }
    })

    it('returns null for a missing session id', () => {
        const store = new Store(':memory:')
        try {
            expect(store.sessions.setSessionAutomationPaused('no-such-session', true, 'default')).toBeNull()
            expect(store.sessions.setSessionAutomationPaused('no-such-session', false, 'default')).toBeNull()
        } finally {
            store.close()
        }
    })
})
