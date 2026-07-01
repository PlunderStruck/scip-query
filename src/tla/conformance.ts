import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import type { SymbolMatch } from '../domain/types.js';
import { getAst } from '../source/ast.js';
import type { SyntaxNode } from '../source/ast.js';
import { escapeRegex as escapeRegExp } from '../source/source-stripper.js';
import { resolveSymbol } from '../symbols/symbol-lookup.js';
import { getDefinitionsForFile } from '../symbols/definition-catalog.js';
import { leafName, shortenSymbol } from '../symbols/symbol-parser.js';
import {
  scipKindName,
  scipFunctionLikeKindNumbers,
  scipTypeLikeKindNumbers,
  scipValueLikeKindNumbers,
} from '../symbols/symbol-kind.js';
import { callGraph } from '../queries/navigation/call-graph.js';
import type { TlaModelContract, TlaModuleFacts, TlaTraceStep } from './model-contract.js';

export type TlaFindingSeverity = 'info' | 'warning' | 'error';
export type TlaFindingEvidence = 'model-text' | 'compiler-symbol' | 'static-action' | 'trace' | 'unknown' | 'contract';

export interface TlaConformanceFinding {
  id: string;
  severity: TlaFindingSeverity;
  evidence: TlaFindingEvidence;
  category:
    | 'contract'
    | 'model-text'
    | 'missing-referent'
    | 'ambiguous-referent'
    | 'invalid-referent-kind'
    | 'unmapped-write'
    | 'undeclared-write'
    | 'missing-write-evidence'
    | 'undeclared-read'
    | 'missing-read-evidence'
    | 'missing-call'
    | 'missing-invariant'
    | 'trace';
  modelElement?: string;
  codeRef?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  relatedFiles?: string[];
  message: string;
  why: string[];
  remediation: string;
}

export interface TlaConformanceResult {
  modelVariables: string[];
  modelOperators: string[];
  mappedVariables: number;
  mappedActions: number;
  resolvedReferents: number;
  staticWrites: TlaStaticWrite[];
  staticReads: TlaStaticRead[];
  waivers: TlaWaiverUse[];
  checkedInvariants: string[];
  traceStepsChecked: number;
  findings: TlaConformanceFinding[];
}

interface VariableResolution {
  aliases: VariableAlias[];
  referents: ResolvedReferent[];
}

interface ResolvedAction {
  name: string;
  mapping: TlaModelContract['actions'][string];
  referents: ResolvedReferent[];
}

interface ResolvedReferent {
  ref: string;
  match: SymbolMatch | null;
}

export interface VariableAlias {
  variable: string;
  alias: string;
}

export interface TlaStaticWrite {
  variable: string;
  alias: string;
  file: string;
  line: number;
  target: string;
  kind: 'assignment' | 'declaration' | 'object-field' | 'mutation-call' | 'update' | 'delete' | 'source-scan';
  enclosingSymbol?: string;
  enclosingShort?: string;
}

export interface TlaStaticRead {
  variable: string;
  alias: string;
  file: string;
  line: number;
  target: string;
  kind: 'identifier' | 'source-scan';
  enclosingSymbol?: string;
  enclosingShort?: string;
}

interface TlaWaiverUse {
  action: string;
  kind: 'read' | 'write';
  variable: string;
  reason: string;
  legacy: boolean;
}

const MUTATING_METHODS = new Set([
  'add',
  'clear',
  'delete',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

export function verifyTlaConformance(
  db: ScipDatabase,
  contract: TlaModelContract,
  moduleFacts: TlaModuleFacts | null,
  traceSteps: readonly TlaTraceStep[] = [],
  checkedInvariants: readonly string[] = [],
): TlaConformanceResult {
  const findings: TlaConformanceFinding[] = [];
  const variableResolution = aliasesForVariables(db, contract, findings);
  const variableAliases = variableResolution.aliases;
  const actions = resolveActions(db, contract, findings);
  if (moduleFacts) verifyModelText(contract, moduleFacts, checkedInvariants, findings);

  const actionSymbols = new Set(
    actions.flatMap((action) => action.referents.map((referent) => referent.match?.symbol).filter(Boolean) as string[]),
  );
  const staticWrites = collectAllStaticWrites(db, contract, actions, variableAliases, actionSymbols, findings);
  const staticReads = collectAllStaticReads(db, actions, variableAliases, findings);
  verifyDeclaredCalls(db, actions, findings);
  verifyTraces(contract, traceSteps, findings);

  return {
    modelVariables: moduleFacts?.variables ?? [],
    modelOperators: moduleFacts?.operators ?? [],
    mappedVariables: Object.keys(contract.variables).length,
    mappedActions: Object.keys(contract.actions).length,
    resolvedReferents:
      resolvedCount(actions.flatMap((action) => action.referents)) + resolvedCount(variableResolution.referents),
    staticWrites,
    staticReads,
    waivers: waiverUses(contract),
    checkedInvariants: [...checkedInvariants],
    traceStepsChecked: traceSteps.length,
    findings,
  };
}

function aliasesForVariables(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): VariableResolution {
  const aliases: VariableAlias[] = [];
  const referents: ResolvedReferent[] = [];
  for (const [name, variable] of Object.entries(contract.variables)) {
    const variableAliases = new Set(variable.aliases);
    for (const ref of variable.code) {
      const referent = resolveReferent(db, ref, findings, name);
      referents.push(referent);
      const match = referent.match;
      if (!match) {
        findings.push(
          finding('missing-referent', 'error', 'compiler-symbol', {
            modelElement: name,
            codeRef: ref,
            message: `TLA+ variable ${name} maps to missing TypeScript referent ${ref}.`,
            why: ['The mapping contract must point at live compiler-indexed code before conformance can be checked.'],
            remediation: `Update variables.${name}.code to a live symbol, or remove the variable from the model mapping.`,
          }),
        );
        continue;
      }
      validateVariableReferentKind(db, name, ref, match, findings);
      if (variable.aliases.length === 0) variableAliases.add(leafName(match.symbol));
    }
    for (const alias of variableAliases) aliases.push({ variable: name, alias });
  }
  return { aliases: dedupeAliases(aliases), referents };
}

function resolveActions(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): ResolvedAction[] {
  return Object.entries(contract.actions).map(([name, mapping]) => {
    const referents = mapping.code.map((ref) => {
      const referent = resolveReferent(db, ref, findings, name);
      const match = referent.match;
      if (!match) {
        findings.push(
          finding('missing-referent', 'error', 'compiler-symbol', {
            modelElement: name,
            codeRef: ref,
            message: `TLA+ action ${name} maps to missing TypeScript referent ${ref}.`,
            why: ['The action cannot be compared to code because the mapped symbol did not resolve in the SCIP index.'],
            remediation: `Update actions.${name}.code to a live function or method symbol.`,
          }),
        );
      } else {
        validateActionReferentKind(db, name, ref, match, findings);
      }
      return referent;
    });
    return { name, mapping, referents };
  });
}

function verifyModelText(
  contract: TlaModelContract,
  moduleFacts: TlaModuleFacts,
  checkedInvariants: readonly string[],
  findings: TlaConformanceFinding[],
): void {
  const variables = new Set(moduleFacts.variables);
  const operators = new Set(moduleFacts.operators);
  const invariants = new Set(checkedInvariants);
  for (const name of Object.keys(contract.variables)) {
    if (!variables.has(name)) {
      findings.push(
        finding('model-text', 'error', 'model-text', {
          modelElement: name,
          file: moduleFacts.path,
          message: `Mapped TLA+ variable ${name} is not declared in the module.`,
          why: ['The mapping names a model variable, but the TLA+ module text does not declare it with VARIABLE(S).'],
          remediation: `Declare ${name} in the TLA+ module or remove it from the mapping.`,
        }),
      );
    }
  }
  for (const name of Object.keys(contract.actions)) {
    if (!operators.has(name)) {
      findings.push(
        finding('model-text', 'error', 'model-text', {
          modelElement: name,
          file: moduleFacts.path,
          message: `Mapped TLA+ action ${name} is not defined in the module.`,
          why: ['The mapping names a model action, but the TLA+ module text has no matching operator definition.'],
          remediation: `Define ${name} == ... in the TLA+ module or update the mapping action name.`,
        }),
      );
    }
  }
  for (const invariant of contract.invariants) {
    if (!invariants.has(invariant)) {
      findings.push(
        finding('missing-invariant', 'warning', 'model-text', {
          modelElement: invariant,
          file: moduleFacts.path,
          message: `Mapping lists invariant ${invariant}, but the checker config does not include it.`,
          why: ['The model mapping names an invariant that was not found in INVARIANT lines of the selected config.'],
          remediation: `Add INVARIANT ${invariant} to the config used for this run, or remove it from the mapping invariants list.`,
        }),
      );
    }
  }
}

function collectAllStaticWrites(
  db: ScipDatabase,
  contract: TlaModelContract,
  actions: readonly ResolvedAction[],
  aliases: readonly VariableAlias[],
  actionSymbols: ReadonlySet<string>,
  findings: TlaConformanceFinding[],
): TlaStaticWrite[] {
  const writes: TlaStaticWrite[] = [];
  for (const action of actions) {
    const actionWrites: TlaStaticWrite[] = [];
    for (const referent of action.referents) {
      if (!referent.match) continue;
      const found = collectWritesForRange(
        db,
        referent.match.relativePath,
        referent.match.startLine,
        referent.match.endLine,
        aliases,
      );
      actionWrites.push(...found);
      writes.push(...found);
    }
    verifyActionWrites(action, actionWrites, findings);
  }

  for (const file of scopedFiles(db, contract)) {
    for (const write of collectWritesForRange(db, file, 0, Number.POSITIVE_INFINITY, aliases)) {
      writes.push(write);
      if (!isUnmappedWriteCandidate(write)) continue;
      if (write.enclosingSymbol && actionSymbols.has(write.enclosingSymbol)) continue;
      findings.push(
        finding('unmapped-write', 'error', 'static-action', {
          modelElement: write.variable,
          codeRef: write.enclosingSymbol ?? `${write.file}:${write.line + 1}`,
          file: write.file,
          startLine: write.line,
          endLine: write.line,
          message: `Modeled variable ${write.variable} is written outside any mapped TLA+ action.`,
          why: [
            `The static source scan found ${write.target} at ${write.file}:${write.line + 1}.`,
            write.enclosingShort
              ? `The write is inside ${write.enclosingShort}, which is not mapped as a model action.`
              : 'The write is outside an indexed callable definition.',
          ],
          remediation: `Map the enclosing code to a TLA+ action, remove the write, or remove ${write.variable} from the modeled slice if it is intentionally out of scope.`,
        }),
      );
    }
  }

  return uniqueWrites(writes);
}

function isUnmappedWriteCandidate(write: TlaStaticWrite): boolean {
  return write.kind !== 'declaration' && write.kind !== 'object-field';
}

function verifyActionWrites(
  action: ResolvedAction,
  writes: readonly TlaStaticWrite[],
  findings: TlaConformanceFinding[],
): void {
  const declared = new Set(action.mapping.writes);
  const observed = new Set(writes.map((write) => write.variable));
  for (const write of writes) {
    if (!declared.has(write.variable)) {
      findings.push(
        finding('undeclared-write', 'error', 'static-action', {
          modelElement: action.name,
          codeRef: write.enclosingSymbol ?? `${write.file}:${write.line + 1}`,
          file: write.file,
          startLine: write.line,
          endLine: write.line,
          message: `TLA+ action ${action.name} writes modeled variable ${write.variable}, but the mapping does not declare that write.`,
          why: [`The code writes ${write.target} at ${write.file}:${write.line + 1}.`],
          remediation: `Add ${write.variable} to actions.${action.name}.writes, update the model action, or change the code so it no longer mutates that modeled variable.`,
        }),
      );
    }
  }
  for (const variable of declared) {
    if (!observed.has(variable) && !isFactWaived(action, 'write', variable)) {
      findings.push(
        finding('missing-write-evidence', 'warning', 'unknown', {
          modelElement: action.name,
          message: `TLA+ action ${action.name} declares a write to ${variable}, but no direct source write was found.`,
          why: [
            'The write may happen through an alias, callback, dependency, or runtime side effect that static scanning could not prove.',
          ],
          remediation: `Add a more precise variable alias, add the write sink as a mapped action referent, provide a trace, or waive actions.${action.name}.writes.${variable} with a specific reason.`,
        }),
      );
    }
  }
}

function collectAllStaticReads(
  db: ScipDatabase,
  actions: readonly ResolvedAction[],
  aliases: readonly VariableAlias[],
  findings: TlaConformanceFinding[],
): TlaStaticRead[] {
  const reads: TlaStaticRead[] = [];
  for (const action of actions) {
    const actionReads: TlaStaticRead[] = [];
    for (const referent of action.referents) {
      if (!referent.match) continue;
      const found = collectReadsForRange(
        db,
        referent.match.relativePath,
        referent.match.startLine,
        referent.match.endLine,
        aliases,
      );
      actionReads.push(...found);
      reads.push(...found);
    }
    verifyActionReads(action, actionReads, findings);
  }
  return uniqueReads(reads);
}

function verifyActionReads(
  action: ResolvedAction,
  reads: readonly TlaStaticRead[],
  findings: TlaConformanceFinding[],
): void {
  const declared = new Set(action.mapping.reads);
  const observed = new Set(reads.map((read) => read.variable));
  for (const read of reads) {
    if (!declared.has(read.variable) && !isFactWaived(action, 'read', read.variable)) {
      findings.push(
        finding('undeclared-read', 'warning', 'static-action', {
          modelElement: action.name,
          codeRef: read.enclosingSymbol ?? `${read.file}:${read.line + 1}`,
          file: read.file,
          startLine: read.line,
          endLine: read.line,
          message: `TLA+ action ${action.name} reads modeled variable ${read.variable}, but the mapping does not declare that read.`,
          why: [`The code reads ${read.target} at ${read.file}:${read.line + 1}.`],
          remediation: `Add ${read.variable} to actions.${action.name}.reads, update the model action, or waive the read with a specific reason if it is intentionally outside the model step.`,
        }),
      );
    }
  }
  for (const variable of declared) {
    if (!observed.has(variable) && !isFactWaived(action, 'read', variable)) {
      findings.push(
        finding('missing-read-evidence', 'warning', 'unknown', {
          modelElement: action.name,
          message: `TLA+ action ${action.name} declares a read of ${variable}, but no direct source read was found.`,
          why: [
            'The read may happen through an alias, callback, dependency, or runtime side effect that static scanning could not prove.',
          ],
          remediation: `Add a more precise variable alias, add the read source as a mapped action referent, provide a trace, or waive actions.${action.name}.reads.${variable} with a specific reason.`,
        }),
      );
    }
  }
}

function verifyDeclaredCalls(
  db: ScipDatabase,
  actions: readonly ResolvedAction[],
  findings: TlaConformanceFinding[],
): void {
  for (const action of actions) {
    if (action.mapping.calls.length === 0) continue;
    const expected = action.mapping.calls.map((ref) => resolveReferent(db, ref, findings, action.name));
    for (const item of expected) {
      if (!item.match) {
        findings.push(
          finding('missing-referent', 'error', 'compiler-symbol', {
            modelElement: action.name,
            codeRef: item.ref,
            message: `actions.${action.name}.calls contains missing TypeScript referent ${item.ref}.`,
            why: ['Declared call checks require the expected callee to resolve in the SCIP index.'],
            remediation: `Update actions.${action.name}.calls to a live symbol or remove the stale call expectation.`,
          }),
        );
      }
    }
    const expectedSymbols = new Set(expected.map((item) => item.match?.symbol).filter(Boolean) as string[]);
    for (const referent of action.referents) {
      if (!referent.match) continue;
      const graph = callGraph(db, referent.match.symbol);
      const actual = new Set(graph?.callees.map((callee) => callee.symbol) ?? []);
      for (const expectedSymbol of expectedSymbols) {
        if (!actual.has(expectedSymbol)) {
          findings.push(
            finding('missing-call', 'error', 'compiler-symbol', {
              modelElement: action.name,
              codeRef: referent.ref,
              file: referent.match.relativePath,
              startLine: referent.match.startLine,
              endLine: referent.match.endLine,
              message: `TLA+ action ${action.name} no longer calls ${shortenSymbol(expectedSymbol)} from ${referent.ref}.`,
              why: [
                'The mapping declares a call dependency that is absent from the current compiler-resolved call graph.',
              ],
              remediation: `Update actions.${action.name}.calls, update the TLA+ action, or restore the code path if the call is required.`,
            }),
          );
        }
      }
    }
  }
}

function verifyTraces(
  contract: TlaModelContract,
  steps: readonly TlaTraceStep[],
  findings: TlaConformanceFinding[],
): void {
  for (const [index, step] of steps.entries()) {
    const action = contract.actions[step.action];
    if (!action) {
      findings.push(
        finding('trace', 'error', 'trace', {
          modelElement: step.action,
          codeRef: step.code,
          message: `Trace step ${index} uses action ${step.action}, which is not mapped.`,
          why: ['Every observed trace action must map to a TLA+ action before trace conformance can be checked.'],
          remediation: `Add actions.${step.action} to the mapping, or fix the trace action name.`,
        }),
      );
      continue;
    }
    const changed = changedTraceVariables(step);
    const allowed = new Set(action.writes);
    for (const variable of changed) {
      if (!allowed.has(variable)) {
        findings.push(
          finding('trace', 'error', 'trace', {
            modelElement: step.action,
            codeRef: step.code,
            message: `Trace step ${index} changed ${variable}, but action ${step.action} does not declare that write.`,
            why: ['The runtime trace observed a state change outside the action write set.'],
            remediation: `Update actions.${step.action}.writes, update the TLA+ model, or investigate the code path that changed ${variable}.`,
          }),
        );
      }
    }
  }
}

export function collectWritesForRange(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
): TlaStaticWrite[] {
  const astWrites = collectAstWrites(db, file, startLine, endLine, aliases);
  if (astWrites) return astWrites;
  return collectSourceScanWrites(db, file, startLine, endLine, aliases);
}

export function collectReadsForRange(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
): TlaStaticRead[] {
  const astReads = collectAstReads(db, file, startLine, endLine, aliases);
  if (astReads) return astReads;
  return collectSourceScanReads(db, file, startLine, endLine, aliases);
}

function collectAstWrites(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
): TlaStaticWrite[] | null {
  const tree = getAst(db, file);
  if (!tree) return null;
  const writes: TlaStaticWrite[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.startPosition.row > endLine || node.endPosition.row < startLine) return;
    recordWriteNode(db, file, node, aliases, writes);
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return uniqueWrites(writes);
}

function collectAstReads(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
): TlaStaticRead[] | null {
  const tree = getAst(db, file);
  if (!tree) return null;
  const reads: TlaStaticRead[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.startPosition.row > endLine || node.endPosition.row < startLine) return;
    recordReadNode(db, file, node, aliases, reads);
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return uniqueReads(reads);
}

function recordWriteNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  aliases: readonly VariableAlias[],
  writes: TlaStaticWrite[],
): void {
  if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
    const target = node.childForFieldName('left') ?? node.namedChild(0);
    if (target) recordTargetMatches(db, file, target, 'assignment', aliases, writes);
    return;
  }
  if (node.type === 'variable_declarator') {
    const target = node.childForFieldName('name') ?? node.namedChild(0);
    if (target) recordTargetMatches(db, file, target, 'declaration', aliases, writes);
    return;
  }
  if (node.type === 'pair') {
    const target = node.childForFieldName('key') ?? node.namedChild(0);
    if (target) recordTargetMatches(db, file, target, 'object-field', aliases, writes);
    return;
  }
  if (node.type === 'update_expression') {
    const target = node.namedChildren.find((child) => child.type !== '++' && child.type !== '--') ?? node.namedChild(0);
    if (target) recordTargetMatches(db, file, target, 'update', aliases, writes);
    return;
  }
  if (node.type === 'unary_expression' && /^\s*delete\b/.test(node.text)) {
    const target = node.namedChild(0);
    if (target) recordTargetMatches(db, file, target, 'delete', aliases, writes);
    return;
  }
  if (node.type === 'call_expression') {
    const target = node.childForFieldName('function') ?? node.namedChild(0);
    if (!target || !isMutatingCallTarget(target)) return;
    recordTargetMatches(db, file, target, 'mutation-call', aliases, writes);
  }
}

function recordReadNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  aliases: readonly VariableAlias[],
  reads: TlaStaticRead[],
): void {
  if (!isIdentifierLike(node) || isWritePosition(node)) return;
  for (const alias of aliases) {
    if (node.text !== alias.alias) continue;
    const enclosing = enclosingSymbolForLine(db, file, node.startPosition.row);
    reads.push({
      variable: alias.variable,
      alias: alias.alias,
      file,
      line: node.startPosition.row,
      target: node.text,
      kind: 'identifier',
      enclosingSymbol: enclosing?.symbol,
      enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
    });
  }
}

function isIdentifierLike(node: SyntaxNode): boolean {
  return (
    node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'shorthand_property_identifier'
  );
}

function isWritePosition(node: SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'assignment_expression' || parent.type === 'augmented_assignment_expression') {
      const target = parent.childForFieldName('left') ?? parent.namedChild(0);
      return Boolean(target && nodeContains(target, node));
    }
    if (parent.type === 'update_expression') return true;
    if (parent.type === 'unary_expression' && /^\s*delete\b/.test(parent.text)) return true;
    if (parent.type === 'pair') {
      const key = parent.childForFieldName('key') ?? parent.namedChild(0);
      return Boolean(key && nodeContains(key, node));
    }
    if (parent.type === 'call_expression') {
      const target = parent.childForFieldName('function') ?? parent.namedChild(0);
      if (target && isMutatingCallTarget(target) && nodeContains(target, node)) return true;
    }
    if (
      parent.type.endsWith('statement') ||
      parent.type === 'function_declaration' ||
      parent.type === 'method_definition'
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return false;
}

function nodeContains(container: SyntaxNode, node: SyntaxNode): boolean {
  return container.startIndex <= node.startIndex && container.endIndex >= node.endIndex;
}

function isMutatingCallTarget(target: SyntaxNode): boolean {
  if (target.type !== 'member_expression') return false;
  const member = target.namedChild(target.namedChildCount - 1);
  return Boolean(member && MUTATING_METHODS.has(member.text));
}

function recordTargetMatches(
  db: ScipDatabase,
  file: string,
  target: SyntaxNode,
  kind: TlaStaticWrite['kind'],
  aliases: readonly VariableAlias[],
  writes: TlaStaticWrite[],
): void {
  for (const alias of aliases) {
    if (!aliasMatchesTarget(alias.alias, target.text)) continue;
    const enclosing = enclosingSymbolForLine(db, file, target.startPosition.row);
    writes.push({
      variable: alias.variable,
      alias: alias.alias,
      file,
      line: target.startPosition.row,
      target: target.text,
      kind,
      enclosingSymbol: enclosing?.symbol,
      enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
    });
  }
}

function collectSourceScanWrites(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
): TlaStaticWrite[] {
  const source = readFileSync(join(db.config.projectRoot, file), 'utf8');
  const lines = source.split(/\r?\n/);
  const writes: TlaStaticWrite[] = [];
  const boundedEnd = Number.isFinite(endLine) ? Math.min(lines.length - 1, endLine) : lines.length - 1;
  for (let line = Math.max(0, startLine); line <= boundedEnd; line += 1) {
    const text = lines[line] ?? '';
    for (const alias of aliases) {
      const escaped = escapeRegExp(alias.alias);
      const pattern = new RegExp(
        `(?:\\b${escaped}\\b\\s*(?:=|\\+=|-=|\\*=|/=|%=)|\\b${escaped}\\b\\s*\\.\\s*(?:${[...MUTATING_METHODS].join('|')})\\s*\\(|\\b${escaped}\\b\\s*\\[[^\\]]+\\]\\s*=)`,
      );
      if (!pattern.test(text)) continue;
      const enclosing = enclosingSymbolForLine(db, file, line);
      writes.push({
        variable: alias.variable,
        alias: alias.alias,
        file,
        line,
        target: text.trim(),
        kind: 'source-scan',
        enclosingSymbol: enclosing?.symbol,
        enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
      });
    }
  }
  return uniqueWrites(writes);
}

function collectSourceScanReads(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
): TlaStaticRead[] {
  const source = readFileSync(join(db.config.projectRoot, file), 'utf8');
  const lines = source.split(/\r?\n/);
  const reads: TlaStaticRead[] = [];
  const boundedEnd = Number.isFinite(endLine) ? Math.min(lines.length - 1, endLine) : lines.length - 1;
  for (let line = Math.max(0, startLine); line <= boundedEnd; line += 1) {
    const text = lines[line] ?? '';
    for (const alias of aliases) {
      const escaped = escapeRegExp(alias.alias);
      if (!new RegExp(`\\b${escaped}\\b`).test(text)) continue;
      if (new RegExp(`\\b${escaped}\\b\\s*(?:=|\\+=|-=|\\*=|/=|%=|\\.|\\[)`).test(text)) continue;
      const enclosing = enclosingSymbolForLine(db, file, line);
      reads.push({
        variable: alias.variable,
        alias: alias.alias,
        file,
        line,
        target: text.trim(),
        kind: 'source-scan',
        enclosingSymbol: enclosing?.symbol,
        enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
      });
    }
  }
  return uniqueReads(reads);
}

function scopedFiles(db: ScipDatabase, contract: TlaModelContract): string[] {
  const scopes = contract.scope ?? [];
  if (scopes.length === 0) return [];
  const rows = db.all<{ relative_path: string }>(`SELECT relative_path FROM documents ORDER BY relative_path`);
  return rows.map((row) => row.relative_path).filter((file) => scopes.some((scope) => file.includes(scope)));
}

function resolveReferent(
  db: ScipDatabase,
  ref: string,
  findings: TlaConformanceFinding[],
  modelElement: string,
): ResolvedReferent {
  const resolution = resolveSymbol(db, ref);
  const match = resolution.match ?? (ref.includes('#') ? resolveSymbol(db, ref.replace('#', '/')).match : null);
  if (resolution.match && resolution.total > 1 && !isQualifiedReferent(ref)) {
    findings.push(
      finding('ambiguous-referent', 'warning', 'compiler-symbol', {
        modelElement,
        codeRef: ref,
        file: resolution.match.relativePath,
        startLine: resolution.match.startLine,
        endLine: resolution.match.endLine,
        message: `Mapping referent ${ref} resolved ambiguously to ${shortenSymbol(resolution.match.symbol)}.`,
        why: [
          `${resolution.total} indexed definitions share this lookup shape.`,
          alternatesText(resolution.candidates),
        ].filter(Boolean),
        remediation: `Qualify ${ref} with a path or fuller symbol name so the mapping cannot drift to another definition.`,
      }),
    );
  }
  return { ref, match };
}

function isQualifiedReferent(ref: string): boolean {
  return /[/#:]/.test(ref);
}

function alternatesText(candidates: readonly { shortName: string; relativePath: string; startLine: number }[]): string {
  if (candidates.length === 0) return '';
  return `Other candidates: ${candidates
    .slice(0, 3)
    .map((candidate) => `${candidate.shortName} at ${candidate.relativePath}:${candidate.startLine + 1}`)
    .join(', ')}.`;
}

function validateVariableReferentKind(
  db: ScipDatabase,
  variable: string,
  ref: string,
  match: SymbolMatch,
  findings: TlaConformanceFinding[],
): void {
  const kind = symbolKind(db, match);
  if (kind === null || VALUE_LIKE_KINDS.has(kind)) return;
  const isType = TYPE_LIKE_KINDS.has(kind);
  findings.push(
    finding('invalid-referent-kind', 'error', 'compiler-symbol', {
      modelElement: variable,
      codeRef: ref,
      file: match.relativePath,
      startLine: match.startLine,
      endLine: match.endLine,
      message: isType
        ? `TLA+ variable ${variable} referent is a type; map the runtime state it describes.`
        : `TLA+ variable ${variable} referent is ${scipKindName(kind)}; map the runtime state it describes.`,
      why: [`${ref} resolves to ${shortenSymbol(match.symbol)} with SCIP kind ${scipKindName(kind)}.`],
      remediation: `Map variables.${variable}.code to a value-like symbol such as a const, let, field, or property that holds runtime state.`,
    }),
  );
}

function validateActionReferentKind(
  db: ScipDatabase,
  action: string,
  ref: string,
  match: SymbolMatch,
  findings: TlaConformanceFinding[],
): void {
  const kind = symbolKind(db, match);
  if (kind === null || FUNCTION_LIKE_KINDS.has(kind)) return;
  if (!TYPE_LIKE_KINDS.has(kind)) return;
  findings.push(
    finding('invalid-referent-kind', 'error', 'compiler-symbol', {
      modelElement: action,
      codeRef: ref,
      file: match.relativePath,
      startLine: match.startLine,
      endLine: match.endLine,
      message: `TLA+ action ${action} referent is a type; map the runtime transition code it describes.`,
      why: [`${ref} resolves to ${shortenSymbol(match.symbol)} with SCIP kind ${scipKindName(kind)}.`],
      remediation: `Map actions.${action}.code to a function or method that performs the transition.`,
    }),
  );
}

function symbolKind(db: ScipDatabase, match: SymbolMatch): number | null {
  const row = db.get<{ kind: number | null }>('SELECT kind FROM global_symbols WHERE id = ?', match.symbolId);
  return row?.kind ?? null;
}

function enclosingSymbolForLine(db: ScipDatabase, file: string, line: number): SymbolMatch | null {
  const definitions = getDefinitionsForFile(db, file)
    .filter((definition) => definition.startLine <= line && definition.endLine >= line)
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine));
  return definitions[0] ?? null;
}

function aliasMatchesTarget(alias: string, target: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(alias)}([^A-Za-z0-9_$]|$)`).test(target);
}

function changedTraceVariables(step: TlaTraceStep): string[] {
  if (!step.before || !step.after) return [];
  const keys = new Set([...Object.keys(step.before), ...Object.keys(step.after)]);
  return [...keys].filter((key) => JSON.stringify(step.before?.[key]) !== JSON.stringify(step.after?.[key]));
}

function uniqueWrites(writes: readonly TlaStaticWrite[]): TlaStaticWrite[] {
  const seen = new Set<string>();
  const out: TlaStaticWrite[] = [];
  for (const write of writes) {
    const key = `${write.variable}:${write.file}:${write.line}:${write.target}:${write.enclosingSymbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(write);
  }
  return out;
}

function uniqueReads(reads: readonly TlaStaticRead[]): TlaStaticRead[] {
  const seen = new Set<string>();
  const out: TlaStaticRead[] = [];
  for (const read of reads) {
    const key = `${read.variable}:${read.file}:${read.line}:${read.target}:${read.enclosingSymbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(read);
  }
  return out;
}

function dedupeAliases(aliases: readonly VariableAlias[]): VariableAlias[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    const key = `${alias.variable}:${alias.alias}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolvedCount(referents: readonly ResolvedReferent[]): number {
  return referents.filter((referent) => referent.match).length;
}

function isFactWaived(action: ResolvedAction, kind: 'read' | 'write', variable: string): boolean {
  const waived = kind === 'read' ? action.mapping.waive?.reads : action.mapping.waive?.writes;
  return Boolean(waived?.includes(variable));
}

function waiverUses(contract: TlaModelContract): TlaWaiverUse[] {
  return Object.entries(contract.actions).flatMap(([action, mapping]) => {
    const waive = mapping.waive;
    if (!waive) return [];
    return [
      ...(waive.reads ?? []).map((variable) => ({
        action,
        kind: 'read' as const,
        variable,
        reason: waive.reason,
        legacy: waive.legacy === true,
      })),
      ...(waive.writes ?? []).map((variable) => ({
        action,
        kind: 'write' as const,
        variable,
        reason: waive.reason,
        legacy: waive.legacy === true,
      })),
    ];
  });
}

const TYPE_LIKE_KINDS = new Set(scipTypeLikeKindNumbers());
const FUNCTION_LIKE_KINDS = new Set(scipFunctionLikeKindNumbers());
const VALUE_LIKE_KINDS = new Set(scipValueLikeKindNumbers());

function finding(
  category: TlaConformanceFinding['category'],
  severity: TlaFindingSeverity,
  evidence: TlaFindingEvidence,
  fields: Omit<TlaConformanceFinding, 'id' | 'category' | 'severity' | 'evidence'>,
): TlaConformanceFinding {
  const idInput = JSON.stringify({ category, evidence, ...fields });
  return {
    id: `TLA${createHash('sha1').update(idInput).digest('hex').slice(0, 10).toUpperCase()}`,
    category,
    severity,
    evidence,
    ...fields,
  };
}
