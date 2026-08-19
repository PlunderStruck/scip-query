import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stronglyConnectedComponents } from '../../src/analysis/strongly-connected-components.js';

describe('source import cycle contract', () => {
  it('keeps production TypeScript modules acyclic', () => {
    const sourceRoot = resolve('src');
    const files = sourceFiles(sourceRoot);
    const knownFiles = new Set(files);
    const graph = new Map<string, Set<string>>();

    for (const file of files) {
      const dependencies = new Set<string>();
      const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles;
      for (const imported of imports) {
        const dependency = resolveLocalImport(file, imported.fileName, knownFiles);
        if (dependency) dependencies.add(dependency);
      }
      graph.set(file, dependencies);
    }

    const cycles = stronglyConnectedComponents(graph)
      .components.filter((component) => component.length > 1 || graph.get(component[0]!)?.has(component[0]!))
      .map((component) => component.map((file) => relative(sourceRoot, file).split(sep).join('/')).sort())
      .sort((left, right) => left.join('\0').localeCompare(right.join('\0')));

    expect(cycles).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && isTypeScriptSource(path) ? [path] : [];
    })
    .sort();
}

function resolveLocalImport(importer: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = resolve(dirname(importer), specifier);
  const candidates = [
    resolved,
    resolved.replace(/\.js$/, '.ts'),
    resolved.replace(/\.jsx$/, '.tsx'),
    resolved.replace(/\.mjs$/, '.mts'),
    resolved.replace(/\.cjs$/, '.cts'),
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.mts`,
    `${resolved}.cts`,
    join(resolved, 'index.ts'),
    join(resolved, 'index.tsx'),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function isTypeScriptSource(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
}
