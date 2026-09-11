import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { types } from 'node:util';

type ReadMethod = 'get' | 'all';
interface RecordedRead {
  statement: number;
  method: ReadMethod;
  parameters: string;
  digest: string;
}

/** Exact default SQLite reads, including empty results, consumed by a synchronous computation. */
export interface DatabaseReadProof {
  version: 1;
  encoding: string;
  statements: string[];
  reads: RecordedRead[];
}

interface ReadPort {
  prepare(sql: string): { get(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown[] };
}

interface ReadInput {
  owner: ReadPort;
  sql: string;
  method: ReadMethod;
  parameters: unknown[];
  supported: boolean;
}

const ENCODING = `node-v8:${process.versions.node}:${process.versions.v8}`;
const MAX_READS = 20_000;
const MAX_PROOF_BYTES = 16 * 1024 * 1024;
let active: ReadCapture | null = null;

class ReadCapture {
  complete = true;
  private bytes = 0;
  private statements = new Map<string, number>();
  private reads = new Map<string, RecordedRead>();
  constructor(
    readonly owner: ReadPort,
    readonly parent: ReadCapture | null,
  ) {}

  record(sql: string, method: ReadMethod, parameters: string, digest: string): void {
    if (!this.complete) return;
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.statements.size;
      this.statements.set(sql, statement);
      this.bytes += sql.length * 2;
    }
    const key = `${statement}:${method}:${parameters}`;
    const previous = this.reads.get(key);
    if (previous) {
      if (previous.digest !== digest) this.complete = false;
      return;
    }
    this.bytes += key.length * 2 + 128;
    if (this.reads.size >= MAX_READS || this.bytes > MAX_PROOF_BYTES) {
      this.complete = false;
      return;
    }
    this.reads.set(key, { statement, method, parameters, digest });
  }

  proof(): DatabaseReadProof | undefined {
    return this.complete
      ? { version: 1, encoding: ENCODING, statements: [...this.statements.keys()], reads: [...this.reads.values()] }
      : undefined;
  }
}

/** Nested captures also contribute to their parent; asynchronous reads cannot produce a proof. */
export function withDatabaseReadRecording<T>(owner: ReadPort, run: () => T): { result: T; proof?: DatabaseReadProof } {
  const capture = new ReadCapture(owner, active);
  active = capture;
  try {
    const result = run();
    if (types.isPromise(result)) recordUnsupportedDatabaseRead();
    return { result, proof: capture.proof() };
  } catch (error) {
    recordUnsupportedDatabaseRead();
    throw error;
  } finally {
    active = capture.parent;
  }
}

/** Non-default statement shapes and incomplete read operations invalidate the enclosing proof. */
export function recordUnsupportedDatabaseRead(): void {
  for (let capture = active; capture; capture = capture.parent) capture.complete = false;
}

/** Cached compiler derivations must expose their underlying reads during capture. */
export function isRecordingDatabaseReads(owner: ReadPort): boolean {
  for (let capture = active; capture; capture = capture.parent) {
    if (capture.owner === owner) return true;
  }
  return false;
}

/** The shared database facade calls this before returning rows to a consumer that may mutate them. */
export function recordDatabaseRead<T>(input: ReadInput, run: () => T): T {
  if (!active) return run();
  const encoded = encodeReadParameters(input);
  let result: T;
  try {
    result = run();
  } catch (error) {
    recordUnsupportedDatabaseRead();
    throw error;
  }
  if (encoded !== undefined) recordCompletedRead(input, encoded, result);
  return result;
}

function encodeReadParameters(input: ReadInput): string | undefined {
  try {
    if (input.supported && safeParameters(input.parameters)) return serialize(input.parameters).toString('base64');
  } catch {
    /* Unsupported parameter encoding leaves the ordinary read available. */
  }
  recordUnsupportedDatabaseRead();
  return undefined;
}

function recordCompletedRead({ owner, sql, method, parameters }: ReadInput, encoded: string, result: unknown): void {
  try {
    if (serialize(parameters).toString('base64') !== encoded) {
      recordUnsupportedDatabaseRead();
      return;
    }
    const digest = digestResult(result);
    for (let capture: ReadCapture | null = active; capture; capture = capture.parent) {
      if (capture.owner === owner) capture.record(sql, method, encoded, digest);
      else capture.complete = false;
    }
  } catch {
    recordUnsupportedDatabaseRead();
  }
}

/** Re-run the exact read-only queries; row identities or a prior nonempty result are not substitutes. */
export function databaseReadsMatch(port: ReadPort, proof: DatabaseReadProof | undefined): boolean {
  const statements = new Map<number, ReturnType<ReadPort['prepare']>>();
  try {
    if (!validProof(proof)) return false;
    return proof.reads.every((read) => {
      let statement = statements.get(read.statement);
      if (!statement) {
        statement = port.prepare(proof.statements[read.statement]!);
        statements.set(read.statement, statement);
      }
      const parameters: unknown = deserialize(Buffer.from(read.parameters, 'base64'));
      if (!Array.isArray(parameters) || !safeParameters(parameters)) return false;
      return digestResult(statement[read.method](...parameters)) === read.digest;
    });
  } catch {
    return false;
  }
}

function validProof(proof: DatabaseReadProof | undefined): proof is DatabaseReadProof {
  if (
    !proof ||
    proof.version !== 1 ||
    proof.encoding !== ENCODING ||
    !Array.isArray(proof.statements) ||
    !Array.isArray(proof.reads) ||
    proof.reads.length > MAX_READS
  )
    return false;
  if (!proof.statements.every((sql) => typeof sql === 'string')) return false;
  if (JSON.stringify(proof).length * 2 > MAX_PROOF_BYTES) return false;
  return proof.reads.every(
    (read) =>
      read &&
      Number.isSafeInteger(read.statement) &&
      read.statement >= 0 &&
      read.statement < proof.statements.length &&
      (read.method === 'get' || read.method === 'all') &&
      typeof read.parameters === 'string' &&
      typeof read.digest === 'string',
  );
}

/** Getters, proxies and mutable shared buffers cannot establish the actual values SQLite consumed. */
function safeParameters(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || ['string', 'number', 'bigint'].includes(typeof value)) return true;
  if (typeof value !== 'object' || types.isProxy(value) || depth > 3) return false;
  if (ArrayBuffer.isView(value)) return Buffer.isBuffer(value) && !types.isSharedArrayBuffer(value.buffer);
  if (!isParameterContainer(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return 'value' in descriptor && safeParameters(descriptor.value, depth + 1);
  });
}

function isParameterContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

function digestResult(result: unknown): string {
  return createHash('sha256').update(serialize(result)).digest('hex');
}
