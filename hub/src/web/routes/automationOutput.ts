import { Hono } from 'hono'
import type { DecryptedMessage } from '@hapi/protocol'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { StoredMessage } from '../../store/types'
import { requireSessionFromParam } from './guards'

/**
 * Automation-output cursor endpoint for the hapi-control MCP bridge.
 *
 * GET /api/sessions/:id/automation/output?afterSeq=0&limit=N
 *
 * The generic /messages endpoint's cursor mode is position-based
 * (afterAt + afterSeq together, seq >= 1) for the web pagination protocol;
 * the MCP bridge's poll loop only has a seq watermark, so it gets a dedicated
 * endpoint with the old single-parameter contract. Namespace isolation goes
 * through the same requireSessionFromParam guard as every other session
 * route. Response shape matches DecryptedMessage (the format the bridge
 * already parses).
 *
 * Two modes:
 *  - Tail (afterSeq ABSENT): the newest `limit` rows by seq, ascending.
 *  - Cursor (afterSeq present, >= 0): rows with seq > afterSeq, ascending,
 *    starting from the oldest when afterSeq = 0. Gaps from deleted rows are
 *    skipped — the cursor is a seq watermark, not a position. Out-of-order
 *    created_at never matters: seq is the insert order.
 *
 * Both modes are SQL-bounded (never read-all-then-slice). `more` is exact:
 * each mode reads LIMIT (limit + 1) rows, drops the overflow row, and reports
 * whether it existed.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function toDecryptedMessage(message: StoredMessage): DecryptedMessage {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        content: message.content,
        createdAt: message.createdAt,
        invokedAt: message.invokedAt,
        scheduledAt: message.scheduledAt,
        ...(message.deliveryState ? { deliveryState: message.deliveryState } : {})
    }
}

/** Parse a positive integer query param; NaN signals invalid. */
function parseIntParam(value: string | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min) return NaN
    return Math.min(parsed, max)
}

export function createAutomationOutputRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/automation/output', (c) => {
        const engine = options.getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const limit = parseIntParam(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
        if (Number.isNaN(limit)) {
            return c.json({ error: 'limit must be a positive integer' }, 400)
        }

        // afterSeq distinguishes the two modes: ABSENT = tail (newest N),
        // present (>= 0) = forward cursor. 0 is a valid "start of history".
        const afterSeqRaw = c.req.query('afterSeq')
        const cursorMode = afterSeqRaw !== undefined && afterSeqRaw !== ''
        let afterSeq: number | null = null
        if (cursorMode) {
            const parsed = Number(afterSeqRaw)
            if (!Number.isInteger(parsed) || parsed < 0) {
                return c.json({ error: 'afterSeq must be a non-negative integer' }, 400)
            }
            afterSeq = parsed
        }

        // LIMIT (limit + 1): an extra row proves there is more beyond this
        // page. Which row is the overflow depends on the mode — the tail
        // query returns the newest rows first-in-last in ascending order, so
        // its overflow is the OLDEST row; the cursor query's overflow is the
        // newest. Drop the right one before responding.
        const overread = limit + 1
        const rows = afterSeq === null
            ? options.store.messages.getMessagesLastBySeqLimit(sessionId, overread)
            : options.store.messages.getMessagesAfterSeqLimit(sessionId, afterSeq, overread)
        const more = rows.length > limit
        const messages = more
            ? (afterSeq === null ? rows.slice(-limit) : rows.slice(0, limit))
            : rows

        const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : null

        return c.json({
            messages: messages.map(toDecryptedMessage),
            afterSeq,
            limit,
            lastSeq,
            more
        })
    })

    return app
}
