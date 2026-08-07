import { createHash } from 'node:crypto';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { getAst } from '../../source/ast/ast-core.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { resolveCallableExpression } from './object-members.js';
import { runtimeBoundarySourceScope } from './source-scope.js';
import { evaluateStaticValue as evaluateBoundaryValue } from '../../symbols/graph/static-value-flow.js';
import type { BoundaryEvidenceStrength, BoundaryKeyPart, BoundaryObservation, BoundaryOwner } from './types.js';

export interface BoundaryFileContext {
  db: ScipDatabase;
  file: string;
  source: string;
  root: SyntaxNode;
  constants: ReadonlyMap<string, string>;
  ownerAt(line: number): BoundaryOwner;
}

export interface BoundaryExtractor {
  id: string;
  supports(source: string): boolean;
  extract(context: BoundaryFileContext): BoundaryObservation[];
}

const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const HTTP_RECEIVER_PATTERN = /(?:^|\.)(?:app|router|server)$/u;
const READ_METHODS = new Set(['findFirst', 'findMany', 'findUnique', 'from', 'get', 'select']);
const WRITE_METHODS = new Set(['create', 'delete', 'insert', 'remove', 'update', 'upsert']);
const SQL_EXECUTE_METHODS = new Set(['execute', 'query', 'raw']);

export const BOUNDARY_EXTRACTORS: readonly BoundaryExtractor[] = [
  httpExtractor(),
  effectHttpApiExtractor(),
  registryExtractor(),
  persistenceExtractor(),
  queueExtractor(),
];

export function boundaryFileContext(db: ScipDatabase, file: string): BoundaryFileContext | null {
  const root = getAst(db, file)?.rootNode;
  if (!root) return null;
  const source = getSourceText(db, file);
  const definitions = getDefinitionsForFile(db, file);
  const callables = getSourceFacts(db, file)?.callables ?? [];
  return {
    db,
    file,
    source,
    root,
    constants: literalConstants(root),
    ownerAt: (line) => {
      const definition = definitions
        .filter((candidate) => candidate.startLine <= line && candidate.endLine >= line)
        .sort(
          (left, right) =>
            left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
        )[0];
      if (definition) {
        return {
          file,
          symbol: definition.symbol,
          name: definition.leaf,
          startLine: definition.startLine,
          endLine: definition.endLine,
        };
      }
      const callable = callables
        .filter((candidate) => candidate.startLine <= line && candidate.endLine >= line)
        .sort(
          (left, right) =>
            left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
        )[0];
      return {
        file,
        symbol: null,
        name: callable?.name ?? null,
        startLine: callable?.startLine ?? line,
        endLine: callable?.endLine ?? line,
      };
    },
  };
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
    supports: (source) =>
      effectHttpApiImportedBindings(source, 'HttpApiEndpoint').size > 0 ||
      effectHttpApiImportedBindings(source, 'HttpApiBuilder').size > 0,
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      const endpointBindings = effectHttpApiImportedBindings(context.source, 'HttpApiEndpoint');
      const groupBindings = effectHttpApiImportedBindings(context.source, 'HttpApiGroup');
      const builderBindings = effectHttpApiImportedBindings(context.source, 'HttpApiBuilder');

      walk(context.root, (node) => {
        if (node.type !== 'call_expression') return;
        const callee = callMember(node);
        if (!callee) return;
        const args = callArguments(node);

        if (endpointBindings.has(callee.receiver) && HTTP_METHODS.has(callee.member)) {
          const operation = addressedArgument(args[0], context);
          const path = addressedArgument(args[1], context);
          const group = enclosingFrameworkCallArgument(node, groupBindings, 'make', 0, context);
          if (!operation || !path || !group) return;
          const method = callee.member.toUpperCase();
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
          return;
        }

        if (!['handle', 'handleRaw'].includes(callee.member)) return;
        const group = enclosingFrameworkCallArgument(node, builderBindings, 'group', 1, context);
        const operation = addressedArgument(args[0], context);
        const handler = args[1];
        if (!group || !operation || !handler) return;
        const keyParts = effectHttpApiOperationKey(group, operation);
        const targets = resolveCallableExpression(context.db, context.file, handler.text);
        const registration = observation(
          context,
          node,
          'builtin.effect-httpapi',
          'framework.handle',
          keyParts,
          targets.length === 1 ? resolvedStrength(keyParts) : 'candidate',
          'effect-httpapi-handler-registration',
        );
        const target = targets[0];
        if (targets.length === 1 && target) {
          registration.owner = {
            file: target.relativePath,
            symbol: target.symbol,
            name: target.leaf,
            startLine: target.startLine,
            endLine: target.endLine,
          };
        }
        observations.push(registration);
      });
      return observations;
    },
  };
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

function effectHttpApiImportedBindings(source: string, importedName: string): Set<string> {
  const bindings = new Set<string>();
  const namedImport = /\bimport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(namedImport)) {
    const moduleName = match[2] ?? '';
    if (!effectHttpApiModule(moduleName)) continue;
    for (const rawSpecifier of (match[1] ?? '').split(',')) {
      const specifier = rawSpecifier.trim().replace(/^type\s+/u, '');
      const imported = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(specifier);
      if (imported?.[1] === importedName) bindings.add(imported[2] ?? imported[1]);
    }
  }
  const namespaceImport = /\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(namespaceImport)) {
    const moduleName = match[2] ?? '';
    if (moduleName.endsWith(`/${importedName}`) && effectHttpApiModule(moduleName)) bindings.add(match[1]!);
  }
  return bindings;
}

function effectHttpApiModule(moduleName: string): boolean {
  return (
    moduleName === 'effect/unstable/httpapi' ||
    moduleName === '@effect/platform' ||
    moduleName.startsWith('@effect/platform/HttpApi')
  );
}

function enclosingFrameworkCallArgument(
  node: SyntaxNode,
  bindings: ReadonlySet<string>,
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
  bindings: ReadonlySet<string>,
  member: string,
  argumentIndex: number,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  const callee = callMember(node);
  if (!callee || callee.member !== member || !bindings.has(callee.receiver)) return null;
  return addressedArgument(callArguments(node)[argumentIndex], context);
}

function callMember(node: SyntaxNode): { receiver: string; member: string } | null {
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  if (!target || !['member_expression', 'subscript_expression'].includes(target.type)) return null;
  const object = target.childForFieldName('object') ?? target.namedChild(0);
  const property = target.childForFieldName('property') ?? target.childForFieldName('index') ?? target.namedChild(1);
  if (!object || !property) return null;
  return {
    receiver: object.text.replace(/\s+/gu, ''),
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
      hasPackageImport(source, ['axios']) ||
      /\b(?:FastAPI|Flask|APIRouter|axum|Router::new)\b/u.test(source),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      walk(context.root, (node) => {
        if (node.type === 'decorator') {
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
              'exact',
              'framework-decorator',
            ),
          );
          return;
        }
        if (node.type !== 'call_expression') return;
        const callee = callTarget(node);
        if (!callee) return;
        const leaf = callee.split('.').at(-1)?.toLowerCase() ?? '';
        const receiver = callee.includes('.') ? callee.slice(0, callee.lastIndexOf('.')) : '';
        const args = callArguments(node);

        if (leaf === 'route' && hasPackageImport(context.source, ['axum'])) {
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
              resolvedStrength([{ name: 'path', ...path }]),
              'framework-adapter',
            ),
          );
          return;
        }

        if (callee === 'fetch' || callee.endsWith('.fetch')) {
          const path = addressedArgument(args[0], context);
          if (!path) return;
          const explicitMethod = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/u.exec(args[1]?.text ?? '')?.[1]?.toUpperCase();
          const method = explicitMethod ?? (args[1] ? null : 'GET');
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
          return;
        }

        if (!HTTP_METHODS.has(leaf)) return;
        const path = addressedArgument(args[0], context);
        if (!path) return;
        const method = leaf.toUpperCase();
        const frameworkHandler =
          HTTP_RECEIVER_PATTERN.test(receiver) &&
          hasPackageImport(context.source, ['express', 'fastify', 'hono', 'koa-router', '@koa/router']);
        if (frameworkHandler) {
          observations.push(
            observation(
              context,
              node,
              'builtin.http',
              'http.handle',
              [
                { name: 'method', value: method, evidence: 'literal' },
                { name: 'path', ...path },
              ],
              resolvedStrength([{ name: 'path', ...path }]),
              'framework-adapter',
            ),
          );
          return;
        }
        const axiosBindings = importedBindings(context.source, ['axios']);
        const clientRoot = receiver.split('.')[0] ?? '';
        if (axiosBindings.has(clientRoot)) {
          observations.push(
            observation(
              context,
              node,
              'builtin.http',
              'http.request',
              [
                { name: 'method', value: method, evidence: 'literal' },
                { name: 'path', ...path },
              ],
              resolvedStrength([{ name: 'path', ...path }]),
              'client-adapter',
            ),
          );
        }
      });
      return observations;
    },
  };
}

function registryExtractor(): BoundaryExtractor {
  return {
    id: 'builtin.registry',
    supports: (source) => /(?:Handlers?|Registry|Routes?)\b/iu.test(source),
    extract: (context) => {
      const observations: BoundaryObservation[] = [];
      walk(context.root, (node) => {
        if (node.type === 'pair') {
          const container = registryContainerName(node);
          if (!container) return;
          const keyNode = node.childForFieldName('key') ?? node.namedChild(0);
          const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
          const key = registryKey(keyNode, context);
          if (!key || !valueNode || !registryValueLike(valueNode)) return;
          const valueStrength = directlyCallable(valueNode) ? 'exact' : 'candidate';
          observations.push(
            observation(
              context,
              node,
              'builtin.registry',
              'registry.handle',
              [
                { name: 'registry', value: container, evidence: 'identifier' },
                { name: 'key', ...key },
              ],
              resolvedStrength([{ name: 'key', ...key }], valueStrength),
              'object-member',
            ),
          );
          return;
        }
        if (node.type !== 'call_expression') return;
        const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
        if (!calleeNode) return;
        const match = /^([A-Za-z_$][\w$]*)\s*\[\s*(['"`])([^'"`]+)\2\s*\]$/u.exec(calleeNode.text.trim());
        if (!match) return;
        observations.push(
          observation(
            context,
            node,
            'builtin.registry',
            'registry.dispatch',
            [
              { name: 'registry', value: match[1]!, evidence: 'identifier' },
              { name: 'key', value: match[3]!, evidence: 'literal' },
            ],
            'exact',
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
      walk(context.root, (node) => {
        if (node.type !== 'call_expression') return;
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
        const evidence =
          leaf === 'insert'
            ? 'persistence-insert'
            : action === 'database.read' && /\bFOR\s+UPDATE\s+SKIP\s+LOCKED\b/iu.test(sql)
              ? 'persistence-skip-locked-claim'
              : 'persistence-adapter';
        observations.push(
          observation(
            context,
            node,
            'builtin.persistence',
            action,
            [{ name: 'resource', ...resource }],
            resolvedStrength([{ name: 'resource', ...resource }]),
            evidence,
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
      walk(context.root, (node) => {
        if (node.type !== 'call_expression') return;
        const callee = callTarget(node);
        if (!callee) return;
        const leaf = callee.split('.').at(-1) ?? '';
        const args = callArguments(node);
        const action =
          leaf === 'sendToQueue' || leaf === 'send'
            ? 'queue.send'
            : leaf === 'consume' || leaf === 'subscribe'
              ? 'queue.consume'
              : null;
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
            resolvedStrength([{ name: 'address', ...address }]),
            'framework-adapter',
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
  const owner = context.ownerAt(node.startPosition.row);
  const identity = JSON.stringify({
    extractor,
    action,
    file: context.file,
    line: node.startPosition.row,
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
    valuePrecision: keyParts.some((part) => part.evidence === 'expression')
      ? 'unknown'
      : keyParts.some((part) => part.evidence === 'identifier')
        ? 'symbolic'
        : 'literal',
    modality: 'may',
    resolution: 'unresolved',
    sourceScope: runtimeBoundarySourceScope(context.file),
  };
}

function boundaryRole(action: string): string {
  const leaf = action.split('.').at(-1) ?? action;
  if (['handle', 'subscribe', 'consume', 'read'].includes(leaf)) return 'consumer';
  if (['request', 'publish', 'send', 'write', 'dispatch'].includes(leaf)) return 'producer';
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

function importedBindings(source: string, packages: readonly string[]): Set<string> {
  const bindings = new Set<string>();
  for (const packageName of packages) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(
      `(?:import\\s+([A-Za-z_$][\\w$]*)[^;]*?\\sfrom\\s*|(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\s*\\(\\s*)['"]${escaped}(?:[/']|")`,
      'gu',
    );
    for (const match of source.matchAll(pattern)) {
      const binding = match[1] ?? match[2];
      if (binding) bindings.add(binding);
    }
  }
  return bindings;
}

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
        derivation: value.derivation,
      }
    : null;
}

function objectFieldArgument(
  node: SyntaxNode | null | undefined,
  field: string,
  context: BoundaryFileContext,
): Omit<BoundaryKeyPart, 'name'> | null {
  if (!node) return null;
  const pair = node.namedChildren.find((child) => {
    if (child.type !== 'pair') return false;
    const key = child.childForFieldName('key') ?? child.namedChild(0);
    return key?.text.replace(/^['"`]|['"`]$/gu, '') === field;
  });
  const value = pair?.childForFieldName('value') ?? pair?.namedChild(1);
  return addressedArgument(value, context);
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
  if (base === 'candidate' || keyParts.some((part) => part.evidence === 'expression')) return 'candidate';
  if (base === 'derived' || keyParts.some((part) => part.evidence === 'constant')) return 'derived';
  return 'exact';
}

function stringLiteral(node: SyntaxNode): string | null {
  const text = node.text.trim();
  const quote = text[0];
  if ((quote !== "'" && quote !== '"' && quote !== '`') || text.at(-1) !== quote) return null;
  const value = text.slice(1, -1);
  if (quote === '`' && value.includes('${')) return null;
  return value;
}

function literalConstants(root: SyntaxNode): Map<string, string> {
  const constants = new Map<string, string>();
  walk(root, (node) => {
    if (node.type !== 'variable_declarator') return;
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value || !/^[A-Za-z_$][\w$]*$/u.test(name.text)) return;
    const literal = stringLiteral(value);
    if (literal !== null) constants.set(name.text, literal);
  });
  return constants;
}

function registryContainerName(node: SyntaxNode): string | null {
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
  return /(?:handlers?|registry|routes?)$/iu.test(value) ? value : null;
}

function directlyCallable(node: SyntaxNode): boolean {
  return /(?:function|lambda|method)/u.test(node.type) || node.type === 'arrow_function';
}

function registryValueLike(node: SyntaxNode): boolean {
  if (directlyCallable(node) || node.type === 'member_expression') return true;
  return node.type === 'identifier' && /(?:command|controller|dispatch|handle|handler)/iu.test(node.text);
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
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
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

function parameterName(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  const named = node.childForFieldName('name') ?? node.childForFieldName('pattern');
  if (named) return parameterName(named);
  return node.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
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
