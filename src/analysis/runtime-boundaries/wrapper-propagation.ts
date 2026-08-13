import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { referenceEvidenceForSymbol } from '../../symbols/references/reference-sites.js';
import { leafName } from '../../symbols/symbol-parser.js';
import {
  parameterName,
  smallestCoveringCallable,
  walkNamedSyntax as walk,
} from '../../source/ast/ast-callables.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { boundaryFileContext, createBoundaryObservation, type BoundaryFileContext } from './extractors.js';
import type { BoundaryKeyPart, BoundaryObservation } from './types.js';

export interface WrapperPropagationResult {
  observations: BoundaryObservation[];
  wrappersAnalyzed: number;
  filesInspected: number;
  errors: string[];
}

interface WrapperTemplate {
  observation: BoundaryObservation;
  parameterIndexes: ReadonlyMap<string, number>;
}

/**
 * A wrapper template is an indexed callable whose boundary address is one of
 * its parameters. Compiler-attributed callsites can therefore substitute an
 * exact argument without guessing what the wrapper does.
 */
export function propagateCompilerResolvedWrappers(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
): WrapperPropagationResult {
  const templates = wrapperTemplates(db, observations);
  const derived: BoundaryObservation[] = [];
  const filesInspected = new Set<string>();
  const errors: string[] = [];

  for (const template of templates) {
    const owner = template.observation.owner;
    const definition = owner.symbol
      ? getDefinitionsForFile(db, owner.file).find((candidate) => candidate.symbol === owner.symbol)
      : null;
    if (!definition) continue;

    try {
      for (const site of referenceEvidenceForSymbol(db, definition, { semantic: false })) {
        const context = boundaryFileContext(db, site.file);
        if (!context) continue;
        filesInspected.add(site.file);
        for (const call of matchingCallsAtLine(context.root, site.line, leafName(definition.symbol))) {
          const keyParts = substituteParameters(template, call, context);
          if (!keyParts) continue;
          derived.push(
            createBoundaryObservation(
              context,
              call,
              'builtin.wrapper',
              template.observation.action,
              keyParts,
              'exact',
              'compiler-resolved-wrapper',
            ),
          );
        }
      }
    } catch (error) {
      errors.push(
        `builtin.wrapper failed for ${owner.file}:${owner.startLine + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    observations: derived,
    wrappersAnalyzed: templates.length,
    filesInspected: filesInspected.size,
    errors,
  };
}

function wrapperTemplates(db: ScipDatabase, observations: readonly BoundaryObservation[]): WrapperTemplate[] {
  const templates: WrapperTemplate[] = [];
  for (const observation of observations) {
    if (observation.strength !== 'candidate' || !observation.owner.symbol) continue;
    const expressionParts = observation.keyParts.filter((part) => part.evidence === 'expression');
    if (expressionParts.length === 0) continue;
    const context = boundaryFileContext(db, observation.owner.file);
    if (!context) continue;
    const parameters = callableParameterNames(context.root, observation.owner.startLine, observation.owner.endLine);
    if (!parameters) continue;
    const parameterIndexes = new Map(parameters.flatMap((name, index) => (name ? [[name, index] as const] : [])));
    if (expressionParts.every((part) => parameterIndexes.has(part.value))) {
      templates.push({ observation, parameterIndexes });
    }
  }
  return templates;
}

function substituteParameters(
  template: WrapperTemplate,
  call: SyntaxNode,
  context: BoundaryFileContext,
): BoundaryKeyPart[] | null {
  const args = callArguments(call);
  const substituted: BoundaryKeyPart[] = [];
  for (const part of template.observation.keyParts) {
    if (part.evidence !== 'expression') {
      substituted.push(part);
      continue;
    }
    const parameterIndex = template.parameterIndexes.get(part.value);
    const argument = parameterIndex === undefined ? null : addressedArgument(args[parameterIndex], context.constants);
    if (!argument || argument.evidence === 'expression') return null;
    substituted.push({ name: part.name, ...argument });
  }
  return substituted;
}

function callableParameterNames(root: SyntaxNode, startLine: number, endLine: number): Array<string | null> | null {
  const callable = smallestCoveringCallable(root, startLine, endLine);
  const parameters =
    callable?.childForFieldName('parameters') ??
    callable?.namedChildren.find((child) => /parameters/u.test(child.type));
  if (!parameters) return null;
  return parameters.namedChildren.map(parameterName);
}

function matchingCallsAtLine(root: SyntaxNode, line: number, expectedLeaf: string): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  walk(root, (node) => {
    if (node.type !== 'call_expression' && node.type !== 'call') return;
    if (node.startPosition.row > line || node.endPosition.row < line) return;
    const target = node.childForFieldName('function') ?? node.namedChild(0);
    const leaf = target?.text.replace(/\s+/gu, '').split('.').at(-1) ?? '';
    if (leaf === expectedLeaf) calls.push(node);
  });
  return calls;
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function addressedArgument(
  node: SyntaxNode | null | undefined,
  constants: ReadonlyMap<string, string>,
): Omit<BoundaryKeyPart, 'name'> | null {
  if (!node) return null;
  const text = node.text.trim();
  const quote = text[0];
  if ((quote === "'" || quote === '"' || quote === '`') && text.at(-1) === quote) {
    const literal = text.slice(1, -1);
    if (quote !== '`' || !literal.includes('${')) return { value: literal, evidence: 'literal' };
  }
  const constant = /^[A-Za-z_$][\w$]*$/u.test(text) ? constants.get(text) : undefined;
  return constant === undefined ? null : { value: constant, evidence: 'constant' };
}
