import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function publicationReporters() {
  const path = 'src/reindex/index.ts';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['reportPublishedIndexMaintenance', 'reportLocalGenerationDurability'];
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(declarations).toHaveLength(names.length);
  const javascript = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const context = createContext({});
  // Exercise only publication reporting, without starting a reindex or publishing artifacts.
  runInContext(javascript, context);
  return {
    maintenance: context['reportPublishedIndexMaintenance'] as (
      changes: { added: string[]; removed: string[] },
      run: { onStatus(message: string): void },
    ) => void,
    durability: context['reportLocalGenerationDurability'] as (
      publication: { achievedDurability: string; currentGeneration: string },
      run: { onStatus(message: string): void },
    ) => void,
  };
}

describe('publication status callback compatibility', () => {
  it('retains the run receiver and reports additions before removals and durability', () => {
    const reporters = publicationReporters();
    const messages: string[] = [];
    const run = {
      marker: 'fresh-run',
      onStatus(this: { marker: string }, message: string) {
        expect(this).toBe(run);
        expect(this.marker).toBe('fresh-run');
        messages.push(message);
      },
    };
    reporters.maintenance({ added: ['a', 'b'], removed: ['old'] }, run);
    reporters.durability({ achievedDurability: 'file-flushed', currentGeneration: '123456789012abcdef' }, run);
    expect(messages).toEqual([
      'Added SQLite query indexes: a, b',
      'Removed redundant SQLite indexes: old',
      'Published local generation 123456789012 (file-flushed; directory sync unsupported)',
    ]);
  });

  it('does not access or call the callback when neither report applies', () => {
    const reporters = publicationReporters();
    const run = {
      get onStatus(): (message: string) => void {
        throw new Error('status callback must remain untouched');
      },
    };
    reporters.maintenance({ added: [], removed: [] }, run);
    reporters.durability({ achievedDurability: 'durable', currentGeneration: 'generation' }, run);
  });
});
