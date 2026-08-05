import { getReExports, getSourceImports } from '../../language-parsers/index.js';
import { getAst } from '../../source/ast/ast-core.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { BoundaryDerivation, BoundaryKeyPart, BoundaryTerm, BoundaryValuePrecision } from './types.js';

const MAX_EVALUATION_DEPTH = 8;
const MAX_REEXPORT_DEPTH = 4;

export interface BoundaryValueContext {
  db: ScipDatabase;
  file: string;
  root: SyntaxNode;
}

export interface EvaluatedBoundaryValue {
  value: string;
  evidence: BoundaryKeyPart['evidence'];
  term: BoundaryTerm;
  precision: BoundaryValuePrecision;
  derivation: BoundaryDerivation;
}

/** Resolve finite address-bearing values without assigning protocol meaning. */
export function evaluateBoundaryValue(
  context: BoundaryValueContext,
  node: SyntaxNode | null | undefined,
): EvaluatedBoundaryValue | null {
  if (!node) return null;
  return evaluateNode(context, node, 0, new Set());
}

function evaluateNode(
  context: BoundaryValueContext,
  input: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedBoundaryValue | null {
  if (depth > MAX_EVALUATION_DEPTH) return unknownValue(input, 'value-evaluation-depth');
  const node = unwrapExpression(input);
  const literal = stringTerm(node);
  if (literal) return directValue(context.file, node, literal.term, literal.value, literal.precision);

  if (node.type === 'binary_expression' && /\+/u.test(node.text)) {
    const parts = node.namedChildren.map((child) => evaluateNode(context, child, depth + 1, new Set(seen)));
    if (parts.length >= 2 && parts.every((part): part is EvaluatedBoundaryValue => part !== null)) {
      const term: BoundaryTerm = { kind: 'concat', parts: parts.map((part) => part.term) };
      const value = parts.map((part) => part.value).join('');
      return derivedValue(
        context.file,
        node,
        term,
        value,
        parts.some((part) => part.precision !== 'literal') ? 'constrained-pattern' : 'literal',
        parts,
      );
    }
  }

  const text = node.text.trim();
  if (/^[A-Za-z_$][\w$]*$/u.test(text)) {
    return resolveIdentifier(context, text, node, depth, seen);
  }

  const member = memberParts(node);
  if (member) {
    return resolveMember(context, member.base, member.properties, node, depth, seen);
  }

  return unknownValue(node, `unsupported-expression:${node.type}`);
}

function resolveIdentifier(
  context: BoundaryValueContext,
  name: string,
  site: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedBoundaryValue | null {
  const identity = `${context.file}\0${name}`;
  if (seen.has(identity)) return unknownValue(site, 'value-cycle');
  seen.add(identity);

  const local = findVariableInitializer(context.root, name);
  if (local) {
    const value = evaluateNode(context, local, depth + 1, seen);
    return value ? derivedFrom(site, 'local-constant', value) : unknownValue(site, 'non-foldable-local');
  }

  const imported = getSourceImports(context.db, context.file).find(
    (item) => item.localName === name && item.sourcePath,
  );
  if (!imported?.sourcePath) return symbolicValue(site, name, 'unresolved-identifier');
  if (imported.kind === 'namespace') {
    return symbolicValue(site, name, 'namespace-import-requires-property');
  }
  const importedName = imported.importedName === 'default' ? name : imported.importedName;
  const targets = resolveImportedDefinitions(context.db, imported.sourcePath, importedName);
  if (targets.length !== 1)
    return symbolicValue(
      site,
      name,
      targets.length === 0 ? 'import-definition-missing' : 'import-definition-ambiguous',
    );
  const target = targets[0]!;
  const targetRoot = getAst(context.db, target.relativePath)?.rootNode;
  if (!targetRoot) return symbolicValue(site, target.symbol, 'import-definition-unparsed');
  const initializer = findVariableInitializer(targetRoot, target.leaf);
  if (!initializer) return symbolicValue(site, target.symbol, 'import-definition-non-value');
  const value = evaluateNode(
    { db: context.db, file: target.relativePath, root: targetRoot },
    initializer,
    depth + 1,
    seen,
  );
  return value
    ? derivedFrom(site, 'imported-constant', value, target.symbol)
    : symbolicValue(site, target.symbol, 'import-value-unresolved');
}

function resolveMember(
  context: BoundaryValueContext,
  base: string,
  properties: readonly string[],
  site: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedBoundaryValue | null {
  const imported = getSourceImports(context.db, context.file).find(
    (item) => item.localName === base && item.sourcePath,
  );
  let targetFile = context.file;
  let targetName = base;
  let proofSymbol: string | undefined;

  if (imported?.sourcePath) {
    if (imported.kind === 'namespace') {
      targetName = properties[0] ?? '';
      properties = properties.slice(1);
    } else {
      targetName = imported.importedName === 'default' ? base : imported.importedName;
    }
    const targets = resolveImportedDefinitions(context.db, imported.sourcePath, targetName);
    if (targets.length !== 1) {
      return symbolicValue(
        site,
        `${base}.${properties.join('.')}`,
        targets.length === 0 ? 'member-definition-missing' : 'member-definition-ambiguous',
      );
    }
    targetFile = targets[0]!.relativePath;
    targetName = targets[0]!.leaf;
    proofSymbol = targets[0]!.symbol;
  }

  const targetRoot = targetFile === context.file ? context.root : getAst(context.db, targetFile)?.rootNode;
  if (!targetRoot) return symbolicValue(site, proofSymbol ?? base, 'member-definition-unparsed');
  let current = findVariableInitializer(targetRoot, targetName);
  if (!current) return symbolicValue(site, proofSymbol ?? base, 'member-base-non-value');
  for (const property of properties) {
    const object = unwrapExpression(current);
    current = objectMemberValue(object, property);
    if (!current)
      return symbolicValue(
        site,
        proofSymbol ?? `${base}.${properties.join('.')}`,
        `member-property-missing:${property}`,
      );
  }
  const value = evaluateNode({ db: context.db, file: targetFile, root: targetRoot }, current, depth + 1, seen);
  return value
    ? derivedFrom(site, 'member-constant', value, proofSymbol)
    : symbolicValue(site, proofSymbol ?? base, 'member-value-unresolved');
}

function stringTerm(node: SyntaxNode): { term: BoundaryTerm; value: string; precision: BoundaryValuePrecision } | null {
  const text = node.text.trim();
  const quote = text[0];
  if ((quote !== "'" && quote !== '"' && quote !== '`') || text.at(-1) !== quote) return null;
  const raw = text.slice(1, -1);
  if (quote !== '`' || !raw.includes('${')) {
    return { term: { kind: 'literal', value: raw }, value: raw, precision: 'literal' };
  }
  const parts: BoundaryTerm[] = [];
  let cursor = 0;
  const interpolation = /\$\{([^}]*)\}/gu;
  for (const match of raw.matchAll(interpolation)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, index) });
    parts.push({ kind: 'unknown', reason: `template-hole:${match[1]?.trim() || 'expression'}` });
    cursor = index + match[0].length;
  }
  if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
  return {
    term: { kind: 'pattern', language: 'template', value: raw.replace(interpolation, '{}') },
    value: raw.replace(interpolation, '{}'),
    precision: 'constrained-pattern',
  };
}

function directValue(
  file: string,
  node: SyntaxNode,
  term: BoundaryTerm,
  value: string,
  precision: BoundaryValuePrecision,
): EvaluatedBoundaryValue {
  return {
    value,
    evidence: 'literal',
    term,
    precision,
    derivation: derivation('direct-literal', 'direct', file, node),
  };
}

function derivedValue(
  file: string,
  node: SyntaxNode,
  term: BoundaryTerm,
  value: string,
  precision: BoundaryValuePrecision,
  inputs: readonly EvaluatedBoundaryValue[],
): EvaluatedBoundaryValue {
  return {
    value,
    evidence: 'constant',
    term,
    precision,
    derivation: {
      ...derivation('constant-concatenation', 'mechanically-derived', file, node),
      inputFactIds: inputs.flatMap((input) => input.derivation.inputFactIds),
      sourceSpans: inputs.flatMap((input) => input.derivation.sourceSpans),
    },
  };
}

function derivedFrom(
  site: SyntaxNode,
  rule: string,
  value: EvaluatedBoundaryValue,
  symbol?: string,
): EvaluatedBoundaryValue {
  if (value.evidence === 'expression') {
    return {
      ...value,
      derivation: {
        kind: 'heuristic',
        rule,
        ruleVersion: '1',
        inputFactIds: [...value.derivation.inputFactIds, ...(symbol ? [symbol] : [])],
        sourceSpans: value.derivation.sourceSpans,
      },
    };
  }
  return {
    ...value,
    evidence: 'constant',
    derivation: {
      kind: 'mechanically-derived',
      rule,
      ruleVersion: '1',
      inputFactIds: [...value.derivation.inputFactIds, ...(symbol ? [symbol] : [])],
      sourceSpans: value.derivation.sourceSpans,
    },
  };
}

function symbolicValue(node: SyntaxNode, symbol: string, reason: string): EvaluatedBoundaryValue {
  return {
    value: node.text.trim(),
    evidence: 'expression',
    term: { kind: 'symbol', symbol },
    precision: 'symbolic',
    derivation: derivation(reason, 'heuristic', '', node),
  };
}

function unknownValue(node: SyntaxNode, reason: string): EvaluatedBoundaryValue {
  return {
    value: node.text.trim(),
    evidence: 'expression',
    term: { kind: 'unknown', reason },
    precision: 'unknown',
    derivation: derivation(reason, 'heuristic', '', node),
  };
}

function derivation(
  rule: string,
  kind: BoundaryDerivation['kind'],
  file: string,
  node: SyntaxNode,
): BoundaryDerivation {
  return {
    kind,
    rule,
    ruleVersion: '1',
    inputFactIds: [],
    sourceSpans: file ? [{ file, startLine: node.startPosition.row, endLine: node.endPosition.row }] : [],
  };
}

function memberParts(node: SyntaxNode): { base: string; properties: string[] } | null {
  const compact = node.text.replace(/\s+/gu, '');
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(compact)) return null;
  const [base, ...properties] = compact.split('.');
  return base ? { base, properties } : null;
}

function findVariableInitializer(root: SyntaxNode, name: string): SyntaxNode | null {
  let match: SyntaxNode | null = null;
  walk(root, (node) => {
    if (match || node.type !== 'variable_declarator') return;
    const declared = node.childForFieldName('name') ?? node.namedChild(0);
    if (declared?.text.trim() !== name) return;
    const declaration = node.parent;
    if (
      !declaration ||
      declaration.type !== 'lexical_declaration' ||
      !/^\s*(?:export\s+)?const\b/u.test(declaration.text)
    ) {
      return;
    }
    match = node.childForFieldName('value') ?? node.namedChild(1);
  });
  return match;
}

function objectMemberValue(object: SyntaxNode, property: string): SyntaxNode | null {
  for (const pair of object.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key') ?? pair.namedChild(0);
    if (key?.text.replace(/^['"`]|['"`]$/gu, '') !== property) continue;
    return pair.childForFieldName('value') ?? pair.namedChild(1);
  }
  return null;
}

function unwrapExpression(input: SyntaxNode): SyntaxNode {
  let node = input;
  while (
    ['as_expression', 'satisfies_expression', 'type_assertion', 'parenthesized_expression'].includes(node.type) &&
    node.namedChildren.length > 0
  ) {
    node = node.namedChildren[0]!;
  }
  return node;
}

function resolveImportedDefinitions(
  db: ScipDatabase,
  relativePath: string,
  importedName: string,
  depth = 0,
  seen = new Set<string>(),
): ReturnType<typeof getDefinitionsForFile> {
  const identity = `${relativePath}\0${importedName}`;
  if (seen.has(identity) || depth > MAX_REEXPORT_DEPTH) return [];
  seen.add(identity);
  const direct = getDefinitionsForFile(db, relativePath).filter((definition) => definition.leaf === importedName);
  if (direct.length > 0) return direct;
  return getReExports(db, relativePath).flatMap((reexport) => {
    if (!reexport.sourcePath) return [];
    if (reexport.kind === 'named' && !reexport.names.includes(importedName)) return [];
    return resolveImportedDefinitions(db, reexport.sourcePath, importedName, depth + 1, new Set(seen));
  });
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
