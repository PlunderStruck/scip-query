import { resolve } from 'node:path';

export const DEFAULT_RUST_ANALYZER_SESSION_CAPACITY = 4;

export interface RustAnalyzerSessionIdentity {
  key: string;
}

/**
 * Worker-local, insertion-ordered LRU for rust-analyzer sessions.
 *
 * The owning Worker dispatches requests serially. Eviction therefore removes
 * the least-recently-used entry, joins its shutdown, and only then admits the
 * replacement. If shutdown fails, the victim is restored so a live process is
 * never lost from ownership tracking.
 */
export class RustAnalyzerSessionRegistry<Session extends RustAnalyzerSessionIdentity> {
  private readonly entries = new Map<string, Session>();

  constructor(readonly capacity = DEFAULT_RUST_ANALYZER_SESSION_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('Rust analyzer session capacity must be a positive safe integer.');
    }
  }

  get(key: string): Session | undefined {
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing;
  }

  async acquire(
    key: string,
    create: () => Promise<Session>,
    shutdown: (victim: Session) => Promise<void>,
  ): Promise<Session> {
    const retained = this.get(key);
    if (retained) return retained;

    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.entries().next().value as [string, Session] | undefined;
      if (!oldest) throw new Error('Rust analyzer session registry capacity accounting is inconsistent.');
      this.entries.delete(oldest[0]);
      try {
        await shutdown(oldest[1]);
      } catch (error) {
        this.restoreOldest(oldest);
        throw error;
      }
    }
    const session = await create();
    if (session.key !== key) {
      try {
        await shutdown(session);
      } catch (cleanupError) {
        throw new AggregateError(
          [cleanupError],
          `Rust analyzer session factory returned '${session.key}' for reserved key '${key}', and the mismatched session could not be reaped.`,
          { cause: cleanupError },
        );
      }
      throw new Error(`Rust analyzer session factory returned '${session.key}' for reserved key '${key}'.`);
    }
    this.entries.set(key, session);
    return session;
  }

  deleteIfSame(session: Session): boolean {
    if (this.entries.get(session.key) !== session) return false;
    return this.entries.delete(session.key);
  }

  async shutdownAll(shutdown: (session: Session) => Promise<void>): Promise<void> {
    const retained = [...this.entries.values()];
    this.entries.clear();
    const outcomes = await Promise.allSettled(retained.map(shutdown));
    const failures: Array<{ session: Session; reason: unknown }> = [];
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index]!;
      if (outcome.status === 'fulfilled') continue;
      const session = retained[index]!;
      failures.push({ session, reason: outcome.reason });
      this.entries.set(session.key, session);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to shut down ${failures.length} retained rust-analyzer session(s).`,
      );
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private restoreOldest(entry: [string, Session]): void {
    const newer = [...this.entries.entries()];
    this.entries.clear();
    this.entries.set(entry[0], entry[1]);
    for (const [key, session] of newer) this.entries.set(key, session);
  }
}

export function canonicalRustLinkedProjects(projectRoot: string, linkedProjects: readonly string[]): string[] {
  const absoluteRoot = resolve(projectRoot);
  return [...new Set(linkedProjects.map((project) => resolve(absoluteRoot, project)))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function rustAnalyzerSessionKey(binary: string, sessionRoot: string, linkedProjects: readonly string[]): string {
  return JSON.stringify({ binary, sessionRoot, linkedProjects });
}
