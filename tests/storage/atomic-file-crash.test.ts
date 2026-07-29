import { describe, expect, it } from 'vitest';

import { cloneFileDurable } from '../../src/filesystem/durable-file.js';
import { createFileAtomicExclusive, replaceFileAtomic } from '../../src/storage/atomic-file.js';
import { PersistenceFrontierRuntime, SimulatedPowerLoss } from '../helpers/persistence-frontier.js';

describe('filesystem persistence frontier', () => {
  it.each([
    ['fsync-file:/repo/state.json.tmp-frontier', 'old'],
    ['rename:/repo/state.json.tmp-frontier->/repo/state.json', 'old'],
    ['fsync-dir:/repo', 'new'],
  ])('recovers atomic replacement after %s with old-or-new complete bytes', (phase, expected) => {
    const runtime = new PersistenceFrontierRuntime();
    runtime.seedDirectory('/repo');
    runtime.seedFile('/repo/state.json', 'old');
    runtime.crashAfter(phase);

    expect(() => replaceFileAtomic('/repo/state.json', 'new', { durability: 'durable', runtime })).toThrow(
      SimulatedPowerLoss,
    );
    runtime.recover();

    expect(runtime.readFile('/repo/state.json')).toBe(expected);
  });

  it.each([
    ['mkdir:/repo/cache', false, false],
    ['fsync-dir:/repo', true, false],
    ['mkdir:/repo/cache/nested', true, false],
    ['fsync-dir:/repo/cache', true, false],
    ['rename:/repo/cache/nested/state.json.tmp-frontier->/repo/cache/nested/state.json', true, false],
    ['fsync-dir:/repo/cache/nested', true, true],
  ])(
    'recovers a first publication after %s only when its complete ancestor chain and target name persisted',
    (phase, cacheSurvives, targetSurvives) => {
      const runtime = new PersistenceFrontierRuntime();
      runtime.seedDirectory('/repo');
      runtime.crashAfter(phase);

      expect(() =>
        replaceFileAtomic('/repo/cache/nested/state.json', 'new', { durability: 'durable', runtime }),
      ).toThrow(SimulatedPowerLoss);
      runtime.recover();

      expect(runtime.pathExists('/repo/cache')).toBe(cacheSurvives);
      expect(runtime.readFile('/repo/cache/nested/state.json')).toBe(targetSurvives ? 'new' : undefined);
    },
  );

  it.each([
    ['fsync-file:/repo/first.json.tmp-frontier', false],
    ['link:/repo/first.json.tmp-frontier->/repo/first.json', false],
    ['fsync-dir:/repo', true],
  ])('recovers exclusive publication after %s without exposing an uncommitted public name', (phase, survives) => {
    const runtime = new PersistenceFrontierRuntime();
    runtime.seedDirectory('/repo');
    runtime.crashAfter(phase);

    expect(() => createFileAtomicExclusive('/repo/first.json', 'first', { durability: 'durable', runtime })).toThrow(
      SimulatedPowerLoss,
    );
    runtime.recover();

    expect(runtime.readFile('/repo/first.json')).toBe(survives ? 'first' : undefined);
  });

  it.each([
    ['copy:/source.db->/generation/index.db', false],
    ['chmod:/generation/index.db:444', false],
    ['fsync-file:/generation/index.db', false],
    ['fsync-dir:/generation', true],
  ])('recovers a cloned artifact after %s only with durable bytes and final mode', (phase, survives) => {
    const runtime = new PersistenceFrontierRuntime();
    runtime.seedFile('/source.db', 'database');
    runtime.seedDirectory('/generation');
    runtime.crashAfter(phase);

    expect(() => cloneFileDurable('/source.db', '/generation/index.db', { mode: 0o444, runtime })).toThrow(
      SimulatedPowerLoss,
    );
    runtime.recover();

    expect(runtime.readFile('/generation/index.db')).toBe(survives ? 'database' : undefined);
    expect(runtime.fileMode('/generation/index.db')).toBe(survives ? 0o444 : undefined);
  });
});
