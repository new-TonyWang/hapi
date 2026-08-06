import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexProfiles } from './codexModels';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('listCodexProfiles', () => {
    it('scans profile config files and profiles declared in config.toml', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-profiles-'));
        tempDirs.push(codexHome);
        writeFileSync(join(codexHome, 'tokenmax.config.toml'), 'model = "gpt-5"\n');
        writeFileSync(join(codexHome, 'glm.config.toml'), 'model = "glm-4"\n');
        writeFileSync(join(codexHome, 'config.toml'), [
            '[profiles.work]',
            'model = "gpt-5"',
            '[profiles.tokenmax]',
            'model = "gpt-5"'
        ].join('\n'));
        mkdirSync(join(codexHome, 'ignored.config.toml'));
        writeFileSync(join(codexHome, 'not-a-profile.toml'), 'model = "ignored"\n');

        expect(listCodexProfiles(codexHome)).toEqual(['glm', 'tokenmax', 'work']);
    });

    it('returns an empty list when CODEX_HOME does not exist', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-codex-profiles-missing-'));
        tempDirs.push(root);

        expect(listCodexProfiles(join(root, 'missing'))).toEqual([]);
    });
});
