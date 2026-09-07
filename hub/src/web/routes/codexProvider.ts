import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { SyncEngine } from '../../sync/syncEngine'
import { requireSessionFromParam, requireSyncEngine } from './guards'

/**
 * POST /api/sessions/:id/codex-provider
 *
 * Runtime Codex provider switch: archives an active session, persists the
 * provider (empty string = Codex default, which also clears the profile),
 * and reopens it on the new provider. Inactive sessions get the config
 * change only. Errors from the engine surface as-is (409 like the other
 * session-config endpoints: flavor/local-session rejections, archive or
 * reopen failures, concurrent-switch contention).
 *
 * Route contract mirrors 3008 (3008-compatible body shape) so the hapi-control
 * MCP bridge's change_codex_provider tool works against this hub unchanged.
 */

const codexProviderBodySchema = z.object({
    // null / '' selects Codex's default provider; otherwise a provider name
    // (from GET /api/machines/:id/codex-models). Trimmed before use; the
    // schema mirrors 3008's trim+max(255).
    provider: z.string().trim().max(255).nullable()
})

export function createCodexProviderRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/codex-provider', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Namespace guard: resolveSessionAccess inside the engine enforces
        // the caller's namespace (c.get('namespace')); the route-level
        // requireSessionFromParam gives the same 403/404 surface as every
        // other session endpoint.
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: false })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = codexProviderBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.changeCodexProvider(sessionResult.sessionId, c.get('namespace'), parsed.data.provider)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to change Codex provider'
            return c.json({ error: message }, 409)
        }
    })

    return app
}
