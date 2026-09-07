import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createAutomationOutputRoutes } from './automationOutput'

/**
 * Real Hono + real Store (in-memory) tests for the automation-output cursor.
 * The sync engine is mocked only at resolveSessionAccess (the same guard the
 * route uses in production); message rows go through the real SQL layer.
 */

function createSession(overrides?: Partial<Session>): Session {
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }
    return { ...base, ...overrides }
}

function createApp(store: Store, session: Session, namespace = 'default'): Hono<WebAppEnv> {
    const engine = {
        resolveSessionAccess: (sessionId: string, requestNamespace: string) => {
            if (session.namespace !== requestNamespace) {
                return { ok: false as const, reason: 'access-denied' as const }
            }
            if (sessionId !== session.id) {
                return { ok: false as const, reason: 'not-found' as const }
            }
            return { ok: true as const, sessionId, session }
        }
    } as Partial<SyncEngine>
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createAutomationOutputRoutes({
        store,
        getSyncEngine: () => engine as SyncEngine
    }))
    return app
}

/** Seed a message; returns its row through the real insert path. */
function seed(store: Store, sessionId: string, seq: number, text: string, createdAt = seq): void {
    // addMessage assigns seq itself (MAX(seq)+1); insert in the desired order
    // so seq lands 1..N. createdAt can be forced out of order for the
    // unordered-createdAt test.
    store.messages.addMessage(
        sessionId,
        { role: 'user', content: { type: 'text', text } },
        undefined,
        null,
        createdAt
    )
}

function withStore(session: Session, fn: (app: Hono<WebAppEnv>, store: Store) => Promise<void>): Promise<void> {
    const store = new Store(':memory:')
    // tag = session.id, requestedId = session.id — the tag is the stable key
    // and the requested id pins the row's id to what the engine mock returns.
    store.sessions.getOrCreateSession(session.id, session.metadata, null, session.namespace, undefined, undefined, undefined, session.id)
    return fn(createApp(store, session), store).finally(() => store.close())
}

describe('GET /api/sessions/:id/automation/output', () => {
    it('no cursor (afterSeq absent) returns the LAST N rows ascending, not the first', async () => {
        await withStore(createSession(), async (app, store) => {
            const total = 25
            for (let i = 1; i <= total; i++) seed(store, 'session-1', i, `msg-${i}`)

            const response = await app.request('/api/sessions/session-1/automation/output?limit=4')

            expect(response.status).toBe(200)
            const body = await response.json() as { messages: Array<{ seq: number }>; afterSeq: number | null; lastSeq: number | null; more: boolean }
            expect(body.messages.map((m) => m.seq)).toEqual([22, 23, 24, 25])
            expect(body.afterSeq).toBeNull()
            expect(body.lastSeq).toBe(25)
            // Tail mode's `more` means "older history exists before this
            // page" — 21 rows precede the returned tail, so true.
            expect(body.more).toBe(true)
        })
    })

    it('same 25-row dataset: afterSeq=0 returns the FIRST N rows, distinguishing the two modes', async () => {
        await withStore(createSession(), async (app, store) => {
            const total = 25
            for (let i = 1; i <= total; i++) seed(store, 'session-1', i, `msg-${i}`)

            const response = await app.request('/api/sessions/session-1/automation/output?afterSeq=0&limit=4')

            expect(response.status).toBe(200)
            const body = await response.json() as { messages: Array<{ seq: number }>; afterSeq: number; lastSeq: number | null; more: boolean }
            expect(body.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4])
            expect(body.afterSeq).toBe(0)
            expect(body.lastSeq).toBe(4)
            expect(body.more).toBe(true)
        })
    })

    it('tail mode with out-of-order createdAt still returns the newest N by seq', async () => {
        await withStore(createSession(), async (app, store) => {
            const total = 25
            // Scrambled createdAt: decreasing timestamps as seq increases, so
            // the highest-seq rows have the LOWEST created_at. A tail that
            // ordered by created_at would return the wrong rows entirely.
            for (let i = 1; i <= total; i++) seed(store, 'session-1', i, `msg-${i}`, 100_000 - i * 10)

            const response = await app.request('/api/sessions/session-1/automation/output?limit=4')

            expect(response.status).toBe(200)
            const body = await response.json() as {
                messages: Array<{ seq: number; createdAt: number; content: { content: { text: string } } }>
            }
            expect(body.messages.map((m) => m.seq)).toEqual([22, 23, 24, 25])
            expect(body.messages.map((m) => m.content.content.text)).toEqual(['msg-22', 'msg-23', 'msg-24', 'msg-25'])
            // Proof the tail is seq-ordered, not createdAt-ordered: these rows
            // carry the smallest timestamps in the dataset.
            expect(Math.max(...body.messages.map((m) => m.createdAt))).toBeLessThan(
                Math.min(...Array.from({ length: 21 }, (_, i) => 100_000 - (i + 1) * 10))
            )
        })
    })

    it('afterSeq=0 returns messages from the start, ascending', async () => {
        await withStore(createSession(), async (app, store) => {
            for (let i = 1; i <= 5; i++) seed(store, 'session-1', i, `msg-${i}`)

            const response = await app.request('/api/sessions/session-1/automation/output?afterSeq=0&limit=10')

            expect(response.status).toBe(200)
            const body = await response.json() as { messages: Array<{ seq: number }>; afterSeq: number; lastSeq: number | null; more: boolean }
            expect(body.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
            expect(body.afterSeq).toBe(0)
            expect(body.lastSeq).toBe(5)
            expect(body.more).toBe(false)
        })
    })

    it('paging with limit < total walks the full history with no gaps and no repeats', async () => {
        await withStore(createSession(), async (app, store) => {
            const total = 25
            for (let i = 1; i <= total; i++) seed(store, 'session-1', i, `msg-${i}`)

            const seen: number[] = []
            let cursor = 0
            let pages = 0
            for (;;) {
                const response = await app.request(`/api/sessions/session-1/automation/output?afterSeq=${cursor}&limit=4`)
                expect(response.status).toBe(200)
                const body = await response.json() as { messages: Array<{ seq: number }>; more: boolean }
                seen.push(...body.messages.map((m) => m.seq))
                pages += 1
                if (!body.more || body.messages.length === 0) break
                cursor = body.messages[body.messages.length - 1].seq
                expect(pages).toBeLessThan(20) // no runaway
            }

            expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1))
            expect(pages).toBe(7) // 25 rows / 4 per page = 6 full + 1 short
        })
    })

    it('empty result at the tip', async () => {
        await withStore(createSession(), async (app, store) => {
            for (let i = 1; i <= 3; i++) seed(store, 'session-1', i, `msg-${i}`)

            const response = await app.request('/api/sessions/session-1/automation/output?afterSeq=3&limit=10')

            expect(response.status).toBe(200)
            const body = await response.json() as { messages: unknown[]; lastSeq: null; more: boolean }
            expect(body.messages).toEqual([])
            expect(body.lastSeq).toBeNull()
            expect(body.more).toBe(false)
        })
    })

    it('skips over gaps left by deleted rows (cursor is a seq watermark, not a position)', async () => {
        await withStore(createSession(), async (app, store) => {
            for (let i = 1; i <= 6; i++) seed(store, 'session-1', i, `msg-${i}`)
            // Delete by localId path is not available here (no localIds seeded);
            // delete through the store's transactional cancel path requires queued
            // state. Use the raw db through the documented store surface instead:
            // messages are keyed by seq, and cancelQueuedMessage covers deletes of
            // queued rows. For a hard delete we exercise the SQL directly.
            const rawDelete = (store as unknown as { db: { exec: (sql: string) => void } }).db
            rawDelete.exec("DELETE FROM messages WHERE seq IN (3, 4)")

            const response = await app.request('/api/sessions/session-1/automation/output?afterSeq=2&limit=10')

            expect(response.status).toBe(200)
            const body = await response.json() as { messages: Array<{ seq: number }> }
            // Rows 3 and 4 are gone; the cursor at 2 jumps the gap to 5, 6 —
            // no error, no phantom rows, nothing lost.
            expect(body.messages.map((m) => m.seq)).toEqual([5, 6])
        })
    })

    it('out-of-order createdAt does not lose or reorder data (seq is the order)', async () => {
        await withStore(createSession(), async (app, store) => {
            // Insert with deliberately scrambled createdAt: each message's
            // created_at decreases as seq increases.
            for (let i = 1; i <= 5; i++) seed(store, 'session-1', i, `msg-${i}`, 1000 - i * 10)

            const response = await app.request('/api/sessions/session-1/automation/output?afterSeq=0&limit=10')

            expect(response.status).toBe(200)
            const body = await response.json() as {
                messages: Array<{ seq: number; createdAt: number; content: { content: { text: string } } }>
            }
            // Ascending seq regardless of createdAt ordering.
            expect(body.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
            expect(body.messages.map((m) => m.content.content.text)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'])
        })
    })

    it('rejects access from a different namespace', async () => {
        await withStore(createSession(), async (app) => {
            const response = await app.request('/api/sessions/session-1/automation/output?afterSeq=0', {
                headers: { 'x-namespace': 'other' }
            })

            // The middleware in createApp pins the namespace; simulate the
            // cross-tenant case by rebuilding the app under another namespace.
            const otherApp = createApp(new Store(':memory:'), createSession({ id: 'session-1', namespace: 'other' }), 'tenant')
            const denied = await otherApp.request('/api/sessions/session-1/automation/output?afterSeq=0')

            expect(response.status).toBe(200)
            expect(denied.status).toBe(403)
            expect(await denied.json()).toEqual({ error: 'Session access denied' })
        })
    })

    it('404s for an unknown session', async () => {
        await withStore(createSession(), async (app) => {
            const response = await app.request('/api/sessions/nope/automation/output?afterSeq=0')

            expect(response.status).toBe(404)
        })
    })

    it('validates query params', async () => {
        await withStore(createSession(), async (app) => {
            const badAfter = await app.request('/api/sessions/session-1/automation/output?afterSeq=-1')
            expect(badAfter.status).toBe(400)

            const badLimit = await app.request('/api/sessions/session-1/automation/output?limit=abc')
            expect(badLimit.status).toBe(400)
        })
    })
})
