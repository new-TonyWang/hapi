/**
 * Pure Codex profile resolution.
 *
 * Codex >= 0.134 profiles are external files: `<name>.config.toml` under
 * CODEX_HOME. The `[profiles.name]` table and top-level `profile =` in
 * config.toml are legacy (no longer read by Codex); they remain supported
 * here only as a compatibility fallback for machines with older configs.
 *
 * Resolution order for the same name: external file object first (current
 * Codex behavior), legacy table second (fallback). When neither exists the
 * result is a clear error. An explicit provider always overrides the final
 * `model_provider`.
 *
 * Names are validated defensively. External Codex profile names are limited
 * to letters/numbers/hyphen/underscore, but HAPI keeps accepting legacy
 * quoted/space names (e.g. `legacy work`) for the fallback table; callers
 * must not forward such names to `codex -p`.
 *
 * No I/O, no TOML parsing, no argv handling here. Never mutates its inputs
 * (the returned config is a fresh shallow copy); never logs config contents.
 */

export type ResolveProfileConfigResult =
    | {
        ok: true;
        source: 'external' | 'legacy';
        config: Record<string, unknown>;
    }
    | {
        ok: false;
        message: string;
    };

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f]/;

function isUsableObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateProfileName(profileName: string): string | null {
    if (typeof profileName !== 'string' || profileName.trim().length === 0) {
        return 'Codex profile name must be a non-empty string';
    }
    if (profileName.includes('/') || profileName.includes('\\')) {
        return `Codex profile name must not contain path separators: ${JSON.stringify(profileName)}`;
    }
    if (profileName === '.' || profileName === '..') {
        return `Codex profile name must not be a path segment: ${JSON.stringify(profileName)}`;
    }
    if (CONTROL_CHARACTER_PATTERN.test(profileName)) {
        return `Codex profile name must not contain control characters: ${JSON.stringify(profileName)}`;
    }
    return null;
}

function buildResult(
    source: 'external' | 'legacy',
    base: Record<string, unknown>,
    explicitProvider: string | null | undefined
): ResolveProfileConfigResult {
    const config: Record<string, unknown> = { ...base };
    if (typeof explicitProvider === 'string' && explicitProvider.trim().length > 0) {
        config.model_provider = explicitProvider;
    }
    return { ok: true, source, config };
}

export function resolveProfileConfig(
    profileName: string,
    legacyProfiles: Record<string, unknown> | null | undefined,
    externalProfile: Record<string, unknown> | null | undefined,
    explicitProvider?: string | null
): ResolveProfileConfigResult {
    const invalidNameMessage = validateProfileName(profileName);
    if (invalidNameMessage !== null) {
        return { ok: false, message: invalidNameMessage };
    }

    if (isUsableObject(externalProfile)) {
        return buildResult('external', externalProfile, explicitProvider);
    }

    const legacyTable = isUsableObject(legacyProfiles) ? legacyProfiles : null;
    if (legacyTable !== null && Object.prototype.hasOwnProperty.call(legacyTable, profileName)) {
        const legacyEntry = legacyTable[profileName];
        if (isUsableObject(legacyEntry)) {
            return buildResult('legacy', legacyEntry, explicitProvider);
        }
    }

    return {
        ok: false,
        message: `Codex profile not found (no external profile object and no legacy profile table entry): ${JSON.stringify(profileName)}`
    };
}
