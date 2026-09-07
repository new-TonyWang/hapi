/**
 * Runner-local Codex profile loading (I/O layer).
 *
 * Reads CODEX_HOME (default ~/.codex) once per resolution:
 * - legacy `[profiles]` table from config.toml (Codex >= 0.134 no longer
 *   reads it; kept as a compatibility fallback), and
 * - the parsed object of the selected external `<name>.config.toml`.
 *
 * Resolution order: profile name validation FIRST (any invalid or
 * path-traversing name is rejected before a single filesystem call), then
 * the external file, then the legacy table fallback. A selected external
 * file that exists but is malformed/unreadable is an explicit error — it
 * must never silently fall back to the legacy table.
 *
 * The explicit provider is independent of the profile: it flows out as its
 * own field so provider-only sessions (no profile selected) keep working.
 * When both exist, the explicit provider overrides the profile's
 * model_provider (applied by resolveProfileConfig).
 *
 * The result is meant to be applied through the app-server JSON-RPC
 * `config` / `modelProvider` fields — never through `-p`/`-c profile=`
 * (both rejected or deprecated for app-server) and never through argv.
 *
 * TOML parsing is injected: production uses Bun.TOML; tests inject a stub.
 * The TOML parser is a real parser — never a hand-rolled line regex — so
 * quoted keys, numbers, booleans, arrays and inline tables survive intact.
 *
 * Credentials stay on the runner: nothing here logs config contents or
 * returns values to the Hub; only resolved profile *keys* flow onward.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveProfileConfig, type ResolveProfileConfigResult } from './resolveProfileConfig';

/** Minimal TOML parse contract; production implementation is Bun.TOML.parse. */
export type TomlParser = (source: string) => Record<string, unknown>;

const FALLBACK_TOML_PARSER: TomlParser | null =
    typeof Bun !== 'undefined' && Bun.TOML
        ? (source: string) => Bun.TOML.parse(source) as Record<string, unknown>
        : null;

/**
 * Resolve outcome: the profile part (null when no profile requested;
 * ok:false for invalid names, broken files, or not-found profiles) plus the
 * explicit provider carried independently, so provider-only sessions work
 * without any profile existing.
 */
export type ResolveCodexProfileOutcome = {
    profile: ResolveProfileConfigResult | null;
    provider: string | undefined;
};

/** Re-exported so callers can validate before any filesystem access. */
export function validateCodexProfileName(profileName: string): string | null {
    if (typeof profileName !== 'string' || profileName.trim().length === 0) {
        return 'Codex profile name must be a non-empty string';
    }
    if (profileName.includes('/') || profileName.includes('\\')) {
        return `Codex profile name must not contain path separators: ${JSON.stringify(profileName)}`;
    }
    if (profileName === '.' || profileName === '..') {
        return `Codex profile name must not be a path segment: ${JSON.stringify(profileName)}`;
    }
    if (/[\u0000-\u001f]/.test(profileName)) {
        return `Codex profile name must not contain control characters: ${JSON.stringify(profileName)}`;
    }
    return null;
}

/**
 * Parse a TOML file. Returns:
 * - `{ status: 'absent' }` when the file does not exist
 * - `{ status: 'invalid' }` when it exists but cannot be parsed — callers
 *   decide whether that is fatal (selected external profile) or ignorable
 *   (main config.toml; the legacy fallback stays reachable)
 */
type ParsedTomlFile =
    | { status: 'absent' }
    | { status: 'invalid' }
    | { status: 'parsed'; value: Record<string, unknown> };

function parseTomlFile(path: string, parseToml: TomlParser | null): ParsedTomlFile {
    if (!parseToml || !existsSync(path)) {
        return { status: 'absent' };
    }
    try {
        const value = parseToml(readFileSync(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? { status: 'parsed', value }
            : { status: 'invalid' };
    } catch {
        return { status: 'invalid' };
    }
}

export type ResolveCodexProfileOptions = {
    /** Overrides CODEX_HOME / ~/.codex (tests pass a temp directory). */
    codexHome?: string;
    /** Injected TOML parser; defaults to Bun.TOML when available. */
    parseToml?: TomlParser | null;
};

function resolveCodexHome(options: ResolveCodexProfileOptions): string {
    return options.codexHome
        ?? (process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0
            ? process.env.CODEX_HOME
            : join(homedir(), '.codex'));
}

/**
 * Resolve a Codex profile and the explicit provider, runner-local.
 *
 * The profile part is null when no profile is requested. Invalid names are
 * rejected BEFORE any filesystem access. A selected external profile file
 * that is malformed or unreadable returns an explicit error (no silent
 * legacy fallback); a missing/invalid main config.toml merely disables the
 * legacy fallback. Callers must abort session startup on profile ok:false
 * and surface the message (profile names only, never config contents).
 *
 * The provider field is set independently of the profile result whenever an
 * explicit non-empty provider was given — provider-only sessions never
 * depend on a profile existing.
 */
export function resolveCodexProfileConfig(
    profileName: string | null | undefined,
    explicitProvider?: string | null,
    options: ResolveCodexProfileOptions = {}
): ResolveCodexProfileOutcome {
    const provider = typeof explicitProvider === 'string' && explicitProvider.trim().length > 0
        ? explicitProvider.trim()
        : undefined;

    if (typeof profileName !== 'string' || profileName.trim().length === 0) {
        return { profile: null, provider };
    }

    // Validate the name before touching the filesystem: traversal/invalid
    // names must never reach join/existsSync/readFileSync.
    const invalidNameMessage = validateCodexProfileName(profileName);
    if (invalidNameMessage !== null) {
        return { profile: { ok: false, message: invalidNameMessage }, provider };
    }

    const codexHome = resolveCodexHome(options);
    const parseToml = options.parseToml !== undefined ? options.parseToml : FALLBACK_TOML_PARSER;

    // The selected external profile file is authoritative when present:
    // malformed/unreadable means a broken profile, which is a hard error.
    const externalPath = join(codexHome, `${profileName}.config.toml`);
    const externalFile = parseTomlFile(externalPath, parseToml);
    if (externalFile.status === 'invalid') {
        return {
            profile: {
                ok: false,
                message: `Codex profile file exists but could not be parsed: ${JSON.stringify(profileName)} (expected ${externalPath})`
            },
            provider
        };
    }
    const externalProfile = externalFile.status === 'parsed' ? externalFile.value : null;

    // The main config.toml only feeds the legacy fallback; when it is
    // absent or malformed there is simply no legacy table to consult.
    const mainConfigFile = parseTomlFile(join(codexHome, 'config.toml'), parseToml);
    const mainConfig = mainConfigFile.status === 'parsed' ? mainConfigFile.value : null;
    const legacyProfilesTable = mainConfig?.profiles;
    const legacyProfiles = typeof legacyProfilesTable === 'object'
        && legacyProfilesTable !== null
        && !Array.isArray(legacyProfilesTable)
        ? legacyProfilesTable as Record<string, unknown>
        : null;

    return {
        profile: resolveProfileConfig(profileName, legacyProfiles, externalProfile, provider),
        provider
    };
}
