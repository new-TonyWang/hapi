import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
    existsSyncMock: vi.fn((_path: string) => false),
    readFileSyncMock: vi.fn((_path: string) => '')
}));

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: (path: string) => {
            existsSyncMock(path);
            return (actual.existsSync as (p: string) => boolean)(path);
        },
        readFileSync: ((path: string, ...rest: unknown[]) => {
            readFileSyncMock(path);
            return (actual.readFileSync as (p: string, ...r: unknown[]) => string)(path, ...rest);
        }) as typeof import('node:fs').readFileSync
    };
});

import { resolveCodexProfileConfig } from './codexProfileConfig';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

beforeEach(() => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();
});

/** Real-TOML-semantics stub: mirrors Bun.TOML for the test fixtures. */
function stubTomlParser(source: string): Record<string, unknown> {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
}

function makeCodexHome(files: Record<string, string>): string {
    const home = mkdtempSync(join(tmpdir(), 'hapi-profile-config-'));
    tempDirs.push(home);
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(home, name), content);
    }
    return home;
}

describe('resolveCodexProfileConfig', () => {
    it('resolves an external file profile with full TOML semantics (strings, numbers, arrays, quoted keys)', () => {
        const home = makeCodexHome({
            'work.config.toml': JSON.stringify({
                model: 'gpt-5',
                model_reasoning_effort: 'high',
                temperature: 0.2,
                experimental: ['a', 'b'],
                'quoted key': 'kept',
                nested: { model_provider: 'custom-proxy', retries: 3 }
            })
        });

        const result = resolveCodexProfileConfig('work', undefined, {
            codexHome: home,
            parseToml: stubTomlParser
        });

        expect(result.profile).toEqual({
            ok: true,
            source: 'external',
            config: {
                model: 'gpt-5',
                model_reasoning_effort: 'high',
                temperature: 0.2,
                experimental: ['a', 'b'],
                'quoted key': 'kept',
                nested: { model_provider: 'custom-proxy', retries: 3 }
            }
        });
        expect(result.provider).toBeUndefined();
    });

    it('falls back to the legacy [profiles] table from config.toml', () => {
        const home = makeCodexHome({
            'config.toml': JSON.stringify({
                profiles: { work: { model: 'gpt-5', model_provider: 'legacy-proxy' } }
            })
        });

        const result = resolveCodexProfileConfig('work', undefined, {
            codexHome: home,
            parseToml: stubTomlParser
        });

        expect(result.profile).toEqual({
            ok: true,
            source: 'legacy',
            config: { model: 'gpt-5', model_provider: 'legacy-proxy' }
        });
    });

    it('prefers the external file when both sources define the same name', () => {
        const home = makeCodexHome({
            'config.toml': JSON.stringify({
                profiles: { work: { model: 'legacy-model' } }
            }),
            'work.config.toml': JSON.stringify({ model: 'external-model' })
        });

        const result = resolveCodexProfileConfig('work', undefined, {
            codexHome: home,
            parseToml: stubTomlParser
        });

        expect(result.profile).toEqual({
            ok: true,
            source: 'external',
            config: { model: 'external-model' }
        });
    });

    it('applies the explicit provider over the profile provider and reports it independently', () => {
        const home = makeCodexHome({
            'work.config.toml': JSON.stringify({
                model: 'gpt-5',
                model_provider: 'profile-proxy'
            })
        });

        const result = resolveCodexProfileConfig('work', 'explicit-proxy', {
            codexHome: home,
            parseToml: stubTomlParser
        });

        expect(result.provider).toBe('explicit-proxy');
        expect(result.profile).toEqual({
            ok: true,
            source: 'external',
            // resolveProfileConfig already folded the explicit provider in
            config: { model: 'gpt-5', model_provider: 'explicit-proxy' }
        });
    });

    it('carries the explicit provider with NO profile at all (provider-only path)', () => {
        const home = makeCodexHome({
            'config.toml': JSON.stringify({ model: 'gpt-default' })
        });

        const result = resolveCodexProfileConfig(null, 'provider-only-proxy', {
            codexHome: home,
            parseToml: stubTomlParser
        });

        expect(result).toEqual({ profile: null, provider: 'provider-only-proxy' });
    });

    it('returns a null profile and no provider when neither is requested (default path untouched)', () => {
        expect(resolveCodexProfileConfig(null, undefined, { parseToml: stubTomlParser }))
            .toEqual({ profile: null, provider: undefined });
        expect(resolveCodexProfileConfig(undefined, null, { parseToml: stubTomlParser }))
            .toEqual({ profile: null, provider: undefined });
        expect(resolveCodexProfileConfig('', '   ', { parseToml: stubTomlParser }))
            .toEqual({ profile: null, provider: undefined });
    });

    it('returns a clear error for a profile found in neither source', () => {
        const home = makeCodexHome({
            'config.toml': JSON.stringify({ profiles: { other: { model: 'gpt-5' } } })
        });

        const result = resolveCodexProfileConfig('ghost', undefined, {
            codexHome: home,
            parseToml: stubTomlParser
        });

        expect(result.profile?.ok).toBe(false);
        if (result.profile && !result.profile.ok) {
            expect(result.profile.message).toContain('not found');
            expect(result.profile.message).toContain('ghost');
        }
    });

    it('validates invalid names with ZERO filesystem calls (existsSync/readFileSync never invoked)', () => {
        for (const name of ['../escape', 'a/b', 'a\\b', '.', '..', 'bad' + String.fromCharCode(0) + 'name']) {
            const result = resolveCodexProfileConfig(name, undefined, {
                codexHome: '/definitely-should-not-be-read',
                parseToml: stubTomlParser
            });
            expect(result.profile?.ok).toBe(false);
            if (result.profile && !result.profile.ok) {
                expect(result.profile.message).toMatch(/profile name/i);
            }
        }

        expect(existsSyncMock).not.toHaveBeenCalled();
        expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    it('rejects a selected-but-malformed external file explicitly (no silent legacy fallback)', () => {
        const home = makeCodexHome({
            'config.toml': JSON.stringify({ profiles: { work: { model: 'gpt-legacy' } } }),
            'work.config.toml': '{ malformed toml'
        });

        const result = resolveCodexProfileConfig('work', undefined, {
            codexHome: home,
            parseToml: (source: string): Record<string, unknown> => {
                // strict parser: throws on malformed input like real TOML
                if (source.includes('{ malformed')) throw new Error('parse error');
                return JSON.parse(source);
            }
        });

        expect(result.profile?.ok).toBe(false);
        if (result.profile && !result.profile.ok) {
            expect(result.profile.message).toContain('could not be parsed');
            expect(result.profile.message).toContain('work');
        }
    });

    it('a malformed main config.toml disables the legacy fallback but external files still resolve', () => {
        const home = makeCodexHome({
            'config.toml': 'not [ valid toml',
            'work.config.toml': JSON.stringify({ model: 'gpt-external' })
        });

        const result = resolveCodexProfileConfig('work', undefined, {
            codexHome: home,
            parseToml: (source: string): Record<string, unknown> => {
                if (source.includes('not [ valid')) throw new Error('parse error');
                return JSON.parse(source);
            }
        });

        expect(result.profile).toEqual({
            ok: true,
            source: 'external',
            config: { model: 'gpt-external' }
        });
    });

    it('resolves from CODEX_HOME env when no explicit home is given', () => {
        const home = makeCodexHome({
            'work.config.toml': JSON.stringify({ model: 'gpt-5' })
        });
        const previous = process.env.CODEX_HOME;
        process.env.CODEX_HOME = home;
        try {
            const result = resolveCodexProfileConfig('work', undefined, {
                parseToml: stubTomlParser
            });
            expect(result.profile).toEqual({
                ok: true,
                source: 'external',
                config: { model: 'gpt-5' }
            });
        } finally {
            if (previous === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = previous;
            }
        }
    });
});
