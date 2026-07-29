import { basename, dirname, normalize } from 'node:path/posix';

import type { DurableFileCloneRuntime } from '../../src/filesystem/durable-file.js';
import type { AtomicFileRuntime } from '../../src/storage/atomic-file.js';

interface ModeledNode {
  id: number;
  kind: 'directory' | 'file';
  bytes: Buffer;
  mode: number;
}

interface OpenDescriptor {
  path: string;
  nodeId: number;
}

/**
 * A deterministic filesystem model that keeps process-visible state separate
 * from the state committed by file and directory synchronization. A modeled
 * power loss discards every mutation that has not crossed the corresponding
 * persistence frontier.
 */
export class PersistenceFrontierRuntime implements AtomicFileRuntime, DurableFileCloneRuntime {
  readonly platform: NodeJS.Platform = 'darwin';
  readonly trace: string[] = [];

  private nextNodeId = 2;
  private nextDescriptor = 10;
  private volatileNodes = new Map<number, ModeledNode>([
    [1, { id: 1, kind: 'directory', bytes: Buffer.alloc(0), mode: 0o755 }],
  ]);
  private volatileEntries = new Map<number, Map<string, number>>([[1, new Map()]]);
  private persistedNodes = cloneNodes(this.volatileNodes);
  private persistedEntries = cloneEntries(this.volatileEntries);
  private descriptors = new Map<number, OpenDescriptor>();
  private crashLabel: string | undefined;
  private crashOccurrence = 1;
  private matchingOperations = 0;
  private crashed = false;

  randomToken(): string {
    return 'frontier';
  }

  crashAfter(label: string, occurrence = 1): void {
    this.crashLabel = label;
    this.crashOccurrence = occurrence;
    this.matchingOperations = 0;
  }

  recover(): void {
    this.crashed = false;
    this.crashLabel = undefined;
    this.matchingOperations = 0;
  }

  seedDirectory(path: string): void {
    this.assertRunning();
    this.makeDirectory(path);
    for (const component of ancestorDirectories(path)) {
      this.persistDirectory(component);
    }
    this.trace.length = 0;
  }

  seedFile(path: string, bytes: string | Buffer, mode = 0o600): void {
    this.seedDirectory(dirname(path));
    const fd = this.openFile(path, 'wx', mode);
    const payload = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    this.writeFile(fd, payload, 0, payload.length);
    this.syncFile(fd);
    this.closeFile(fd);
    this.persistDirectory(dirname(path));
    this.trace.length = 0;
  }

  pathExists(path: string): boolean {
    return this.resolve(path) !== undefined;
  }

  makeDirectory(path: string): void {
    this.assertRunning();
    const normalized = normalizedPath(path);
    if (normalized === '/') return;
    const parent = dirname(normalized);
    if (!this.pathExists(parent)) this.makeDirectory(parent);
    if (this.pathExists(normalized)) return;
    const parentNode = this.requireNode(parent, 'directory');
    const node: ModeledNode = {
      id: this.nextNodeId++,
      kind: 'directory',
      bytes: Buffer.alloc(0),
      mode: 0o755,
    };
    this.volatileNodes.set(node.id, node);
    this.volatileEntries.set(node.id, new Map());
    this.volatileEntries.get(parentNode.id)!.set(basename(normalized), node.id);
    this.afterOperation(`mkdir:${normalized}`);
  }

  openFile(path: string, flags: string, mode = 0o600): number {
    this.assertRunning();
    const normalized = normalizedPath(path);
    let node = this.resolve(normalized);
    if (flags.includes('x')) {
      if (node) throw errno('EEXIST', `modeled path already exists: ${normalized}`);
      const parentNode = this.requireNode(dirname(normalized), 'directory');
      node = {
        id: this.nextNodeId++,
        kind: 'file',
        bytes: Buffer.alloc(0),
        mode,
      };
      this.volatileNodes.set(node.id, node);
      this.volatileEntries.get(parentNode.id)!.set(basename(normalized), node.id);
      this.afterOperation(`create-file:${normalized}`);
    } else if (!node) {
      throw errno('ENOENT', `modeled path does not exist: ${normalized}`);
    }
    const descriptor = this.nextDescriptor++;
    this.descriptors.set(descriptor, { path: normalized, nodeId: node.id });
    return descriptor;
  }

  writeFile(fd: number, bytes: Buffer, offset: number, length: number): number {
    this.assertRunning();
    const descriptor = this.requireDescriptor(fd);
    const node = this.volatileNodes.get(descriptor.nodeId);
    if (!node || node.kind !== 'file') throw errno('EBADF', 'modeled descriptor is not a file');
    const chunk = bytes.subarray(offset, offset + length);
    node.bytes = Buffer.concat([node.bytes, chunk]);
    this.afterOperation(`write:${descriptor.path}`);
    return chunk.length;
  }

  syncFile(fd: number): void {
    this.assertRunning();
    const descriptor = this.requireDescriptor(fd);
    const node = this.volatileNodes.get(descriptor.nodeId);
    if (!node) throw errno('EBADF', 'modeled descriptor no longer exists');
    if (node.kind === 'file') {
      this.persistedNodes.set(node.id, cloneNode(node));
      this.afterOperation(`fsync-file:${descriptor.path}`);
      return;
    }
    this.persistDirectory(descriptor.path);
    this.afterOperation(`fsync-dir:${descriptor.path}`);
  }

  closeFile(fd: number): void {
    this.assertRunning();
    if (!this.descriptors.delete(fd)) throw errno('EBADF', 'modeled descriptor is not open');
  }

  renameFile(source: string, target: string): void {
    this.assertRunning();
    const normalizedSource = normalizedPath(source);
    const normalizedTarget = normalizedPath(target);
    const sourceParent = this.requireNode(dirname(normalizedSource), 'directory');
    const targetParent = this.requireNode(dirname(normalizedTarget), 'directory');
    const sourceEntries = this.volatileEntries.get(sourceParent.id)!;
    const nodeId = sourceEntries.get(basename(normalizedSource));
    if (nodeId === undefined) throw errno('ENOENT', `modeled source does not exist: ${normalizedSource}`);
    sourceEntries.delete(basename(normalizedSource));
    this.volatileEntries.get(targetParent.id)!.set(basename(normalizedTarget), nodeId);
    this.afterOperation(`rename:${normalizedSource}->${normalizedTarget}`);
  }

  linkFile(source: string, target: string): void {
    this.assertRunning();
    const normalizedSource = normalizedPath(source);
    const normalizedTarget = normalizedPath(target);
    const sourceNode = this.requireNode(normalizedSource, 'file');
    if (this.pathExists(normalizedTarget)) throw errno('EEXIST', `modeled target exists: ${normalizedTarget}`);
    const targetParent = this.requireNode(dirname(normalizedTarget), 'directory');
    this.volatileEntries.get(targetParent.id)!.set(basename(normalizedTarget), sourceNode.id);
    this.afterOperation(`link:${normalizedSource}->${normalizedTarget}`);
  }

  removeFile(path: string): void {
    this.assertRunning();
    const normalized = normalizedPath(path);
    const parent = this.requireNode(dirname(normalized), 'directory');
    const removed = this.volatileEntries.get(parent.id)!.delete(basename(normalized));
    if (!removed) throw errno('ENOENT', `modeled path does not exist: ${normalized}`);
    this.afterOperation(`unlink:${normalized}`);
  }

  copyFile(source: string, target: string): void {
    this.assertRunning();
    const normalizedTarget = normalizedPath(target);
    const sourceNode = this.requireNode(source, 'file');
    const parent = this.requireNode(dirname(normalizedTarget), 'directory');
    const node: ModeledNode = {
      id: this.nextNodeId++,
      kind: 'file',
      bytes: Buffer.from(sourceNode.bytes),
      mode: sourceNode.mode,
    };
    this.volatileNodes.set(node.id, node);
    this.volatileEntries.get(parent.id)!.set(basename(normalizedTarget), node.id);
    this.afterOperation(`copy:${normalizedPath(source)}->${normalizedTarget}`);
  }

  chmodFile(path: string, mode: number): void {
    this.assertRunning();
    const normalized = normalizedPath(path);
    const node = this.requireNode(normalized, 'file');
    node.mode = mode;
    this.afterOperation(`chmod:${normalized}:${mode.toString(8)}`);
  }

  readFile(path: string): string | undefined {
    const node = this.resolve(path);
    return node?.kind === 'file' ? node.bytes.toString('utf8') : undefined;
  }

  fileMode(path: string): number | undefined {
    const node = this.resolve(path);
    return node?.kind === 'file' ? node.mode : undefined;
  }

  private persistDirectory(path: string): void {
    const directory = this.requireNode(path, 'directory');
    const entries = this.volatileEntries.get(directory.id) ?? new Map();
    this.persistedNodes.set(directory.id, cloneNode(directory));
    this.persistedEntries.set(directory.id, new Map(entries));
    for (const nodeId of entries.values()) {
      const node = this.volatileNodes.get(nodeId);
      if (!node) continue;
      const persisted = this.persistedNodes.get(nodeId);
      this.persistedNodes.set(nodeId, {
        ...cloneNode(node),
        bytes: node.kind === 'file' ? Buffer.from(persisted?.bytes ?? Buffer.alloc(0)) : Buffer.alloc(0),
        mode: persisted?.mode ?? node.mode,
      });
      if (node.kind === 'directory' && !this.persistedEntries.has(nodeId)) {
        this.persistedEntries.set(nodeId, new Map());
      }
    }
  }

  private afterOperation(label: string): void {
    this.trace.push(label);
    if (label !== this.crashLabel) return;
    this.matchingOperations += 1;
    if (this.matchingOperations !== this.crashOccurrence) return;
    this.volatileNodes = cloneNodes(this.persistedNodes);
    this.volatileEntries = cloneEntries(this.persistedEntries);
    this.descriptors.clear();
    this.crashed = true;
    throw new SimulatedPowerLoss(label);
  }

  private resolve(path: string): ModeledNode | undefined {
    const normalized = normalizedPath(path);
    if (normalized === '/') return this.volatileNodes.get(1);
    let current = this.volatileNodes.get(1);
    for (const component of normalized.slice(1).split('/')) {
      if (!current || current.kind !== 'directory') return undefined;
      const nodeId = this.volatileEntries.get(current.id)?.get(component);
      if (nodeId === undefined) return undefined;
      current = this.volatileNodes.get(nodeId);
    }
    return current;
  }

  private requireNode(path: string, kind: ModeledNode['kind']): ModeledNode {
    const node = this.resolve(path);
    if (!node || node.kind !== kind) throw errno('ENOENT', `modeled ${kind} does not exist: ${path}`);
    return node;
  }

  private requireDescriptor(fd: number): OpenDescriptor {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) throw errno('EBADF', `modeled descriptor is not open: ${fd}`);
    return descriptor;
  }

  private assertRunning(): void {
    if (this.crashed) throw new SimulatedPowerLoss(this.crashLabel ?? 'unknown');
  }
}

export class SimulatedPowerLoss extends Error {
  constructor(readonly phase: string) {
    super(`simulated power loss after ${phase}`);
    this.name = 'SimulatedPowerLoss';
  }
}

function normalizedPath(path: string): string {
  const normalized = normalize(path);
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function ancestorDirectories(path: string): string[] {
  const normalized = normalizedPath(path);
  const result = ['/'];
  let current = '';
  for (const component of normalized.slice(1).split('/').filter(Boolean)) {
    current += `/${component}`;
    result.push(current);
  }
  return result;
}

function cloneNode(node: ModeledNode): ModeledNode {
  return { ...node, bytes: Buffer.from(node.bytes) };
}

function cloneNodes(nodes: Map<number, ModeledNode>): Map<number, ModeledNode> {
  return new Map([...nodes].map(([id, node]) => [id, cloneNode(node)]));
}

function cloneEntries(entries: Map<number, Map<string, number>>): Map<number, Map<string, number>> {
  return new Map([...entries].map(([id, names]) => [id, new Map(names)]));
}

function errno(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
