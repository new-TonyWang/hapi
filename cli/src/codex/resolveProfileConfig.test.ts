import { describe, expect, it } from 'vitest';
import { resolveProfileConfig } from './resolveProfileConfig';

describe('resolveProfileConfig', () => {
    it('resolves an external-file profile (current Codex >= 0.134 semantics)', () => {
        const result = resolveProfileConfig('fast', undefined, {
            model: 'gpt-5-mini',
            model_reasoning_effort: 'high'
        });

        expect(result).toEqual({
            ok: true,
            source: 'external',
            config: { model: 'gpt-5-mini', model_reasoning_effort: 'high' }
        });
    });

    it('resolves a legacy [profiles.name] entry as fallback only', () => {
        const result = resolveProfileConfig(
            'work',
            { work: { model: 'gpt-5', model_provider: 'legacy-proxy' } },
            null
        );

        expect(result).toEqual({
            ok: true,
            source: 'legacy',
            config: { model: 'gpt-5', model_provider: 'legacy-proxy' }
        });
    });

    it('prefers the external file when both sources define the same name', () => {
        const result = resolveProfileConfig(
            'work',
            { work: { model: 'legacy-model' } },
            { model: 'external-model', model_provider: 'external-proxy' }
        );

        expect(result).toEqual({
            ok: true,
            source: 'external',
            config: { model: 'external-model', model_provider: 'external-proxy' }
        });
    });

    it('falls back to the legacy table when the external object is absent', () => {
        const result = resolveProfileConfig(
            'work',
            { work: { model: 'legacy-model', model_provider: 'legacy-proxy' } },
            undefined
        );

        expect(result).toEqual({
            ok: true,
            source: 'legacy',
            config: { model: 'legacy-model', model_provider: 'legacy-proxy' }
        });
    });

    it('overrides the final model_provider with the explicit provider', () => {
        const result = resolveProfileConfig(
            'work',
            null,
            { model: 'gpt-5', model_provider: 'profile-proxy' },
            'explicit-proxy'
        );

        expect(result).toEqual({
            ok: true,
            source: 'external',
            config: { model: 'gpt-5', model_provider: 'explicit-proxy' }
        });
    });

    it('keeps the profile model_provider when no explicit provider is given', () => {
        const result = resolveProfileConfig('work', null, {
            model: 'gpt-5',
            model_provider: 'profile-proxy'
        });

        expect(result).toEqual({
            ok: true,
            source: 'external',
            config: { model: 'gpt-5', model_provider: 'profile-proxy' }
        });
    });

    it('reports a clear error when the profile exists in neither source', () => {
        const result = resolveProfileConfig('ghost', { other: { model: 'gpt-5' } }, null);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('not found');
            expect(result.message).toContain('ghost');
        }
    });

    it('rejects invalid profile names before any lookup', () => {
        const invalidNames = ['', '   ', 'a/b', 'a\\b', '.', '..', 'bad\u0000name', 'bad\u001fname'];

        for (const name of invalidNames) {
            const result = resolveProfileConfig(name, { work: { model: 'gpt-5' } }, { model: 'gpt-5' });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.message).toMatch(/profile name/i);
            }
        }
    });

    it('allows legacy quoted/space names (HAPI fallback compatibility, never passed to codex -p)', () => {
        const spaced = resolveProfileConfig('legacy work', { 'legacy work': { model: 'gpt-5' } }, null);
        expect(spaced).toEqual({ ok: true, source: 'legacy', config: { model: 'gpt-5' } });

        const dotted = resolveProfileConfig('v1.stable', null, { model: 'gpt-5' });
        expect(dotted).toEqual({ ok: true, source: 'external', config: { model: 'gpt-5' } });
    });

    it('never mutates its input objects and returns a fresh config', () => {
        const legacyProfiles = { work: { model: 'gpt-5', model_provider: 'legacy-proxy' } };
        const externalProfile = { model: 'gpt-5', model_provider: 'external-proxy', nested: { key: 'value' } };
        const legacySnapshot = structuredClone(legacyProfiles);
        const externalSnapshot = structuredClone(externalProfile);

        const result = resolveProfileConfig('work', legacyProfiles, externalProfile, 'explicit-proxy');

        expect(result.ok).toBe(true);
        expect(legacyProfiles).toEqual(legacySnapshot);
        expect(externalProfile).toEqual(externalSnapshot);
        if (result.ok) {
            expect(result.config).not.toBe(legacyProfiles.work);
            expect(result.config).not.toBe(externalProfile);
        }
    });
});
