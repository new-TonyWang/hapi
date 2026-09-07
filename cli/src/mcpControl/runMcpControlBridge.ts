/**
 * hapi mcp-control entrypoint
 *
 * Starts the independent-scheduling MCP bridge over stdio.
 * Must never write to stdout (reserved for MCP protocol); errors -> stderr.
 *
 * URL/token resolution order:
 *   --url / --token flags > HAPI_API_URL / CLI_API_TOKEN env >
 *   ~/.hapi/settings.json (same fields `hapi auth` writes)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { readSettings } from '@/persistence'
import { HubApiBridge } from './hubApiClient'
import { createControlMcpServer, type ParentSessionDefaults } from './controlMcpServer'

function parseArgs(argv: string[]): { url: string | null; token: string | null } {
    let url: string | null = null
    let token: string | null = null
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--url' && i + 1 < argv.length) {
            url = argv[++i]
        } else if (arg === '--token' && i + 1 < argv.length) {
            token = argv[++i]
        } else if (arg.startsWith('--url=')) {
            url = arg.slice('--url='.length)
        } else if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length)
        }
    }
    return { url, token }
}

async function resolveCredentials(flags: { url: string | null; token: string | null }): Promise<{ url: string; token: string }> {
    let url = flags.url
    let token = flags.token

    if (!url || !token) {
        const settings = await readSettings()
        url = url || process.env.HAPI_API_URL || settings.apiUrl || settings.serverUrl || configuration.apiUrl
        token = token || process.env.CLI_API_TOKEN || settings.cliApiToken || configuration.cliApiToken
    }

    if (!url) {
        throw new Error('Missing hub URL. Pass --url, set HAPI_API_URL, or configure ~/.hapi/settings.json.')
    }
    if (!token) {
        throw new Error('Missing CLI_API_TOKEN. Pass --token, set the env var, or run `hapi auth login`.')
    }

    return { url, token }
}

/**
 * Resolve create_session defaults from the parent session. Returns null-ish
 * fields per item when the session cannot be read (archived, hub hiccup) —
 * the tool then requires explicit arguments for those.
 */
async function fetchParentDefaults(bridge: HubApiBridge, parentSessionId: string): Promise<ParentSessionDefaults> {
    const empty: ParentSessionDefaults = {
        machineId: null, directory: null, flavor: null, model: null, codexProfile: null, codexProvider: null, permissionMode: null
    }
    try {
        const session = await bridge.getSession(parentSessionId)
        return {
            machineId: session.machineId,
            directory: session.path,
            flavor: session.flavor,
            model: session.model,
            codexProfile: session.codexProfile,
            codexProvider: session.codexProvider,
            permissionMode: session.permissionMode
        }
    } catch (error) {
        logger.debug('[hapi-mcp-control] could not load parent session defaults; create_session will require explicit args', error)
        return empty
    }
}

export async function runMcpControlBridge(argv: string[]): Promise<void> {
    try {
        const flags = parseArgs(argv)
        const { url, token } = await resolveCredentials(flags)
        const parsedUrl = new URL(url)
        if (parsedUrl.port !== '3010') {
            throw new Error('hapi-control MCP is restricted to the 3010 Hub')
        }
        const parentSessionId = process.env.HAPI_SESSION_ID?.trim()
        if (!parentSessionId) {
            throw new Error('hapi-control MCP must run inside an existing HAPI session (HAPI_SESSION_ID missing)')
        }

        logger.debug(`[hapi-mcp-control] starting, hub: ${url}`)
        // Fail fast on bad credentials so misconfiguration surfaces
        // immediately instead of on the first tool call.
        const bridge = new HubApiBridge({ baseUrl: url, accessToken: token })

        // Fetch the parent session once so create_session can default its
        // arguments to the current session (machine/directory/flavor/model/
        // provider). Failure is non-fatal: the tool falls back to requiring
        // explicit machineId+directory.
        const defaults = await fetchParentDefaults(bridge, parentSessionId)

        const server = createControlMcpServer(bridge, parentSessionId, defaults)
        const transport = new StdioServerTransport()
        await server.connect(transport)
    } catch (error) {
        // stdout is the MCP channel; diagnostics must go to stderr.
        process.stderr.write(`[hapi-mcp-control] Fatal: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
    }
}
