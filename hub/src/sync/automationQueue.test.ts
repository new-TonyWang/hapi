import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { MessageService } from './messageService'
import { SyncEngine, AutomationPausedError } from './syncEngine'

/**
 * Phone-takeover semantics at the engine layer (automation pause port):
 * the per-session serial queue orders pause/send/abort so a pause issued
 * mid-send is applied before the automation send's check — no automation
 * send slips past the pause — and a resume/human send issued while
 * stopAutomation's abort RPC is in flight stays queued behind it.
 *
 * The engine is real (real Store, real SessionCache) so pause persistence
 * is exercised against SQLite; only messageService/rpcGateway are swapped
 * for hermetic message recording and a controllable abort.
 */

function createEngineHarness() {
    const store = new Store(':memory:')
    const sentFroms: Array<string | undefined> = []
    const messageService = {
        sendMessage: async (_sessionId: string, payload: { sentFrom?: string }) => {
            sentFroms.push(payload.sentFrom)
            return { actualSessionId: _sessionId, createdAt: Date.now() }
        },
        // handleSessionAlive touches these on the new engine; no-op stubs.
        replayImmediateQueuedMessages: () => 0
    } as unknown as MessageService
    const abortCalls: string[] = []

    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: () => {} } as never)
    // Swap internals for hermetic message recording + controllable abort.
    ;(engine as unknown as { messageService: MessageService }).messageService = messageService
    const rpcGateway = { abortSession: async (id: string) => { abortCalls.push(id) } }
    ;(engine as unknown as { rpcGateway: unknown }).rpcGateway = rpcGateway

    const session = engine.getOrCreateSession(
        'pause-order-session',
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        null,
        'default'
    )

    return { engine, store, session, sentFroms, abortCalls }
}

beforeEach(() => {
    // Harness state is per-call; nothing global to reset.
})

afterEach(() => {
    // Each test's engine.timer is stopped inside the test body (finally).
})

describe('automation pause queue ordering', () => {
    it('human send passes while paused and never resumes', async () => {
        const { engine, store, session, sentFroms } = createEngineHarness()
        try {
            await engine.setAutomationPaused(session.id, true)

            // Human origin: allowed even though automationPaused
            await engine.sendMessage(session.id, { text: 'human', sentFrom: 'webapp' })

            expect(sentFroms).toEqual(['webapp'])
            expect(engine.getSession(session.id)?.automationPaused).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('automation send rejected with 409-mapped error while paused', async () => {
        const { engine, store, session, sentFroms } = createEngineHarness()
        try {
            await engine.setAutomationPaused(session.id, true)

            let caught: unknown = null
            await engine.sendAutomationMessage(session.id, { text: 'auto' }).catch((e) => { caught = e })

            expect(caught).toBeInstanceOf(AutomationPausedError)
            expect(sentFroms).toEqual([])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('explicit resume unblocks automation sends', async () => {
        const { engine, store, session, sentFroms } = createEngineHarness()
        try {
            await engine.setAutomationPaused(session.id, true)
            await engine.setAutomationPaused(session.id, false)
            await engine.sendAutomationMessage(session.id, { text: 'auto' })

            expect(sentFroms).toEqual(['webapp'])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('pause queued BEHIND an in-flight send: the send completes first, later sends are rejected', async () => {
        const { engine, store, session, sentFroms } = createEngineHarness()
        try {
            // Deterministic order 1: the send enters the queue first and is
            // already running when the pause lands behind it. The queue runs
            // entries in call order, so the send completes — and everything
            // after the pause write must observe the flag.
            const inFlight = engine.sendAutomationMessage(session.id, { text: 'first' })
            // Let the send entry start (it holds the queue slot while its
            // messageService promise resolves on the microtask queue).
            await new Promise((resolve) => setTimeout(resolve, 0))

            await engine.setAutomationPaused(session.id, true)
            await inFlight

            // The pre-pause send was delivered, exactly once.
            expect(sentFroms).toEqual(['webapp'])
            expect(engine.getSession(session.id)?.automationPaused).toBe(true)

            // Any automation send after the pause is rejected.
            let caught: unknown = null
            await engine.sendAutomationMessage(session.id, { text: 'after pause' }).catch((e) => { caught = e })
            expect(caught).toBeInstanceOf(AutomationPausedError)
            expect(sentFroms).toEqual(['webapp'])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('pause queued AHEAD of a send: the send is rejected outright, nothing delivered', async () => {
        const { engine, store, session, sentFroms } = createEngineHarness()
        try {
            // Deterministic order 2: the pause lands in the queue before the
            // send's entry starts. The send's in-entry pause check then sees
            // the persisted flag and rejects — the message service is never
            // called for it.
            await engine.setAutomationPaused(session.id, true)

            let caught: unknown = null
            await engine.sendAutomationMessage(session.id, { text: 'queued after pause' }).catch((e) => { caught = e })

            expect(caught).toBeInstanceOf(AutomationPausedError)
            expect(sentFroms).toEqual([])
            expect(engine.getSession(session.id)?.automationPaused).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('a history action started while a send waits in the queue rejects the send (in-queue check)', async () => {
        const { engine, store, session, sentFroms, abortCalls } = createEngineHarness()
        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

            // Abort RPC hangs until released: stopAutomation occupies the
            // queue slot while its abort is in flight, and the send parks
            // behind it.
            let releaseAbort: (() => void) | undefined
            const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve })
            ;(engine as unknown as { rpcGateway: { abortSession: (id: string) => Promise<void> } }).rpcGateway = {
                abortSession: async (id: string) => {
                    abortCalls.push(id)
                    await abortGate
                }
            }

            const stopping = engine.stopAutomation(session.id)
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(abortCalls).toEqual([session.id])

            // Send parks in the queue behind the hanging abort.
            const queuedSend = engine.sendMessage(session.id, { text: 'waits behind abort', sentFrom: 'webapp' })
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(sentFroms).toEqual([])

            // A history action claims the session lock while the send is
            // still parked. (Direct Set access — same surface the fork/
            // rewind paths use.)
            const historyLock = (engine as unknown as { historyActionsInFlight: Set<string> }).historyActionsInFlight
            historyLock.add(session.id)

            // Release the abort: the queue advances to the send entry, which
            // must now REJECT on the in-queue history check — and the
            // message service must never have been called for it.
            releaseAbort?.()
            await stopping
            let caught: unknown = null
            await queuedSend.catch((e) => { caught = e })

            expect(caught).toBeInstanceOf(Error)
            expect((caught as Error).message).toBe('Conversation history action already in progress')
            expect(sentFroms).toEqual([])

            historyLock.delete(session.id)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('stopAutomation persists pause first and skips abort RPC when idle', async () => {
        const { engine, store, session, abortCalls } = createEngineHarness()
        try {
            const result = await engine.stopAutomation(session.id)

            expect(result).toEqual({ automationPaused: true, wasRunning: false })
            expect(abortCalls).toEqual([])
            expect(engine.getSession(session.id)?.automationPaused).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('stopAutomation awaits abort for a running session and reports wasRunning', async () => {
        const { engine, store, session, abortCalls } = createEngineHarness()
        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

            const result = await engine.stopAutomation(session.id)

            expect(result).toEqual({ automationPaused: true, wasRunning: true })
            expect(abortCalls).toEqual([session.id])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('stopAutomation propagates real abort failures after persisting the pause', async () => {
        const { engine, store, session } = createEngineHarness()
        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            ;(engine as unknown as { rpcGateway: { abortSession: (id: string) => Promise<void> } }).rpcGateway = {
                abortSession: async () => { throw new Error('RPC socket disconnected') }
            }

            let caught: unknown = null
            await engine.stopAutomation(session.id).catch((e) => { caught = e })

            expect(caught).toBeInstanceOf(Error)
            expect((caught as Error).message).toBe('RPC socket disconnected')
            // Pause still persisted before the failure
            expect(engine.getSession(session.id)?.automationPaused).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('resume and human send cannot overtake a stop whose abort RPC is in flight', async () => {
        const { engine, store, session, sentFroms, abortCalls } = createEngineHarness()
        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

            // Abort RPC hangs until released
            let releaseAbort: (() => void) | undefined
            const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve })
            ;(engine as unknown as { rpcGateway: { abortSession: (id: string) => Promise<void> } }).rpcGateway = {
                abortSession: async (id: string) => {
                    abortCalls.push(id)
                    await abortGate
                }
            }

            const stopping = engine.stopAutomation(session.id)

            // Let the stop entry start and reach the hanging abort RPC
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(abortCalls).toEqual([session.id])

            // Resume + human send issued while the abort RPC is in flight:
            // both must wait, not run before/concurrently with the abort.
            const resumed = engine.setAutomationPaused(session.id, false)
            const humanSend = engine.sendMessage(session.id, { text: 'human mid-abort', sentFrom: 'webapp' })

            // Yield again so a queued entry would run if the queue allowed it
            await new Promise((resolve) => setTimeout(resolve, 0))

            // While abort is still pending, neither has executed
            expect(engine.getSession(session.id)?.automationPaused).toBe(true)
            expect(sentFroms).toEqual([])

            // Let the abort finish; the queued pair then runs in order
            releaseAbort?.()
            const result = await stopping
            await resumed
            await humanSend

            expect(result).toEqual({ automationPaused: true, wasRunning: true })
            // Resume applied after the abort completed, human send delivered
            expect(engine.getSession(session.id)?.automationPaused).toBe(false)
            expect(sentFroms).toEqual(['webapp'])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('pause persist failure surfaces as error and never fires the abort', async () => {
        const { engine, store, session, abortCalls } = createEngineHarness()
        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            // Simulate the pause write failing (session vanished mid-stop):
            // patch the method on the real cache object, keep the rest intact.
            const cache = engine['sessionCache' as keyof typeof engine] as unknown as {
                setAutomationPaused: (id: string, paused: boolean) => unknown
            }
            const original = cache.setAutomationPaused.bind(cache)
            cache.setAutomationPaused = (id: string, paused: boolean) =>
                paused ? null : original(id, paused)

            let caught: unknown = null
            await engine.stopAutomation(session.id).catch((e) => { caught = e })

            expect(caught).toBeInstanceOf(Error)
            expect((caught as Error).message).toBe('Failed to persist automation pause')
            // Abort never fired for a stop whose pause could not be persisted
            expect(abortCalls).toEqual([])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('queue entry failures do not poison later entries (send after failed stop)', async () => {
        const { engine, store, session, sentFroms } = createEngineHarness()
        try {
            // First stop fails at the abort RPC (propagated).
            ;(engine as unknown as { rpcGateway: { abortSession: (id: string) => Promise<void> } }).rpcGateway = {
                abortSession: async () => { throw new Error('abort failed') }
            }
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            let stopError: unknown = null
            await engine.stopAutomation(session.id).catch((e) => { stopError = e })
            expect(stopError).toBeInstanceOf(Error)

            // The queue tail must be usable: a human send still runs.
            await engine.sendMessage(session.id, { text: 'after failed stop', sentFrom: 'webapp' })
            expect(sentFroms).toEqual(['webapp'])
        } finally {
            engine.stop()
            store.close()
        }
    })
})
