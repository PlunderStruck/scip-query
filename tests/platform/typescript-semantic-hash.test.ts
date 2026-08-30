import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recoverTypeScriptPackageSemanticHash,
  typeScriptPackageSemanticHash,
  typeScriptSemanticHash,
} from '../../src/platform/typescript-semantic-hash.js';

describe('TypeScript semantic hash', () => {
  it('ignores spaces and repeated blank lines while preserving the first line boundary', () => {
    const compact = typeScriptSemanticHash('value.ts', 'const a = 1;\nconst b = 2;\n');
    const spaced = typeScriptSemanticHash('value.ts', 'const   a = 1;\n\n\nconst b = 2;\n');
    const sameLine = typeScriptSemanticHash('value.ts', 'const a = 1; const b = 2;\n');

    expect(spaced).toBe(compact);
    expect(sameLine).not.toBe(compact);
  });

  it('keeps comments, literals, and JSX text in the fingerprint', () => {
    expect(typeScriptSemanticHash('value.ts', '// @ts-ignore\nconst value = "a";\n')).not.toBe(
      typeScriptSemanticHash('value.ts', '// ordinary comment\nconst value = "a";\n'),
    );
    expect(typeScriptSemanticHash('value.ts', 'const value = "a";\n')).not.toBe(
      typeScriptSemanticHash('value.ts', 'const value = "b";\n'),
    );
    expect(typeScriptSemanticHash('value.tsx', 'const view = <p>a</p>;\n')).not.toBe(
      typeScriptSemanticHash('value.tsx', 'const view = <p>b</p>;\n'),
    );
  });

  it('stays unavailable for source formats the TypeScript scanner cannot safely classify', () => {
    expect(typeScriptSemanticHash('Component.vue', '<template>value</template>')).toBeUndefined();
  });
});

describe('TypeScript package semantic hash', () => {
  it('ignores formatting, key order, and scripts', () => {
    const first = typeScriptPackageSemanticHash(
      'package.json',
      JSON.stringify({ scripts: { test: 'vitest' }, type: 'module', dependencies: { typescript: '1' } }),
    );
    const second = typeScriptPackageSemanticHash(
      'package.json',
      JSON.stringify({ dependencies: { typescript: '1' }, type: 'module', scripts: { test: 'jest' } }, null, 2),
    );

    expect(second).toBe(first);
  });

  it('keeps compiler and dependency inputs in the fingerprint', () => {
    expect(typeScriptPackageSemanticHash('package.json', '{"type":"module"}')).not.toBe(
      typeScriptPackageSemanticHash('package.json', '{"type":"commonjs"}'),
    );
    expect(typeScriptPackageSemanticHash('package.json', '{"dependencies":{"typescript":"1"}}')).not.toBe(
      typeScriptPackageSemanticHash('package.json', '{"dependencies":{"typescript":"2"}}'),
    );
  });

  it('recovers a legacy package semantic hash from a byte-identical Git blob', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-package-history-'));
    const packagePath = join(projectRoot, 'package.json');
    const previous = `${JSON.stringify({ type: 'module', scripts: { test: 'vitest' } }, null, 2)}\n`;
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
      writeFileSync(packagePath, previous);
      execFileSync('git', ['add', 'package.json'], { cwd: projectRoot });
      execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'base'],
        { cwd: projectRoot },
      );

      expect(
        recoverTypeScriptPackageSemanticHash(
          projectRoot,
          'package.json',
          createHash('sha256').update(previous).digest('hex'),
        ),
      ).toBe(typeScriptPackageSemanticHash('package.json', previous));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
