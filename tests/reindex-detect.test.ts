import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectLanguages } from '../src/reindex/detect.js';

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

describe('detectLanguages', () => {
  it('detects C++ projects from source extensions and does not also claim C for header-only matches', () => {
    const projectRoot = createProject('scip-query-detect-cpp-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'include'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'main.cpp'), 'int main() { return 0; }\n');
    writeFileSync(join(projectRoot, 'include', 'engine.hpp'), '#pragma once\n');

    const languages = detectLanguages(projectRoot);
    expect(languages).toContain('cpp');
    expect(languages).not.toContain('c');
  });

  it('detects C projects when C source files are present', () => {
    const projectRoot = createProject('scip-query-detect-c-');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'main.c'), 'int main(void) { return 0; }\n');
    writeFileSync(join(projectRoot, 'src', 'main.h'), '#pragma once\n');

    const languages = detectLanguages(projectRoot);
    expect(languages).toContain('c');
  });

  it('detects both C# and Visual Basic from project files instead of skipping wildcard markers', () => {
    const projectRoot = createProject('scip-query-detect-dotnet-');
    writeFileSync(join(projectRoot, 'App.csproj'), '<Project />\n');
    writeFileSync(join(projectRoot, 'Legacy.vbproj'), '<Project />\n');

    const languages = detectLanguages(projectRoot);
    expect(languages).toContain('csharp');
    expect(languages).toContain('vb');
  });

  it('keeps TypeScript as the canonical JS-family language when both are present', () => {
    const projectRoot = createProject('scip-query-detect-ts-');
    writeFileSync(join(projectRoot, 'package.json'), '{}\n');
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{}\n');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'main.ts'), 'export const answer = 42;\n');
    writeFileSync(join(projectRoot, 'src', 'legacy.js'), 'module.exports = 42;\n');

    const languages = detectLanguages(projectRoot);
    expect(languages).toContain('typescript');
    expect(languages).not.toContain('javascript');
  });
});
