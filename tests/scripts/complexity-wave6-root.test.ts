import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function freshnessParser() {
  const path = 'scripts/incremental-freshness-contract.mjs';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['parseArgs', 'freshnessContractOptions', 'requiredValue', 'nonNegativeInteger', 'positiveInteger'];
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(declarations).toHaveLength(names.length);
  const context = createContext({ Error });
  // Do not load the script entrypoint: these cases never start a watcher or edit a repository.
  runInContext(declarations.map((node) => node.getText(source)).join('\n'), context);
  return context['parseArgs'] as (argv: string[]) => Record<string, unknown>;
}

describe('incremental freshness argument compatibility', () => {
  it('retains every default and returns a fresh options record', () => {
    const parse = freshnessParser();
    const first = parse([]);
    expect(first).toEqual({
      scenario: 'manual-noop-control',
      iterations: 5,
      projectRoot: undefined,
      cli: undefined,
      out: undefined,
      editFile: 'src/domain/number-parsing.ts',
      debounce: 750,
      cooldown: 1000,
      idleTimeout: 50,
      burstWrites: 20,
      burstInterval: 25,
      timeout: 60000,
    });
    first['scenario'] = 'changed';
    expect(parse([])['scenario']).toBe('manual-noop-control');
  });

  it('preserves each option mapping, last-value precedence, numeric syntax and literal paths', () => {
    const parse = freshnessParser();
    expect(
      parse([
        '--scenario',
        'daemon-edit',
        '--iterations',
        '3',
        '--iterations',
        '0x2',
        '--project-root',
        './relative-root',
        '--cli',
        './cli.mjs',
        '--out',
        './out.jsonl',
        '--edit-file',
        '--literal-name',
        '--debounce',
        '0',
        '--cooldown',
        '0',
        '--idle-timeout',
        '0',
        '--burst-writes',
        '1',
        '--burst-interval',
        '0',
        '--timeout',
        '1e2',
      ]),
    ).toEqual({
      scenario: 'daemon-edit',
      iterations: 2,
      projectRoot: './relative-root',
      cli: './cli.mjs',
      out: './out.jsonl',
      editFile: '--literal-name',
      debounce: 0,
      cooldown: 0,
      idleTimeout: 0,
      burstWrites: 1,
      burstInterval: 0,
      timeout: 100,
    });
  });

  it('preserves validation order and distinct missing, nonnegative and positive failures', () => {
    const parse = freshnessParser();
    expect(() => parse(['--scenario', 'bad', '--unknown'])).toThrow('unknown option: --unknown');
    expect(() => parse(['--scenario', 'bad'])).toThrow('unknown scenario: bad');
    expect(() => parse(['--timeout'])).toThrow('--timeout requires a value');
    expect(() => parse(['--cli', ''])).toThrow('--cli requires a value');
    expect(() => parse(['--timeout', '0'])).toThrow('--timeout must be a positive integer');
    expect(() => parse(['--cooldown', '-1'])).toThrow('--cooldown must be a non-negative integer');
    expect(() => parse(['--iterations', '1.5'])).toThrow('--iterations must be a non-negative integer');
  });

  it('rejects inherited object names as unknown options', () => {
    const parse = freshnessParser();
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(() => parse([name, 'value'])).toThrow(`unknown option: ${name}`);
    }
  });
});

function workerConfigParser() {
  const path = 'src/reindex/worker.ts';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['parseTypeScriptWorkerConfig', 'typeScriptWorkerProjects', 'typeScriptWorkerHeap'];
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(declarations).toHaveLength(names.length);
  const javascript = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const context = createContext({ Error });
  // Decode only; never start the reindex worker or its parent-process monitor.
  runInContext(javascript, context);
  return context['parseTypeScriptWorkerConfig'] as (value: string | undefined) => Record<string, unknown>;
}

describe('TypeScript reindex worker configuration', () => {
  it('distinguishes invalid JSON from a valid record with absent fields', () => {
    const parse = workerConfigParser();
    for (const value of [undefined, '', '{broken', 'null', '[]', '1']) expect(parse(value)).toEqual({});
    const empty = parse('{}');
    expect(Object.keys(empty)).toEqual(['projectMode', 'projects', 'maxHeapMb']);
    expect(empty).toEqual({ projectMode: undefined, projects: undefined, maxHeapMb: undefined });
  });

  it('retains accepted project strings and duplicates while filtering invalid elements', () => {
    const parse = workerConfigParser();
    expect(
      parse(
        JSON.stringify({ projectMode: 'workspace', projects: ['', ' ', null, 1, ' a ', 'a', 'a'], maxHeapMb: 512 }),
      ),
    ).toEqual({ projectMode: 'workspace', projects: [' a ', 'a', 'a'], maxHeapMb: 512 });
  });

  it('omits unusable field values without rejecting the rest of the record', () => {
    const parse = workerConfigParser();
    expect(parse(JSON.stringify({ projectMode: 'other', projects: [' ', 1], maxHeapMb: 0 }))).toEqual({
      projectMode: undefined,
      projects: undefined,
      maxHeapMb: undefined,
    });
    expect(parse(JSON.stringify({ projectMode: 'single', projects: 'a', maxHeapMb: 1.5 }))).toEqual({
      projectMode: 'single',
      projects: undefined,
      maxHeapMb: undefined,
    });
  });
});
