import { pathsResolveSame } from '../../domain/path-normalization.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import { getSourceImports } from '../../language-parsers/index.js';
import {
  getAst,
  getCallableSites,
  getCallSites,
  nodesOfTypes,
  smallestCoveringCallable,
  type SyntaxNode,
} from '../../source/ast.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../definition-catalog.js';
import { resolveImportedDefinitions } from '../imported-definitions.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from '../leaf-symbol-index.js';
import { getResolvedReferenceSites } from '../references/reference-sites.js';
import { parentTypeName } from '../symbol-parser.js';

const SERVICE_IMPLEMENTATION_FILES = new WeakMap<ScipDatabase, Map<string, string[]>>();
const SERVICE_DECLARATION_FILES = new WeakMap<ScipDatabase, Map<string, string[]>>();
const MEMBER_CALL_EXPRESSIONS = new WeakMap<ScipDatabase, Map<string, Map<string, SyntaxNode>>>();
const FACTORY_CALLBACK_IMPLEMENTATIONS = new WeakMap<
  ScipDatabase,
  Map<string, Array<{ name: string; file: string; startLine: number; endLine: number }>>
>();
const SERVICE_MEMBER_IMPLEMENTATIONS = new WeakMap<
  ScipDatabase,
  Map<string, Array<{ name: string; startLine: number; endLine: number; file: string }>>
>();

export interface ImportedMemberCallTarget {
  calleeLeaf: string;
  line: number;
  sourceFile: string;
  targetFile: string;
  targetStartLine: number;
  targetEndLine: number;
  targetSymbol?: string;
  /** Service declaration file whose consumers can call an implementation in targetFile. */
  serviceFile?: string;
  /** Number of mechanically possible targets retained for this callsite. */
  resolutionAlternativeCount?: number;
  resolution?:
    | 'direct-import-receiver'
    | 'constructed-member-receiver'
    | 'imported-service-object-member'
    | 'factory-callback-member';
  strength?: 'exact' | 'candidate';
}

export interface ImportedMemberCallTargetsResult {
  targets: ImportedMemberCallTarget[];
  unresolvedCallsites: number;
}

/**
 * Recover service declaration files implemented by one provider file. This is
 * the reverse half of service-member resolution: callers import the declaration
 * while the selected implementation lives in a different file.
 */
export function serviceDeclarationFilesForImplementation(db: ScipDatabase, implementationFile: string): string[] {
  let byImplementation = SERVICE_DECLARATION_FILES.get(db);
  if (!byImplementation) {
    byImplementation = new Map();
    SERVICE_DECLARATION_FILES.set(db, byImplementation);
  }
  const cached = byImplementation.get(implementationFile);
  if (cached) return cached;
  const root = getAst(db, implementationFile)?.rootNode;
  if (!root) {
    byImplementation.set(implementationFile, []);
    return [];
  }
  const providerAliases = new Set<string>();
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
    const callee = node.childForFieldName('function') ?? node.namedChild(0);
    const match = /^([A-Za-z_$][\w$]*(?:\.Service)?)\.of$/u.exec(callee?.text.replace(/\s+/gu, '') ?? '');
    if (match) providerAliases.add(match[1]!);
  });
  const imports = getSourceImports(db, implementationFile).filter(
    (entry): entry is ParsedSourceImport & { sourcePath: string } => Boolean(entry.sourcePath),
  );
  const files = new Set<string>();
  for (const alias of providerAliases) {
    const namespace = /^([A-Za-z_$][\w$]*)\.Service$/u.exec(alias);
    if (namespace) {
      for (const imported of imports) {
        if (imported.localName === namespace[1]) files.add(imported.sourcePath);
      }
      continue;
    }
    if (alias !== 'Service') continue;
    if (getDefinitionsForFile(db, implementationFile).some((definition) => definition.leaf === 'Service')) {
      files.add(implementationFile);
    }
    for (const imported of imports) {
      if ((imported.localName ?? imported.importedName) === 'Service') files.add(imported.sourcePath);
    }
  }
  const result = uniqueResolvedPaths([...files]).sort();
  byImplementation.set(implementationFile, result);
  return result;
}

/**
 * Recover file-level targets for member calls whose callable is present in
 * source but absent from the compiler symbol table. A target is admitted only
 * when exactly one directly imported source file declares the callable leaf.
 */
export function importedMemberCallTargets(
  db: ScipDatabase,
  sourceFile: string,
  options: {
    ranges?: readonly { startLine: number; endLine: number }[];
    excludeIndexedTargets?: boolean;
  } = {},
): ImportedMemberCallTargetsResult {
  const allCallsites = getCallSites(db, sourceFile);
  const callsites = allCallsites?.filter(
    (site) =>
      !options.ranges || options.ranges.some((range) => site.line >= range.startLine && site.line <= range.endLine),
  );
  if (!callsites) return { targets: [], unresolvedCallsites: 0 };

  const sourceImports = getSourceImports(db, sourceFile).filter(
    (entry): entry is ParsedSourceImport & { sourcePath: string } => Boolean(entry.sourcePath),
  );
  const sourceAliases = simpleIdentifierAliases(getSourceText(db, sourceFile) ?? '');
  const sourceRoot = getAst(db, sourceFile)?.rootNode ?? null;
  const serviceReceivers = sourceRoot ? indexServiceReceivers(sourceRoot) : emptyServiceReceiverIndex();
  const callablesByFile = new Map<string, Array<{ name: string; startLine: number; endLine: number }>>();
  const leafIndex = getGlobalLeafIndex(db);
  const targets: ImportedMemberCallTarget[] = [];
  let unresolvedCallsites = 0;

  for (const site of callsites) {
    if (!site.memberAccess) continue;
    const indexedCandidates = sameLanguageCandidates(sourceFile, leafIndex.get(site.calleeLeaf) ?? []);
    if (
      options.excludeIndexedTargets !== false &&
      pickAstCallCandidate(db, sourceFile, indexedCandidates, true, site.calleeQualifier)
    ) {
      continue;
    }

    const receiver = site.calleeQualifier;
    const constructedTarget = constructedMemberCallTarget(db, sourceFile, site, sourceImports);
    if (constructedTarget) {
      targets.push(constructedTarget);
      continue;
    }
    const assembledTargets = importedServiceObjectMemberTargets(
      db,
      sourceFile,
      site,
      sourceImports,
      serviceAliasesForCallsite(serviceReceivers, site.calleeQualifier, site.line),
    );
    if (assembledTargets.length > 0) {
      targets.push(...assembledTargets);
      continue;
    }
    const injectedTargets = factoryCallbackMemberTargets(db, sourceFile, site);
    if (injectedTargets.length > 0) {
      targets.push(...injectedTargets);
      continue;
    }
    const importedReceiver = receiver ? (sourceAliases.get(receiver) ?? receiver) : null;
    const receiverFiles = importedReceiver
      ? uniqueResolvedPaths(
          sourceImports
            .filter((entry) => (entry.localName ?? entry.importedName) === importedReceiver)
            .map((entry) => entry.sourcePath),
        )
      : [];
    const matchingCallables = receiverFiles.flatMap((file) => {
      let callables = callablesByFile.get(file);
      if (!callables) {
        callables = getCallableSites(db, file) ?? [];
        callablesByFile.set(file, callables);
      }
      return callables.filter((callable) => callable.name === site.calleeLeaf).map((callable) => ({ file, callable }));
    });
    if (matchingCallables.length !== 1) {
      unresolvedCallsites += 1;
      continue;
    }
    const match = matchingCallables[0]!;
    targets.push({
      calleeLeaf: site.calleeLeaf,
      line: site.line,
      sourceFile,
      targetFile: match.file,
      targetStartLine: match.callable.startLine,
      targetEndLine: match.callable.endLine,
      resolution: 'direct-import-receiver',
      strength: 'candidate',
    });
  }

  return { targets, unresolvedCallsites };
}

function importedServiceObjectMemberTargets(
  db: ScipDatabase,
  sourceFile: string,
  site: NonNullable<ReturnType<typeof getCallSites>>[number],
  sourceImports: ReadonlyArray<ParsedSourceImport & { sourcePath: string }>,
  importedServiceAliases: ReadonlySet<string>,
): ImportedMemberCallTarget[] {
  const receiver = site.calleeQualifier;
  if (!receiver || !/^[A-Za-z_$][\w$]*$/u.test(receiver)) return [];
  if (importedServiceAliases.size !== 1) return [];
  const alias = [...importedServiceAliases][0]!;
  const targetFiles = uniqueResolvedPaths(
    sourceImports
      .filter((entry) => entry.localName === alias || entry.importedName === alias)
      .map((entry) => entry.sourcePath),
  );
  if (targetFiles.length !== 1) return [];
  const targetFile = targetFiles[0]!;
  const implementations = serviceMemberImplementations(db, targetFile, site.calleeLeaf);
  return implementations.map((implementation) => ({
    calleeLeaf: implementation.name,
    line: site.line,
    sourceFile,
    targetFile: implementation.file,
    targetStartLine: implementation.startLine,
    targetEndLine: implementation.endLine,
    serviceFile: targetFile,
    resolutionAlternativeCount: implementations.length,
    resolution: 'imported-service-object-member',
    strength: 'candidate',
  }));
}

interface ServiceReceiverIndex {
  declarations: Map<string, Array<{ line: number; alias: string }>>;
  callbacks: Array<{ startLine: number; endLine: number; receivers: Set<string>; alias: string }>;
}

function emptyServiceReceiverIndex(): ServiceReceiverIndex {
  return { declarations: new Map(), callbacks: [] };
}

/** Index the two Effect service acquisition forms once per source-file query. */
function indexServiceReceivers(root: SyntaxNode): ServiceReceiverIndex {
  const index = emptyServiceReceiverIndex();
  walk(root, (node) => {
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name') ?? node.namedChild(0);
      const value = node.childForFieldName('value') ?? node.namedChild(1);
      if (name?.type !== 'identifier' || !value) return;
      const aliases = new Set<string>();
      walk(value, (candidate) => {
        if (candidate.type !== 'member_expression') return;
        const object = candidate.childForFieldName('object') ?? candidate.namedChild(0);
        const property = candidate.childForFieldName('property') ?? candidate.namedChild(1);
        if (object?.type === 'identifier' && property?.text === 'Service') aliases.add(object.text);
      });
      if (aliases.size === 1) {
        const declarations = index.declarations.get(name.text) ?? [];
        declarations.push({ line: node.startPosition.row, alias: [...aliases][0]! });
        index.declarations.set(name.text, declarations);
      }
      return;
    }

    if (!['arrow_function', 'function_expression', 'generator_function'].includes(node.type)) return;
    const parameters = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
    if (!parameters) return;
    let current: SyntaxNode | null = node.parent;
    while (current && current.type !== 'call_expression') current = current.parent;
    if (!current) return;
    const callee = current.childForFieldName('function') ?? current.namedChild(0);
    const match = /^([A-Za-z_$][\w$]*)\.Service\.use$/u.exec(callee?.text ?? '');
    if (!match) return;
    const receivers = new Set<string>();
    walk(parameters, (candidate) => {
      if (candidate.type === 'identifier') receivers.add(candidate.text);
    });
    if (receivers.size === 0) return;
    index.callbacks.push({
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      receivers,
      alias: match[1]!,
    });
  });
  return index;
}

function serviceAliasesForCallsite(
  index: ServiceReceiverIndex,
  receiver: string | undefined,
  line: number,
): Set<string> {
  if (!receiver || !/^[A-Za-z_$][\w$]*$/u.test(receiver)) return new Set();
  const aliases = new Set(
    (index.declarations.get(receiver) ?? [])
      .filter((declaration) => declaration.line <= line)
      .map((declaration) => declaration.alias),
  );
  for (const callback of index.callbacks) {
    if (callback.startLine <= line && callback.endLine >= line && callback.receivers.has(receiver)) {
      aliases.add(callback.alias);
    }
  }
  return aliases;
}

/**
 * Resolve `options.callback()` inside a factory to callable values supplied in
 * object-literal arguments at compiler-resolved callsites of that factory.
 * Every possible target is retained; callers decide whether multiplicity is
 * acceptable evidence for their query.
 */
function factoryCallbackMemberTargets(
  db: ScipDatabase,
  sourceFile: string,
  site: NonNullable<ReturnType<typeof getCallSites>>[number],
): ImportedMemberCallTarget[] {
  const receiver = site.calleeQualifier;
  if (!receiver || !/^[A-Za-z_$][\w$]*$/u.test(receiver)) return [];
  const root = getAst(db, sourceFile)?.rootNode;
  if (!root) return [];
  const callsite = callExpressionForSite(db, sourceFile, root, site.line, site.calleeLeaf, receiver);
  const factoryCallable = callsite ? enclosingCallableDeclaringParameter(callsite, receiver) : null;
  if (!factoryCallable) return [];
  if (!callableReturnsObject(factoryCallable)) return [];
  const factorySite = (getCallableSites(db, sourceFile) ?? [])
    .filter(
      (callable) =>
        callable.startLine <= factoryCallable.startPosition.row && callable.endLine >= factoryCallable.endPosition.row,
    )
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))[0];
  if (!factorySite) return [];
  const factoryDefinitions = getDefinitionsForFile(db, sourceFile).filter(
    (definition) => definition.isFunctionLike && definition.leaf === factorySite.name,
  );
  if (factoryDefinitions.length !== 1) return [];
  const factory = factoryDefinitions[0]!;
  let byFactory = FACTORY_CALLBACK_IMPLEMENTATIONS.get(db);
  if (!byFactory) {
    byFactory = new Map();
    FACTORY_CALLBACK_IMPLEMENTATIONS.set(db, byFactory);
  }
  const cacheKey = `${factory.symbol}\0${site.calleeLeaf}`;
  let unique = byFactory.get(cacheKey);
  if (!unique) {
    const targets: Array<{ name: string; file: string; startLine: number; endLine: number }> = [];
    for (const reference of getResolvedReferenceSites(db, factory)) {
      const callerRoot = getAst(db, reference.file)?.rootNode;
      if (!callerRoot) continue;
      const calls = nodesOfTypes(callerRoot, 'call_expression').filter((node) => {
        if (node.startPosition.row > reference.line || node.endPosition.row < reference.line) return false;
        const callee = node.childForFieldName('function') ?? node.namedChild(0);
        const leaf = callee?.text
          .replace(/\s+/gu, '')
          .replace(/<[^<>]*>$/u, '')
          .match(/[A-Za-z_$][\w$]*$/u)?.[0];
        return leaf === factory.leaf;
      });
      if (calls.length !== 1) continue;
      const argumentsNode = calls[0]!.childForFieldName('arguments');
      const object = argumentsNode?.namedChildren.find((argument) => unwrap(argument).type === 'object');
      if (!object) continue;
      for (const child of unwrap(object).namedChildren) {
        if (child.type === 'shorthand_property_identifier' && child.text === site.calleeLeaf) {
          targets.push(...callableTargetsFromArgumentValue(db, reference.file, site.calleeLeaf, child, child));
          continue;
        }
        if (child.type !== 'pair') continue;
        const key = child.childForFieldName('key') ?? child.namedChild(0);
        const value = child.childForFieldName('value') ?? child.namedChild(1);
        if (unquotedPropertyName(key?.text) !== site.calleeLeaf || !value) continue;
        targets.push(...callableTargetsFromArgumentValue(db, reference.file, site.calleeLeaf, value, child));
      }
    }
    unique = targets.filter(
      (target, index, all) =>
        all.findIndex(
          (other) =>
            other.file === target.file &&
            other.startLine === target.startLine &&
            other.endLine === target.endLine &&
            other.name === target.name,
        ) === index,
    );
    byFactory.set(cacheKey, unique);
  }
  return unique.map((target) => ({
    calleeLeaf: target.name,
    line: site.line,
    sourceFile,
    targetFile: target.file,
    targetStartLine: target.startLine,
    targetEndLine: target.endLine,
    resolutionAlternativeCount: unique.length,
    resolution: 'factory-callback-member',
    strength: unique.length === 1 ? 'exact' : 'candidate',
  }));
}

function callExpressionForSite(
  db: ScipDatabase,
  sourceFile: string,
  root: SyntaxNode,
  line: number,
  member: string,
  receiver: string,
): SyntaxNode | null {
  let byFile = MEMBER_CALL_EXPRESSIONS.get(db);
  if (!byFile) {
    byFile = new Map();
    MEMBER_CALL_EXPRESSIONS.set(db, byFile);
  }
  let calls = byFile.get(sourceFile);
  if (!calls) {
    calls = new Map();
    for (const node of nodesOfTypes(root, 'call_expression')) {
      const callee = node.childForFieldName('function') ?? node.namedChild(0);
      const match = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(callee?.text.replace(/\s+/gu, '') ?? '');
      if (!match) continue;
      for (let callLine = node.startPosition.row; callLine <= node.endPosition.row; callLine += 1) {
        const key = `${callLine}\0${match[1]}\0${match[2]}`;
        const existing = calls!.get(key);
        if (!existing || node.endIndex - node.startIndex < existing.endIndex - existing.startIndex)
          calls!.set(key, node);
      }
    }
    byFile.set(sourceFile, calls);
  }
  return calls.get(`${line}\0${receiver}\0${member}`) ?? null;
}

function callableReturnsObject(callable: SyntaxNode): boolean {
  return callable.descendantsOfType('return_statement').some((node) => {
    const argument = node.childForFieldName('argument') ?? node.namedChild(0);
    return Boolean(argument && unwrap(argument).type === 'object');
  });
}

function enclosingCallableDeclaringParameter(node: SyntaxNode, parameter: string): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (/(?:function|method|lambda)/u.test(current.type) || current.type === 'arrow_function') {
      const parameters = current.childForFieldName('parameters') ?? current.childForFieldName('parameter');
      let found = false;
      if (parameters) {
        walk(parameters, (candidate) => {
          if (candidate.type === 'identifier' && candidate.text === parameter) found = true;
        });
      }
      if (found) return current;
    }
    current = current.parent;
  }
  return null;
}

function callableTargetsFromArgumentValue(
  db: ScipDatabase,
  file: string,
  member: string,
  value: SyntaxNode,
  owner: SyntaxNode,
): Array<{ name: string; file: string; startLine: number; endLine: number }> {
  if (value.type === 'identifier') {
    return (getCallableSites(db, file) ?? [])
      .filter((callable) => callable.name === value.text)
      .map((callable) => ({ ...callable, file }));
  }
  const delegated = factoryReturnedMemberImplementations(db, file, value.text);
  if (delegated.length > 0) return delegated;
  if (!syntaxContainsCallableValue(value)) return [];
  const covering = (getCallableSites(db, file) ?? [])
    .filter(
      (callable) =>
        callable.startLine >= owner.startPosition.row &&
        callable.endLine <= owner.endPosition.row &&
        (callable.name === member || callable.name.startsWith('source@')),
    )
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine));
  const callable = covering[0];
  return [
    callable
      ? { ...callable, file }
      : { name: member, file, startLine: owner.startPosition.row, endLine: owner.endPosition.row },
  ];
}

function serviceMemberImplementations(
  db: ScipDatabase,
  serviceFile: string,
  member: string,
): Array<{ name: string; startLine: number; endLine: number; file: string }> {
  let byMember = SERVICE_MEMBER_IMPLEMENTATIONS.get(db);
  if (!byMember) {
    byMember = new Map();
    SERVICE_MEMBER_IMPLEMENTATIONS.set(db, byMember);
  }
  const key = `${serviceFile}\u0000${member}`;
  const cached = byMember.get(key);
  if (cached) return cached;
  const implementations = serviceImplementationFiles(db, serviceFile).flatMap((file) =>
    serviceObjectMemberImplementations(db, file, serviceFile, member),
  );
  byMember.set(key, implementations);
  return implementations;
}

function serviceObjectMemberImplementations(
  db: ScipDatabase,
  implementationFile: string,
  serviceFile: string,
  member: string,
): Array<{ name: string; startLine: number; endLine: number; file: string }> {
  const root = getAst(db, implementationFile)?.rootNode;
  const callables = getCallableSites(db, implementationFile) ?? [];
  if (!root) return [];
  const serviceAliases = serviceAliasesForImplementation(db, implementationFile, serviceFile);
  if (serviceAliases.size === 0) return [];
  const implementationNames = new Set<string>();
  const inlineImplementations: Array<{ name: string; startLine: number; endLine: number }> = [];
  const providerContainers: Array<{ name: string; startLine: number; endLine: number }> = [];
  const factoryMemberImplementations: Array<{ name: string; startLine: number; endLine: number; file: string }> = [];
  walk(root, (node) => {
    if (!insideServiceFactoryObject(node, serviceAliases)) return;
    if (node.type === 'pair') {
      const key = node.childForFieldName('key') ?? node.namedChild(0);
      const value = node.childForFieldName('value') ?? node.namedChild(1);
      if (unquotedPropertyName(key?.text) !== member || !value) return;
      if (value.type === 'identifier') implementationNames.add(value.text);
      else if (syntaxContainsCallableValue(value)) {
        inlineImplementations.push({
          name: member,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
        });
      } else {
        const callbackImplementations = factoryReturnedMemberCallbackImplementations(
          db,
          implementationFile,
          value.text,
        );
        const resolved = factoryReturnedMemberImplementations(db, implementationFile, value.text);
        if (callbackImplementations.length > 0) factoryMemberImplementations.push(...callbackImplementations);
        else if (resolved.length > 0) factoryMemberImplementations.push(...resolved);
        else {
          const provider = enclosingServiceProviderBinding(node);
          if (provider) providerContainers.push(provider);
        }
      }
      return;
    }
    if (node.type === 'shorthand_property_identifier' && node.text === member) implementationNames.add(member);
  });
  const namedImplementations = callables.filter((callable) => implementationNames.has(callable.name));
  return [
    ...namedImplementations.map((implementation) => ({ ...implementation, file: implementationFile })),
    ...inlineImplementations.map((implementation) => ({ ...implementation, file: implementationFile })),
    ...providerContainers.map((implementation) => ({ ...implementation, file: implementationFile })),
    ...factoryMemberImplementations,
  ].filter(
    (implementation, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.file === implementation.file &&
          candidate.name === implementation.name &&
          candidate.startLine === implementation.startLine &&
          candidate.endLine === implementation.endLine,
      ) === index,
  );
}

function insideServiceFactoryObject(node: SyntaxNode, serviceAliases: ReadonlySet<string>): boolean {
  let current: SyntaxNode | null = node;
  let object: SyntaxNode | null = null;
  while (current) {
    if (current.type === 'object') object = current;
    if (current.type === 'call_expression') {
      if (!object) return false;
      const callee = current.childForFieldName('function') ?? current.namedChild(0);
      return callee ? serviceAliases.has(callee.text.replace(/\.of$/u, '')) && callee.text.endsWith('.of') : false;
    }
    current = current.parent;
  }
  return false;
}

function serviceImplementationFiles(db: ScipDatabase, serviceFile: string): string[] {
  let byService = SERVICE_IMPLEMENTATION_FILES.get(db);
  if (!byService) {
    byService = new Map();
    SERVICE_IMPLEMENTATION_FILES.set(db, byService);
  }
  const cached = byService.get(serviceFile);
  if (cached) return cached;
  const files = new Set<string>([serviceFile]);
  const serviceDefinitions = getDefinitionsForFile(db, serviceFile).filter(
    (definition) => definition.leaf === 'Service' && definition.isTypeLike,
  );
  for (const definition of serviceDefinitions) {
    for (const site of getResolvedReferenceSites(db, definition)) files.add(site.file);
  }
  const result = [...files].sort();
  byService.set(serviceFile, result);
  return result;
}

function serviceAliasesForImplementation(
  db: ScipDatabase,
  implementationFile: string,
  serviceFile: string,
): Set<string> {
  const aliases = new Set<string>();
  if (pathsResolveSame(implementationFile, serviceFile)) aliases.add('Service');
  for (const imported of getSourceImports(db, implementationFile)) {
    if (!imported.sourcePath || !pathsResolveSame(imported.sourcePath, serviceFile)) continue;
    if (imported.kind === 'namespace' && imported.localName) {
      aliases.add(`${imported.localName}.Service`);
      continue;
    }
    const importedName = imported.importedName === 'default' ? imported.localName : imported.importedName;
    if (importedName === 'Service') aliases.add(imported.localName ?? imported.importedName);
    else if (imported.localName && imported.importedName !== 'default') aliases.add(`${imported.localName}.Service`);
  }
  return aliases;
}

/**
 * Resolve `factoryResult.member` when one local binding is initialized from a
 * uniquely resolved factory and that factory returns one callable member with
 * the requested name. The derivation is bounded to direct local bindings,
 * direct imports, and source-visible return objects.
 */
function factoryReturnedMemberImplementations(
  db: ScipDatabase,
  sourceFile: string,
  expression: string,
): Array<{ name: string; startLine: number; endLine: number; file: string }> {
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(expression.replace(/\s+/gu, ''));
  if (!member) return [];
  const root = getAst(db, sourceFile)?.rootNode;
  if (!root) return [];
  const initializer = findVariableInitializer(root, member[1]!);
  const call = initializer ? firstValueCall(initializer) : null;
  if (!call) return [];
  const callee = call.childForFieldName('function') ?? call.namedChild(0);
  const targets = callee ? resolveCallableTargetDefinitions(db, sourceFile, callee.text) : [];
  if (targets.length !== 1) return [];
  const target = targets[0]!;
  const targetRoot = getAst(db, target.relativePath)?.rootNode;
  if (!targetRoot) return [];
  const callable = smallestCoveringCallable(targetRoot, target.startLine, target.endLine);
  if (!callable) return [];
  const candidates: Array<{ name: string; startLine: number; endLine: number; file: string }> = [];
  for (const node of callable.descendantsOfType('return_statement')) {
    const argument = node.childForFieldName('argument') ?? node.namedChild(0);
    if (!argument) continue;
    const returned = unwrap(argument);
    if (returned.type !== 'object') continue;
    for (const child of returned.namedChildren) {
      if (child.type === 'shorthand_property_identifier' && child.text === member[2]) {
        for (const site of getCallableSites(db, target.relativePath) ?? []) {
          if (site.name === member[2]) candidates.push({ ...site, file: target.relativePath });
        }
        continue;
      }
      if (child.type !== 'pair') continue;
      const key = child.childForFieldName('key') ?? child.namedChild(0);
      const value = child.childForFieldName('value') ?? child.namedChild(1);
      if (unquotedPropertyName(key?.text) !== member[2] || !value) continue;
      if (value.type === 'identifier') {
        for (const site of getCallableSites(db, target.relativePath) ?? []) {
          if (site.name === value.text) candidates.push({ ...site, file: target.relativePath });
        }
      } else if (syntaxContainsCallableValue(value)) {
        candidates.push({
          name: member[2]!,
          startLine: child.startPosition.row,
          endLine: child.endPosition.row,
          file: target.relativePath,
        });
      }
    }
  }
  return candidates.filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          other.file === candidate.file &&
          other.name === candidate.name &&
          other.startLine === candidate.startLine &&
          other.endLine === candidate.endLine,
      ) === index,
  );
}

/**
 * Resolve a service member delegated through a factory result to the exact
 * callback(s) that member reaches inside the factory. The derivation follows
 * direct local calls in the returned factory object, then binds only the
 * reached option members to the direct object-literal factory callsite.
 */
function factoryReturnedMemberCallbackImplementations(
  db: ScipDatabase,
  sourceFile: string,
  expression: string,
): Array<{ name: string; startLine: number; endLine: number; file: string }> {
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(expression.replace(/\s+/gu, ''));
  if (!member) return [];
  const sourceRoot = getAst(db, sourceFile)?.rootNode;
  if (!sourceRoot) return [];
  const initializer = findVariableInitializer(sourceRoot, member[1]!);
  const factoryCall = initializer ? firstValueCall(initializer) : null;
  const callee = factoryCall?.childForFieldName('function') ?? factoryCall?.namedChild(0);
  const factories = callee ? resolveCallableTargetDefinitions(db, sourceFile, callee.text) : [];
  if (factories.length !== 1 || !factoryCall) return [];
  const factory = factories[0]!;
  const factoryRoot = getAst(db, factory.relativePath)?.rootNode;
  if (!factoryRoot) return [];
  const factoryCallable = smallestCoveringCallable(factoryRoot, factory.startLine, factory.endLine);
  if (!factoryCallable) return [];
  const parameterNames = new Set<string>();
  const parameters = factoryCallable.childForFieldName('parameters') ?? factoryCallable.childForFieldName('parameter');
  if (parameters) {
    walk(parameters, (candidate) => {
      if (candidate.type === 'identifier') parameterNames.add(candidate.text);
    });
  }
  if (parameterNames.size === 0) return [];

  const returnedMembers = factoryReturnedMemberImplementations(db, sourceFile, expression);
  if (returnedMembers.length === 0) return [];
  const factoryCallables = (getCallableSites(db, factory.relativePath) ?? []).filter(
    (callable) => callable.startLine >= factory.startLine && callable.endLine <= factory.endLine,
  );
  const factoryCallsites = (getCallSites(db, factory.relativePath) ?? []).filter(
    (site) => site.line >= factory.startLine && site.line <= factory.endLine,
  );
  const reachedOptionMembers = new Set<string>();
  const queue = returnedMembers.map((implementation) => ({
    name: implementation.name,
    startLine: implementation.startLine,
    endLine: implementation.endLine,
  }));
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < 32) {
    const current = queue.shift()!;
    const key = `${current.name}\0${current.startLine}\0${current.endLine}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const site of factoryCallsites.filter(
      (candidate) => candidate.line >= current.startLine && candidate.line <= current.endLine,
    )) {
      if (site.memberAccess && site.calleeQualifier && parameterNames.has(site.calleeQualifier)) {
        reachedOptionMembers.add(site.calleeLeaf);
        continue;
      }
      if (site.memberAccess) continue;
      const localTargets = factoryCallables.filter((callable) => callable.name === site.calleeLeaf);
      if (localTargets.length === 1) queue.push(localTargets[0]!);
    }
  }
  if (reachedOptionMembers.size === 0) return [];

  const argumentsNode = factoryCall.childForFieldName('arguments');
  const object = argumentsNode?.namedChildren.find((argument) => unwrap(argument).type === 'object');
  if (!object) return [];
  const targets: Array<{ name: string; startLine: number; endLine: number; file: string }> = [];
  for (const child of unwrap(object).namedChildren) {
    if (child.type === 'shorthand_property_identifier' && reachedOptionMembers.has(child.text)) {
      targets.push(...callableTargetsFromArgumentValue(db, sourceFile, child.text, child, child));
      continue;
    }
    if (child.type !== 'pair') continue;
    const property = child.childForFieldName('key') ?? child.namedChild(0);
    const value = child.childForFieldName('value') ?? child.namedChild(1);
    const callbackName = unquotedPropertyName(property?.text);
    if (!callbackName || !reachedOptionMembers.has(callbackName) || !value) continue;
    targets.push(...callableTargetsFromArgumentValue(db, sourceFile, callbackName, value, child));
  }
  return targets.filter(
    (target, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.file === target.file &&
          candidate.name === target.name &&
          candidate.startLine === target.startLine &&
          candidate.endLine === target.endLine,
      ) === index,
  );
}

function findVariableInitializer(root: SyntaxNode, name: string): SyntaxNode | null {
  for (const node of nodesOfTypes(root, 'variable_declarator')) {
    const declared = node.childForFieldName('name') ?? node.namedChild(0);
    if (declared?.text === name) return node.childForFieldName('value') ?? node.namedChild(1);
  }
  return null;
}

function firstValueCall(node: SyntaxNode): SyntaxNode | null {
  return node.type === 'call_expression' ? node : (node.descendantsOfType('call_expression')[0] ?? null);
}

function resolveCallableTargetDefinitions(
  db: ScipDatabase,
  sourceFile: string,
  expression: string,
): Array<{ relativePath: string; startLine: number; endLine: number }> {
  const compact = expression.replace(/\s+/gu, '').replace(/<[^<>]*>$/u, '');
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(compact);
  if (member) {
    const imported = getSourceImports(db, sourceFile).filter(
      (entry) => entry.localName === member[1] && entry.sourcePath,
    );
    if (imported.length !== 1 || !imported[0]!.sourcePath) return [];
    const targetFile = imported[0]!.sourcePath;
    const indexed = resolveImportedDefinitions(db, targetFile, member[2]!).filter(
      (definition) => definition.isFunctionLike,
    );
    if (indexed.length > 0) return indexed;
    return (getCallableSites(db, targetFile) ?? [])
      .filter((callable) => callable.name === member[2])
      .map((callable) => ({ ...callable, relativePath: targetFile }));
  }
  if (!/^[A-Za-z_$][\w$]*$/u.test(compact)) return [];
  const local = getDefinitionsForFile(db, sourceFile).filter(
    (definition) => definition.leaf === compact && definition.isFunctionLike,
  );
  if (local.length > 0) return local;
  const localSource = (getCallableSites(db, sourceFile) ?? [])
    .filter((callable) => callable.name === compact)
    .map((callable) => ({ ...callable, relativePath: sourceFile }));
  if (localSource.length > 0) return localSource;
  const imported = getSourceImports(db, sourceFile).filter(
    (entry) => entry.localName === compact && entry.sourcePath && entry.kind !== 'namespace',
  );
  if (imported.length !== 1 || !imported[0]!.sourcePath) return [];
  const targetFile = imported[0]!.sourcePath;
  const importedName = imported[0]!.importedName === 'default' ? compact : imported[0]!.importedName;
  const indexed = resolveImportedDefinitions(db, targetFile, importedName).filter(
    (definition) => definition.isFunctionLike,
  );
  if (indexed.length > 0) return indexed;
  return (getCallableSites(db, targetFile) ?? [])
    .filter((callable) => callable.name === importedName)
    .map((callable) => ({ ...callable, relativePath: targetFile }));
}

function syntaxContainsCallableValue(node: SyntaxNode): boolean {
  return (
    ['arrow_function', 'function_expression', 'generator_function'].includes(node.type) ||
    node.descendantsOfType(['arrow_function', 'function_expression', 'generator_function']).length > 0
  );
}

function enclosingServiceProviderBinding(
  node: SyntaxNode,
): { name: string; startLine: number; endLine: number } | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'variable_declarator') {
      const name = current.childForFieldName('name') ?? current.namedChild(0);
      if (name?.type === 'identifier') {
        return { name: name.text, startLine: current.startPosition.row, endLine: current.endPosition.row };
      }
    }
    current = current.parent;
  }
  return null;
}

function unquotedPropertyName(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/^(?:['"])(.*)(?:['"])$/u, '$1');
}

function constructedMemberCallTarget(
  db: ScipDatabase,
  sourceFile: string,
  site: NonNullable<ReturnType<typeof getCallSites>>[number],
  sourceImports: ReadonlyArray<ParsedSourceImport & { sourcePath: string }>,
): ImportedMemberCallTarget | null {
  const member = /^this\.([A-Za-z_$][\w$]*)$/u.exec(site.calleeQualifier ?? '');
  if (!member) return null;
  const root = getAst(db, sourceFile)?.rootNode;
  if (!root) return null;
  const classScope = smallestEnclosingClass(root, site.line);
  if (!classScope) return null;

  const constructorNames = new Set<string>();
  walk(classScope, (node) => {
    if (node.type !== 'assignment_expression') return;
    const left = node.childForFieldName('left') ?? node.namedChild(0);
    const right = node.childForFieldName('right') ?? node.namedChild(node.namedChildCount - 1);
    if (left?.text.replace(/\s+/gu, '') !== `this.${member[1]}` || !right) return;
    const constructed = unwrap(right);
    if (constructed.type !== 'new_expression') return;
    const constructor = constructed.childForFieldName('constructor') ?? constructed.namedChild(0);
    const name = constructor?.text.match(/[A-Za-z_$][\w$]*$/u)?.[0];
    if (name) constructorNames.add(name);
  });
  if (constructorNames.size !== 1) return null;
  const constructorName = [...constructorNames][0]!;
  const imported = sourceImports.filter((entry) => entry.localName === constructorName);
  if (imported.length !== 1) return null;
  const importedName = imported[0]!.importedName === 'default' ? constructorName : imported[0]!.importedName;
  const resolvedOwnerTypes =
    imported[0]!.importedName === 'default'
      ? resolveImportedDefinitions(db, imported[0]!.sourcePath, constructorName)
      : [];
  const ownerTypeName = resolvedOwnerTypes.length === 1 ? resolvedOwnerTypes[0]!.leaf : importedName;
  const methods = getDefinitionsForFile(db, imported[0]!.sourcePath).filter(
    (definition) =>
      definition.isFunctionLike &&
      definition.leaf === site.calleeLeaf &&
      parentTypeName(definition.symbol) === ownerTypeName,
  );
  if (methods.length !== 1) return null;
  const method = methods[0]!;
  return {
    calleeLeaf: site.calleeLeaf,
    line: site.line,
    sourceFile,
    targetFile: method.relativePath,
    targetStartLine: method.startLine,
    targetEndLine: method.endLine,
    targetSymbol: method.symbol,
    resolution: 'constructed-member-receiver',
    strength: 'exact',
  };
}

function smallestEnclosingClass(root: SyntaxNode, line: number): SyntaxNode | null {
  const candidates: SyntaxNode[] = [];
  walk(root, (node) => {
    if (
      ['class', 'class_declaration', 'class_definition'].includes(node.type) &&
      node.startPosition.row <= line &&
      node.endPosition.row >= line
    ) {
      candidates.push(node);
    }
  });
  return (
    candidates.sort(
      (left, right) =>
        left.endPosition.row - left.startPosition.row - (right.endPosition.row - right.startPosition.row),
    )[0] ?? null
  );
}

function unwrap(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (
    ['parenthesized_expression', 'as_expression', 'type_assertion', 'satisfies_expression'].includes(current.type) &&
    current.namedChildCount === 1
  ) {
    current = current.namedChild(0)!;
  }
  return current;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function simpleIdentifierAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gu;
  for (const match of source.matchAll(pattern)) {
    const local = match[1];
    const target = match[2];
    if (local && target) aliases.set(local, target);
  }
  return aliases;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  for (const path of paths) {
    if (!unique.some((candidate) => pathsResolveSame(candidate, path))) unique.push(path);
  }
  return unique;
}
