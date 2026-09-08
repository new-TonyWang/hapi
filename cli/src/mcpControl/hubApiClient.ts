/**
 * Hub REST API client for the hapi-control MCP bridge
 *
 * Auth flow: POST /api/auth {accessToken} -> short-lived JWT -> Bearer on
 * all subsequent /api/* calls. Mirrors what the web app does with
 * CLI_API_TOKEN, so the bridge reuses existing hub endpoints and
 * permission/namespace semantics unchanged.
 */

import { randomUUID } from 'node:crypto'

/**
 * Structured hub error. `code` carries hub-specific machine-readable codes
 * (e.g. 'automation_paused' on 409) so tool handlers can branch on them.
 */
export class HubApiError extends Error {
    readonly status: number
    readonly code: string | undefined

    constructor(message: string, status: number, code?: string) {
        super(message)
        this.name = 'HubApiError'
        this.status = status
        this.code = code
    }
}

/** One hub session as returned by GET /api/sessions/:id (minus noisy fields). */
export type HubSessionInfo = {
    id: string
    active: boolean
    thinking: boolean
    automationPaused: boolean
    parentSessionId: string | null
    path: string | null
    name: string | null
    flavor: string | null
    model: string | null
    effort: string | null
    /** Live permission mode (session row; falls back to metadata preference). */
    permissionMode: string | null
    /** Machine this session runs on (metadata.machineId); null when unset. */
    machineId: string | null
    /** Codex profile selected at spawn (metadata.codexProfile); null for non-codex. */
    codexProfile: string | null
    /** Codex backend provider selected at spawn (metadata.codexProvider); null for non-codex. */
    codexProvider: string | null
    updatedAt: number
}

/** One message in a hub session, flattened to text for MCP consumption. */
export type HubMessageInfo = {
    id: string
    seq: number | null
    role: 'user' | 'agent' | 'unknown'
    text: string
    createdAt: number
}

export type HubApiBridgeOptions = {
    /** Hub base URL, e.g. http://localhost:3006 (no trailing slash). */
    baseUrl: string
    /** CLI_API_TOKEN (optionally "token:namespace"). */
    accessToken: string
    /** Injectable fetch for tests; defaults to global fetch. */
    fetchFn?: typeof fetch
    /** Auth + request timeout in ms. */
    timeoutMs?: number
}

type AuthSuccess = { ok: true; token: string }
type AuthFailure = { ok: false; status: number; message: string }

/**
 * Extract human-readable text from a stored message content envelope.
 * Shapes (same ones the web app normalizes, see web/src/chat/normalize*.ts):
 *   user:  {role:'user',   content: {type:'text', text}}
 *   agent: {role:'agent',  content: {type:'output', data: {message: {content: blocks}}}}
 * where blocks is a string or [{type:'text'|'tool_use'|...}].
 * Unrecognized shapes fall back to JSON stringify so nothing is silently
 * dropped.
 */
export function extractMessageText(content: unknown): { role: 'user' | 'agent' | 'unknown'; text: string } {
    if (!content || typeof content !== 'object') {
        return { role: 'unknown', text: typeof content === 'string' ? content : '' }
    }

    const record = content as Record<string, unknown>

    // User envelope written by messageService.sendMessage
    if (record.role === 'user') {
        const inner = record.content
        if (typeof inner === 'string') {
            return { role: 'user', text: inner }
        }
        if (inner && typeof inner === 'object') {
            const innerRecord = inner as Record<string, unknown>
            if (innerRecord.type === 'text' && typeof innerRecord.text === 'string') {
                return { role: 'user', text: innerRecord.text }
            }
        }
        return { role: 'user', text: safeStringify(inner) }
    }

    // Agent envelope from the CLI: {role:'agent', content:{type:'output', data:{message:{content}}}}
    if (record.role === 'agent') {
        const inner = record.content
        if (inner && typeof inner === 'object') {
            const innerRecord = inner as Record<string, unknown>
            if (innerRecord.type === 'output' && innerRecord.data && typeof innerRecord.data === 'object') {
                const data = innerRecord.data as Record<string, unknown>
                // Skip pure-event records (ready/emitted etc.) — no text to show
                if (typeof data.type === 'string' && data.type !== 'assistant' && data.type !== 'user') {
                    return { role: 'agent', text: '' }
                }
                const message = data.message
                if (message && typeof message === 'object') {
                    const extracted = extractAssistantBlocks((message as Record<string, unknown>).content)
                    if (extracted !== null) {
                        return { role: 'agent', text: extracted }
                    }
                }
            }
        }
        return { role: 'agent', text: safeStringify(record) }
    }

    return { role: 'unknown', text: safeStringify(content) }
}

/**
 * Pull text blocks out of an assistant message content (string or block array).
 * Returns null when the shape is not an assistant message.
 */
function extractAssistantBlocks(content: unknown): string | null {
    if (typeof content === 'string') {
        return content
    }
    if (!Array.isArray(content)) {
        return null
    }
    const parts: string[] = []
    for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const blockRecord = block as Record<string, unknown>
        if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') {
            parts.push(blockRecord.text)
        }
    }
    // Tool-only turns produce no text; keep them visible as a stub so callers
    // can still see the turn happened.
    return parts.length > 0 ? parts.join('\n\n') : '(no text content)'
}

function safeStringify(value: unknown): string {
    if (value === undefined) return ''
    try {
        const stringified = JSON.stringify(value)
        return typeof stringified === 'string' ? stringified : String(value)
    } catch {
        return String(value)
    }
}

export class HubApiBridge {
    private readonly baseUrl: string
    private readonly accessToken: string
    private readonly fetchFn: typeof fetch
    private readonly timeoutMs: number

    /** Cached JWT; hub issues 15m tokens, re-auth on 401 instead of preemptively. */
    private jwt: string | null = null

    constructor(options: HubApiBridgeOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '')
        this.accessToken = options.accessToken
        this.fetchFn = options.fetchFn ?? fetch
        this.timeoutMs = options.timeoutMs ?? 15_000
    }

    /**
     * Create a new agent session on a machine (POST /api/machines/:id/spawn).
     * codexProfile/codexProvider are only accepted for agent=codex; passing
     * them with any other flavor is rejected before the request goes out.
     * model/permissionMode are optional and passed through verbatim.
     */
    async createSession(
        machineId: string,
        directory: string,
        agent?: string,
        model?: string,
        codexProfile?: string,
        codexProvider?: string,
        parentSessionId?: string,
        permissionMode?: string
    ): Promise<{ sessionId: string }> {
        if ((codexProfile !== undefined || codexProvider !== undefined) && agent !== 'codex') {
            throw new Error(
                `codexProfile/codexProvider are only valid with agent=codex (got agent=${agent ?? 'claude (default)'})`
            )
        }
        const body: Record<string, unknown> = { directory }
        if (parentSessionId) body.parentSessionId = parentSessionId
        if (agent) {
            body.agent = agent
        }
        if (model !== undefined) {
            body.model = model
        }
        if (codexProfile !== undefined) {
            body.codexProfile = codexProfile
        }
        if (codexProvider !== undefined) {
            body.codexProvider = codexProvider
        }
        if (permissionMode !== undefined) {
            body.permissionMode = permissionMode
        }
        const result = await this.requestJson<{ type: string; sessionId?: string; message?: string }>(
            'POST',
            `/api/machines/${encodeURIComponent(machineId)}/spawn`,
            body
        )
        if (result.type === 'success' && typeof result.sessionId === 'string') {
            return { sessionId: result.sessionId }
        }
        throw new Error(result.message || `Failed to create session: ${JSON.stringify(result)}`)
    }

    /**
     * Change a session's permission mode (POST /api/sessions/:id/permission-mode).
     * Hot-applies to active sessions (RPC to the CLI); persisted for the next
     * resume. 409 on failure (invalid mode for flavor, session down).
     */
    async setPermissionMode(sessionId: string, mode: string): Promise<void> {
        await this.requestJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            mode
        })
    }

    /**
     * Send a user message to a session (POST /api/sessions/:id/automation/messages).
     * Automation origin: rejected 409 automation_paused while the session is
     * human-paused; never resumes implicitly.
     */
    async sendMessage(sessionId: string, text: string): Promise<void> {
        await this.requestJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/automation/messages`, {
            text,
            localId: `mcp-${randomUUID()}`
        })
    }

    /** Fetch session state (GET /api/sessions/:id). */
    async getSession(sessionId: string): Promise<HubSessionInfo> {
        const result = await this.requestJson<{ session: Record<string, unknown> }>(
            'GET',
            `/api/sessions/${encodeURIComponent(sessionId)}`
        )
        return toSessionInfo(result.session)
    }

    /**
     * Fetch messages for MCP consumption
     * (GET /api/sessions/:id/automation/output).
     * Cursor mode (afterSeq given, default 0): messages with seq > afterSeq,
     * ascending, SQL-bounded by limit — gap-free polling, empty at the tip.
     * Tail mode (afterSeq absent): last `limit` messages re-ordered
     * oldest-first, same as the web thread tail.
     *
     * The generic /messages cursor requires afterAt + afterSeq together
     * (position-based protocol); the automation-output endpoint keeps the
     * bridge's single-seq-watermark contract.
     */
    async readMessages(sessionId: string, limit: number, afterSeq?: number): Promise<HubMessageInfo[]> {
        const query = `limit=${limit}${afterSeq !== undefined ? `&afterSeq=${afterSeq}` : ''}`
        const result = await this.requestJson<{
            messages: Array<Record<string, unknown>>
        }>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/automation/output?${query}`)
        const messages = Array.isArray(result.messages) ? result.messages : []
        return messages
            .map(toMessageInfo)
            .sort((a, b) => {
                if (a.seq !== null && b.seq !== null) return a.seq - b.seq
                return a.createdAt - b.createdAt
            })
    }

    /** Pause automation for a session (POST /api/sessions/:id/pause-automation). */
    async pauseAutomation(sessionId: string): Promise<void> {
        await this.requestJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/pause-automation`)
    }

    /** Resume automation for a session (POST /api/sessions/:id/resume-automation). */
    async resumeAutomation(sessionId: string): Promise<void> {
        await this.requestJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/resume-automation`)
    }

    /**
     * Interrupt a session (POST /api/sessions/:id/stop-automation).
     * Hub semantics: persist the automation pause first, then abort the
     * running turn; an already-idle session skips the abort RPC and
     * reports wasRunning=false. Real abort failures throw.
     */
    async interruptSession(sessionId: string): Promise<{ wasRunning: boolean }> {
        return await this.requestJson<{ wasRunning: boolean }>(
            'POST',
            `/api/sessions/${encodeURIComponent(sessionId)}/stop-automation`
        )
    }

    /** List machines available for spawn (GET /api/machines). */
    async listMachines(): Promise<Array<{ id: string; active: boolean; displayName: string | null }>> {
        const result = await this.requestJson<{ machines: Array<Record<string, unknown>> }>('GET', '/api/machines')
        const machines = Array.isArray(result.machines) ? result.machines : []
        return machines.map((machine) => {
            const metadata = machine.metadata as Record<string, unknown> | null | undefined
            return {
                id: String(machine.id ?? ''),
                active: Boolean(machine.active),
                displayName: typeof metadata?.displayName === 'string' ? metadata.displayName : null
            }
        })
    }

    /**
     * List Codex profiles and providers configured on a machine
     * (GET /api/machines/:id/codex-models). Names only — credentials never
     * leave the runner; this response carries no secrets.
     */
    async listCodexOptions(machineId: string): Promise<{ models: string[]; profiles: string[]; providers: string[] }> {
        const result = await this.requestJson<{ models?: unknown; profiles?: unknown; providers?: unknown }>(
            'GET',
            `/api/machines/${encodeURIComponent(machineId)}/codex-models`
        )
        return {
            models: toModelIdArray(result.models),
            profiles: toStringArray(result.profiles),
            providers: toStringArray(result.providers)
        }
    }

    /**
     * Change the Codex model provider of a session
     * (POST /api/sessions/:id/codex-provider). Provider is a name from
     * list_codex_options; the empty string selects Codex's default provider.
     * The hub reopens the session to apply the change.
     */
    async changeCodexProvider(sessionId: string, provider: string): Promise<void> {
        await this.requestJson(
            'POST',
            `/api/sessions/${encodeURIComponent(sessionId)}/codex-provider`,
            { provider }
        )
    }

    /** Exchange CLI_API_TOKEN for a JWT via /api/auth; cached until it expires or a 401. */
    private async authenticate(): Promise<AuthSuccess | AuthFailure> {
        const response = await this.rawFetch('POST', '/api/auth', { accessToken: this.accessToken })
        if (!response.ok) {
            return { ok: false, status: response.status, message: await errorText(response) }
        }
        const body = await response.json().catch(() => null) as { token?: unknown } | null
        if (!body || typeof body.token !== 'string') {
            return { ok: false, status: 502, message: 'Malformed /api/auth response' }
        }
        this.jwt = body.token
        return { ok: true, token: body.token }
    }

    /** JSON request with auth + one transparent re-auth retry on 401. */
    private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
        const attempt = async (): Promise<Response> => {
            if (!this.jwt) {
                const auth = await this.authenticate()
                if (!auth.ok) {
                    throw new Error(`Authentication failed (${auth.status}): ${auth.message}`)
                }
            }
            return await this.authedFetch(method, path, body)
        }

        let response = await attempt()
        if (response.status === 401) {
            // Token expired (hub JWTs live ~15m); re-auth once and retry.
            this.jwt = null
            response = await attempt()
        }

        if (!response.ok) {
            const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null
            const code = body && typeof body.code === 'string' ? body.code : undefined
            const detail = body && typeof body.error === 'string' ? body.error : (response.statusText || 'unknown error')
            throw new HubApiError(`Hub API ${method} ${path} failed (${response.status}): ${detail}`, response.status, code)
        }
        const text = await response.text()
        if (!text) {
            return {} as T
        }
        return JSON.parse(text) as T
    }

    private async authedFetch(method: string, path: string, body?: unknown): Promise<Response> {
        return await this.rawFetch(method, path, body, {
            Authorization: `Bearer ${this.jwt}`
        })
    }

    private async rawFetch(
        method: string,
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>
    ): Promise<Response> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
            return await this.fetchFn(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    ...extraHeaders
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal
            })
        } finally {
            clearTimeout(timer)
        }
    }
}

function toSessionInfo(raw: Record<string, unknown>): HubSessionInfo {
    const metadata = raw.metadata as Record<string, unknown> | null | undefined
    return {
        id: String(raw.id ?? ''),
        active: Boolean(raw.active),
        thinking: Boolean(raw.thinking),
        automationPaused: Boolean(raw.automationPaused),
        parentSessionId: typeof raw.parentSessionId === 'string'
            ? raw.parentSessionId
            : (typeof metadata?.parentSessionId === 'string' ? metadata.parentSessionId : null),
        path: typeof metadata?.path === 'string' ? metadata.path : null,
        name: typeof metadata?.name === 'string' ? metadata.name : null,
        flavor: typeof metadata?.flavor === 'string' ? metadata.flavor : null,
        model: typeof raw.model === 'string' ? raw.model : null,
        effort: typeof raw.effort === 'string' ? raw.effort : null,
        permissionMode: typeof raw.permissionMode === 'string'
            ? raw.permissionMode
            : (typeof metadata?.preferredPermissionMode === 'string' ? metadata.preferredPermissionMode : null),
        machineId: typeof metadata?.machineId === 'string' ? metadata.machineId : null,
        codexProfile: typeof metadata?.codexProfile === 'string' ? metadata.codexProfile : null,
        codexProvider: typeof metadata?.codexProvider === 'string' ? metadata.codexProvider : null,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
    }
}

function toMessageInfo(raw: Record<string, unknown>): HubMessageInfo {
    const extracted = extractMessageText(raw.content)
    return {
        id: String(raw.id ?? ''),
        seq: typeof raw.seq === 'number' ? raw.seq : null,
        role: extracted.role,
        text: extracted.text,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0
    }
}

function toModelIdArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .map((entry) => {
            if (!entry || typeof entry !== 'object') return null
            const id = (entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).model
            return typeof id === 'string' ? id : null
        })
        .filter((entry): entry is string => entry !== null)
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string')
}

async function errorText(response: Response): Promise<string> {
    try {
        const body = await response.json() as { error?: unknown } | null
        if (body && typeof body.error === 'string') {
            return body.error
        }
    } catch {
        // fall through to status text
    }
    return response.statusText || 'unknown error'
}
