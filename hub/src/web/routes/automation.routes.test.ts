/**
 * Route tests for the automation pause/resume surface:
 * - POST /sessions/:id/stop-automation     (ordered pause + abort)
 * - POST /sessions/:id/pause-automation
 * - POST /sessions/:id/resume-automation
 * - POST /sessions/:id/automation/messages (409 automation_paused while paused)
 *
 * Covers: success shapes, 409 mapping, human /messages passing while paused
 * (never implicitly resuming), namespace guard 403, and real errors as 500.
 */
import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { AutomationPausedError, type SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'
import { createSessionsRoutes } from './sessions'

// ---------------------------------------------------------------------------
// Helpers — partial engine mocks cast to SyncEngine (route-subset only)
// ---------------------------------------------------------------------------

type EngineOverrides = {
    resolveSessionAccess?: (sessionId: string, namespace: string) => unknown
    stopAutomation?: (sessionId: string) => Promise<{ automationPaused: boolean; wasRunning: boolean }>
    setAutomationPaused?: (sessionId: string, paused: boolean) => Promise<unknown>
    sendMessage?: (sessionId: string, payload: unknown) => Promise<void>
    sendAutomationMessage?: (sessionId: string, payload: unknown) => Promise<void>
    abortSession?: (sessionId: string) => Promise<void>
}

function makeEngine(overrides: EngineOverrides = {}) {
    return {
        resolveSessionAccess: (sessionId: string, namespace: string) => {
            if (namespace === 'other-namespace') {
                return { ok: false, reason: 'access-denied' }
            }
            return {
                ok: true,
                sessionId,
                session: { id: sessionId, active: true, thinking: false }
            }
        },
        stopAutomation: async () => ({ automationPaused: true, wasRunning: false }),
        setAutomationPaused: async (sessionId: string, paused: boolean) => ({
            id: sessionId,
            active: true,
            automationPaused: paused
        }),
        sendMessage: async () => {},
        sendAutomationMessage: async () => {},
        abortSession: async () => {},
        ...overrides
    } as unknown as SyncEngine
}

function makeApp(engine: SyncEngine, namespace = 'default') {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine))
    app.route('/api', createMessagesRoutes(() => engine))
    // Route-level rejections (500) must not take the whole test app down.
    app.onError((error, c) => c.json({ error: error.message }, 500))
    return app
}

const jsonPost = (path: string, body?: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
})

// ---------------------------------------------------------------------------
// stop-automation
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/stop-automation', () => {
    it('returns the ordered stop result (pause persisted, wasRunning reported)', async () => {
        const calls: string[] = []
        const engine = makeEngine({
            stopAutomation: async (sessionId) => {
                calls.push(`stop:${sessionId}`)
                return { automationPaused: true, wasRunning: true }
            }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/stop-automation', jsonPost('/stop-automation')
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, automationPaused: true, wasRunning: true })
        expect(calls).toEqual(['stop:session-1'])
    })

    it('succeeds on an idle session (wasRunning=false) without requireActive', async () => {
        const engine = makeEngine({
            resolveSessionAccess: (sessionId) => ({
                ok: true,
                sessionId,
                session: { id: sessionId, active: false, thinking: false }
            }),
            stopAutomation: async () => ({ automationPaused: true, wasRunning: false })
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/stop-automation', jsonPost('/stop-automation')
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, automationPaused: true, wasRunning: false })
    })

    it('surfaces real engine failures as 500 (never swallowed)', async () => {
        const engine = makeEngine({
            stopAutomation: async () => { throw new Error('abort rpc exploded') }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/stop-automation', jsonPost('/stop-automation')
        )

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'abort rpc exploded' })
    })

    it('rejects cross-namespace access with 403', async () => {
        const response = await makeApp(makeEngine(), 'other-namespace').request(
            '/api/sessions/session-1/stop-automation', jsonPost('/stop-automation')
        )

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Session access denied' })
    })
})

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/pause-automation and /resume-automation', () => {
    it('pause returns the persisted automationPaused flag', async () => {
        const calls: Array<[string, boolean]> = []
        const engine = makeEngine({
            setAutomationPaused: async (sessionId, paused) => {
                calls.push([sessionId, paused])
                return { id: sessionId, active: true, automationPaused: paused }
            }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/pause-automation', jsonPost('/pause-automation')
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, automationPaused: true })
        expect(calls).toEqual([['session-1', true]])
    })

    it('resume clears the flag and reports it', async () => {
        const calls: Array<[string, boolean]> = []
        const engine = makeEngine({
            setAutomationPaused: async (sessionId, paused) => {
                calls.push([sessionId, paused])
                return { id: sessionId, active: true, automationPaused: paused }
            }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/resume-automation', jsonPost('/resume-automation')
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, automationPaused: false })
        expect(calls).toEqual([['session-1', false]])
    })

    it('a null session from the engine maps to 500, not a success', async () => {
        const engine = makeEngine({
            setAutomationPaused: async () => null
        })

        for (const path of ['pause-automation', 'resume-automation']) {
            const response = await makeApp(engine).request(
                `/api/sessions/session-1/${path}`, jsonPost(path)
            )
            expect(response.status).toBe(500)
        }
    })

    it('pause works on an inactive session (no requireActive)', async () => {
        const engine = makeEngine({
            resolveSessionAccess: (sessionId) => ({
                ok: true,
                sessionId,
                session: { id: sessionId, active: false, thinking: false }
            }),
            setAutomationPaused: async (sessionId, paused) => ({
                id: sessionId, active: false, automationPaused: paused
            })
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/pause-automation', jsonPost('/pause-automation')
        )

        expect(response.status).toBe(200)
    })

    it('rejects cross-namespace access with 403', async () => {
        const app = makeApp(makeEngine(), 'other-namespace')

        for (const path of ['pause-automation', 'resume-automation']) {
            const response = await app.request(`/api/sessions/session-1/${path}`, jsonPost(path))
            expect(response.status).toBe(403)
        }
    })
})

// ---------------------------------------------------------------------------
// automation/messages
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/automation/messages', () => {
    it('routes through sendAutomationMessage and preserves the full payload', async () => {
        const sent: Array<{ sessionId: string; payload: unknown }> = []
        const engine = makeEngine({
            sendAutomationMessage: async (sessionId, payload) => {
                sent.push({ sessionId, payload })
            }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/automation/messages',
            jsonPost('/automation/messages', {
                text: 'auto step',
                localId: 'local-auto-1',
                scheduledAt: null,
                deliveryMode: 'queue'
            })
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(sent).toEqual([{
            sessionId: 'session-1',
            payload: {
                text: 'auto step',
                localId: 'local-auto-1',
                attachments: undefined,
                scheduledAt: null,
                deliveryMode: 'queue'
            }
        }])
    })

    it('maps AutomationPausedError to 409 {code: automation_paused}', async () => {
        const engine = makeEngine({
            sendAutomationMessage: async () => {
                throw new AutomationPausedError('session-1')
            }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/automation/messages',
            jsonPost('/automation/messages', { text: 'blocked' })
        )

        expect(response.status).toBe(409)
        const body = await response.json() as { error: string; code: string }
        expect(body.code).toBe('automation_paused')
        expect(body.error).toContain('Automation is paused')
    })

    it('re-escalates non-pause errors instead of swallowing them', async () => {
        const engine = makeEngine({
            sendAutomationMessage: async () => { throw new Error('queue exploded') }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/automation/messages',
            jsonPost('/automation/messages', { text: 'boom' })
        )

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'queue exploded' })
    })

    it('rejects an invalid body with 400 before touching the engine', async () => {
        let called = false
        const engine = makeEngine({
            sendAutomationMessage: async () => { called = true }
        })

        const response = await makeApp(engine).request(
            '/api/sessions/session-1/automation/messages',
            jsonPost('/automation/messages', { localId: 'missing-text' })
        )

        expect(response.status).toBe(400)
        expect(called).toBe(false)
    })

    it('rejects cross-namespace access with 403', async () => {
        const response = await makeApp(makeEngine(), 'other-namespace').request(
            '/api/sessions/session-1/automation/messages',
            jsonPost('/automation/messages', { text: 'nope' })
        )

        expect(response.status).toBe(403)
    })
})

// ---------------------------------------------------------------------------
// human messages while paused
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/messages while automation is paused', () => {
    it('human sends pass through sendMessage and never implicitly resume', async () => {
        const humanSent: Array<{ sessionId: string; payload: unknown }> = []
        const engine = makeEngine({
            // Human path: no pause check in the route — the engine's
            // sendMessage contract lets human sends through while paused
            // (only sendAutomationMessage enforces the flag).
            sendMessage: async (sessionId, payload) => {
                humanSent.push({ sessionId, payload })
            },
            // Automation path mirrors the engine contract: throws when the
            // session is paused. The route's job is mapping that to 409.
            sendAutomationMessage: async () => {
                throw new AutomationPausedError('session-1')
            },
            resolveSessionAccess: (sessionId) => ({
                ok: true,
                sessionId,
                // Paused session: human path must still work.
                session: { id: sessionId, active: true, thinking: false, automationPaused: true }
            })
        })
        const app = makeApp(engine)

        const human = await app.request(
            '/api/sessions/session-1/messages',
            jsonPost('/messages', { text: 'human direct message' })
        )
        expect(human.status).toBe(200)
        expect(humanSent).toHaveLength(1)

        // The automation route still 409s on the same paused session.
        const automation = await app.request(
            '/api/sessions/session-1/automation/messages',
            jsonPost('/automation/messages', { text: 'automation attempt' })
        )
        expect(automation.status).toBe(409)
        const body = await automation.json() as { code: string }
        expect(body.code).toBe('automation_paused')
    })
})
