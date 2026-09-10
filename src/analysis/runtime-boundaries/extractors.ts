import { recordSourceEvidenceUnavailable } from '../../domain/file-access-recorder.js';
import { runtimeBindingIdentity, runtimeCallableDefinition } from './binding-identity.js';
import { boundaryKeyPrecision, boundaryValuePrecision } from './value-precision.js';
import { isPlatformFetch, fetchRequestMethod, effectiveObjectField } from './http-call-semantics.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { callSiteOwner } from '../../source/facts/source-callables.js';
import { lexicalCallOwners, sourceCallableOwnerKey } from '../../symbols/graph/call-graph-evidence.js';
import { createHash } from 'node:crypto';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { getAst, getAstForSource } from '../../source/ast/ast-core.js';
import { nodesOfTypes } from '../../source/ast/ast-node-index.js';
import { parameterName } from '../../source/ast/ast-callables.js';
import { detectAstLanguage } from '../../source/ast/ast-language.js';
import type { SyntaxNode, Tree } from '../../source/ast/ast-types.js';
import { callableSitesFromRoot, getCallableSites, type CallableSite } from '../../source/facts/ast-facts.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { runtimeBoundarySourceScope } from './source-scope.js';
import { evaluateStaticValue as evaluateBoundaryValue } from '../../symbols/graph/static-value-flow.js';
import type { BoundaryEvidenceStrength, BoundaryKeyPart, BoundaryObservation } from './types.js';

export type { BoundaryFileContext } from './types.js';
import type { BoundaryFileContext } from './types.js';

/** Keeps an uncached native tree alive only while its root node is reachable. */
const BOUNDARY_CONTEXT_TREES = new WeakMap<object, Tree>();

export interface BoundaryExtractor {
  id: string;
  supports(source: string): boolean;
  extract(context: BoundaryFileContext): BoundaryObservation[];
}

export interface RuntimeBoundaryProfileSpan {
  <T>(name: string, run: () => T, metadata?: Readonly<Record<string, string | number | boolean>>): T;
}

const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const HTTP_ROUTER_FACTORIES = new Map<string, ReadonlySet<string | null>>([
  ['express', new Set(['default', 'Router', null])],
  ['fastify', new Set(['default', 'fastify', null])],
  ['hono', new Set(['Hono'])],
  ['koa-router', new Set(['default', null])],
  ['@koa/router', new Set(['default', 'Router', null])],
]);
const READ_METHODS = new Set(['findFirst', 'findMany', 'findUnique', 'from', 'get', 'select']);
const WRITE_METHODS = new Set(['create', 'delete', 'insert', 'remove', 'update', 'upsert']);
const SQL_EXECUTE_METHODS = new Set(['execute', 'query', 'raw']);
const CAPABILITY_DESCRIPTOR_IDENTITY = /(?:\b(?:name|id)|['"`](?:name|id)['"`])\s*:/u;
const CAPABILITY_DESCRIPTOR_HANDLER =
  /(?:^\s*|[,{]\s*)(?:async\s+)?['"`]?(?:execute|handler|invoke|run)['"`]?\s*(?::|\([^)]*\)\s*\{)/mu;
const CAPABILITY_REFERENCE_WITH_SEPARATOR = /\b[A-Za-z_$][\w$-]*[_-][\w$-]*\s*\(/u;
const CAPABILITY_INSTRUCTION_REFERENCE =
  /\b(?:use|call|invoke|run|via|with|read|stop)(?:\s+the)?(?:\s+(?:tool|capability|command))?\s+[A-Za-z_$][\w$-]*\s*\(/iu;

export const BOUNDARY_EXTRACTORS: readonly BoundaryExtractor[] = [
  httpExtractor(),
  effectHttpApiExtractor(),
  nodeChildProcessExtractor(),
  capabilityRegistryExtractor(),
  registryExtractor(),
  persistenceExtractor(),
  queueExtractor(),
];

const NODE_CHILD_PROCESS_OPERATIONS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

function nodeChildProcessExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.node-child-process',
    supports: (source) => source.includes('child_process'),
    extract: (context) => {
      const bindings = sourceBindingResolver(context.file, context.root);
      const observations: BoundaryObservation[] = [];
      visitDescendantsOfType(context.root, 'call_expression', (node) => {
        const target = node.childForFieldName('function');
        const imported = target && bindings.importedValue(target);
        const operation =
          imported && ['node:child_process', 'child_process'].includes(imported.module) ? imported.member : null;
        if (!operation || !NODE_CHILD_PROCESS_OPERATIONS.has(operation)) return;

        const args = callArguments(node);
        const executable = addressedArgument(args[0], context) ?? {
          value: args[0]?.text.trim() || '<missing>',
          evidence: 'expression' as const,
        };
        const action = ['exec', 'execFile', 'execFileSync', 'execSync'].includes(operation)
          ? 'process.exec'
          : 'process.spawn';
        observations.push(
          observation(
            context,
            node,
            'builtin.node-child-process',
            action,
            [
              { name: 'operation', value: operation, evidence: 'literal' },
              { name: 'executable', ...executable },
            ],
            'exact',
            'node-child-process-import',
          ),
        );
      });
      return observations;
    },
  };
}

export function boundaryFileContext(
  db: ScipDatabase,
  file: string,
  knownSource?: string,
  profileSpan?: RuntimeBoundaryProfileSpan,
): BoundaryFileContext | null {
  const tree = profileBoundaryWork(profileSpan, 'runtime-boundaries.context.ast', file, () =>
    knownSource === undefined ? getAst(db, file) : getAstForSource(db, file, knownSource),
  );
  if (!tree) {
    recordSourceEvidenceUnavailable(file);
    return null;
  }
  const root = tree.rootNode;
  if (knownSource !== undefined) BOUNDARY_CONTEXT_TREES.set(root, tree);
  const source = knownSource ?? getSourceText(db, file);
  let definitions: ReturnType<typeof getDefinitionsForFile> | undefined;
  let callables: readonly CallableSite[] | null | undefined;
  const callableSites = (): readonly CallableSite[] | null => {
    if (callables !== undefined) return callables;
    callables = profileBoundaryWork(profileSpan, 'runtime-boundaries.context.callable-sites', file, () => {
      const language = detectAstLanguage(file);
      const fromRoot = language ? callableSitesFromRoot(root, language) : null;
      return fromRoot ?? getCallableSites(db, file);
    });
    return callables;
  };
  return {
    db,
    file,
    source,
    root,
    ownerAt: (node) => {
      const definitionsForFile = (definitions ??= profileBoundaryWork(
        profileSpan,
        'runtime-boundaries.context.definitions',
        file,
        () =>
          getDefinitionsForFile(
            db,
            file,
            { rangeCorrectionEvidence: { source, callables: callableSites() } },
            (phase, run) =>
              profileBoundaryWork(profileSpan, `runtime-boundaries.context.definitions.${phase}`, file, run),
          ),
      ));
      const language = detectAstLanguage(file);
      const sourceOwner = language ? callSiteOwner(node, language) : null;
      const owners = lexicalCallOwners(db, file, definitionsForFile);
      const containing = definitionsForFile.filter(
        (definition) =>
          !definition.isFunctionLike &&
          definition.startLine <= node.startPosition.row &&
          definition.endLine >= node.endPosition.row,
      );
      const definition = sourceOwner
        ? owners.get(sourceCallableOwnerKey(sourceOwner))
        : containing.length === 1
          ? containing[0]
          : null;
      return {
        file,
        symbol: definition?.symbol ?? null,
        name: sourceOwner?.name ?? definition?.leaf ?? null,
        startLine: sourceOwner?.startLine ?? definition?.startLine ?? node.startPosition.row,
        endLine: sourceOwner?.endLine ?? definition?.endLine ?? node.endPosition.row,
        startColumn: sourceOwner?.startColumn ?? definition?.startChar ?? node.startPosition.column,
        endColumn: sourceOwner?.endColumn ?? definition?.endChar ?? node.endPosition.column,
      };
    },
  };
}

function profileBoundaryWork<T>(
  profileSpan: RuntimeBoundaryProfileSpan | undefined,
  name: string,
  file: string,
  run: () => T,
): T {
  return profileSpan ? profileSpan(name, run, { file }) : run();
}

/**
 * Effect HttpApi separates an HTTP endpoint declaration from the callable
 * registered to implement it. The runtime joins those sites by group and
 * operation name, so neither a call graph nor a path-only HTTP extractor can
 * recover the handoff on its own.
 */
function effectHttpApiExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.effect-httpapi',
    supports: (source) => source.includes('effect/unstable/httpapi') || source.includes('@effect/platform'),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      const groupBindings = 'HttpApiGroup';
      const builderBindings = 'HttpApiBuilder';

      visitDescendantsOfType(context.root, 'call_expression', (node) => {
        const callee = callMember(node);
        if (!callee) return;
        const args = callArguments(node);

        if (effectImportedReceiver(context, callee.receiver, 'HttpApiEndpoint') && HTTP_METHODS.has(callee.member)) {
          appendEffectEndpoint(observations, context, node, callee.member, args, groupBindings);
          return;
        }

        appendEffectRegistration(observations, context, node, callee.member, args, builderBindings);
      });
      return observations;
    },
  };
}

function appendEffectEndpoint(
  observations: BoundaryObservation[],
  context: BoundaryFileContext,
  node: SyntaxNode,
  member: string,
  args: SyntaxNode[],
  groupBindings: string,
): void {
  const operation = addressedArgument(args[0], context);
  const path = addressedArgument(args[1], context);
  const group = enclosingFrameworkCallArgument(node, groupBindings, 'make', 0, context);
  if (!operation || !path || !group) return;
  const method = member.toUpperCase();
  observations.push(
    observation(
      context,
      node,
      'builtin.effect-httpapi',
      'http.handle',
      [
        { name: 'method', value: method, evidence: 'literal' },
        { name: 'path', ...path },
      ],
      resolvedStrength([{ name: 'path', ...path }]),
      'effect-httpapi-endpoint-declaration',
    ),
  );
  observations.push(
    observation(
      context,
      node,
      'builtin.effect-httpapi',
      'framework.declare',
      effectHttpApiOperationKey(group, operation),
      resolvedStrength(effectHttpApiOperationKey(group, operation)),
      'effect-httpapi-operation-declaration',
    ),
  );
}
function appendEffectRegistration(
  observations: BoundaryObservation[],
  context: BoundaryFileContext,
  node: SyntaxNode,
  member: string,
  args: SyntaxNode[],
  builderBindings: string,
): void {
  if (!['handle', 'handleRaw'].includes(member)) return;
  const group = enclosingFrameworkCallArgument(node, builderBindings, 'group', 1, context);
  const operation = addressedArgument(args[0], context);
  const handler = args[1];
  if (!group || !operation || !handler) return;
  const keyParts = effectHttpApiOperationKey(group, operation);
  const target = runtimeCallableDefinition(context, handler);
  const registration = observation(
    context,
    node,
    'builtin.effect-httpapi',
    'framework.handle',
    keyParts,
    target ? resolvedStrength(keyParts) : 'candidate',
    'effect-httpapi-handler-registration',
  );
  if (target) {
    registration.owner = {
      file: target.relativePath,
      symbol: target.symbol,
      name: target.leaf,
      startLine: target.startLine,
      endLine: target.endLine,
      startColumn: target.startChar,
      endColumn: target.endChar,
    };
  }
  observations.push(registration);
}

function effectHttpApiOperationKey(
  group: Omit<BoundaryKeyPart, 'name'>,
  operation: Omit<BoundaryKeyPart, 'name'>,
): BoundaryKeyPart[] {
  return [
    { name: 'adapter', value: 'effect-httpapi', evidence: 'literal' },
    { name: 'group', ...group },
    { name: 'operation', ...operation },
  ];
}

function effectImportedReceiver(context: BoundaryFileContext, receiver: SyntaxNode, importedName: string): boolean {
  const imported = sourceBindingResolver(context.file, context.root).importedValue(receiver);
  if (!imported) return false;
  return (
    ((imported.module === 'effect/unstable/httpapi' || imported.module === '@effect/platform') &&
      imported.member === importedName) ||
    (imported.module === `@effect/platform/${importedName}` && imported.member === null)
  );
}

function enclosingFrameworkCallArgument(
  node: SyntaxNode,
  bindings: string,
  member: string,
  argumentIndex: number,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'call_expression') {
      const direct = frameworkCallArgument(current, bindings, member, argumentIndex, context);
      if (direct) return direct;
      const receiver = current.childForFieldName('function') ?? current.namedChild(0);
      let nested: Omit<BoundaryKeyPart, 'name'> | null = null;
      if (receiver) {
        walk(receiver, (candidate) => {
          if (!nested && candidate.type === 'call_expression') {
            nested = frameworkCallArgument(candidate, bindings, member, argumentIndex, context);
          }
        });
      }
      if (nested) return nested;
    }
    current = current.parent;
  }
  return null;
}

function frameworkCallArgument(
  node: SyntaxNode,
  bindings: string,
  member: string,
  argumentIndex: number,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  const callee = callMember(node);
  if (!callee || callee.member !== member || !effectImportedReceiver(context, callee.receiver, bindings)) return null;
  return addressedArgument(callArguments(node)[argumentIndex], context);
}

function callMember(node: SyntaxNode): { receiver: SyntaxNode; member: string } | null {
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  if (!target || !['member_expression', 'subscript_expression'].includes(target.type)) return null;
  const object = target.childForFieldName('object') ?? target.namedChild(0);
  const property = target.childForFieldName('property') ?? target.childForFieldName('index') ?? target.namedChild(1);
  if (!object || !property) return null;
  return {
    receiver: object,
    member: property.text.replace(/^['"`]|['"`]$/gu, ''),
  };
}

function httpExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.http',
    supports: (source) =>
      /\bfetch\s*\(|\baxios\b|\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|options|head)\s*\(/u.test(
        source,
      ) ||
      hasPackageImport(source, ['axios', ...HTTP_ROUTER_FACTORIES.keys()]) ||
      /\b(?:FastAPI|Flask|APIRouter|axum|Router::new)\b/u.test(source),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      const collectDecorator = (node: SyntaxNode): void => {
        const match = /^@[^\s(]+\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])([^'"`]+)\2/iu.exec(
          node.text.trim(),
        );
        if (!match || !hasPackageImport(context.source, ['fastapi', 'flask'])) return;
        observations.push(
          observation(
            context,
            node,
            'builtin.http',
            'http.handle',
            [
              { name: 'method', value: match[1]!.toUpperCase(), evidence: 'literal' },
              { name: 'path', value: match[3]!, evidence: 'literal' },
            ],
            'candidate',
            'framework-decorator-receiver-unverified',
          ),
        );
      };
      const collectAxumRoute = (node: SyntaxNode, args: SyntaxNode[]): void => {
        const path = addressedArgument(args[0], context);
        const method = /^\s*(get|post|put|patch|delete|options|head)\s*\(/iu.exec(args[1]?.text ?? '')?.[1];
        if (!path || !method) return;
        observations.push(
          observation(
            context,
            node,
            'builtin.http',
            'http.handle',
            [
              { name: 'method', value: method.toUpperCase(), evidence: 'literal' },
              { name: 'path', ...path },
            ],
            'candidate',
            'framework-route-receiver-unverified',
          ),
        );
      };
      const collectFetchRequest = (node: SyntaxNode, args: SyntaxNode[]): void => {
        const path = addressedArgument(args[0], context);
        if (!path) return;
        const method = fetchRequestMethod(args[1], context);
        const keyParts: BoundaryKeyPart[] = [
          ...(method ? [{ name: 'method', value: method, evidence: 'literal' as const }] : []),
          { name: 'path', ...path },
        ];
        observations.push(
          observation(
            context,
            node,
            'builtin.http',
            'http.request',
            keyParts,
            method ? resolvedStrength(keyParts) : 'candidate',
            'call-expression',
          ),
        );
      };
      const collectMethodCall = (node: SyntaxNode, args: SyntaxNode[], leaf: string): void => {
        if (!HTTP_METHODS.has(leaf)) return;
        const receiver = httpMethodReceiver(context, node, leaf);
        if (!receiver) return;
        // Unrelated get/delete/etc. calls can take large imported schema objects.
        // Resolve an address only after the receiver establishes HTTP relevance.
        const path = addressedArgument(args[0], context);
        if (!path) return;
        observations.push(
          observation(
            context,
            node,
            'builtin.http',
            receiver.action,
            [
              { name: 'method', value: leaf.toUpperCase(), evidence: 'literal' },
              { name: 'path', ...path },
              ...(receiver.action === 'http.handle'
                ? [{ name: 'router', ...runtimeBindingIdentity(context, receiver.router) }]
                : []),
            ],
            resolvedStrength([{ name: 'path', ...path }]),
            receiver.evidence,
          ),
        );
      };
      visitDescendantsOfType(context.root, ['decorator', 'call_expression'], (node) => {
        if (node.type === 'decorator') return collectDecorator(node);
        if (node.type !== 'call_expression') return;
        const callee = callTarget(node);
        if (!callee) return;
        const leaf = callee.split('.').at(-1) ?? '';
        const args = callArguments(node);
        if (leaf === 'route' && hasPackageImport(context.source, ['axum'])) return collectAxumRoute(node, args);
        if (isPlatformFetch(context, node)) return collectFetchRequest(node, args);
        collectMethodCall(node, args, leaf);
      });
      return observations;
    },
  };
}

function httpMethodReceiver(
  context: BoundaryFileContext,
  node: SyntaxNode,
  leaf: string,
):
  | { action: 'http.handle'; evidence: 'framework-adapter'; router: SyntaxNode }
  | { action: 'http.request'; evidence: 'client-adapter' }
  | null {
  const target = node.childForFieldName('function');
  if (!target) return null;
  const bindings = sourceBindingResolver(context.file, context.root);
  const router = target.childForFieldName('object');
  const factory = router && bindings.constructedValue(router);
  if (factory && HTTP_ROUTER_FACTORIES.get(factory.module)?.has(factory.member))
    return { action: 'http.handle', evidence: 'framework-adapter', router: router! };
  const imported = bindings.importedValue(target);
  return imported?.module === 'axios' && imported.member === leaf
    ? { action: 'http.request', evidence: 'client-adapter' }
    : null;
}

function capabilityRegistryExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.capability-registry',
    supports: (source) =>
      (CAPABILITY_DESCRIPTOR_IDENTITY.test(source) && CAPABILITY_DESCRIPTOR_HANDLER.test(source)) ||
      CAPABILITY_REFERENCE_WITH_SEPARATOR.test(source) ||
      CAPABILITY_INSTRUCTION_REFERENCE.test(source),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      const seen = new Set<string>();
      const nodeTypes: string[] = [];
      if (CAPABILITY_DESCRIPTOR_IDENTITY.test(context.source) && CAPABILITY_DESCRIPTOR_HANDLER.test(context.source)) {
        nodeTypes.push('pair');
      }
      if (
        CAPABILITY_REFERENCE_WITH_SEPARATOR.test(context.source) ||
        CAPABILITY_INSTRUCTION_REFERENCE.test(context.source)
      ) {
        nodeTypes.push('string', 'string_literal', 'template_string');
      }
      visitDescendantsOfType(context.root, nodeTypes, (node) => {
        if (node.type === 'pair') {
          appendCapabilityDescriptor(observations, seen, context, node);
          return;
        }
        appendCapabilityReferences(observations, seen, context, node);
      });
      return observations;
    },
  };
}

function appendCapabilityDescriptor(
  observations: BoundaryObservation[],
  seen: Set<string>,
  context: BoundaryFileContext,
  node: SyntaxNode,
): void {
  const keyNode = node.childForFieldName('key') ?? node.namedChild(0);
  const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
  const field = keyNode?.text.replace(/^['"`]|['"`]$/gu, '');
  if (field !== 'name' && field !== 'id') return;
  const handler = capabilityDescriptorHandler(node);
  if (!handler) return;
  const key = registryKey(valueNode, context);
  if (!key || key.evidence !== 'literal') return;
  const identity = `handle\0${key.value}\0${handler.startPosition.row}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  observations.push(
    observation(
      context,
      handler,
      'builtin.capability-registry',
      'registry.handle',
      [{ name: 'key', ...key }],
      'exact',
      'capability-descriptor',
    ),
  );
}
function appendCapabilityReferences(
  observations: BoundaryObservation[],
  seen: Set<string>,
  context: BoundaryFileContext,
  node: SyntaxNode,
): void {
  if (!['string', 'string_literal', 'template_string'].includes(node.type)) return;
  const text = node.text.replace(/^['"`]|['"`]$/gu, '');
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$-]*)\s*\(/gu)) {
    const key = match[1]!;
    if (!isCapabilityReference(text, key, match.index)) continue;
    const identity = `reference\0${key}\0${node.startPosition.row}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    observations.push(
      observation(
        context,
        node,
        'builtin.capability-registry',
        'registry.reference',
        [{ name: 'key', value: key, evidence: 'literal' }],
        'exact',
        'capability-instruction-reference',
      ),
    );
  }
}

function isCapabilityReference(text: string, key: string, offset: number): boolean {
  if (key.includes('_') || key.includes('-')) return true;
  const prefix = text.slice(Math.max(0, offset - 64), offset);
  return /\b(?:use|call|invoke|run|via|with|read|stop)(?:\s+the)?(?:\s+(?:tool|capability|command))?\s*$/iu.test(
    prefix,
  );
}

function registryExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.registry',
    supports: (source) => /(?:Handlers?|Registry|Routes?)\b/iu.test(source),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      visitDescendantsOfType(context.root, ['pair', 'call_expression'], (node) => {
        if (node.type === 'pair') {
          collectRegistryMemberObservation(context, node, observations);
          return;
        }
        if (node.type !== 'call_expression') return;
        const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
        if (!calleeNode) return;
        if (calleeNode.type !== 'subscript_expression') return;
        const receiver = calleeNode.childForFieldName('object');
        const key = addressedArgument(calleeNode.childForFieldName('index'), context);
        if (!receiver || !key) return;
        const registry = runtimeBindingIdentity(context, receiver);
        observations.push(
          observation(
            context,
            node,
            'builtin.registry',
            'registry.dispatch',
            [
              { name: 'registry', ...registry },
              { name: 'key', ...key },
            ],
            resolvedStrength([
              { name: 'registry', ...registry },
              { name: 'key', ...key },
            ]),
            'indexed-access-call',
          ),
        );
      });
      return observations;
    },
  };
}

function persistenceExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.persistence',
    supports: (source) =>
      /\b(?:db|database|prisma|drizzle|[A-Za-z_$][\w$]*(?:Repository|Repo))\b[^;]{0,1024}?\.\s*(?:findFirst|findMany|findUnique|from|get|select|create|delete|insert|remove|update|upsert|execute|query|raw|transaction)(?:\s*<[^()]{1,512}>)?\s*\(/iu.test(
        source,
      ),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      const transactionReceivers = persistenceTransactionReceivers(context.root);
      visitDescendantsOfType(context.root, 'call_expression', (node) => {
        const callee = callTarget(node);
        if (!callee) return;
        const parts = callee.split('.');
        const leaf = parts.at(-1) ?? '';
        const args = callArguments(node);
        const sql = args[0]?.text ?? '';
        const action = persistenceAction(leaf, sql);
        if (!action) return;
        const adapter = persistenceAdapter(parts, transactionReceivers);
        if (!adapter) return;
        const argumentResource = persistenceArgument(args[0], context) ?? sqlPersistenceResource(sql);
        const resource = persistenceResource(adapter, parts, leaf, argumentResource);
        if (!resource) return;
        const evidence = persistenceObservationEvidence(leaf, action, sql);
        observations.push(
          observation(
            context,
            node,
            'builtin.persistence',
            action,
            [{ name: 'resource', ...resource }],
            'candidate',
            `${evidence}-receiver-and-resource-identity-unverified`,
          ),
        );
      });
      return observations;
    },
  };
}

function persistenceArgument(
  node: SyntaxNode | null | undefined,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  if (!node) return null;
  const compact = node.text.replace(/\s+/gu, '');
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(compact)) {
    return {
      value: compact.split('.').at(-1)!,
      evidence: 'identifier',
      term: { kind: 'symbol', symbol: compact },
    };
  }
  return addressedArgument(node, context);
}

function queueExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.queue',
    supports: (source) =>
      hasPackageImport(source, ['amqplib', 'bullmq', 'kafkajs', '@aws-sdk/client-sqs', 'rabbitmq']) &&
      /\.(?:sendToQueue|consume|send|subscribe)\s*\(/u.test(source),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      visitDescendantsOfType(context.root, 'call_expression', (node) => {
        const callee = callTarget(node);
        if (!callee) return;
        const leaf = callee.split('.').at(-1) ?? '';
        const args = callArguments(node);
        const action = queueCallAction(leaf);
        if (!action) return;

        const address =
          leaf === 'send' || leaf === 'subscribe'
            ? objectFieldArgument(args[0], 'topic', context)
            : addressedArgument(args[0], context);
        if (!address) return;
        observations.push(
          observation(
            context,
            node,
            'builtin.queue',
            action,
            [{ name: 'address', ...address }],
            'candidate',
            'queue-receiver-and-broker-identity-unverified',
          ),
        );
      });
      return observations;
    },
  };
}

function observation(
  context: BoundaryFileContext,
  node: SyntaxNode,
  extractor: string,
  action: string,
  keyParts: BoundaryKeyPart[],
  strength: BoundaryEvidenceStrength,
  evidence: string,
): BoundaryObservation {
  const owner = context.ownerAt(node);
  const identity = JSON.stringify({
    extractor,
    action,
    file: context.file,
    line: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
    keyParts,
  });
  return {
    id: `boundary:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    extractor,
    action,
    owner,
    source: {
      file: context.file,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
    },
    keyParts,
    evidence,
    strength,
    protocol: action.split('.')[0] ?? action,
    role: boundaryRole(action),
    executionDomain: executionDomain(context.file),
    derivation: {
      kind: strength === 'candidate' ? 'heuristic' : strength === 'derived' ? 'mechanically-derived' : 'direct',
      rule: evidence,
      ruleVersion: '1',
      inputFactIds: keyParts.flatMap((part) => part.derivation?.inputFactIds ?? []),
      sourceSpans: [
        { file: context.file, startLine: node.startPosition.row, endLine: node.endPosition.row },
        ...keyParts.flatMap((part) => part.derivation?.sourceSpans ?? []),
      ],
    },
    valuePrecision: boundaryValuePrecision(keyParts),
    modality: 'may',
    resolution: 'unresolved',
    sourceScope: runtimeBoundarySourceScope(context.file),
  };
}

function boundaryRole(action: string): string {
  const leaf = action.split('.').at(-1) ?? action;
  if (['handle', 'subscribe', 'consume', 'read'].includes(leaf)) return 'consumer';
  if (['request', 'publish', 'send', 'write', 'dispatch', 'reference', 'invoke', 'spawn', 'exec'].includes(leaf)) {
    return 'producer';
  }
  return 'observe';
}

function executionDomain(file: string): string | null {
  const normalized = file.replaceAll('\\', '/');
  const workspace = /^(apps|services|packages)\/([^/]+)/u.exec(normalized);
  return workspace ? `${workspace[1]}/${workspace[2]}` : null;
}

function hasPackageImport(source: string, packages: readonly string[]): boolean {
  return packages.some((packageName) => {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(
      `(?:\\bfrom\\s+${escaped}\\b|\\buse\\s+${escaped}\\b|(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*)['"]${escaped}(?:[/']|"))`,
      'u',
    ).test(source);
  });
}

// scip-query: ignore-passthrough — exported construction boundary keeps extractors off the private observation primitive.
export function createBoundaryObservation(
  context: BoundaryFileContext,
  node: SyntaxNode,
  extractor: string,
  action: string,
  keyParts: BoundaryKeyPart[],
  strength: BoundaryEvidenceStrength,
  evidence: string,
): BoundaryObservation {
  return observation(context, node, extractor, action, keyParts, strength, evidence);
}

function callTarget(node: SyntaxNode): string | null {
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  return target?.text.replace(/\s+/gu, '') ?? null;
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function addressedArgument(
  node: SyntaxNode | null | undefined,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  const value = evaluateBoundaryValue(context, node);
  return value
    ? {
        value: value.value,
        evidence: value.evidence,
        term: value.term,
        precision: value.precision,
        derivation: value.derivation,
      }
    : null;
}

function objectFieldArgument(
  node: SyntaxNode | null | undefined,
  field: string,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  const fieldValue = effectiveObjectField(context, node ?? undefined, field);
  return fieldValue.kind === 'value' ? addressedArgument(fieldValue.node, context) : null;
}

function registryKey(
  node: SyntaxNode | null | undefined,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  if (!node) return null;
  const evaluated = addressedArgument(node, context);
  if (evaluated?.evidence === 'literal' || evaluated?.evidence === 'constant') return evaluated;
  const identifier = node.text.trim();
  if (/^[A-Za-z_$][\w$]*$/u.test(identifier)) {
    return {
      value: identifier,
      evidence: 'identifier',
      term: { kind: 'symbol', symbol: identifier },
    };
  }
  return evaluated;
}

function resolvedStrength(
  keyParts: readonly BoundaryKeyPart[],
  base: BoundaryEvidenceStrength = 'exact',
): BoundaryEvidenceStrength {
  if (
    base === 'candidate' ||
    keyParts.some(
      (part) =>
        part.evidence === 'expression' ||
        ['unknown', 'constrained-pattern', 'finite-set'].includes(boundaryKeyPrecision(part)),
    )
  )
    return 'candidate';
  if (base === 'derived' || keyParts.some((part) => part.evidence === 'constant')) return 'derived';
  return 'exact';
}

function registryContainerName(node: SyntaxNode): SyntaxNode | null {
  const object = node.parent;
  let declarator = object?.parent ?? null;
  while (
    declarator &&
    ['as_expression', 'satisfies_expression', 'type_assertion', 'parenthesized_expression'].includes(declarator.type)
  ) {
    declarator = declarator.parent;
  }
  if (!object || !declarator || declarator.type !== 'variable_declarator') return null;
  const name = declarator.childForFieldName('name') ?? declarator.namedChild(0);
  const value = name?.text ?? '';
  return /(?:handlers?|registry|routes?)$/iu.test(value) ? name : null;
}

function directlyCallable(node: SyntaxNode): boolean {
  return /(?:function|lambda|method)/u.test(node.type) || node.type === 'arrow_function';
}

function registryValueLike(node: SyntaxNode): boolean {
  if (directlyCallable(node) || node.type === 'member_expression') return true;
  return node.type === 'identifier' && /(?:command|controller|dispatch|handle|handler)/iu.test(node.text);
}

function capabilityDescriptorHandler(identityPair: SyntaxNode): SyntaxNode | null {
  let current = identityPair.parent;
  while (current && current.type !== 'variable_declarator') {
    if (['object', 'object_literal', 'dictionary'].includes(current.type)) {
      for (const child of current.namedChildren) {
        if (isCapabilityHandlerMember(child)) return current;
      }
    }
    current = current.parent;
  }
  return null;
}

function isCapabilityHandlerMember(child: SyntaxNode): boolean {
  if (child.type === 'pair' && isCapabilityHandlerPair(child)) return true;
  const name = child.childForFieldName('name') ?? child.namedChild(0);
  if (
    name &&
    ['execute', 'handler', 'invoke', 'run'].includes(name.text.replace(/^['"`]|['"`]$/gu, '')) &&
    /(?:function|method)/u.test(child.type)
  ) {
    return true;
  }
  return false;
}

function isCapabilityHandlerPair(child: SyntaxNode): boolean {
  const key = child.childForFieldName('key') ?? child.namedChild(0);
  const value = child.childForFieldName('value') ?? child.namedChild(1);
  const field = key?.text.replace(/^['"`]|['"`]$/gu, '');
  return !!field && ['execute', 'handler', 'invoke', 'run'].includes(field) && !!value && registryValueLike(value);
}

type PersistenceAdapter = 'database' | 'orm' | 'repository';

function persistenceAdapter(
  parts: readonly string[],
  transactionReceivers: ReadonlySet<string> = new Set(),
): PersistenceAdapter | null {
  const receiverParts = parts.slice(0, -1).map((part) => part.replace(/\([^)]*\)/gu, ''));
  if (receiverParts.some((part) => /^(?:prisma|drizzle)$/iu.test(part))) return 'orm';
  if (receiverParts.some((part) => /(?:Repository|Repo)$/u.test(part))) return 'repository';
  if (receiverParts.some((part) => /^(?:db|database)$/iu.test(part) || transactionReceivers.has(part))) {
    return 'database';
  }
  return null;
}

function persistenceAction(leaf: string, sql: string): 'database.read' | 'database.write' | null {
  if (READ_METHODS.has(leaf)) return 'database.read';
  if (WRITE_METHODS.has(leaf)) return 'database.write';
  if (!SQL_EXECUTE_METHODS.has(leaf)) return null;
  const operation = /\b(SELECT|INSERT|UPDATE|DELETE)\b/iu.exec(sql)?.[1]?.toUpperCase();
  return operation === 'SELECT' ? 'database.read' : operation ? 'database.write' : null;
}

function persistenceTransactionReceivers(root: SyntaxNode): Set<string> {
  const receivers = new Set<string>();
  visitDescendantsOfType(root, 'call_expression', (node) => {
    const target = callTarget(node);
    if (!target) return;
    const parts = target.split('.');
    if (parts.at(-1) !== 'transaction' || !persistenceAdapter(parts)) return;
    for (const callback of callArguments(node)) {
      if (!directlyCallable(callback)) continue;
      const parameters =
        callback.childForFieldName('parameters') ??
        callback.namedChildren.find((child) => /parameters/u.test(child.type));
      const first = parameters?.namedChildren[0];
      const name = first ? parameterName(first) : null;
      if (name) receivers.add(name);
    }
  });
  return receivers;
}

function sqlPersistenceResource(sql: string): Omit<BoundaryKeyPart, 'name'> | null {
  const resource = sqlResource(sql);
  return resource
    ? {
        value: resource,
        evidence: 'identifier',
        term: { kind: 'symbol', symbol: resource },
      }
    : null;
}

function persistenceResource(
  adapter: PersistenceAdapter,
  parts: readonly string[],
  leaf: string,
  argument: Omit<BoundaryKeyPart, 'name'> | null,
): Omit<BoundaryKeyPart, 'name'> | null {
  if (adapter === 'orm' && parts.length >= 3) {
    return { value: parts.at(-2)!.replace(/\([^)]*\)/gu, ''), evidence: 'identifier' };
  }
  if (adapter === 'repository') {
    const owner = parts.at(-2)?.replace(/(?:Repository|Repo)$/u, '');
    return owner ? { value: owner, evidence: 'identifier' } : null;
  }
  if (!argument) return null;
  if (leaf === 'from' || leaf === 'insert') return argument;
  const table = sqlResource(argument.value);
  return table ? { value: table, evidence: argument.evidence } : null;
}

function sqlResource(sql: string): string | null {
  return /\b(?:from|into|update|table)\s+(?:\$\{\s*)?['"`]?([A-Za-z_$][\w$.-]*)/iu.exec(sql)?.[1] ?? null;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function visitDescendantsOfType(root: SyntaxNode, type: string | string[], visit: (node: SyntaxNode) => void): void {
  for (const node of nodesOfTypes(root, type)) visit(node);
}

function collectRegistryMemberObservation(
  context: BoundaryFileContext,
  node: SyntaxNode,
  observations: BoundaryObservation[],
): void {
  const container = registryContainerName(node);
  if (!container) return;
  const keyNode = node.childForFieldName('key') ?? node.namedChild(0);
  const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
  const key = registryKey(keyNode, context);
  if (!key || !valueNode || !registryValueLike(valueNode)) return;
  const registry = runtimeBindingIdentity(context, container);
  const effective = effectiveObjectField(context, node.parent ?? undefined, key.value);
  if (effective.kind === 'value' && effective.node.startIndex !== valueNode.startIndex) return;
  const stable = !sourceBindingResolver(context.file, context.root).hasObservedWrite(container, true);
  const valueStrength = stable && effective.kind === 'value' && directlyCallable(valueNode) ? 'exact' : 'candidate';
  observations.push(
    observation(
      context,
      node,
      'builtin.registry',
      'registry.handle',
      [
        { name: 'registry', ...registry },
        { name: 'key', ...key },
      ],
      resolvedStrength(
        [
          { name: 'registry', ...registry },
          { name: 'key', ...key },
        ],
        valueStrength,
      ),
      'object-member',
    ),
  );
}

function persistenceObservationEvidence(leaf: string, action: string, sql: string): string {
  return leaf === 'insert'
    ? 'persistence-insert'
    : action === 'database.read' && /\bFOR\s+UPDATE\s+SKIP\s+LOCKED\b/iu.test(sql)
      ? 'persistence-skip-locked-claim'
      : 'persistence-adapter';
}

function queueCallAction(leaf: string): 'queue.send' | 'queue.consume' | null {
  return leaf === 'sendToQueue' || leaf === 'send'
    ? 'queue.send'
    : leaf === 'consume' || leaf === 'subscribe'
      ? 'queue.consume'
      : null;
}
