import { createHash } from 'node:crypto';
import { runtimeBindingIdentity } from './binding-identity.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import type { ScipDatabase } from '../../storage/db.js';
import { evaluateStaticValue as evaluateBoundaryValue } from '../../symbols/graph/static-value-flow.js';
import { boundaryFileContext } from './extractors.js';
import type {
  BoundaryFileContext,
  BoundaryFrontier,
  BoundaryKeyPart,
  BoundaryObservation,
  BoundarySourceLocation,
} from './types.js';

interface HttpMount {
  file: string;
  line: number;
  prefix: Omit<BoundaryKeyPart, 'name'>;
  targetIdentity: string;
  receiver: BoundaryKeyPart;
  source: BoundarySourceLocation;
}

export interface HttpMountCompositionResult {
  observations: BoundaryObservation[];
  filesInspected: number;
  mounts: number;
  frontiers: BoundaryFrontier[];
}

export function composeHttpMountsWithCoverage(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
): HttpMountCompositionResult {
  const handlersByIdentity = httpHandlersByRouter(observations);
  const derived: BoundaryObservation[] = [];
  const collected = collectHttpMounts(db);
  const frontiers = [...collected.frontiers];
  const queue = [...handlersByIdentity].flatMap(([identity, handlers]) =>
    handlers.map((handler) => ({ identity, handler, visited: new Set([identity]) })),
  );
  const mountsByTarget = new Map<string, HttpMount[]>();
  for (const mount of collected.mounts) {
    const bucket = mountsByTarget.get(mount.targetIdentity) ?? [];
    bucket.push(mount);
    mountsByTarget.set(mount.targetIdentity, bucket);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const state = queue[cursor]!;
    for (const mount of mountsByTarget.get(state.identity) ?? []) {
      if (derived.length >= 10_000) {
        frontiers.push(mountFrontier(mount.source, 'http-mount-composition-limit', ['remaining-mount-paths']));
        return {
          observations: derived,
          filesInspected: collected.filesInspected,
          mounts: collected.mounts.length,
          frontiers,
        };
      }
      const next = composeMountState(state, mount, derived, frontiers);
      if (next) queue.push(next);
    }
  }
  return {
    observations: derived,
    filesInspected: collected.filesInspected,
    mounts: collected.mounts.length,
    frontiers,
  };
}

function httpHandlersByRouter(observations: readonly BoundaryObservation[]) {
  const result = new Map<string, BoundaryObservation[]>();
  for (const observation of observations) {
    if (
      observation.action !== 'http.handle' ||
      observation.sourceScope !== 'production' ||
      observation.strength === 'candidate'
    )
      continue;
    const router = observation.keyParts.find((part) => part.name === 'router');
    if (router?.term?.kind !== 'symbol' || router.evidence === 'expression') continue;
    const bucket = result.get(router.term.symbol) ?? [];
    bucket.push(observation);
    result.set(router.term.symbol, bucket);
  }
  return result;
}

interface MountState {
  identity: string;
  handler: BoundaryObservation;
  visited: Set<string>;
}

function composeMountState(
  state: MountState,
  mount: HttpMount,
  derived: BoundaryObservation[],
  frontiers: BoundaryFrontier[],
): MountState | null {
  const receiver = mount.receiver.term;
  if (receiver?.kind !== 'symbol') return null;
  if (state.visited.has(receiver.symbol)) {
    frontiers.push(mountFrontier(mount.source, 'http-mount-cycle', ['acyclic-router-path']));
    return null;
  }
  const before = derived.length;
  appendMountedHttpHandler(mount, state.handler, derived);
  return derived.length === before
    ? null
    : { identity: receiver.symbol, handler: derived.at(-1)!, visited: new Set(state.visited).add(receiver.symbol) };
}

function mountFrontier(source: BoundarySourceLocation, reason: string, missingKeyParts: string[]): BoundaryFrontier {
  return {
    observationId: `mount:${source.file}:${source.startLine}:${source.startColumn}:${reason}`,
    reason,
    missingKeyParts,
    sourceScope: 'production',
    kind: 'value-flow',
    action: 'http.handle',
    strength: 'candidate',
    source,
  };
}

function collectHttpMounts(db: ScipDatabase): {
  mounts: HttpMount[];
  filesInspected: number;
  frontiers: BoundaryFrontier[];
} {
  const mounts: HttpMount[] = [];
  const frontiers: BoundaryFrontier[] = [];
  const files = getSourceFiles(db);
  for (const file of files) {
    const context = boundaryFileContext(db, file);
    if (
      !context ||
      !sourceBindingResolver(file, context.root)
        .moduleReferences()
        .some((ref) => ref.literal && ref.specifier === 'express')
    )
      continue;
    walk(context.root, (node) => collectMountCall(context, node, mounts, frontiers));
  }
  return { mounts, filesInspected: files.length, frontiers };
}

function expressMountReceiver(context: BoundaryFileContext, node: SyntaxNode): SyntaxNode | null {
  if (node.type !== 'call_expression') return null;
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  if (target?.type !== 'member_expression' || target.childForFieldName('property')?.text !== 'use') return null;
  const receiver = target.childForFieldName('object');
  return receiver && isExpressInstance(context, receiver) ? receiver : null;
}

function isExpressInstance(context: BoundaryFileContext, node: SyntaxNode): boolean {
  const factory = sourceBindingResolver(context.file, context.root).constructedValue(node);
  return factory?.module === 'express' && [null, 'default', 'Router'].includes(factory.member);
}

function mountArguments(
  context: BoundaryFileContext,
  args: SyntaxNode[],
): { prefix: Omit<BoundaryKeyPart, 'name'>; routers: SyntaxNode[] } | null {
  const first = args[0];
  if (!first) return null;
  const value = evaluateBoundaryValue(context, first);
  if (value && value.evidence !== 'expression' && value.precision === 'literal') {
    return { prefix: value, routers: args.slice(1) };
  }
  // A lone router/middleware argument uses Express's default root mount path.
  if (args.length === 1 || isExpressInstance(context, first)) {
    return { prefix: { value: '/', evidence: 'constant', term: { kind: 'literal', value: '/' } }, routers: args };
  }
  return null;
}

function collectMountCall(
  context: BoundaryFileContext,
  node: SyntaxNode,
  mounts: HttpMount[],
  frontiers: BoundaryFrontier[],
): void {
  const receiverNode = expressMountReceiver(context, node);
  if (!receiverNode) return;
  const source = {
    file: context.file,
    startLine: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
  const args = mountArguments(context, callArguments(node));
  if (!args) {
    frontiers.push(mountFrontier(source, 'http-mount-prefix-unresolved', ['literal-prefix']));
    return;
  }
  for (const argument of args.routers) {
    const mounted = runtimeBindingIdentity(context, argument);
    if (mounted.evidence === 'expression' || mounted.term?.kind !== 'symbol') {
      frontiers.push(mountFrontier(source, 'http-mount-target-unresolved', ['router-instance-binding']));
      continue;
    }
    mounts.push({
      file: context.file,
      line: node.startPosition.row,
      prefix: args.prefix,
      targetIdentity: mounted.term.symbol,
      receiver: { name: 'router', ...runtimeBindingIdentity(context, receiverNode) },
      source,
    });
  }
}

function composePath(prefix: string, path: string): string {
  const left = prefix === '/' ? '' : prefix.replace(/\/+$/u, '');
  const right = path.startsWith('/') ? path : `/${path}`;
  return `${left}${right}` || '/';
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function appendMountedHttpHandler(
  mount: HttpMount,
  handler: BoundaryObservation,
  derived: BoundaryObservation[],
): void {
  const path = handler.keyParts.find((part) => part.name === 'path');
  if (!path || path.evidence === 'expression') return;
  const composed = composePath(mount.prefix.value, path.value);
  const keyParts = handler.keyParts.map(
    (part): BoundaryKeyPart =>
      part.name === 'router'
        ? mount.receiver
        : part.name === 'path'
          ? {
              name: 'path',
              value: composed,
              evidence: 'constant',
              term: {
                kind: 'concat',
                parts: [
                  mount.prefix.term ?? { kind: 'literal', value: mount.prefix.value },
                  path.term ?? { kind: 'literal', value: path.value },
                ],
              },
              derivation: {
                kind: 'mechanically-derived',
                rule: 'http.mount-prefix',
                ruleVersion: '1',
                inputFactIds: [handler.id],
                sourceSpans: [
                  handler.source,
                  mount.source,
                  ...(mount.prefix.derivation?.sourceSpans ?? []),
                  ...(path.derivation?.sourceSpans ?? []),
                ],
              },
            }
          : part,
  );
  const identity = `${handler.id}\0${mount.file}\0${mount.line}:${mount.source.startColumn}\0${composed}`;
  derived.push({
    ...handler,
    id: `boundary:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    keyParts,
    strength: 'derived',
    evidence: 'framework-mount-composition',
    derivation: {
      kind: 'mechanically-derived',
      rule: 'http.mount-prefix',
      ruleVersion: '1',
      inputFactIds: [handler.id],
      sourceSpans: [handler.source, mount.source],
    },
    resolution: 'unresolved',
  });
  // Preserve the independently observed registration. A mount adds a scoped path;
  // it cannot rewrite the direct fact or the cached inputs used by incremental extraction.
}
