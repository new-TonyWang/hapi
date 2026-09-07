/**
 * hapi-control MCP server
 *
 * Independent scheduling bridge: exposes hub REST capabilities as MCP tools
 * so any MCP client can create HAPI agent sessions, send them messages, read
 * history and interrupt them.
 *
 * Tools:
 *   - create_session     (spawn a new agent session on a machine)
 *   - send_message       (send user text to a session)
 *   - get_session        (session status: active/thinking/metadata)
 *   - read_messages      (recent messages, oldest first)
 *   - interrupt_session  (abort a running session)
 *   - list_codex_options (profiles/providers configured on a machine)
 *   - change_codex_provider (switch a Codex session's provider; reopens it)
 *
 * Model/effort are intentionally NOT exposed; callers spawn with defaults.
 * codexProfile/codexProvider ARE exposed (agent=codex only): they select which
 * configured Codex backend the session runs on, not a model override.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { HubApiBridge, HubApiError } from './hubApiClient'

// Widen to ZodTypeAny to sidestep SDK ZodRawShape instantiation-depth issues
// (same pattern as startHappyServer.ts / happyMcpStdioBridge.ts).
const createSessionSchema: z.ZodTypeAny = z.object({
    machineId: z.string().min(1).optional()
        .describe('Target machine id (see list_machines). Defaults to the current session\'s machine.'),
    directory: z.string().min(1).optional()
        .describe('Absolute working directory for the session. Defaults to the current session\'s directory.'),
    agent: z.enum(['claude', 'codex', 'cursor', 'gemini', 'opencode']).optional()
        .describe('Agent flavor. Defaults to the current session\'s flavor (claude when unknown).'),
    model: z.string().min(1).optional()
        .describe('Model id for the session (e.g. z-ai/glm-5.3, kimi-k3, gpt-5.5). Defaults to the current session\'s model.'),
    codexProfile: z.string().min(1).optional()
        .describe('Codex profile name; only valid when agent is codex. Defaults to the current session\'s profile.'),
    codexProvider: z.string().min(1).optional()
        .describe('Codex model provider name; only valid when agent is codex. Defaults to the current session\'s provider.'),
    permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'ask', 'debug', 'autoReview', 'read-only', 'safe-yolo', 'yolo']).optional()
        .describe('Permission mode for the child: "default" requires human approval for most actions (a spawned child can stall waiting for approvals nobody answers). For unattended background work use "safe-yolo" (auto-approve with sandbox) or "yolo"/"bypassPermissions" (no approval at all — only for trusted, narrowly-scoped tasks). Defaults to the current session\'s mode.'),
    parentSessionId: z.string().uuid().optional()
        .describe('Must match the current HAPI session; child sessions are only created from a HAPI session')
})

const sendMessageSchema: z.ZodTypeAny = z.object({
    sessionId: z.string().min(1).describe('Session id from create_session'),
    text: z.string().min(1).describe('Message text to send')
})

const sessionArgSchema: z.ZodTypeAny = z.object({
    sessionId: z.string().min(1).describe('Session id')
})

const readMessagesSchema: z.ZodTypeAny = z.object({
    sessionId: z.string().min(1).describe('Session id'),
    limit: z.number().int().min(1).max(200).optional()
        .describe('Max messages to return (default 20)'),
    afterSeq: z.number().int().min(0).optional()
        .describe('Cursor: only return messages with seq > afterSeq (gap-free, ascending). Poll with the last seq you saw.')
})

const listMachinesSchema: z.ZodTypeAny = z.object({})

const listCodexOptionsSchema: z.ZodTypeAny = z.object({
    machineId: z.string().min(1).describe('Machine id whose Codex config to inspect (see list_machines)')
})

const changeCodexProviderSchema: z.ZodTypeAny = z.object({
    sessionId: z.string().min(1).describe('Session id (must be a Codex session)'),
    provider: z.string().describe('Provider name from list_codex_options; empty string selects Codex\'s default provider')
})

const setPermissionModeSchema: z.ZodTypeAny = z.object({
    sessionId: z.string().min(1).describe('Session id (e.g. from create_session)'),
    mode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'ask', 'debug', 'autoReview', 'read-only', 'safe-yolo', 'yolo'])
        .describe('New permission mode. Use "safe-yolo" to unblock a child stalled on permission prompts; "default" restores human gating.')
})

function textResult(text: string, isError = false) {
    return {
        content: [{ type: 'text' as const, text }],
        isError
    }
}

/**
 * Parent-session context used to default create_session arguments. Fetched
 * once at bridge startup (runMcpControlBridge) so an empty `create_session`
 * call clones the current session: same machine, directory, flavor, model,
 * codex profile/provider. Null fields mean "no default known" — the argument
 * then stays unset and hub defaults apply.
 */
export type ParentSessionDefaults = {
    machineId: string | null
    directory: string | null
    flavor: string | null
    model: string | null
    codexProfile: string | null
    codexProvider: string | null
    /** Live permission mode of the parent, inherited when the caller omits it. */
    permissionMode: string | null
}

/**
 * Register the mcp-control tools (create_session, send_message, get_session,
 * read_messages, interrupt_session, pause/resume_automation,
 * list_machines, list_codex_options, change_codex_provider,
 * set_permission_mode) onto an existing McpServer instance. Shared by the
 * standalone stdio bridge (createControlMcpServer) and the in-session hapi
 * MCP bridge (startHappyServer), so every flavor's session sees one unified
 * "hapi" MCP server instead of two separate ones.
 */
export function registerControlTools(
    server: McpServer,
    bridge: HubApiBridge,
    parentSessionId?: string,
    defaults?: ParentSessionDefaults
): void {
    server.registerTool<any, any>(
        'create_session',
        {
            title: 'Create HAPI Session',
            description: 'Spawn a new agent session on a machine. Returns the session id. Omitted arguments default to the current session (machine, directory, flavor, model, codex profile/provider, permission mode); pass them explicitly to override. For unattended child work prefer permissionMode "safe-yolo" — a child left on "default" can stall forever waiting for permission approvals nobody answers. After spawning, poll get_session / read_messages to watch the child; if it stalls, set_permission_mode unblocks it. codexProfile/codexProvider are only valid with agent=codex.',
            inputSchema: createSessionSchema
        },
        async (args: { machineId?: string; directory?: string; agent?: string; model?: string; codexProfile?: string; codexProvider?: string; permissionMode?: string; parentSessionId?: string }) => {
            try {
                if (parentSessionId && args.parentSessionId !== undefined && args.parentSessionId !== parentSessionId) {
                    throw new Error('parentSessionId must match the current HAPI session')
                }
                // Unspecified args inherit the parent session's values (same
                // machine/directory/flavor/model/provider/permission mode) so
                // an empty call clones the current session; explicit args win.
                const machineId = args.machineId ?? defaults?.machineId ?? undefined
                const directory = args.directory ?? defaults?.directory ?? undefined
                let agent = args.agent ?? defaults?.flavor ?? undefined
                const model = args.model ?? defaults?.model ?? undefined
                const codexProfile = args.codexProfile ?? defaults?.codexProfile ?? undefined
                const codexProvider = args.codexProvider ?? defaults?.codexProvider ?? undefined
                const permissionMode = args.permissionMode ?? defaults?.permissionMode ?? undefined
                if (!machineId || !directory) {
                    const missing = [
                        !machineId ? 'machineId' : null,
                        !directory ? 'directory' : null
                    ].filter(Boolean).join(' and ')
                    throw new Error(`create_session requires ${missing} (no default available from the current session)`)
                }
                // Flavor guard: normalize non-creatable flavors (e.g. gemini,
                // retired by upstream) to claude; schema enum already rejects
                // unknown values when the caller passes one explicitly.
                if (agent && !['claude', 'codex', 'cursor', 'gemini', 'opencode'].includes(agent)) {
                    agent = undefined
                }
                const { sessionId } = await bridge.createSession(
                    machineId,
                    directory,
                    agent,
                    model,
                    codexProfile,
                    codexProvider,
                    parentSessionId,
                    permissionMode
                )
                return textResult(sessionId)
            } catch (error) {
                return textResult(`Failed to create session: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'send_message',
        {
            title: 'Send Message',
            description: 'Send a user message to an active HAPI session (automation origin: distinct from the human phone/web composer, which is never blocked). Rejected (409 automation_paused) while paused: a human has taken over the session — wait for the user to explicitly allow resuming, do NOT resume on your own; sending never resumes implicitly.',
            inputSchema: sendMessageSchema
        },
        async (args: { sessionId: string; text: string }) => {
            try {
                await bridge.sendMessage(args.sessionId, args.text)
                return textResult('Message sent')
            } catch (error) {
                if (error instanceof HubApiError && error.code === 'automation_paused') {
                    return textResult(
                        'Message rejected: automation is paused for this session — a human has taken over. ' +
                        'Wait for the user to explicitly allow resuming before calling resume_automation; ' +
                        'do not resume on your own. Sending never resumes implicitly.',
                        true
                    )
                }
                return textResult(`Failed to send message: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'get_session',
        {
            title: 'Get Session',
            description: 'Get session status (active, thinking, working directory, agent flavor, permission mode). A child left on permission mode "default" can stall waiting for human approvals that never come — if a spawned child is not making progress, check its permissionMode here and read_messages for pending approval requests, then set_permission_mode to unblock it.',
            inputSchema: sessionArgSchema
        },
        async (args: { sessionId: string }) => {
            try {
                const session = await bridge.getSession(args.sessionId)
                const lines = [
                    `id: ${session.id}`,
                    `active: ${session.active}`,
                    `thinking: ${session.thinking}`,
                    `automationPaused: ${session.automationPaused}`,
                    `parentSessionId: ${session.parentSessionId ?? 'none'}`,
                    `path: ${session.path ?? 'unknown'}`,
                    `name: ${session.name ?? 'none'}`,
                    `flavor: ${session.flavor ?? 'unknown'}`,
                    `model: ${session.model ?? 'default'}`,
                    `effort: ${session.effort ?? 'default'}`,
                    `permissionMode: ${session.permissionMode ?? 'default'}`,
                    `codexProvider: ${session.codexProvider ?? 'none'}`,
                    `updatedAt: ${new Date(session.updatedAt).toISOString()}`
                ]
                // Guidance: surface the permission-stall risk explicitly so
                // callers notice it at poll time instead of after a hang.
                if (session.active && !session.automationPaused && (session.permissionMode ?? 'default') === 'default') {
                    lines.push('note: permission mode is "default" — the child may be waiting for a human approval. If it is not progressing, use read_messages to check for a pending permission request, then set_permission_mode (e.g. "safe-yolo") to unblock it.')
                }
                return textResult(lines.join('\n'))
            } catch (error) {
                return textResult(`Failed to get session: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'read_messages',
        {
            title: 'Read Messages',
            description: 'Read messages of a session, oldest first. Each line: "seq | role | text". With afterSeq: gap-free cursor polling (empty result means caught up).',
            inputSchema: readMessagesSchema
        },
        async (args: { sessionId: string; limit?: number; afterSeq?: number }) => {
            try {
                const messages = await bridge.readMessages(args.sessionId, args.limit ?? 20, args.afterSeq)
                if (messages.length === 0) {
                    return textResult(args.afterSeq !== undefined ? '(caught up)' : '(no messages)')
                }
                // Every message gets a line (even empty-text event records,
                // rendered as "(event)") so cursor callers can advance their
                // lastSeq past every seq without re-reading.
                return textResult(messages.map((message) => {
                    const body = message.text === '' ? '(event)' : message.text
                    return `${message.seq ?? '-'} | ${message.role} | ${body}`
                }).join('\n'))
            } catch (error) {
                return textResult(`Failed to read messages: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'interrupt_session',
        {
            title: 'Interrupt Session',
            description: 'Interrupt a HAPI session: pauses automation (server rejects subsequent automation sends) and aborts the running turn. After the interrupt a human has taken over — resume only with the user\'s explicit permission. An idle session is paused without an abort. Real abort failures are reported.',
            inputSchema: sessionArgSchema
        },
        async (args: { sessionId: string }) => {
            try {
                const result = await bridge.interruptSession(args.sessionId)
                return textResult(
                    result.wasRunning
                        ? 'Interrupt requested'
                        : 'Session was idle; automation paused, no abort needed'
                )
            } catch (error) {
                return textResult(`Failed to interrupt session: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'pause_automation',
        {
            title: 'Pause Automation',
            description: 'Mark a session human-controlled: server rejects send_message (409 automation_paused) until resume_automation. Persists across restarts; the human (phone/web) can still message directly.',
            inputSchema: sessionArgSchema
        },
        async (args: { sessionId: string }) => {
            try {
                await bridge.pauseAutomation(args.sessionId)
                return textResult('Automation paused. send_message is rejected until resume_automation is called — only with the user\'s explicit permission.')
            } catch (error) {
                return textResult(`Failed to pause automation: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'resume_automation',
        {
            title: 'Resume Automation',
            description: 'Clear the human-interrupt flag; automation (send_message) is allowed again. Only call this with the user\'s explicit permission after a pause — the pause exists because a human took over; never resume on your own. This is the only way to unblock a paused session — sends never resume implicitly.',
            inputSchema: sessionArgSchema
        },
        async (args: { sessionId: string }) => {
            try {
                await bridge.resumeAutomation(args.sessionId)
                return textResult('Automation resumed')
            } catch (error) {
                return textResult(`Failed to resume automation: ${errorMessage(error)}`, true)
            }
        }
    )

    // Supporting tool: callers need machine ids before create_session.
    server.registerTool<any, any>(
        'list_machines',
        {
            title: 'List Machines',
            description: 'List machines available for spawning sessions. Each line: "id | active | displayName".',
            inputSchema: listMachinesSchema
        },
        async () => {
            try {
                const machines = await bridge.listMachines()
                if (machines.length === 0) {
                    return textResult('(no machines)')
                }
                return textResult(
                    machines.map((machine) => `${machine.id} | ${machine.active} | ${machine.displayName ?? ''}`).join('\n')
                )
            } catch (error) {
                return textResult(`Failed to list machines: ${errorMessage(error)}`, true)
            }
        }
    )

    // Discovery for create_session's codexProfile/codexProvider fields:
    // callers need the configured names before they can pick one.
    server.registerTool<any, any>(
        'list_codex_options',
        {
            title: 'List Codex Options',
            description: 'List Codex profiles and providers configured on a machine. Names only; credentials stay on the runner. Output: "profiles:" then "providers:" lines, one name per line. Use these names for create_session codexProfile/codexProvider and change_codex_provider.',
            inputSchema: listCodexOptionsSchema
        },
        async (args: { machineId: string }) => {
            try {
                const { profiles, providers } = await bridge.listCodexOptions(args.machineId)
                const lines = ['profiles:', ...profiles.map((name) => `  ${name}`), 'providers:', ...providers.map((name) => `  ${name}`)]
                return textResult(lines.join('\n'))
            } catch (error) {
                return textResult(`Failed to list codex options: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'change_codex_provider',
        {
            title: 'Change Codex Provider',
            description: 'Change the Codex model provider of an existing Codex session. WARNING: the hub reopens (restarts) the session to apply the change — in-flight work is interrupted. Pick the provider name from list_codex_options; an empty string switches back to Codex\'s default provider. Not for non-Codex sessions; errors are reported as-is.',
            inputSchema: changeCodexProviderSchema
        },
        async (args: { sessionId: string; provider: string }) => {
            try {
                await bridge.changeCodexProvider(args.sessionId, args.provider)
                return textResult(
                    args.provider === ''
                        ? 'Codex provider switched to default; session was reopened to apply it'
                        : `Codex provider switched to ${args.provider}; session was reopened to apply it`
                )
            } catch (error) {
                return textResult(`Failed to change codex provider: ${errorMessage(error)}`, true)
            }
        }
    )

    server.registerTool<any, any>(
        'set_permission_mode',
        {
            title: 'Set Permission Mode',
            description: 'Change a session\'s permission mode; hot-applies to active sessions. Use it to unblock a spawned child stalled on "default" (waiting for human approvals nobody answers): "safe-yolo" auto-approves within the sandbox. Use "default" to restore human gating when a human is available to watch. Modes per flavor: claude default/acceptEdits/auto/bypassPermissions/plan; codex default/read-only/safe-yolo/yolo.',
            inputSchema: setPermissionModeSchema
        },
        async (args: { sessionId: string; mode: string }) => {
            try {
                await bridge.setPermissionMode(args.sessionId, args.mode)
                return textResult(`Permission mode set to ${args.mode}. Active sessions apply it immediately (the running turn may need a nudge via send_message); inactive sessions apply it on next resume.`)
            } catch (error) {
                return textResult(`Failed to set permission mode: ${errorMessage(error)}`, true)
            }
        }
    )

}

/** Build the standalone MCP server wired to a HubApiBridge. Transport attached by caller. */
export function createControlMcpServer(bridge: HubApiBridge, parentSessionId?: string, defaults?: ParentSessionDefaults): McpServer {
    const server = new McpServer({
        name: 'hapi-control',
        version: '1.0.0'
    })
    registerControlTools(server, bridge, parentSessionId, defaults)
    return server
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
