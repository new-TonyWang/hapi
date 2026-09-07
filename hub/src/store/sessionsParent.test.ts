import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

/**
 * v28 sessions.parent_session_id foundation: durable parent→child chain.
 *   - schema: column + partial index exist on fresh and migrated DBs
 *   - getOrCreateSession persists the link at insert time
 *   - StoredSession round-trips parentSessionId (null when unset)
 *   - getSessionChildren: namespace-scoped, oldest-first
 *   - setSessionParent: namespace-guarded set/clear, null on foreign child
 *   - v27→v28 ladder adds the column to a stamped v27 DB
 */

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function freshStore(): Store {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-sessions-parent-'))
    tempDirs.push(dir)
    return new Store(join(dir, 'hapi.db'))
}

function createParent(store: Store, namespace = 'default'): string {
    return store.sessions.getOrCreateSession(
        `parent-${namespace}`,
        { path: '/tmp/project', host: 'localhost' },
        null,
        namespace
    ).id
}

describe('sessions parent_session_id (v28)', () => {
    it('fresh schema has the column and the partial index', () => {
        const store = freshStore()
        try {
            const db = (store as unknown as { db: Database }).db
            const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name)
            expect(columns).toContain('parent_session_id')
            const index = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_parent'"
            ).get() as { name: string } | undefined
            expect(index?.name).toBe('idx_sessions_parent')
        } finally {
            store.close()
        }
    })

    it('getOrCreateSession persists parentSessionId at insert; round-trips in StoredSession', () => {
        const store = freshStore()
        try {
            const parentId = createParent(store)
            const child = store.sessions.getOrCreateSession(
                `child-of-${parentId}`,
                { path: '/tmp/project', host: 'localhost' },
                null,
                'default',
                undefined,
                undefined,
                undefined,
                undefined,
                parentId
            )
            expect(child.parentSessionId).toBe(parentId)

            // Durable: re-read from the store.
            const reread = store.sessions.getSession(child.id)
            expect(reread?.parentSessionId).toBe(parentId)

            // Unset sessions read null (not undefined) through the row mapper.
            const lone = store.sessions.getOrCreateSession('lone-session', { path: '/tmp', host: 'h' }, null, 'default')
            expect(lone.parentSessionId).toBeNull()
        } finally {
            store.close()
        }
    })

    it('getSessionChildren lists children namespace-scoped, oldest-first', () => {
        const store = freshStore()
        try {
            const parentId = createParent(store)
            const childA = store.sessions.getOrCreateSession('child-a', { path: '/tmp', host: 'h' }, null, 'default', undefined, undefined, undefined, undefined, parentId)
            const childB = store.sessions.getOrCreateSession('child-b', { path: '/tmp', host: 'h' }, null, 'default', undefined, undefined, undefined, undefined, parentId)
            // Both created in the same millisecond: the store's tiebreak is
            // (created_at ASC, id ASC), so the deterministic expectation is
            // id-sorted, not insertion-sorted.
            const expected = [childA.id, childB.id].sort()

            const children = store.sessions.getSessionChildren(parentId, 'default')
            expect(children.map((child) => child.id)).toEqual(expected)
            // Session with NO parent must not leak in.
            store.sessions.getOrCreateSession('orphan-session', { path: '/tmp', host: 'h' }, null, 'default')
            expect(store.sessions.getSessionChildren(parentId, 'default').map((child) => child.id)).toEqual(expected)

            // A same-namespace session with a DIFFERENT parent must not leak in.
            store.sessions.getOrCreateSession('other-child', { path: '/tmp', host: 'h' }, null, 'default', undefined, undefined, undefined, undefined, 'some-other-parent')
            expect(store.sessions.getSessionChildren(parentId, 'default').map((child) => child.id)).toEqual(expected)
        } finally {
            store.close()
        }
    })

    it('cross-namespace children are invisible to the default namespace query', () => {
        const store = freshStore()
        try {
            const parentId = createParent(store)
            const tenantChild = store.sessions.getOrCreateSession('tenant-only-child', { path: '/tmp', host: 'h' }, null, 'tenant', undefined, undefined, undefined, undefined, parentId)

            const defaultView = store.sessions.getSessionChildren(parentId, 'default')
            expect(defaultView).toEqual([])

            const tenantView = store.sessions.getSessionChildren(parentId, 'tenant')
            expect(tenantView.map((child) => child.id)).toEqual([tenantChild.id])
        } finally {
            store.close()
        }
    })

    it('setSessionParent sets and clears, namespace-guarded', () => {
        const store = freshStore()
        try {
            const parentId = createParent(store)
            const child = store.sessions.getOrCreateSession('linkable-child', { path: '/tmp', host: 'h' }, null, 'default')
            expect(child.parentSessionId).toBeNull()

            // Set: default-namespace write lands.
            const linked = store.sessions.setSessionParent(child.id, parentId, 'default')
            expect(linked?.parentSessionId).toBe(parentId)

            // Foreign-namespace write finds no row (child lives in 'default').
            expect(store.sessions.setSessionParent(child.id, parentId, 'tenant')).toBeNull()

            // Unknown child id: null, no write.
            expect(store.sessions.setSessionParent('no-such-row', parentId, 'default')).toBeNull()

            // Clear: back to null.
            const cleared = store.sessions.setSessionParent(child.id, null, 'default')
            expect(cleared?.parentSessionId).toBeNull()
            // And the partial index query no longer returns it.
            expect(store.sessions.getSessionChildren(parentId, 'default')).toEqual([])
        } finally {
            store.close()
        }
    })

    it('v27-stamped DB migrates to v28 and gains the column', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-sessions-parent-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const seed = new Database(dbPath, { create: true, readwrite: true, strict: true })
        // Minimal v27 shape: sessions table WITHOUT parent_session_id, stamped 27.
        seed.exec(`
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                namespace TEXT NOT NULL DEFAULT 'default',
                machine_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                agent_state TEXT,
                agent_state_version INTEGER DEFAULT 1,
                model TEXT,
                model_reasoning_effort TEXT,
                effort TEXT,
                service_tier TEXT,
                todos TEXT,
                todos_updated_at INTEGER,
                team_state TEXT,
                team_state_updated_at INTEGER,
                automation_paused INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                global_pinned INTEGER NOT NULL DEFAULT 0,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
        `)
        seed.exec('PRAGMA user_version = 27')
        seed.close()

        const store = new Store(dbPath)
        try {
            const db = (store as unknown as { db: Database }).db
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(28)
            const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name)
            expect(columns).toContain('parent_session_id')
            // Row writes work post-migration.
            const created = store.sessions.getOrCreateSession('post-v28', { path: '/tmp', host: 'h' }, null, 'default')
            expect(created.parentSessionId).toBeNull()
        } finally {
            store.close()
        }
    })
})
