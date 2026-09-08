import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'vitest';
import { compilerFacts, IndexerHistoryFixture } from './indexer-history-fixture.js';
import { interruptibleIndexer } from './indexer-process-fixture.js';
import { PROPERTY_TIMEOUT } from './support.js';

const points = [
  'before-pointer',
  'after-pointer',
  'before-database-mirror',
  'after-database-mirror',
  'after-metadata-mirror',
] as const;

it.each(points)(
  'indexing: real process death at %s preserves a complete snapshot and recovers',
  async (point) => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      fixture.startService();
      const reader = fixture.open();
      const previous = compilerFacts(reader);
      try {
        fixture.write('owner.ts', 'export const value = (input: number) => input + 81;\n');
        const child = interruptibleIndexer(fixture, point);
        try {
          await child.reached();
          const killed = await child.kill();
          assert.equal(killed.signal, 'SIGKILL');
          assert.deepEqual(compilerFacts(reader), previous);
          if (point === 'before-pointer') {
            const current = fixture.open();
            try {
              assert.deepEqual(compilerFacts(current), previous);
            } finally {
              current.close();
            }
          } else {
            fixture.assertCurrent();
          }
          // Keep crash leftovers, stop/start the actual service, and let reindex
          // discover the work from disk. No synthetic change journal is supplied.
          await fixture.restartService();
          await fixture.index();
          fixture.assertCurrent();
          assert.deepEqual(compilerFacts(reader), previous);
        } finally {
          await child.dispose();
        }
      } finally {
        reader.close();
      }
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);

it.each(['before-pointer', 'before-database-mirror'])(
  'indexing: publication I/O failure at %s remains recoverable',
  async (point) => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      fixture.startService();
      const previous = fixture.publication()?.currentGeneration;
      fixture.write('owner.ts', 'export const value = (input: number) => input + 82;\n');
      const child = interruptibleIndexer(fixture, point, 'fail');
      try {
        await child.reached();
        assert.equal((await child.completion).code, 1, child.output());
        assert.match(child.output(), /Injected ENOSPC/);
        if (point === 'before-pointer') assert.equal(fixture.publication()?.currentGeneration, previous);
        else fixture.assertCurrent();
        await fixture.index();
        fixture.assertCurrent();
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: an edit while an older build is paused is rediscovered after rejection',
  async () => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      const previous = fixture.publication()?.currentGeneration;
      fixture.write('owner.ts', 'export const value = (input: number) => input + 83;\n');
      // No daemon here: a full compiler run reaches the conversion checkpoint.
      const child = interruptibleIndexer(fixture, 'before-conversion');
      try {
        await child.reached();
        fixture.write('owner.ts', 'export const value = (input: number) => input + 84;\n');
        const successor = interruptibleIndexer(fixture, 'after-metadata-mirror');
        try {
          await successor.started();
          assert.equal(
            successor.hasReached(),
            false,
            'The successor cannot publish while the first writer holds the lock',
          );
          assert.equal(fixture.publication()?.currentGeneration, previous);
          child.release();
          assert.equal((await child.completion).code, 1, child.output());
          assert.match(child.output(), /project inputs changed during reindex/i);
          await successor.reached();
          fixture.assertCurrent();
          successor.release();
          assert.equal((await successor.completion).code, 0, successor.output());
          await fixture.index();
          fixture.assertCurrent();
        } finally {
          await successor.dispose();
        }
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: the real filesystem watcher catches up after rapid edits without a manual refresh',
  async () => {
    const fixture = new IndexerHistoryFixture(100);
    try {
      await fixture.index();
      fixture.startService();
      const previous = fixture.publication()?.currentGeneration;
      fixture.write('owner.ts', 'export const value = (input: number) => input + 101;\n');
      fixture.write('owner.ts', null);
      fixture.write('owner.ts', 'export const value = (input: number) => input + 102;\n');
      const deadline = performance.now() + 30_000;
      while (fixture.publication()?.currentGeneration === previous) {
        assert.ok(performance.now() < deadline, 'The watcher must eventually publish the observed edits');
        await delay(50);
      }
      fixture.assertCurrent();
      assert.equal(fixture.publication()?.publication?.mode, 'incremental');
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: cancellation before conversion preserves the accepted generation',
  async () => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      const previous = fixture.publication()?.currentGeneration;
      fixture.write('owner.ts', 'export const value = (input: number) => input + 85;\n');
      const child = interruptibleIndexer(fixture, 'before-conversion', 'cancel');
      try {
        await child.reached();
        assert.equal((await child.completion).code, 1, child.output());
        assert.match(child.output(), /cancel|abort/i);
        assert.equal(fixture.publication()?.currentGeneration, previous);
        await fixture.index();
        fixture.assertCurrent();
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: watcher retries edits observed while another indexer owns publication',
  async () => {
    const fixture = new IndexerHistoryFixture(100);
    try {
      await fixture.index();
      const previous = fixture.publication()?.currentGeneration;
      fixture.write('owner.ts', 'export const value = (input: number) => input + 103;\n');
      const child = interruptibleIndexer(fixture, 'before-conversion');
      try {
        await child.reached();
        fixture.startService();
        fixture.write('owner.ts', 'export const value = (input: number) => input + 104;\n');
        child.release();
        assert.equal((await child.completion).code, 1, child.output());
        assert.match(child.output(), /project inputs changed during reindex/i);
        const deadline = performance.now() + 30_000;
        while (fixture.publication()?.currentGeneration === previous) {
          assert.ok(
            performance.now() < deadline,
            'Watcher must retain/retry changes after publication lock contention',
          );
          await delay(50);
        }
        fixture.assertCurrent();
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);
