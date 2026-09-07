import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

/**
 * V26→V27 migration: adds sessions.automation_paused (durable human-takeover
 * flag) with a self-heal back-fill of sessions.model_reasoning_effort for
 * pre-fork 3010 databases whose custom v7 step consumed the official v7 slot.
 *
 * Three database shapes must all land on v27 with both columns present:
 *   1. legacy custom v7   — automation_paused EXISTS, model_reasoning_effort
 *                           MISSING, carries live rows incl. pause=true
 *   2. official v26       — neither pause column nor gap
 *   3. fresh database     — createSchema builds the full table directly
 */

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function tempDbPath(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v27-${label}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

function userVersion(db: Database): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function sessionColumns(db: Database): Set<string> {
    return new Set(
        (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
    )
}

function messageColumns(db: Database): Set<string> {
    return new Set(
        (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((row) => row.name)
    )
}

/** v6→v26 shape as the official ladder built it, minus the v27 column. */
function createOfficialV26Schema(db: Database): void {
    db.exec(`
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
            pinned INTEGER NOT NULL DEFAULT 0,
            global_pinned INTEGER NOT NULL DEFAULT 0,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            invoked_at INTEGER,
            scheduled_at INTEGER,
            delivery_state TEXT NOT NULL DEFAULT 'queued',
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_messages_session ON messages(session_id, seq);
        CREATE TABLE message_epochs (
            session_id TEXT PRIMARY KEY,
            epoch INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );
        CREATE TABLE push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
        CREATE TABLE fcm_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            token TEXT NOT NULL,
            platform TEXT NOT NULL,
            device_id TEXT NOT NULL,
            push_key TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(namespace, device_id, platform)
        );
        CREATE TABLE session_scratchlist (
            session_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            attachments TEXT DEFAULT NULL,
            PRIMARY KEY (session_id, entry_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE usage_events (
            session_id TEXT NOT NULL,
            source_key TEXT NOT NULL,
            source_seq INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            agent TEXT NOT NULL,
            model TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('delta', 'cumulative')),
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            last_input_tokens INTEGER,
            last_output_tokens INTEGER,
            last_cache_read_tokens INTEGER,
            last_cache_creation_tokens INTEGER,
            PRIMARY KEY (session_id, source_key),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE usage_scan_state (
            session_id TEXT PRIMARY KEY,
            message_epoch INTEGER NOT NULL DEFAULT 0,
            last_seq INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE events (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            source_kind TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            sink_kind TEXT,
            sink_ref TEXT,
            event_type TEXT NOT NULL,
            summary TEXT,
            payload_json TEXT,
            artifact_refs TEXT NOT NULL DEFAULT '[]',
            tags TEXT NOT NULL DEFAULT '[]',
            related_session_id TEXT,
            related_event_id TEXT,
            provenance TEXT,
            idempotency_key TEXT,
            dedupe_key TEXT,
            confidence REAL,
            severity TEXT,
            expires_at INTEGER,
            namespace TEXT NOT NULL,
            principal_json TEXT NOT NULL
        );
        CREATE TABLE event_links (
            id TEXT PRIMARY KEY,
            from_event_id TEXT NOT NULL,
            to_event_id TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            metadata_json TEXT,
            namespace TEXT NOT NULL,
            FOREIGN KEY (from_event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY (to_event_id) REFERENCES events(id) ON DELETE CASCADE
        );
    `)
}

/**
 * Legacy pre-fork 3010 shape: the custom v6→v7 WIP used the v7 slot for
 * automation_paused, so the table carries the pause column but NOT the
 * official model_reasoning_effort. Mirrors the audited production DB
 * (user_version=7, 20 session columns, automation_paused present, reasoning
 * column missing) — data-bearing rows included.
 */
function createLegacyCustomV7Schema(db: Database): void {
    db.exec(`
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
            effort TEXT,
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            automation_paused INTEGER NOT NULL DEFAULT 0,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_messages_session ON messages(session_id, seq);
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );
        CREATE TABLE push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
    `)
}

function seedLegacyRows(db: Database): void {
    db.exec(`INSERT INTO sessions (
        id, tag, namespace, machine_id, created_at, updated_at,
        metadata, metadata_version, agent_state, agent_state_version,
        model, effort, automation_paused, active, active_at, seq
    ) VALUES (
        'legacy-s1', 'legacy-tag', 'default', NULL, 1000, 5000,
        '{"path":"/tmp/project","host":"localhost"}', 3, NULL, 1,
        'gpt-5', 'high', 1, 0, 5000, 7
    )`)
    db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
             VALUES ('legacy-m1', 'legacy-s1', '"first"', 1100, 1, 'local-1')`)
    db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
             VALUES ('legacy-m2', 'legacy-s1', '"second"', 1200, 2, 'local-2')`)
}

function seedOfficialRows(db: Database): void {
    db.exec(`INSERT INTO sessions (
        id, tag, namespace, machine_id, created_at, updated_at,
        metadata, metadata_version, agent_state, agent_state_version,
        model, model_reasoning_effort, effort, service_tier,
        pinned, global_pinned, active, active_at, seq
    ) VALUES (
        'official-s1', 'official-tag', 'default', NULL, 2000, 6000,
        '{"path":"/tmp/other","host":"remote"}', 2, NULL, 1,
        'gpt-5.4', 'medium', NULL, NULL,
        0, 0, 0, 6000, 9
    )`)
    db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, delivery_state)
             VALUES ('official-m1', 'official-s1', '"hello"', 2100, 1, 'local-a', 2100, 'queued')`)
}

describe('Store V26→V27 migration: automation_paused + model_reasoning_effort self-heal', () => {
    it('fresh DB: createSchema includes automation_paused, version stamped 27', () => {
        const dbPath = tempDbPath('fresh')
        const store = new Store(dbPath)
        try {
            const db = (store as unknown as { db: Database }).db
            // v28 ladder continues past the v27 step; the v27 columns are
            // still present after the full climb.
            expect(userVersion(db)).toBe(28)
            expect(sessionColumns(db)).toContain('automation_paused')
            expect(sessionColumns(db)).toContain('model_reasoning_effort')
            // New rows start unpaused: DEFAULT 0 on the column.
            const session = store.sessions.getOrCreateSession('fresh-tag', { path: '/p' }, null, 'default')
            const raw = db.prepare('SELECT automation_paused FROM sessions WHERE id = ?').get(session.id) as { automation_paused: number }
            expect(raw.automation_paused).toBe(0)
        } finally {
            store.close()
        }
    })

    it('official v26 DB migrates to v27: automation_paused added, rows preserved', () => {
        const dbPath = tempDbPath('official-v26')

        const seed = new Database(dbPath, { create: true, readwrite: true, strict: true })
        createOfficialV26Schema(seed)
        seedOfficialRows(seed)
        seed.exec('PRAGMA user_version = 26')
        seed.close()

        const store = new Store(dbPath)
        try {
            const db = (store as unknown as { db: Database }).db
            expect(userVersion(db)).toBe(28)
            const columns = sessionColumns(db)
            expect(columns).toContain('automation_paused')
            // Reasoning column was already there — self-heal must not disturb it.
            expect(columns).toContain('model_reasoning_effort')

            // Historical row untouched: content, seq, and the official v7 column value.
            const message = db.prepare('SELECT content, seq, invoked_at FROM messages WHERE id = ?').get('official-m1') as { content: string; seq: number; invoked_at: number }
            expect(message).toEqual({ content: '"hello"', seq: 1, invoked_at: 2100 })
            const session = db.prepare('SELECT model, model_reasoning_effort, seq FROM sessions WHERE id = ?').get('official-s1') as { model: string; model_reasoning_effort: string; seq: number }
            expect(session).toEqual({ model: 'gpt-5.4', model_reasoning_effort: 'medium', seq: 9 })
            // v26 rows had no pause concept — upgraded default is false.
            const paused = db.prepare('SELECT automation_paused FROM sessions WHERE id = ?').get('official-s1') as { automation_paused: number }
            expect(paused.automation_paused).toBe(0)
            // Ladder-added message columns still present after the hop.
            const messages = messageColumns(db)
            expect(messages).toContain('invoked_at')
            expect(messages).toContain('scheduled_at')
            expect(messages).toContain('delivery_state')
        } finally {
            store.close()
        }
    })

    it('legacy custom v7 DB (pause column, no reasoning column) climbs the full ladder to v27', () => {
        const dbPath = tempDbPath('legacy-v7')

        const seed = new Database(dbPath, { create: true, readwrite: true, strict: true })
        createLegacyCustomV7Schema(seed)
        seedLegacyRows(seed)
        seed.exec('PRAGMA user_version = 7')
        seed.close()

        const store = new Store(dbPath)
        try {
            const db = (store as unknown as { db: Database }).db
            expect(userVersion(db)).toBe(28)
            const columns = sessionColumns(db)
            // The missing official v7 column was back-filled by the v27 step.
            expect(columns).toContain('model_reasoning_effort')
            // The pre-existing pause column survived the ladder unchanged.
            expect(columns).toContain('automation_paused')

            // Session history preserved: pause state, seq, metadata, model.
            const session = db.prepare('SELECT automation_paused, seq, metadata, model, effort FROM sessions WHERE id = ?').get('legacy-s1') as { automation_paused: number; seq: number; metadata: string; model: string; effort: string }
            expect(session.automation_paused).toBe(1)
            expect(session.seq).toBe(7)
            expect(JSON.parse(session.metadata)).toEqual({ path: '/tmp/project', host: 'localhost' })
            expect(session.model).toBe('gpt-5')
            expect(session.effort).toBe('high')

            // Message history preserved: content + seq + local_id, ladder-added columns filled.
            const messages = db.prepare('SELECT id, content, seq, local_id, invoked_at FROM messages ORDER BY seq').all() as Array<{ id: string; content: string; seq: number; local_id: string; invoked_at: number }>
            expect(messages).toEqual([
                { id: 'legacy-m1', content: '"first"', seq: 1, local_id: 'local-1', invoked_at: 1100 },
                { id: 'legacy-m2', content: '"second"', seq: 2, local_id: 'local-2', invoked_at: 1200 }
            ])

            // Raw-column verification only: the StoredSession mapping for
            // automation_paused lands in the next step (store/sessions.ts),
            // so this migration test must not depend on it yet.
            expect(db.prepare('SELECT automation_paused FROM sessions WHERE id = ?').get('legacy-s1')).toEqual({ automation_paused: 1 })
        } finally {
            store.close()
        }
    })

    it('reopening a migrated DB is idempotent (no re-ALTER, version stable)', () => {
        const dbPath = tempDbPath('reopen')

        const seed = new Database(dbPath, { create: true, readwrite: true, strict: true })
        createLegacyCustomV7Schema(seed)
        seedLegacyRows(seed)
        seed.exec('PRAGMA user_version = 7')
        seed.close()

        const first = new Store(dbPath)
        first.close()

        const second = new Store(dbPath)
        try {
            const db = (second as unknown as { db: Database }).db
            expect(userVersion(db)).toBe(28)
            // Still exactly one automation_paused / model_reasoning_effort column.
            const names = [...sessionColumns(db)]
            expect(names.filter((name) => name === 'automation_paused')).toHaveLength(1)
            expect(names.filter((name) => name === 'model_reasoning_effort')).toHaveLength(1)
            // Data intact after the second open.
            const session = db.prepare('SELECT automation_paused, seq FROM sessions WHERE id = ?').get('legacy-s1') as { automation_paused: number; seq: number }
            expect(session.automation_paused).toBe(1)
            expect(session.seq).toBe(7)
            expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).toEqual({ count: 2 })
        } finally {
            second.close()
        }
    })
})
