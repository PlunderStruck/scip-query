import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { getCallSites, getCallableIdentityFacts } from '../../src/source/facts/ast-facts.js';
import * as sourceFacts from '../../src/source/facts/source-facts.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { withFileAccessRecording } from '../../src/domain/file-access-recorder.js';
import { withSourceDb } from '../properties/fixture.js';

afterEach(() => vi.restoreAllMocks());

test.each([
  [
    'nested.ts',
    `
    export function run(x: number) {
      const nested = (y: number) => target(y);
      return invoke(() => nested(x));
    }
    const wrapped = wrap('name')(function* (x: number) { yield* target(x); });
    class Service {
      handler = (x: number) => target(x);
      constructor() { new Factory()(); }
      method() { return this.#private(); }
      #private() { return target(); }
    }
    interface Api { method(x: number): void; }
    declare function overload(x: string): string;
  `,
  ],
  [
    'wrapped.mts',
    `
    (target as Handler)(); target!(); (target)(); (await target)();
    client['method'](); client[key](); client?.method?.();
    new Factory().method(); target()();
  `,
  ],
  [
    'view.tsx',
    `
    export const View = () => <Layout>{render(<Menu.Item />)}<span /></Layout>;
    const nested = () => <Child render={() => invoke()} />;
  `,
  ],
  ['module.cjs', 'exports.run = function named(x) { return obj.call(x); }; new Factory();'],
  ['module.mjs', 'export default function* (x) { yield target(x); }'],
  ['broken.ts', 'function broken(x { return target(x); const value = () => other('],
  ['empty.ts', ''],
])('focused views match full extraction for %s without building the full report', (file, text) => {
  withSourceDb({ [file]: text }, (db) => {
    const full = vi.spyOn(sourceFacts, 'getSourceFacts');
    const calls = getCallSites(db, file);
    const identities = getCallableIdentityFacts(db, file);
    expect(full).not.toHaveBeenCalled();
    const facts = sourceFacts.getSourceFacts(db, file);
    expect(calls).toEqual(facts?.callSites ?? null);
    expect(identities).toEqual(facts?.callables.map((callable) => ({ ...callable, branches: undefined })) ?? null);
  });
});

test('cache hits record source dependencies and file invalidation replaces focused facts', () => {
  const file = 'source.ts';
  const text = 'export function first() { return before(); }';
  withSourceDb({ [file]: text }, (db, root) => {
    const calls = getCallSites(db, file);
    const identities = getCallableIdentityFacts(db, file);
    const reads = new Map<string, string>();
    const unavailable = vi.fn();
    withFileAccessRecording(
      () => {},
      () => {
        expect(getCallSites(db, file)).toBe(calls);
        expect(getCallableIdentityFacts(db, file)).toBe(identities);
      },
      undefined,
      { source: (name, source) => reads.set(name, source), unavailable },
    );
    expect(reads).toEqual(new Map([[file, text]]));
    expect(unavailable).not.toHaveBeenCalled();

    writeFileSync(join(root, file), 'export function second() { return after(); }');
    clearRegisteredCaches(db, { groups: ['source-file'], file });
    expect(getCallSites(db, file)?.map((site) => site.calleeLeaf)).toEqual(['after']);
    expect(getCallableIdentityFacts(db, file)?.map((site) => site.name)).toEqual(['second']);
    expect(calls?.map((site) => site.calleeLeaf)).toEqual(['before']);
    expect(identities?.map((site) => site.name)).toEqual(['first']);
  });
});

test.each([
  ['component.vue', '<script setup lang="ts">const run = () => target();</script>'],
  ['script.py', 'def run(x):\n    return target(x)\n'],
  ['lib.rs', 'fn run() { target(); invoke!(); }'],
  ['core.clj', '(defn run [x] (target x))'],
])('retains the existing provider path for %s', (file, text) => {
  withSourceDb({ [file]: text }, (db) => {
    const facts = sourceFacts.getSourceFacts(db, file);
    expect(facts).not.toBeNull();
    expect(getCallSites(db, file)).toEqual(facts?.callSites);
    expect(getCallableIdentityFacts(db, file)).toEqual(facts?.callables);
  });
});
