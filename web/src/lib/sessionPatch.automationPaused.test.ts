import { describe, expect, it } from 'vitest'
import { applySessionDetailPatch } from './sessionPatch'
import type { Session, SessionPatch } from '@/types/api'

/**
 * Targeted coverage for the automationPaused SSE patch path: the hub's
 * pause/resume transitions must actually land in the web detail cache so
 * the banner reflects server state without a REST refetch.
 */
function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1_000,
        active: true,
        activeAt: 1_000,
        updatedAt: 1_000,
        thinking: false,
        permissionMode: 'default',
        ...overrides
    } as Session
}

describe('applySessionDetailPatch automationPaused', () => {
    it('applies automationPaused=true (pause transition shows the banner)', () => {
        const next = applySessionDetailPatch(makeSession(), { automationPaused: true } as SessionPatch)
        expect(next).not.toBeNull()
        expect(next?.automationPaused).toBe(true)
    })

    it('applies automationPaused=false explicitly (resume clears the banner)', () => {
        const paused = makeSession({ automationPaused: true })
        const next = applySessionDetailPatch(paused, { automationPaused: false } as SessionPatch)
        expect(next).not.toBeNull()
        expect(next?.automationPaused).toBe(false)
    })

    it('keeps the flag untouched when the patch omits it (present-means-set)', () => {
        const paused = makeSession({ automationPaused: true })
        const next = applySessionDetailPatch(paused, { thinking: true } as SessionPatch)
        expect(next?.automationPaused).toBe(true)
    })

    it('returns null (no re-render) when the flag value is unchanged', () => {
        const paused = makeSession({ automationPaused: true })
        const next = applySessionDetailPatch(paused, { automationPaused: true } as SessionPatch)
        expect(next).toBeNull()
    })
})
