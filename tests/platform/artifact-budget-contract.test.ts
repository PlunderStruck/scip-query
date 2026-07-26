import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function typeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...typeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('production artifact budget contract', () => {
  it('keeps every raw synchronous file materialization inside a reviewed bounded owner', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const owners = typeScriptFiles(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('readFileSync('))
      .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
      .sort();

    expect(owners).toEqual([
      'src/filesystem/bounded-file.ts',
      'src/platform/project-files.ts',
      'src/tla/instrument.ts',
    ]);

    const boundedFile = readFileSync(join(sourceRoot, 'filesystem', 'bounded-file.ts'), 'utf8');
    expect(boundedFile).toContain('assertReadableIdentity(before');
    expect(boundedFile).toContain('readFileSync(descriptor)');

    const projectFiles = readFileSync(join(sourceRoot, 'platform', 'project-files.ts'), 'utf8');
    expect(projectFiles).toContain('before.size > maxBytes');
    expect(projectFiles).toContain("'changed-during-read'");
    expect(projectFiles).toContain('readFileSync(descriptor)');

    const generatedRecorder = readFileSync(join(sourceRoot, 'tla', 'instrument.ts'), 'utf8');
    expect(generatedRecorder).toContain('TRACE_MAX_BYTES = 16 * 1024 * 1024');
    expect(generatedRecorder).toContain('statSync(tracePath).size');
    expect(generatedRecorder).toContain('Buffer.byteLength(payload)');
  });
});
