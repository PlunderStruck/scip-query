import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, unknown>;
}

describe('runtime support contract', () => {
  it('aligns the package, lockfile, and installed addon on Node 22 and better-sqlite3 13', () => {
    const packageJson = readJson('package.json') as {
      version?: string;
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
      allowScripts?: Record<string, boolean>;
      scripts?: Record<string, string>;
    };
    const packageLock = readJson('package-lock.json') as {
      packages?: Record<
        string,
        {
          version?: string;
          engines?: Record<string, string>;
          dependencies?: Record<string, string>;
          hasInstallScript?: boolean;
        }
      >;
    };
    const installedAddon = readJson('node_modules/better-sqlite3/package.json') as {
      version?: string;
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const buildConfig = readFileSync(resolve(root, 'tsup.config.ts'), 'utf8');
    const rootLock = packageLock.packages?.[''];
    const addonLock = packageLock.packages?.['node_modules/better-sqlite3'];

    expect(packageJson.version).toBe('0.23.0');
    expect(packageJson.scripts?.test).toBe('vitest run --maxWorkers=2');
    expect(packageJson.engines?.node).toBe('>=22.0.0');
    expect(packageJson.dependencies?.['better-sqlite3']).toBe('^13.0.2');
    expect(packageJson.allowScripts?.['better-sqlite3']).toBe(false);
    expect(buildConfig.match(/target: 'node22'/g)).toHaveLength(5);
    expect(buildConfig).toContain("external: ['./cli-main.js', './query-service-fastpath.js']");
    expect(buildConfig).toContain("entry: { 'query-service-fastpath': 'src/runtime/query-service-fastpath.ts' }");
    expect(buildConfig).not.toContain("target: 'node18'");

    expect(rootLock?.version).toBe('0.23.0');
    expect(rootLock?.engines?.node).toBe('>=22.0.0');
    expect(rootLock?.dependencies?.['better-sqlite3']).toBe('^13.0.2');
    expect(addonLock?.version).toBe('13.0.2');
    expect(addonLock?.engines?.node).toBe('>=22');
    expect(addonLock?.dependencies).toEqual({ 'node-addon-api': '^8.0.0' });
    expect(addonLock?.hasInstallScript).not.toBe(true);
    expect(packageLock.packages).not.toHaveProperty('node_modules/prebuild-install');

    expect(installedAddon.version).toBe('13.0.2');
    expect(installedAddon.engines?.node).toBe('>=22');
    expect(installedAddon.dependencies).toEqual({ 'node-addon-api': '^8.0.0' });
    expect(installedAddon.scripts).not.toHaveProperty('install');
  });

  it('executes the bundled N-API database boundary without lifecycle setup', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE runtime_contract (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO runtime_contract(value) VALUES (?)');
      insert.run('bundled');

      expect(db.prepare('SELECT value FROM runtime_contract WHERE id = 1').pluck().get()).toBe('bundled');
    } finally {
      db.close();
    }
  });
});
