import type { ScipDatabase } from './db.js';
import {
  readCachedFileEvidence,
  readCachedProjectEvidence,
  writeCachedFileEvidence,
  writeCachedProjectEvidence,
  type FileEvidenceKind,
  type ProjectEvidenceKind,
} from './evidence-cache.js';

export interface FileEvidenceProduct<T> {
  kind: FileEvidenceKind;
  read(db: ScipDatabase, relativePath: string, contentHash: string): T | null;
  write(db: ScipDatabase, relativePath: string, contentHash: string, value: T): void;
}

export interface FileEvidenceProductOptions<T> {
  kind: FileEvidenceKind;
  serialize(value: T): string;
  deserialize(payload: string): T | null;
}

export interface ProjectEvidenceProduct<T> {
  kind: ProjectEvidenceKind;
  read(db: ScipDatabase, cacheKey: string, projectFingerprint: string): T | null;
  write(db: ScipDatabase, cacheKey: string, projectFingerprint: string, value: T): void;
}

export interface ProjectEvidenceProductOptions<T> {
  kind: ProjectEvidenceKind;
  serialize(value: T): string;
  deserialize(payload: string): T | null;
}

export function createFileEvidenceProduct<T>(opts: FileEvidenceProductOptions<T>): FileEvidenceProduct<T> {
  return {
    kind: opts.kind,
    read(db, relativePath, contentHash) {
      const payload = readCachedFileEvidence(db, opts.kind, relativePath, contentHash);
      if (payload === null) return null;
      try {
        return opts.deserialize(payload);
      } catch {
        return null;
      }
    },
    write(db, relativePath, contentHash, value) {
      writeCachedFileEvidence(db, opts.kind, relativePath, contentHash, opts.serialize(value));
    },
  };
}

export function createProjectEvidenceProduct<T>(opts: ProjectEvidenceProductOptions<T>): ProjectEvidenceProduct<T> {
  return {
    kind: opts.kind,
    read(db, cacheKey, projectFingerprint) {
      const payload = readCachedProjectEvidence(db, opts.kind, cacheKey, projectFingerprint);
      if (payload === null) return null;
      try {
        return opts.deserialize(payload);
      } catch {
        return null;
      }
    },
    write(db, cacheKey, projectFingerprint, value) {
      writeCachedProjectEvidence(db, opts.kind, cacheKey, projectFingerprint, opts.serialize(value));
    },
  };
}
