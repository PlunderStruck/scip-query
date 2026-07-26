import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmAuditEnvironment, runProductionDependencyAudit } from '../../scripts/audit-production-dependencies.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('dependency security controls', () => {
  it('keeps the release production audit explicit and high-severity blocking', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['audit:prod']).toBe('node scripts/audit-production-dependencies.mjs');
  });

  it('removes npm run inherited lifecycle authority before invoking npm audit', () => {
    const inherited = {
      PATH: '/bin',
      npm_config_allow_scripts: 'better-sqlite3,tree-sitter',
      NPM_CONFIG_ALLOW_SCRIPTS: 'mixed-case-alias',
    };

    expect(npmAuditEnvironment(inherited)).toEqual({ PATH: '/bin' });
    expect(inherited.npm_config_allow_scripts).toBe('better-sqlite3,tree-sitter');
  });

  it('uses the Windows npm shim and propagates a failing audit status', () => {
    const calls: Array<{ command: string; args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
    const status = runProductionDependencyAudit({
      environment: { npm_config_allow_scripts: 'better-sqlite3', SAFE: 'yes' },
      platform: 'win32',
      spawn(command, args, options) {
        calls.push({
          command,
          args: args ?? [],
          environment: options?.env ?? {},
        });
        return {
          pid: 1,
          output: [],
          stdout: null,
          stderr: null,
          status: 1,
          signal: null,
        };
      },
    });

    expect(status).toBe(1);
    expect(calls).toEqual([
      {
        command: 'npm.cmd',
        args: ['audit', '--omit=dev', '--audit-level=high'],
        environment: { SAFE: 'yes' },
      },
    ]);
  });

  it('runs the production audit in CI with immutable action identities', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/dependency-security.yml'), 'utf8');

    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('npm run audit:prod');
    expect(workflow).toMatch(/uses: actions\/checkout@[a-f0-9]{40}/u);
    expect(workflow).toMatch(/uses: actions\/setup-node@[a-f0-9]{40}/u);
    expect(workflow).toContain('persist-credentials: false');
  });

  it('requests npm and GitHub Actions dependency updates', () => {
    const dependabot = readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8');

    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: github-actions');
  });
});
