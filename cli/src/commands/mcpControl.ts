import { runMcpControlBridge } from '@/mcpControl/runMcpControlBridge'
import type { CommandDefinition } from './types'

export const mcpControlCommand: CommandDefinition = {
    name: 'mcp-control',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        await runMcpControlBridge(commandArgs)
    }
}
