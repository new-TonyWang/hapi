import { describe, expect, it } from 'vitest';
import type { EnhancedMode } from '../loop';
import { buildThreadStartParams } from './appServerConfig';
import { codexSystemPrompt } from './systemPrompt';

describe('buildThreadStartParams profileConfig (JSON-RPC config path)', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };
    const mode: EnhancedMode = { permissionMode: 'default', collaborationMode: 'default' };

    it('merges profile keys under HAPI-owned keys (profile fills defaults only)', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers,
            profileConfig: {
                source: 'external',
                config: {
                    model: 'gpt-5-profile',
                    model_provider: 'profile-proxy',
                    model_reasoning_effort: 'high',
                    notification: { enabled: true },
                    'quoted.key': 'kept'
                }
            }
        });

        expect(params.config).toMatchObject({
            model: 'gpt-5-profile',
            model_provider: 'profile-proxy',
            'quoted.key': 'kept',
            notification: { enabled: true },
            developer_instructions: codexSystemPrompt,
            'mcp_servers.hapi': { command: 'node', args: ['mcp'] }
        });
        expect(params.modelProvider).toBe('profile-proxy');
        // model stays unset at thread level when mode has no explicit model,
        // letting the profile's config.model apply as the thread default.
        expect(params.model).toBeUndefined();
    });

    it('keeps an explicit session model over the profile model', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { ...mode, model: 'gpt-5-explicit' },
            mcpServers,
            profileConfig: {
                source: 'external',
                config: { model: 'gpt-5-profile' }
            }
        });

        expect(params.model).toBe('gpt-5-explicit');
        expect(params.config?.model).toBe('gpt-5-profile');
        // Explicit model at the top level wins over the config-table model;
        // app-server treats thread/turn params as the stronger override.
    });

    it('keeps an explicit reasoning effort over the profile effort', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { ...mode, modelReasoningEffort: 'minimal' },
            mcpServers,
            profileConfig: {
                source: 'external',
                config: { model_reasoning_effort: 'high' }
            }
        });

        expect(params.config?.model_reasoning_effort).toBe('minimal');
    });

    it('keeps the explicit provider over the profile provider', () => {
        // resolveProfileConfig already applied the explicit provider into
        // the resolved config's model_provider before it reaches here.
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers,
            profileConfig: {
                source: 'external',
                config: { model: 'gpt-5', model_provider: 'explicit-proxy' }
            }
        });

        expect(params.modelProvider).toBe('explicit-proxy');
    });

    it('sets modelProvider from the standalone argument with NO profile (provider-only path)', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers,
            modelProvider: 'provider-only-proxy'
        });

        expect(params.modelProvider).toBe('provider-only-proxy');
        // no profile keys leaked into the config table
        expect(params.config).toEqual({
            'mcp_servers.hapi': { command: 'node', args: ['mcp'] },
            developer_instructions: codexSystemPrompt
        });
    });

    it('the standalone modelProvider argument wins over the profile provider', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers,
            profileConfig: {
                source: 'external',
                config: { model: 'gpt-5', model_provider: 'profile-proxy' }
            },
            modelProvider: 'explicit-wins-proxy'
        });

        expect(params.modelProvider).toBe('explicit-wins-proxy');
    });

    it('does not set modelProvider when the profile has no provider', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers,
            profileConfig: {
                source: 'legacy',
                config: { model: 'gpt-5' }
            }
        });

        expect(params.modelProvider).toBeUndefined();
    });

    it('leaves the no-profile default path byte-identical', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers
        });

        expect(params.modelProvider).toBeUndefined();
        expect(params.config).toEqual({
            'mcp_servers.hapi': { command: 'node', args: ['mcp'] },
            developer_instructions: codexSystemPrompt
        });
    });

    it('applies a legacy-fallback profile the same as an external one', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode,
            mcpServers,
            profileConfig: {
                source: 'legacy',
                config: { model: 'gpt-5-legacy', model_provider: 'legacy-proxy' }
            }
        });

        expect(params.config?.model).toBe('gpt-5-legacy');
        expect(params.modelProvider).toBe('legacy-proxy');
    });
});
