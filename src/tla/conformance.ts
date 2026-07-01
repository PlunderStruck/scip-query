import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import type { SymbolMatch } from '../domain/types.js';
import { getAst } from '../source/ast.js';
import type { SyntaxNode } from '../source/ast.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { getDefinitionsForFile } from '../symbols/definition-catalog.js';
import { leafName, shortenSymbol } from '../symbols/symbol-parser.js';
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
    | 'unmapped-write'
    | 'undeclared-write'
    | 'missing-write-evidence'
    | 'missing-call'
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
  traceStepsChecked: number;
  findings: TlaConformanceFinding[];
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

interface VariableAlias {
  variable: string;
  alias: string;
}

interface TlaStaticWrite {
  variable: string;
  alias: string;
  file: string;
  line: number;
  target: string;
  kind: 'assignment' | 'mutation-call' | 'update' | 'delete' | 'source-scan';
  enclosingSymbol?: string;
  enclosingShort?: string;
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
): TlaConformanceResult {
  const findings: TlaConformanceFinding[] = [];
  const variableAliases = aliasesForVariables(db, contract, findings);
  const actions = resolveActions(db, contract, findings);
  if (moduleFacts) verifyModelText(contract, moduleFacts, findings);

  const actionSymbols = new Set(
    actions.flatMap((action) => action.referents.map((referent) => referent.match?.symbol).filter(Boolean) as string[]),
  );
  const staticWrites = collectAllStaticWrites(db, contract, actions, variableAliases, actionSymbols, findings);
  verifyDeclaredCalls(db, actions, findings);
  verifyTraces(contract, traceSteps, findings);

  return {
    modelVariables: moduleFacts?.variables ?? [],
    modelOperators: moduleFacts?.operators ?? [],
    mappedVariables: Object.keys(contract.variables).length,
    mappedActions: Object.keys(contract.actions).length,
    resolvedReferents:
      resolvedCount(actions.flatMap((action) => action.referents)) +
      resolvedCount(
        Object.values(contract.variables).flatMap((variable) =>
          variable.code.map((ref) => ({ ref, match: resolveReferent(db, ref) })),
        ),
      ),
    staticWrites,
    traceStepsChecked: traceSteps.length,
    findings,
  };
}

function aliasesForVariables(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): VariableAlias[] {
  const aliases: VariableAlias[] = [];
  for (const [name, variable] of Object.entries(contract.variables)) {
    const variableAliases = new Set(variable.aliases);
    for (const ref of variable.code) {
      const match = resolveReferent(db, ref);
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
      variableAliases.add(leafName(match.symbol));
    }
    for (const alias of variableAliases) aliases.push({ variable: name, alias });
  }
  return dedupeAliases(aliases);
}

function resolveActions(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): ResolvedAction[] {
  return Object.entries(contract.actions).map(([name, mapping]) => {
    const referents = mapping.code.map((ref) => {
      const match = resolveReferent(db, ref);
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
      }
      return { ref, match };
    });
    return { name, mapping, referents };
  });
}

function verifyModelText(
  contract: TlaModelContract,
  moduleFacts: TlaModuleFacts,
  findings: TlaConformanceFinding[],
): void {
  const variables = new Set(moduleFacts.variables);
  const operators = new Set(moduleFacts.operators);
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

  for (const file of scopedFiles(db, contract, actions)) {
    for (const write of collectWritesForRange(db, file, 0, Number.POSITIVE_INFINITY, aliases)) {
      writes.push(write);
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
    if (!observed.has(variable) && !action.mapping.allowUnknown) {
      findings.push(
        finding('missing-write-evidence', 'warning', 'unknown', {
          modelElement: action.name,
          message: `TLA+ action ${action.name} declares a write to ${variable}, but no direct source write was found.`,
          why: [
            'The write may happen through an alias, callback, dependency, or runtime side effect that static scanning could not prove.',
          ],
          remediation: `Add a more precise variable alias, add the write sink as a mapped action referent, provide a trace, or mark actions.${action.name}.allowUnknown when this uncertainty is intentional.`,
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
    const expected = action.mapping.calls.map((ref) => ({ ref, match: resolveReferent(db, ref) }));
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

function collectWritesForRange(
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

function scopedFiles(db: ScipDatabase, contract: TlaModelContract, actions: readonly ResolvedAction[]): string[] {
  const scopes =
    contract.scope.length > 0
      ? contract.scope
      : [
          ...new Set(
            actions.flatMap((action) => action.referents.map((r) => r.match?.relativePath).filter(Boolean) as string[]),
          ),
        ];
  if (scopes.length === 0) return [];
  const rows = db.all<{ relative_path: string }>(`SELECT relative_path FROM documents ORDER BY relative_path`);
  return rows.map((row) => row.relative_path).filter((file) => scopes.some((scope) => file.includes(scope)));
}

function resolveReferent(db: ScipDatabase, ref: string): SymbolMatch | null {
  const direct = findFirstSymbolMatch(db, ref);
  if (direct) return direct;
  if (ref.includes('#')) {
    const pathQualified = findFirstSymbolMatch(db, ref.replace('#', '/'));
    if (pathQualified) return pathQualified;
  }
  return null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
