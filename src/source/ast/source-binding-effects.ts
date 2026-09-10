import { ts } from '@ts-morph/common';
import {
  accessBinding,
  bindingAccess,
  unwrapBindingExpression,
  memberLiteralKey,
  memberPathsOverlap,
  isParameterDeclaration,
  type MemberPath,
  type BindingAccess,
} from './source-binding-access.js';

/** One file's conservative write model. Aliases identify possible shared values, not execution order. */
export function sourceBindingEffects(sourceFile: ts.SourceFile, checker: ts.TypeChecker) {
  const written = new Set<ts.Declaration>();
  const aliases = new Map<ts.Declaration, AliasSource[]>();
  const propertyWrites = new Map<ts.Declaration, PropertyEffect[]>();
  const memberWrites: ts.Node[] = [];
  const calls: Array<ts.CallExpression | ts.NewExpression> = [];
  const visit = (node: ts.Node): void => {
    for (const target of assignedIdentifiers(node)) {
      const binding = accessBinding(target, checker);
      if (binding) written.add(binding);
    }
    collectAliasSources(node, checker, aliases);
    memberWrites.push(...assignedProperties(node));
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const call of calls) collectDirectEvalBindings(call, checker, written);
  const record = (target: ts.Node, path: MemberPath, source: ts.Node, unknown: boolean): void => {
    for (const access of possibleBindingAccesses(target, checker, aliases, new Set(), path)) {
      const recorded = propertyWrites.get(access.binding) ?? [];
      recorded.push({ path: access.path, source, unknown });
      propertyWrites.set(access.binding, recorded);
    }
  };
  for (const call of calls) collectCallBindings(call, checker, aliases);
  const escaped = exportedAliasAccesses(sourceFile, checker, aliases);
  for (const target of memberWrites) record(target, [], target, false);
  for (const call of calls)
    for (const effect of callEffects(call, checker)) {
      if (!effect.unknown) {
        record(effect.target, effect.path, call, false);
        continue;
      }
      for (const access of exposedBindingAccesses(
        effect.target,
        checker,
        aliases,
        new Set(),
        effect.path.slice(0, -1),
      )) {
        const recorded = propertyWrites.get(access.binding) ?? [];
        recorded.push({ path: access.path, source: call, unknown: true });
        propertyWrites.set(access.binding, recorded);
      }
    }
  return {
    written,
    hasEscapedValue(expression: ts.Node, memberPath: readonly string[]): boolean {
      return possibleBindingAccesses(expression, checker, aliases, new Set(), memberPath).some((origin) =>
        escaped.some(
          (exposure) =>
            exposure.binding === origin.binding &&
            exposure.path.length <= origin.path.length &&
            memberPathsOverlap(exposure.path, origin.path),
        ),
      );
    },
    usesParameter(node: ts.Node): boolean {
      return possibleBindingAccesses(node, checker, aliases).some(({ binding }) => isParameterDeclaration(binding));
    },
    hasWrite(
      expression: ts.Node,
      includeProperties: boolean,
      memberPath: readonly string[],
      contents: boolean,
      observedAt: ts.Node | null = expression,
    ): boolean | undefined {
      const access = bindingAccess(expression, checker, written);
      if (!access) return undefined;
      return (
        access.reassigned ||
        (includeProperties &&
          possibleBindingAccesses(expression, checker, aliases, new Set(), memberPath).some((origin) =>
            (propertyWrites.get(origin.binding) ?? []).some(
              (effect) =>
                (!observedAt ||
                  !(effect.source.getStart() <= observedAt.getStart() && effect.source.end >= observedAt.end)) &&
                (contents || effect.path.length <= origin.path.length) &&
                memberPathsOverlap(effect.path, origin.path),
            ),
          ))
      );
    },
  };
}

/** A second exported route to an object defeats a proof based only on direct imports of its binding. */
function exportedAliasAccesses(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  aliases: ReadonlyMap<ts.Declaration, AliasSource[]>,
): Array<Pick<BindingAccess, 'binding' | 'path'>> {
  const module = checker.getSymbolAtLocation(sourceFile);
  if (!module) return [];
  return checker.getExportsOfModule(module).flatMap((exported) => {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.valueDeclaration;
    if (!declaration || declaration.getSourceFile() !== sourceFile) return [];
    const value = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    if (!value) return [];
    return exposedBindingAccesses(value, checker, aliases, new Set()).filter(
      (access) => access.binding !== declaration,
    );
  });
}

/** Direct eval shares the caller's lexical environment; string contents cannot prove unchanged bindings. */
function collectDirectEvalBindings(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  written: Set<ts.Declaration>,
): void {
  if (!ts.isCallExpression(call) || call.questionDotToken) return;
  const callee = unwrapBindingExpression(call.expression);
  if (!ts.isIdentifier(callee) || callee.text !== 'eval' || accessBinding(callee, checker)) return;
  for (const symbol of checker.getSymbolsInScope(call, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration) written.add(declaration);
  }
}

function assignmentTarget(node: ts.Node): ts.Node | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return node.left;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return node.operand;
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return node.initializer;
  return undefined;
}

function assignedIdentifiers(node: ts.Node): ts.Identifier[] {
  const target = assignmentTarget(node);
  return target ? assignmentPatternIdentifiers(target) : [];
}

/** Assignment patterns share their traversal; variable writes and member writes retain distinct leaves. */
function assignmentPatternChildren(node: ts.Node): readonly ts.Node[] {
  const unwrapped = unwrapBindingExpression(node);
  if (unwrapped !== node) return [unwrapped];
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return [node.expression];
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  if (ts.isObjectLiteralExpression(node)) return node.properties;
  if (ts.isPropertyAssignment(node)) return [node.initializer];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return [node.left];
  return [];
}

function assignmentPatternIdentifiers(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) return [node];
  if (ts.isShorthandPropertyAssignment(node)) return [node.name];
  return assignmentPatternChildren(node).flatMap(assignmentPatternIdentifiers);
}

function assignedProperties(node: ts.Node): ts.Node[] {
  const target = ts.isDeleteExpression(node) ? node.expression : assignmentTarget(node);
  return target ? propertyAssignmentTargets(target) : [];
}

function propertyAssignmentTargets(node: ts.Node): ts.Node[] {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return [node];
  return assignmentPatternChildren(node).flatMap(propertyAssignmentTargets);
}

interface AliasSource {
  expression: ts.Node;
  path: MemberPath;
  targetPath?: MemberPath;
  shallowCopy?: boolean;
  arrayRestOffset?: number;
}

interface PropertyEffect {
  path: MemberPath;
  source: ts.Node;
  unknown: boolean;
}

/** Bind actual arguments to the same parameter identities used by all property effects. */
function collectCallBindings(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  aliases: Map<ts.Declaration, AliasSource[]>,
): void {
  const callable = localCallable(node.expression, checker);
  if (!callable) return;
  const target = unwrapBindingExpression(node.expression);
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
    appendAliasSource(callable, { expression: target.expression, path: [] }, aliases);
  for (const [index, parameter] of callable.parameters.entries()) {
    const argument = node.arguments?.[index];
    if (argument && !ts.isSpreadElement(argument) && !parameter.dotDotDotToken)
      recordAliasPattern(parameter.name, { expression: argument, path: [] }, checker, aliases);
  }
}

function localCallable(node: ts.Node, checker: ts.TypeChecker): ts.FunctionLikeDeclaration | undefined {
  node = unwrapBindingExpression(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  const member = ts.isElementAccessExpression(node) ? memberLiteralKey(node.argumentExpression) : null;
  const symbol =
    member !== null && ts.isElementAccessExpression(node)
      ? checker.getTypeAtLocation(node.expression).getProperty(member)
      : checker.getSymbolAtLocation(node);
  const binding = ts.isIdentifier(node) ? accessBinding(node, checker) : symbol?.valueDeclaration;
  const value =
    binding && (ts.isVariableDeclaration(binding) || ts.isPropertyAssignment(binding)) ? binding.initializer : binding;
  return value && ts.isFunctionLike(value) && 'body' in value && value.body
    ? (value as ts.FunctionLikeDeclaration)
    : undefined;
}

function returnedValues(callable: ts.FunctionLikeDeclaration): ts.Node[] {
  const body = callable.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const values: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return values;
}

/** Effects describe changed locations; unsupported callees expose reachable object properties. */
function callEffects(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): Array<{ target: ts.Node; path: MemberPath; unknown: boolean }> {
  const callee = unwrapBindingExpression(call.expression);
  const args = call.arguments ?? [];
  const builtin = builtinCallEffects(call, checker);
  if (builtin) return builtin;
  if (localCallable(callee, checker)) return [];
  const exposed = [...args];
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) exposed.push(callee.expression);
  return exposed.map((target) => ({
    target: ts.isSpreadElement(target) ? target.expression : target,
    // An ES module namespace has immutable export slots, but exported objects may be mutated.
    path:
      ts.isIdentifier(target) && ts.isNamespaceImport(accessBinding(target, checker) ?? target) ? [null, null] : [null],
    unknown: true,
  }));
}

/** All observed lexical sources invalidate old values; they never prove which assignment executed last. */
function collectAliasSources(
  node: ts.Node,
  checker: ts.TypeChecker,
  aliases: Map<ts.Declaration, AliasSource[]>,
): void {
  if (ts.isVariableDeclaration(node) && node.initializer)
    recordAliasPattern(node.name, { expression: node.initializer, path: [] }, checker, aliases);
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(node.operatorToken.kind)
  )
    recordAliasPattern(node.left, { expression: node.right, path: [] }, checker, aliases);
  if (ts.isForOfStatement(node)) {
    const target = ts.isVariableDeclarationList(node.initializer)
      ? node.initializer.declarations[0]?.name
      : node.initializer;
    if (target) recordAliasPattern(target, { expression: node.expression, path: [null] }, checker, aliases);
  }
}

function recordAliasPattern(
  target: ts.Node,
  source: AliasSource,
  checker: ts.TypeChecker,
  aliases: Map<ts.Declaration, AliasSource[]>,
): void {
  target = unwrapBindingExpression(target);
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    const access = bindingAccess(target, checker);
    if (access) appendAliasSource(access.binding, { ...source, targetPath: access.path }, aliases);
    return;
  }
  if (ts.isIdentifier(target)) {
    appendAliasSource(accessBinding(target, checker), source, aliases);
    return;
  }
  for (const entry of aliasPatternEntries(target)) {
    recordAliasPattern(
      entry.target,
      {
        ...source,
        path: [...source.path, ...entry.path],
        shallowCopy: source.shallowCopy || entry.shallowCopy,
        arrayRestOffset: entry.arrayRestOffset ?? source.arrayRestOffset,
      },
      checker,
      aliases,
    );
    if (entry.fallback) recordAliasPattern(entry.target, { expression: entry.fallback, path: [] }, checker, aliases);
  }
}

function appendAliasSource(
  binding: ts.Declaration | undefined,
  source: AliasSource,
  aliases: Map<ts.Declaration, AliasSource[]>,
): void {
  if (!binding) return;
  const sources = aliases.get(binding) ?? [];
  sources.push(source);
  aliases.set(binding, sources);
}

interface AliasPatternEntry {
  target: ts.Node;
  path: MemberPath;
  fallback?: ts.Node;
  shallowCopy?: boolean;
  arrayRestOffset?: number;
}

function aliasPatternEntries(target: ts.Node): AliasPatternEntry[] {
  if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) {
    return target.elements.flatMap<AliasPatternEntry>((element, index) => {
      if (!ts.isBindingElement(element)) return [];
      if (element.dotDotDotToken)
        return [
          {
            target: element.name,
            path: [],
            shallowCopy: true,
            ...(ts.isArrayBindingPattern(target) ? { arrayRestOffset: index } : {}),
          },
        ];
      const key = ts.isArrayBindingPattern(target)
        ? String(index)
        : aliasPropertyKey(element.propertyName ?? element.name);
      return [{ target: element.name, path: [key], fallback: element.initializer }];
    });
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) return [{ target: property.expression, path: [], shallowCopy: true }];
      if (ts.isPropertyAssignment(property))
        return [{ target: property.initializer, path: [aliasPropertyKey(property.name)] }];
      if (ts.isShorthandPropertyAssignment(property))
        return [{ target: property.name, path: [property.name.text], fallback: property.objectAssignmentInitializer }];
      return [];
    });
  }
  if (ts.isArrayLiteralExpression(target))
    return target.elements.map((element, index) => ({ target: element, path: [String(index)] }));
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return [{ target: target.left, path: [], fallback: target.right }];
  return [];
}

function aliasPropertyKey(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return memberLiteralKey(ts.isComputedPropertyName(node) ? node.expression : node);
}

/** Keep every possible lexical origin for write rejection, including snapshots of reassigned aliases. */
function possibleBindingAccesses(
  node: ts.Node,
  checker: ts.TypeChecker,
  aliases: ReadonlyMap<ts.Declaration, AliasSource[]>,
  seen: ReadonlySet<ts.Declaration> = new Set(),
  path: MemberPath = [],
): Array<Pick<BindingAccess, 'binding' | 'path'>> {
  node = unwrapBindingExpression(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : memberLiteralKey(node.argumentExpression);
    return possibleBindingAccesses(node.expression, checker, aliases, seen, [key, ...path]);
  }
  const alternatives = aliasExpressionChoices(node);
  if (alternatives)
    return alternatives.flatMap((value) => possibleBindingAccesses(value, checker, aliases, seen, path));
  if (ts.isCallExpression(node)) return possibleCallBindingAccesses(node, checker, aliases, seen, path);
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))
    return containerMemberSources(node, path).flatMap((source) =>
      possibleBindingAccesses(source.expression, checker, aliases, seen, source.path),
    );
  const binding = accessBinding(node, checker);
  if (!binding || seen.has(binding)) return [];
  const next = new Set(seen).add(binding);
  return [
    { binding, path },
    ...(aliases.get(binding) ?? []).flatMap((source) => {
      const selected = aliasSourcePath(source, path);
      return selected ? possibleBindingAccesses(source.expression, checker, aliases, next, selected) : [];
    }),
  ];
}

function aliasSourcePath(source: AliasSource, path: MemberPath): MemberPath | null {
  const target = source.targetPath ?? [];
  // A slot assignment replaces the slot, not the object previously stored there.
  if (source.targetPath && path.length <= target.length) return null;
  if (target.length > path.length || !memberPathsOverlap(target, path)) return null;
  const suffix = path.slice(target.length);
  if (source.shallowCopy && suffix.length < 2) return null;
  if (source.arrayRestOffset !== undefined) {
    const [index, ...remaining] = suffix;
    return [...source.path, index === null ? null : String(Number(index) + source.arrayRestOffset), ...remaining];
  }
  return [...source.path, ...suffix];
}

/** Literal containers copy their slots; only writes below a slot reach its referenced value. */
function containerMemberSources(
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  path: MemberPath,
): AliasSource[] {
  if (path.length < 2) return [];
  return ts.isObjectLiteralExpression(node) ? objectMemberSources(node, path) : arrayMemberSources(node, path);
}

function objectMemberSources(node: ts.ObjectLiteralExpression, path: MemberPath): AliasSource[] {
  const result: AliasSource[] = [];
  for (const property of [...node.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) {
      result.push({ expression: property.expression, path });
      continue;
    }
    const key = aliasPropertyKey(property.name);
    if (path[0] !== null && key !== null && key !== path[0]) continue;
    result.push(...objectPropertyValues(property).map((expression) => ({ expression, path: path.slice(1) })));
    if (path[0] !== null && key === path[0]) break;
  }
  return result;
}

function objectPropertyValues(property: ts.ObjectLiteralElementLike): ts.Node[] {
  if (ts.isPropertyAssignment(property)) return [property.initializer];
  if (ts.isShorthandPropertyAssignment(property)) return [property.name];
  if (ts.isGetAccessorDeclaration(property)) return returnedValues(property);
  return ts.isMethodDeclaration(property) ? [property] : [];
}

function arrayMemberSources(node: ts.ArrayLiteralExpression, path: MemberPath): AliasSource[] {
  const uncertain = path[0] === null || node.elements.some(ts.isSpreadElement);
  return node.elements.flatMap((element, index) => {
    if (!uncertain && String(index) !== path[0]) return [];
    return ts.isSpreadElement(element)
      ? [{ expression: element.expression, path: [null, ...path.slice(1)] }]
      : [{ expression: element, path: path.slice(1) }];
  });
}

/** Traverse the finite source value graph, rather than guessing a maximum number of nested containers. */
function exposedBindingAccesses(
  input: ts.Node,
  checker: ts.TypeChecker,
  aliases: ReadonlyMap<ts.Declaration, AliasSource[]>,
  seen: ReadonlySet<ts.Node>,
  path: MemberPath = [],
): Array<Pick<BindingAccess, 'binding' | 'path'>> {
  const node = unwrapBindingExpression(input);
  if (seen.has(node)) return [];
  const next = new Set(seen).add(node);
  const expand = (source: AliasSource) =>
    exposedBindingAccesses(source.expression, checker, aliases, next, source.path);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : memberLiteralKey(node.argumentExpression);
    return expand({ expression: node.expression, path: [key, ...path] });
  }
  const binding = accessBinding(node, checker);
  if (binding) {
    if (seen.has(binding)) return [];
    const origins = (aliases.get(binding) ?? []).flatMap((source) => {
      const selected = exposureAliasPath(source, path);
      return selected
        ? exposedBindingAccesses(source.expression, checker, aliases, new Set(next).add(binding), selected)
        : [];
    });
    return [{ binding, path: [...path, null] }, ...origins];
  }
  return exposedExpressionSources(node, path, checker).flatMap(expand);
}

function exposureAliasPath(source: AliasSource, path: MemberPath): MemberPath | null {
  const target = source.targetPath;
  if (target && path.length < target.length && memberPathsOverlap(target, path)) return source.path;
  const selected = source.shallowCopy && path.length === 0 ? [null, null] : [...path, null];
  const projected = aliasSourcePath(source, selected);
  return projected ? projected.slice(0, -1) : null;
}

function exposedExpressionSources(node: ts.Node, path: MemberPath, checker: ts.TypeChecker): AliasSource[] {
  if (ts.isFunctionLike(node) && 'body' in node && node.body)
    return returnedValues(node as ts.FunctionLikeDeclaration).map((expression) => ({ expression, path }));
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    const selected = path.length ? [...path, null] : [null, null];
    return containerMemberSources(node, selected).map((source) => ({ ...source, path: source.path.slice(0, -1) }));
  }
  if (ts.isConditionalExpression(node))
    return [node.whenTrue, node.whenFalse].map((expression) => ({ expression, path }));
  if (ts.isBinaryExpression(node)) return [node.left, node.right].map((expression) => ({ expression, path }));
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return exposedCallSources(node, path, checker);
  }
  return [];
}

function exposedCallSources(
  node: ts.CallExpression | ts.NewExpression,
  path: MemberPath,
  checker: ts.TypeChecker,
): AliasSource[] {
  const callable = localCallable(node.expression, checker);
  const values = callable ? returnedValues(callable) : [...(node.arguments ?? [])];
  return values.map((expression) => ({
    expression: ts.isSpreadElement(expression) ? expression.expression : expression,
    path,
  }));
}

function aliasExpressionChoices(node: ts.Node): readonly ts.Node[] | null {
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  if (!ts.isBinaryExpression(node)) return null;
  const kind = node.operatorToken.kind;
  if (kind === ts.SyntaxKind.EqualsToken) return [node.right];
  return [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(kind)
    ? [node.left, node.right]
    : null;
}
function possibleCallBindingAccesses(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  aliases: ReadonlyMap<ts.Declaration, AliasSource[]>,
  seen: ReadonlySet<ts.Declaration>,
  path: MemberPath,
): Array<Pick<BindingAccess, 'binding' | 'path'>> {
  if (builtinCallName(node, checker) === 'Object.assign') {
    return node.arguments.flatMap((argument, index) =>
      index === 0 || path.length >= 2 ? possibleBindingAccesses(argument, checker, aliases, seen, path) : [],
    );
  }
  const callable = localCallable(node.expression, checker);
  if (!callable || seen.has(callable)) return [];
  return returnedValues(callable).flatMap((value) =>
    possibleBindingAccesses(value, checker, aliases, new Set(seen).add(callable), path),
  );
}

function builtinCallEffects(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): ReturnType<typeof callEffects> | null {
  const args = call.arguments ?? [];
  const target = args[0];
  if (!target) return null;
  switch (builtinCallName(call, checker)) {
    case 'Reflect.set':
      return reflectSetEffects(target, args, checker);
    case 'Object.defineProperty':
      if (descriptorMayInstallAccessor(args[2])) return [{ target, path: [null], unknown: true }];
      return [{ target, path: [args[1] ? memberLiteralKey(args[1]) : null], unknown: false }];
    case 'Object.defineProperties':
      if (descriptorMapMayInstallAccessor(args[1])) return [{ target, path: [null], unknown: true }];
      return objectPropertyKeys(args[1]!).map((key) => ({ target, path: [key], unknown: false }));
    case 'Object.assign':
      return args
        .slice(1)
        .flatMap(objectPropertyKeys)
        .map((key) => ({ target, path: [key], unknown: false }));
    default:
      return null;
  }
}

function reflectSetEffects(
  target: ts.Node,
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
): ReturnType<typeof callEffects> {
  const key = args[1] ? memberLiteralKey(args[1]) : null;
  const receiver = args[3] ?? target;
  const declaration = key === null ? undefined : checker.getTypeAtLocation(target).getProperty(key)?.valueDeclaration;
  const fresh = unwrapBindingExpression(target);
  const dataProperty =
    !!declaration &&
    [ts.SyntaxKind.PropertyAssignment, ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.MethodDeclaration].includes(
      declaration.kind,
    );
  const emptyObject = ts.isObjectLiteralExpression(fresh) && fresh.properties.length === 0;
  // A separate receiver can be changed by a setter installed after the target's
  // declaration. Its static property type does not prove the runtime descriptor.
  const namedWrite = emptyObject || (args[3] === undefined && dataProperty);
  // A setter receives `receiver` as this and can write fields other than key.
  return [{ target: receiver, path: namedWrite ? [key] : [null], unknown: !namedWrite }];
}

function descriptorMayInstallAccessor(node: ts.Node | undefined): boolean {
  return !node || objectPropertyKeys(node).some((key) => key === null || key === 'get' || key === 'set');
}

function descriptorMapMayInstallAccessor(node: ts.Node | undefined): boolean {
  const value = node && unwrapBindingExpression(node);
  if (!value || !ts.isObjectLiteralExpression(value)) return true;
  return value.properties.some(
    (property) => !ts.isPropertyAssignment(property) || descriptorMayInstallAccessor(property.initializer),
  );
}

function objectPropertyKeys(source: ts.Node): Array<string | null> {
  const value = unwrapBindingExpression(source);
  return ts.isObjectLiteralExpression(value)
    ? value.properties.map((property) => (ts.isSpreadAssignment(property) ? null : aliasPropertyKey(property.name)))
    : [null];
}

function builtinCallName(call: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): string | null {
  const callee = unwrapBindingExpression(call.expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    accessBinding(callee.expression, checker)
  )
    return null;
  return `${callee.expression.text}.${callee.name.text}`;
}
