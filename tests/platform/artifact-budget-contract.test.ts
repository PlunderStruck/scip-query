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
  it('prohibits unbounded synchronous whole-file reads in production', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const owners = typeScriptFiles(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('readFileSync('))
      .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
      .sort();

    expect(owners).toEqual([]);
  });
});
