import { expect, test } from 'vitest';
import { withTypeScriptBatchCollection } from '../../src/reindex/typescript-project-emission.js';

test('collects between consecutive owned batches and preserves construction and ordinary projects', () => {
  const events: string[] = [];
  class Project {
    constructor(
      public config: { fileNames: string[] },
      public options: { projectRoot: string },
      public cache: unknown,
    ) {
      events.push(options.projectRoot);
    }
    index() {}
  }
  const Reused = withTypeScriptBatchCollection(Project, () => events.push('collect'));
  const config = { fileNames: ['/repo/a.ts'] };
  const cache = { sources: new Map([['prior-project', {}]]), parsedCommandLines: new Map([['prior-project', {}]]) };
  const first = new Reused(config, { projectRoot: '/repo/.scipquery-compiler-shard-0.tsconfig.json' }, cache);
  expect(cache.sources.size).toBe(0);
  expect(cache.parsedCommandLines.size).toBe(0);
  const source = {};
  cache.sources.set('shared.ts', source);
  cache.parsedCommandLines.set('shared.ts', config);
  const second = new Reused(config, { projectRoot: '/repo/.scipquery-compiler-shard-1.tsconfig.json' }, cache);
  expect(cache.sources.get('shared.ts')).toBe(source);
  expect(cache.parsedCommandLines.get('shared.ts')).toBe(config);
  expect(first).toBeInstanceOf(Project);
  expect(second).toBeInstanceOf(Project);
  expect(first.config).toBe(config);
  expect((second as Project).cache).toBe(cache);
  new Reused(config, { projectRoot: '/repo/tsconfig.json' }, cache);
  expect(cache.sources.size).toBe(0);
  expect(cache.parsedCommandLines.size).toBe(0);
  new Reused(config, { projectRoot: '/repo/.scipquery-compiler-shard-2.tsconfig.json' }, cache);
  expect(events).toEqual([
    '/repo/.scipquery-compiler-shard-0.tsconfig.json',
    'collect',
    '/repo/.scipquery-compiler-shard-1.tsconfig.json',
    '/repo/tsconfig.json',
    '/repo/.scipquery-compiler-shard-2.tsconfig.json',
  ]);
});
