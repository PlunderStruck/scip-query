import { describe, expect, it, vi } from 'vitest';
import {
  canonicalRustLinkedProjects,
  RustAnalyzerSessionRegistry,
  rustAnalyzerSessionKey,
} from '../../../src/semantic/rust/session-registry.js';

interface TestSession {
  key: string;
}

describe('Rust analyzer session registry', () => {
  it('canonicalizes linked-project order and duplicate path spellings before identity', () => {
    const projectRoot = '/repo';
    const first = canonicalRustLinkedProjects(projectRoot, [
      '/repo/crates/b/Cargo.toml',
      'crates/a/Cargo.toml',
      './crates/b/Cargo.toml',
    ]);
    const second = canonicalRustLinkedProjects(projectRoot, ['crates/b/Cargo.toml', '/repo/crates/a/Cargo.toml']);

    expect(first).toEqual(['/repo/crates/a/Cargo.toml', '/repo/crates/b/Cargo.toml']);
    expect(second).toEqual(first);
    expect(rustAnalyzerSessionKey('rust-analyzer', '/repo', first)).toBe(
      rustAnalyzerSessionKey('rust-analyzer', '/repo', second),
    );
  });

  it('reuses a canonical identity without creating a second session', async () => {
    const registry = new RustAnalyzerSessionRegistry<TestSession>(2);
    const create = vi.fn(async () => ({ key: 'same' }));
    const shutdown = vi.fn(async () => undefined);

    const first = await registry.acquire('same', create, shutdown);
    const second = await registry.acquire('same', create, shutdown);

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('evicts the least-recently-used session and joins shutdown before creating its replacement', async () => {
    const registry = new RustAnalyzerSessionRegistry<TestSession>(2);
    await registry.acquire(
      'a',
      async () => ({ key: 'a' }),
      async () => undefined,
    );
    await registry.acquire(
      'b',
      async () => ({ key: 'b' }),
      async () => undefined,
    );
    expect(registry.get('a')).toEqual({ key: 'a' });

    let releaseShutdown!: () => void;
    const shutdownBarrier = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const events: string[] = [];
    const replacement = registry.acquire(
      'c',
      async () => {
        events.push('create:c');
        return { key: 'c' };
      },
      async (victim) => {
        events.push(`shutdown:${victim.key}`);
        await shutdownBarrier;
        events.push(`stopped:${victim.key}`);
      },
    );

    await Promise.resolve();
    expect(events).toEqual(['shutdown:b']);
    expect(registry.size).toBe(1);
    expect(registry.get('a')).toEqual({ key: 'a' });

    releaseShutdown();
    await expect(replacement).resolves.toEqual({ key: 'c' });
    expect(events).toEqual(['shutdown:b', 'stopped:b', 'create:c']);
    expect(registry.size).toBe(2);
    expect(registry.get('b')).toBeUndefined();
    expect(registry.get('a')).toEqual({ key: 'a' });
    expect(registry.get('c')).toEqual({ key: 'c' });
  });

  it('restores an eviction victim when shutdown does not prove termination', async () => {
    const registry = new RustAnalyzerSessionRegistry<TestSession>(1);
    const victim = await registry.acquire(
      'a',
      async () => ({ key: 'a' }),
      async () => undefined,
    );
    const create = vi.fn(async () => ({ key: 'b' }));

    await expect(
      registry.acquire('b', create, async () => {
        throw new Error('unreaped process tree');
      }),
    ).rejects.toThrow('unreaped process tree');

    expect(create).not.toHaveBeenCalled();
    expect(registry.get('a')).toBe(victim);
    expect(registry.size).toBe(1);
  });

  it('reaps a factory result that violates its reserved session identity', async () => {
    const registry = new RustAnalyzerSessionRegistry<TestSession>(1);
    const mismatched = { key: 'unexpected' };
    const shutdown = vi.fn(async () => undefined);

    await expect(registry.acquire('reserved', async () => mismatched, shutdown)).rejects.toThrow(
      "returned 'unexpected' for reserved key 'reserved'",
    );

    expect(shutdown).toHaveBeenCalledWith(mismatched);
    expect(registry.size).toBe(0);
  });

  it('joins shutdown of every retained session', async () => {
    const registry = new RustAnalyzerSessionRegistry<TestSession>(2);
    await registry.acquire(
      'a',
      async () => ({ key: 'a' }),
      async () => undefined,
    );
    await registry.acquire(
      'b',
      async () => ({ key: 'b' }),
      async () => undefined,
    );

    const releases = new Map<string, () => void>();
    const stopped: string[] = [];
    const shutdown = registry.shutdownAll(
      (session) =>
        new Promise<void>((resolve) => {
          releases.set(session.key, () => {
            stopped.push(session.key);
            resolve();
          });
        }),
    );

    await Promise.resolve();
    expect([...releases.keys()].sort()).toEqual(['a', 'b']);
    expect(registry.size).toBe(0);
    releases.get('a')!();
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releases.get('b')!();
    await expect(shutdown).resolves.toBeUndefined();
    expect(stopped.sort()).toEqual(['a', 'b']);
    expect(registry.size).toBe(0);
  });

  it('retains ownership of sessions whose shutdown fails after joining every attempt', async () => {
    const registry = new RustAnalyzerSessionRegistry<TestSession>(2);
    const first = await registry.acquire(
      'a',
      async () => ({ key: 'a' }),
      async () => undefined,
    );
    await registry.acquire(
      'b',
      async () => ({ key: 'b' }),
      async () => undefined,
    );
    const attempted: string[] = [];

    await expect(
      registry.shutdownAll(async (session) => {
        attempted.push(session.key);
        if (session.key === 'a') throw new Error('still alive');
      }),
    ).rejects.toThrow('Failed to shut down 1 retained rust-analyzer session');

    expect(attempted.sort()).toEqual(['a', 'b']);
    expect(registry.size).toBe(1);
    expect(registry.get('a')).toBe(first);
  });
});
