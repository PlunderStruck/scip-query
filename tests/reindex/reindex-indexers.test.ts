import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { INDEXER_CONFIGS, getIndexerConfig, temporaryRootConfigContent } from '../../src/reindex/indexers.js';

const tempDirs: string[] = [];

function createProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('indexer configs', () => {
  it('uses the resolved TypeScript indexer binary directly instead of npx', () => {
    const config = getIndexerConfig('typescript');
    const command = config.indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: '/tmp/scip-typescript',
      pnpmWorkspaces: true,
    });

    expect(command).toEqual({
      binary: '/tmp/scip-typescript',
      args: [
        'index',
        '--pnpm-workspaces',
        '--output',
        '/tmp/project/index.scip',
        '--no-progress-bar',
        '--no-global-caches',
      ],
    });
  });

  it('uses an owned temporary root config instead of asking scip-typescript to write one', () => {
    const typescript = getIndexerConfig('typescript').indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: '/tmp/scip-typescript',
    });
    const javascript = getIndexerConfig('javascript').indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: '/tmp/scip-typescript',
    });

    expect(typescript.args).not.toContain('--infer-tsconfig');
    expect(temporaryRootConfigContent({ language: 'typescript' })).toBe('{}');
    expect(javascript.args).not.toContain('--infer-tsconfig');
    expect(temporaryRootConfigContent({ language: 'javascript' })).toBe('{"compilerOptions":{"allowJs":true}}');
    expect(temporaryRootConfigContent({ language: 'typescript', projectPath: 'packages/web' })).toBeUndefined();
    expect(temporaryRootConfigContent({ language: 'typescript', pnpmWorkspaces: true })).toBeUndefined();
  });

  it('passes an explicit TypeScript project without infer or workspace flags', () => {
    const config = getIndexerConfig('typescript');
    const command = config.indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: '/tmp/scip-typescript',
      pnpmWorkspaces: true,
      projectPath: 'packages/web',
    });

    expect(command).toEqual({
      binary: '/tmp/scip-typescript',
      args: ['index', '--output', '/tmp/project/index.scip', '--no-progress-bar', '--no-global-caches', 'packages/web'],
    });
  });

  it('uses scip-python-plus directly instead of npx scip-python', () => {
    const config = getIndexerConfig('python');
    const command = config.indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: '/tmp/scip-python-plus',
    });

    expect(config.indexerBinary).toBe('scip-python-plus');
    expect(command).toEqual({
      binary: '/tmp/scip-python-plus',
      args: ['index', '--output', '/tmp/project/index.scip', '--project-name', 'project'],
    });
  });

  it('runs scip-clojure with project root, output, and optional config path', () => {
    const config = getIndexerConfig('clojure');

    expect(
      config.indexArgs({
        projectRoot: '/tmp/project',
        outputPath: '/tmp/project/index.scip',
        indexerBinary: 'scip-clojure',
      }),
    ).toEqual({
      binary: 'scip-clojure',
      args: ['-root', '/tmp/project', '-output', '/tmp/project/index.scip'],
    });

    expect(
      config.indexArgs({
        projectRoot: '/tmp/project',
        outputPath: '/tmp/project/index.scip',
        indexerBinary: '/tmp/scip-clojure',
        configPath: '.scip-clojure.json',
      }),
    ).toEqual({
      binary: '/tmp/scip-clojure',
      args: [
        '-root',
        '/tmp/project',
        '-output',
        '/tmp/project/index.scip',
        '-config',
        '/tmp/project/.scip-clojure.json',
      ],
    });
  });

  it('uses the current scip-ruby invocation shape and default output path', () => {
    const config = getIndexerConfig('ruby');
    const command = config.indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/custom.scip',
      indexerBinary: 'scip-ruby',
    });

    expect(command).toEqual({
      binary: 'scip-ruby',
      args: ['--dir', '.'],
    });
    expect(config.defaultOutputPath).toBe('index.scip');
  });

  it('uses scip-clang index-output-path instead of the stale output flag', () => {
    const config = getIndexerConfig('cpp');
    const command = config.indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: 'scip-clang',
    });

    expect(command.args).toEqual([
      '--compdb-path',
      'compile_commands.json',
      '--index-output-path',
      '/tmp/project/index.scip',
    ]);
  });

  it('uses the current scip-dart CLI without an index subcommand', () => {
    const config = getIndexerConfig('dart');
    const command = config.indexArgs({
      projectRoot: '/tmp/project',
      outputPath: '/tmp/project/index.scip',
      indexerBinary: 'scip-dart',
    });

    expect(command).toEqual({
      binary: 'scip-dart',
      args: ['--output', '/tmp/project/index.scip'],
    });
  });

  it('has a distinct Visual Basic language bucket that resolves vbproj targets', () => {
    const projectRoot = createProject('scip-query-indexers-vb-');
    writeFileSync(join(projectRoot, 'Legacy.vbproj'), '<Project />\n');

    const config = getIndexerConfig('vb');
    const command = config.indexArgs({
      projectRoot,
      outputPath: join(projectRoot, 'index.scip'),
      indexerBinary: 'scip-dotnet',
    });

    expect(command.binary).toBe('scip-dotnet');
    expect(command.args).toEqual([
      'index',
      join(projectRoot, 'Legacy.vbproj'),
      '--output',
      join(projectRoot, 'index.scip'),
      '--working-directory',
      projectRoot,
    ]);
  });

  it('prefers a C# solution over Unity-generated project files', () => {
    const projectRoot = createProject('scip-query-indexers-unity-');
    writeFileSync(join(projectRoot, 'Assembly-CSharp-Editor.csproj'), '<Project />\n');
    writeFileSync(join(projectRoot, 'Assembly-CSharp.csproj'), '<Project />\n');
    writeFileSync(join(projectRoot, 'Birds.sln'), 'Microsoft Visual Studio Solution File\n');

    const config = getIndexerConfig('csharp');
    const command = config.indexArgs({
      projectRoot,
      outputPath: join(projectRoot, 'index.scip'),
      indexerBinary: 'scip-dotnet',
    });

    expect(command.binary).toBe('scip-dotnet');
    expect(command.args).toEqual([
      'index',
      join(projectRoot, 'Birds.sln'),
      '--output',
      join(projectRoot, 'index.scip'),
      '--working-directory',
      projectRoot,
    ]);
  });

  it('uses only the PHP indexer identity selected by reindex policy', () => {
    const projectRoot = createProject('scip-query-indexers-php-');
    mkdirSync(join(projectRoot, 'vendor', 'bin'), { recursive: true });
    writeFileSync(join(projectRoot, 'vendor', 'bin', 'scip-php'), '#!/usr/bin/env php\n');

    const config = getIndexerConfig('php');
    const installedCommand = config.indexArgs({
      projectRoot,
      outputPath: join(projectRoot, 'custom.scip'),
      indexerBinary: 'scip-php',
    });

    expect(installedCommand).toEqual({ binary: 'scip-php', args: [] });

    const trustedPath = join(projectRoot, 'vendor', 'bin', 'scip-php');
    const trustedCommand = config.indexArgs({
      projectRoot,
      outputPath: join(projectRoot, 'custom.scip'),
      indexerBinary: trustedPath,
    });
    expect(trustedCommand.binary).toBe('php');
    expect(trustedCommand.args).toEqual([
      '-d',
      'error_reporting=E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED',
      trustedPath,
    ]);
    expect(config.defaultOutputPath).toBe('index.scip');
    expect(config.installMethods).toEqual([]);
  });

  it('uses release-based manual install guidance for java-family indexers instead of stale coursier commands', () => {
    const java = getIndexerConfig('java');
    const scala = getIndexerConfig('scala');
    const kotlin = getIndexerConfig('kotlin');

    expect(java.installMethods).toEqual([]);
    expect(scala.installMethods).toEqual([]);
    expect(kotlin.installMethods).toEqual([]);
    expect(java.installUrl).toContain('scip-java/releases');
  });

  it('keeps every automated installer request immutable and destination-owned', () => {
    const methods = Object.values(INDEXER_CONFIGS).flatMap((config) => config.installMethods ?? []);

    expect(methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identity: '@sourcegraph/scip-typescript@0.4.0' }),
        expect.objectContaining({ identity: 'scip-python-plus@0.7.5' }),
        expect.objectContaining({ identity: 'github.com/sourcegraph/scip-go@v0.2.7' }),
        expect.objectContaining({ identity: 'scip-dotnet@0.2.14' }),
        expect.objectContaining({ identity: 'scip_dart@1.6.2' }),
      ]),
    );
    for (const method of methods) {
      expect(method.identity).toMatch(/@(?:v)?\d+\.\d+\.\d+$/);
      expect(method.identity).not.toContain('@latest');
      expect(method.destination?.trim()).not.toBe('');
      expect(method.args.join(' ')).toContain(method.identity!.replace(/@v?(\d+\.\d+\.\d+)$/, ''));
    }
    expect(getIndexerConfig('rust').installMethods).toEqual([]);
  });
});
