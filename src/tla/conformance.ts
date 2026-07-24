import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import type { SymbolMatch } from '../domain/types.js';
import { getAst } from '../source/ast.js';
import type { SyntaxNode } from '../source/ast.js';
import { escapeRegex as escapeRegExp } from '../source/primitives/regex-utils.js';
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
import {
  ormCallEffectiveMethods,
  parseCodeRefWindow,
  type TlaInitMapping,
  type TlaModelContract,
  type TlaModuleFacts,
  type TlaTraceStep,
} from './model-contract.js';
import type { SanyActionFacts } from './sany-facts.js';

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
    | 'invalid-line-window'
    | 'unmapped-write'
    | 'undeclared-write'
    | 'missing-write-evidence'
    | 'undeclared-read'
    | 'missing-read-evidence'
    | 'missing-call'
    | 'missing-invariant'
    | 'model-mapping-read'
    | 'model-mapping-write'
    | 'model-code-read'
    | 'model-code-write'
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

/**
 * Root-cause rollup of `findings`, grouped by (category, modelElement) —
 * the shape mirrors DiffGateRootCauseGroup (src/queries/impact/diff-gate.ts)
 * so agents reading both surfaces see the same grouping contract. At Vega
 * scale a single model produced 10,724 raw findings from a handful of root
 * causes; this is the summary a human/agent should read first.
 */
export interface TlaFindingGroup {
  groupKey: string;
  category: TlaConformanceFinding['category'];
  modelElement?: string;
  severity: TlaFindingSeverity;
  count: number;
  findingIds: string[];
}

// scip-query: ignore-stale — reviewed S1 owned contract; conformance evaluation returns this named result.
export interface TlaConformanceResult {
  modelParse: TlaModuleFacts['modelParse'] | 'unavailable';
  modelVariables: string[];
  modelOperators: string[];
  modelActionFacts: SanyActionFacts[];
  mappedVariables: number;
  mappedActions: number;
  resolvedReferents: number;
  staticWrites: TlaStaticWrite[];
  staticReads: TlaStaticRead[];
  waivers: TlaWaiverUse[];
  checkedInvariants: string[];
  traceStepsChecked: number;
  findings: TlaConformanceFinding[];
  /** Summary rollup of `findings`; JSON keeps `findings` uncapped too. */
  findingGroups: TlaFindingGroup[];
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

/** Q3 / Init-binding: resolved `contract.init` referents. */
interface ResolvedInit {
  mapping: TlaInitMapping;
  referents: ResolvedReferent[];
}

interface ResolvedReferent {
  ref: string;
  match: SymbolMatch | null;
  /**
   * C3 / line-range codeRefs: the resolved sub-range (0-based, matching
   * `SymbolMatch.startLine`/`endLine`) when this referent's codeRef named
   * an `@L<start>-L<end>` window AND it validated inside `match`'s span.
   * Absent when no window was requested, OR when one was requested but
   * failed containment (in that case `match` is nulled out too — see
   * `resolveActions` — so the referent contributes no facts at all rather
   * than silently falling back to the whole function).
   */
  window?: { startLine: number; endLine: number };
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
  kind:
    | 'assignment'
    | 'declaration'
    | 'object-field'
    | 'mutation-call'
    | 'update'
    | 'delete'
    | 'source-scan'
    | 'resource'
    | 'statement'
    | 'orm-call';
  enclosingSymbol?: string;
  enclosingShort?: string;
  /**
   * Set when this write was found not in the mapped action's own referent
   * range but one call hop away (P5.4 / followup #14) — the callee's
   * shortName the write was attributed through. Absent for direct evidence.
   */
  via?: string;
}

export interface TlaStaticRead {
  variable: string;
  alias: string;
  file: string;
  line: number;
  target: string;
  kind: 'identifier' | 'source-scan' | 'resource' | 'statement' | 'orm-call';
  enclosingSymbol?: string;
  enclosingShort?: string;
  /** See `TlaStaticWrite.via`. */
  via?: string;
}

/** A variable bound to filesystem state via `variables.<v>.resource`. */
export interface VariableResource {
  variable: string;
  path: string;
}

/**
 * A variable bound to SQL-backed state via `variables.<v>.statements`
 * (Q2 / statement-alias tier). `regex` is `pattern` compiled once per
 * conformance run — `loadTlaModelContract` already validated it compiles.
 */
export interface VariableStatement {
  variable: string;
  pattern: string;
  regex: RegExp;
}

/**
 * C1 / ORM-call tier: a resolved `variables.<v>.ormCalls` entry — method
 * names already split into their effective write/read buckets (defaults or
 * the entry's `methods` override) by `ormCallEffectiveMethods`.
 */
export interface VariableOrmCall {
  variable: string;
  table: string;
  writeMethods: ReadonlySet<string>;
  readMethods: ReadonlySet<string>;
}

export interface TlaWaiverUse {
  /** Absent for variable-referent waivers (P5.2), which are not action-scoped. */
  action?: string;
  kind: 'read' | 'write' | 'referent';
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

/**
 * Filesystem calls classified as writes/reads of a `resource`-bound
 * variable (P5.1 / followup #13). Matching is textual: the call's first
 * argument text must contain the resource's declared path expression or
 * suffix — evidence tier stays `static-action`, never a stronger tier,
 * because this is not a resolved value comparison.
 */
const FS_WRITE_CALLS = new Set(['writeFileSync', 'rmSync', 'renameSync', 'mkdirSync', 'unlinkSync']);
const FS_READ_CALLS = new Set(['readFileSync', 'existsSync', 'statSync']);

/**
 * Q2 / statement-alias tier: leading-verb classification of a matched SQL
 * statement's static text. Checked against the start of the text (after
 * whitespace) so `'INSERT OR REPLACE INTO ...'` classifies as a write from
 * its leading INSERT, not ambiguously from the later REPLACE keyword.
 */
const SQL_WRITE_VERB = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const SQL_READ_VERB = /^\s*SELECT\b/i;

function classifySqlVerb(text: string): 'write' | 'read' | null {
  if (SQL_WRITE_VERB.test(text)) return 'write';
  if (SQL_READ_VERB.test(text)) return 'read';
  return null;
}

/**
 * I4 / followup #26: matches a `const`/`let`/`var` declaration keyword at
 * the start of a line (module scope or indented), used by the source-scan
 * fallback to mirror the AST path's variable_declarator exclusion — see
 * `isDeclarationLine`.
 */
const DECLARATION_KEYWORD = /^\s*(?:export\s+)?(?:const|let|var)\s+/;

/**
 * True when `text` declares a fresh local binding named `alias` (a
 * `const`/`let`/`var` declaration whose declared identifier is `alias`,
 * with or without an initializer) — mirrors the AST path's
 * `variable_declarator` exclusion for the source-scan fallback, which has
 * no node-level declarator of its own to inspect. Only the declaration's
 * own line is excluded this way; a later plain assignment to the same name
 * is untouched by this check.
 */
function isDeclarationLine(text: string, alias: string): boolean {
  const keywordMatch = text.match(DECLARATION_KEYWORD);
  if (!keywordMatch) return false;
  const afterKeyword = text.slice(keywordMatch[0].length);
  return new RegExp(`^${escapeRegExp(alias)}\\b`).test(afterKeyword);
}

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
  const variableResources = resourcesForVariables(contract);
  const variableStatements = statementsForVariables(contract);
  const variableOrms = ormCallsForVariables(contract);
  const actions = resolveActions(db, contract, findings);
  const init = resolveInit(db, contract, findings);
  if (moduleFacts) verifyModelText(contract, moduleFacts, checkedInvariants, findings);
  const modelActions = new Map((moduleFacts?.actions ?? []).map((action) => [action.name, action]));

  const actionSymbols = new Set(
    actions.flatMap((action) => action.referents.map((referent) => referent.match?.symbol).filter(Boolean) as string[]),
  );
  // Q3: writes found inside an Init referent are Init-attributed, not
  // unmapped — excluded from the sweep the same way a mapped action's own
  // referent is, without needing unmappedWriteScope: "actions" as a
  // whole-file workaround.
  const initSymbols = new Set(
    (init?.referents ?? []).map((referent) => referent.match?.symbol).filter(Boolean) as string[],
  );
  const staticWrites = collectAllStaticWrites(
    db,
    contract,
    actions,
    variableAliases,
    variableResources,
    variableStatements,
    variableOrms,
    actionSymbols,
    initSymbols,
    findings,
    modelActions,
  );
  const staticReads = collectAllStaticReads(
    db,
    actions,
    variableAliases,
    variableResources,
    variableStatements,
    variableOrms,
    findings,
    modelActions,
  );
  verifyDeclaredCalls(db, actions, findings);
  verifyTraces(contract, traceSteps, findings);

  return {
    modelParse: moduleFacts?.modelParse ?? 'unavailable',
    modelVariables: moduleFacts?.variables ?? [],
    modelOperators: moduleFacts?.operators ?? [],
    modelActionFacts: moduleFacts?.actions ?? [],
    mappedVariables: Object.keys(contract.variables).length,
    mappedActions: Object.keys(contract.actions).length,
    resolvedReferents:
      resolvedCount(actions.flatMap((action) => action.referents)) +
      resolvedCount(variableResolution.referents) +
      resolvedCount(init?.referents ?? []),
    staticWrites,
    staticReads,
    waivers: waiverUses(contract),
    checkedInvariants: [...checkedInvariants],
    traceStepsChecked: traceSteps.length,
    findings,
    findingGroups: tlaFindingGroups(findings),
  };
}

export function tlaFindingGroups(findings: readonly TlaConformanceFinding[]): TlaFindingGroup[] {
  const groups = new Map<string, TlaFindingGroup>();
  for (const finding of findings) {
    const groupKey = `${finding.category}:${finding.modelElement ?? '-'}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        category: finding.category,
        modelElement: finding.modelElement,
        severity: finding.severity,
        count: 0,
        findingIds: [],
      };
      groups.set(groupKey, group);
    }
    group.count += 1;
    group.findingIds.push(finding.id);
    group.severity = strongerTlaSeverity(group.severity, finding.severity);
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.count - left.count ||
      tlaSeverityRank(right.severity) - tlaSeverityRank(left.severity) ||
      left.groupKey.localeCompare(right.groupKey),
  );
}

function strongerTlaSeverity(left: TlaFindingSeverity, right: TlaFindingSeverity): TlaFindingSeverity {
  return tlaSeverityRank(right) > tlaSeverityRank(left) ? right : left;
}

function tlaSeverityRank(severity: TlaFindingSeverity): number {
  return severity === 'error' ? 2 : severity === 'warning' ? 1 : 0;
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function aliasesForVariables(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): VariableResolution {
  const aliases: VariableAlias[] = [];
  const referents: ResolvedReferent[] = [];
  for (const [name, variable] of Object.entries(contract.variables)) {
    const variableAliases = new Set(variable.aliases);
    const waived = Boolean(variable.waive);
    for (const ref of variable.code) {
      const referent = resolveReferent(db, ref, findings, name);
      referents.push(referent);
      const match = referent.match;
      if (!match) {
        if (!waived) {
          findings.push(
            finding('missing-referent', 'error', 'compiler-symbol', {
              modelElement: name,
              codeRef: ref,
              message: `TLA+ variable ${name} maps to missing TypeScript referent ${ref}.`,
              why: ['The mapping contract must point at live compiler-indexed code before conformance can be checked.'],
              remediation: `Update variables.${name}.code to a live symbol, or remove the variable from the model mapping.`,
            }),
          );
        }
        continue;
      }
      validateVariableReferentKind(db, name, ref, match, findings, waived);
      if (variable.aliases.length === 0) variableAliases.add(leafName(match.symbol));
    }
    for (const alias of variableAliases) aliases.push({ variable: name, alias });
  }
  return { aliases: dedupeAliases(aliases), referents };
}

function resourcesForVariables(contract: TlaModelContract): VariableResource[] {
  const resources: VariableResource[] = [];
  for (const [name, variable] of Object.entries(contract.variables)) {
    if (variable.resource) resources.push({ variable: name, path: variable.resource.path });
  }
  return resources;
}

function statementsForVariables(contract: TlaModelContract): VariableStatement[] {
  const statements: VariableStatement[] = [];
  for (const [name, variable] of Object.entries(contract.variables)) {
    for (const statement of variable.statements ?? []) {
      statements.push({ variable: name, pattern: statement.pattern, regex: new RegExp(statement.pattern) });
    }
  }
  return statements;
}

function ormCallsForVariables(contract: TlaModelContract): VariableOrmCall[] {
  const orms: VariableOrmCall[] = [];
  for (const [name, variable] of Object.entries(contract.variables)) {
    for (const binding of variable.ormCalls ?? []) {
      const { write, read } = ormCallEffectiveMethods(binding);
      orms.push({ variable: name, table: binding.table, writeMethods: new Set(write), readMethods: new Set(read) });
    }
  }
  return orms;
}

/**
 * P5.4 / followup #14: writes/reads one call hop away from a mapped
 * action's referent are statically invisible per-range (e.g. the
 * preemption path's lock-release write happens inside a callee, not
 * textually inside the mapped function). Include a callee's own effects —
 * one level only, no recursion into the callee's own callees — attributed
 * to the action via the `via` marker. Evidence tier stays `static-action`.
 */
function oneHopCalleeWrites(
  db: ScipDatabase,
  referentSymbol: string,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[],
  statements: readonly VariableStatement[],
  orms: readonly VariableOrmCall[],
): TlaStaticWrite[] {
  return oneHopCalleeEffects(db, referentSymbol, (file, startLine, endLine) =>
    collectWritesForRange(db, file, startLine, endLine, aliases, resources, statements, orms),
  );
}

function oneHopCalleeReads(
  db: ScipDatabase,
  referentSymbol: string,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[],
  statements: readonly VariableStatement[],
  orms: readonly VariableOrmCall[],
): TlaStaticRead[] {
  return oneHopCalleeEffects(db, referentSymbol, (file, startLine, endLine) =>
    collectReadsForRange(db, file, startLine, endLine, aliases, resources, statements, orms),
  );
}

function oneHopCalleeEffects<T extends { via?: string }>(
  db: ScipDatabase,
  referentSymbol: string,
  collect: (file: string, startLine: number, endLine: number) => T[],
): T[] {
  // semantic: false — restrict to precise AST-callsite/SCIP-mention call
  // edges. The heuristic semantic-callee tier (dataflow/type-inference
  // based) is too broad for a one-hop rule meant to stay "static-action"
  // evidence: it pulled in unrelated same-shaped-alias writes from files
  // the referent never actually calls into.
  const graph = callGraph(db, referentSymbol, { semantic: false });
  if (!graph) return [];
  const effects: T[] = [];
  const seenCallees = new Set<string>();
  for (const callee of graph.callees) {
    if (seenCallees.has(callee.symbol)) continue;
    seenCallees.add(callee.symbol);
    const match = resolveSymbol(db, callee.symbol).match;
    if (!match) continue;
    for (const effect of collect(match.relativePath, match.startLine, match.endLine)) {
      effects.push({ ...effect, via: callee.shortName });
    }
  }
  return effects;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function resolveActions(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): ResolvedAction[] {
  return Object.entries(contract.actions).map(([name, mapping]) => {
    const referents = mapping.code.map((raw): ResolvedReferent => {
      // C3: strip an optional `@L<start>-L<end>` window before symbol
      // lookup — `loadTlaModelContract` already rejected malformed window
      // syntax, so `parsed` only carries `{ error }` here in the
      // (unreachable in practice) case of a contract built by hand rather
      // than loaded, in which case the raw text is used as-is and will
      // simply fail to resolve as a symbol.
      const parsed = parseCodeRefWindow(raw);
      const baseRef = 'error' in parsed ? raw : parsed.ref;
      const referent = resolveReferent(db, baseRef, findings, name);
      const match = referent.match;
      if (!match) {
        findings.push(
          finding('missing-referent', 'error', 'compiler-symbol', {
            modelElement: name,
            codeRef: raw,
            message: `TLA+ action ${name} maps to missing TypeScript referent ${raw}.`,
            why: ['The action cannot be compared to code because the mapped symbol did not resolve in the SCIP index.'],
            remediation: `Update actions.${name}.code to a live function or method symbol.`,
          }),
        );
        return { ref: raw, match: null };
      }
      validateActionReferentKind(db, name, raw, match, findings);
      if ('error' in parsed || !parsed.window) return { ref: raw, match };

      // Containment can only be checked now that the referent's actual
      // span is known — a window outside it is a loud verify-time error,
      // never a silent clamp back to the whole function.
      if (windowOutsideSpan(parsed.window, match)) {
        findings.push(
          finding('invalid-line-window', 'error', 'compiler-symbol', {
            modelElement: name,
            codeRef: raw,
            file: match.relativePath,
            startLine: match.startLine,
            endLine: match.endLine,
            message: `TLA+ action ${name} codeRef line window L${parsed.window.startLine}-L${parsed.window.endLine} falls outside ${shortenSymbol(match.symbol)}'s actual span L${match.startLine + 1}-L${match.endLine + 1} in ${match.relativePath}.`,
            why: [
              `${raw} resolves to ${shortenSymbol(match.symbol)} at ${match.relativePath}:${match.startLine + 1}-${match.endLine + 1}.`,
              `The requested window does not fall entirely inside that span.`,
            ],
            remediation: `Update the @L${parsed.window.startLine}-L${parsed.window.endLine} window in actions.${name}.code to fall within L${match.startLine + 1}-L${match.endLine + 1}, or drop the window to cover the whole function.`,
          }),
        );
        return { ref: raw, match: null };
      }

      return {
        ref: raw,
        match,
        window: { startLine: parsed.window.startLine - 1, endLine: parsed.window.endLine - 1 },
      };
    });
    return { name, mapping, referents };
  });
}

function windowOutsideSpan(window: { startLine: number; endLine: number }, match: SymbolMatch): boolean {
  return window.startLine - 1 < match.startLine || window.endLine - 1 > match.endLine;
}

/**
 * Q3 / Init-binding: resolves `contract.init.codeRefs` the same way an
 * action's `code` referents resolve — missing-referent and invalid-
 * referent-kind findings apply, honoring `init.waive` for both, exactly
 * like a variable's `waive` exempts referent-resolution findings.
 */
function resolveInit(
  db: ScipDatabase,
  contract: TlaModelContract,
  findings: TlaConformanceFinding[],
): ResolvedInit | undefined {
  const mapping = contract.init;
  if (!mapping) return undefined;
  const waived = Boolean(mapping.waive);
  const referents = mapping.codeRefs.map((ref) => {
    const referent = resolveReferent(db, ref, findings, 'Init');
    const match = referent.match;
    if (!match) {
      if (!waived) {
        findings.push(
          finding('missing-referent', 'error', 'compiler-symbol', {
            modelElement: 'Init',
            codeRef: ref,
            message: `TLA+ Init maps to missing TypeScript referent ${ref}.`,
            why: ['The Init mapping must point at live compiler-indexed code before conformance can be checked.'],
            remediation: `Update init.codeRefs to a live function or method symbol, or remove the stale entry.`,
          }),
        );
      }
    } else {
      validateInitReferentKind(db, ref, match, findings, waived);
    }
    return referent;
  });
  return { mapping, referents };
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
  for (const action of moduleFacts.actions) {
    const mapping = contract.actions[action.name];
    if (!mapping) continue;
    verifySetAgreement({
      action: action.name,
      field: 'writes',
      modelValues: action.writes,
      mappingValues: mapping.writes,
      missingInMappingCategory: 'model-mapping-write',
      missingInModelCategory: 'model-mapping-write',
      findings,
      file: moduleFacts.path,
      isWaived: (variable) => Boolean(mapping.waive?.writes.includes(variable)),
    });
    verifySetAgreement({
      action: action.name,
      field: 'reads',
      modelValues: action.reads,
      mappingValues: mapping.reads,
      missingInMappingCategory: 'model-mapping-read',
      missingInModelCategory: 'model-mapping-read',
      findings,
      file: moduleFacts.path,
    });
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

function verifySetAgreement(opts: {
  action: string;
  field: 'reads' | 'writes';
  modelValues: readonly string[];
  mappingValues: readonly string[];
  missingInMappingCategory: TlaConformanceFinding['category'];
  missingInModelCategory: TlaConformanceFinding['category'];
  findings: TlaConformanceFinding[];
  file: string;
  /**
   * I1 / followup #23: symmetric with the per-fact action/variable waivers
   * consulted for undeclared-write and missing-write-evidence — a waived
   * write fact must not surface as a model-mapping-write mismatch either.
   * Absent (reads) preserves pre-fix behavior exactly.
   */
  isWaived?: (variable: string) => boolean;
}): void {
  const model = new Set(opts.modelValues);
  const mapping = new Set(opts.mappingValues);
  const isWaived = opts.isWaived ?? (() => false);
  for (const variable of model) {
    if (mapping.has(variable) || isWaived(variable)) continue;
    opts.findings.push(
      finding(opts.missingInMappingCategory, opts.field === 'writes' ? 'error' : 'warning', 'model-text', {
        modelElement: opts.action,
        file: opts.file,
        message: `TLA+ action ${opts.action} ${opts.field === 'writes' ? 'writes' : 'reads'} ${variable}, but the mapping does not declare that ${opts.field.slice(0, -1)}.`,
        why: [`SANY-derived model facts list ${variable} in ${opts.action}.${opts.field}, while the mapping omits it.`],
        remediation: `Add ${variable} to actions.${opts.action}.${opts.field}, or update the TLA+ model if the ${opts.field.slice(0, -1)} is unintended.`,
      }),
    );
  }
  for (const variable of mapping) {
    if (model.has(variable) || isWaived(variable)) continue;
    opts.findings.push(
      finding(opts.missingInModelCategory, opts.field === 'writes' ? 'error' : 'warning', 'model-text', {
        modelElement: opts.action,
        file: opts.file,
        message: `Mapping declares ${opts.action}.${opts.field} includes ${variable}, but the SANY model facts do not.`,
        why: [
          `The mapping says ${opts.action} ${opts.field === 'writes' ? 'writes' : 'reads'} ${variable}, but the parsed TLA+ action does not show that model-side fact.`,
        ],
        remediation: `Update the TLA+ action to ${opts.field === 'writes' ? 'prime' : 'reference'} ${variable}, remove the mapping declaration, or add a waiver if static evidence cannot represent the model boundary.`,
      }),
    );
  }
}

function collectAllStaticWrites(
  db: ScipDatabase,
  contract: TlaModelContract,
  actions: readonly ResolvedAction[],
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[],
  statements: readonly VariableStatement[],
  orms: readonly VariableOrmCall[],
  actionSymbols: ReadonlySet<string>,
  initSymbols: ReadonlySet<string>,
  findings: TlaConformanceFinding[],
  modelActions: ReadonlyMap<string, SanyActionFacts>,
): TlaStaticWrite[] {
  const writes: TlaStaticWrite[] = [];
  for (const action of actions) {
    const actionWrites: TlaStaticWrite[] = [];
    for (const referent of action.referents) {
      if (!referent.match) continue;
      // C3: a codeRef line window scopes fact collection to the
      // sub-range instead of the referent's whole resolved span, so
      // sibling guard/branch actions sharing one function each claim
      // only their own branch's writes.
      const range = referent.window ?? { startLine: referent.match.startLine, endLine: referent.match.endLine };
      const found = collectWritesForRange(
        db,
        referent.match.relativePath,
        range.startLine,
        range.endLine,
        aliases,
        resources,
        statements,
        orms,
      );
      actionWrites.push(...found);
      writes.push(...found);
      // Only credit a one-hop callee write toward a variable this action
      // already declares — a callee shared by several actions (e.g. an
      // unconditional setup call) must never assert a NEW, undeclared fact
      // for an action that doesn't own it; it may only strengthen evidence
      // for a fact the mapping already claims.
      const declaredWrites = new Set(action.mapping.writes);
      const oneHop = oneHopCalleeWrites(db, referent.match.symbol, aliases, resources, statements, orms).filter(
        (write) => declaredWrites.has(write.variable),
      );
      actionWrites.push(...oneHop);
      writes.push(...oneHop);
    }
    verifyActionWrites(action, actionWrites, findings, modelActions.get(action.name));
  }

  // P5.7 / followup #19: 'actions' opts out of the whole-scope-file sweep —
  // only the per-action write/read checks above run. 'scope-files' (default)
  // preserves the original behavior: every touching function anywhere in
  // `scope` must be mapped as an action or its write is flagged.
  const sweepFiles = contract.unmappedWriteScope === 'actions' ? [] : scopedFiles(db, contract);
  for (const file of sweepFiles) {
    for (const write of collectWritesForRange(
      db,
      file,
      0,
      Number.POSITIVE_INFINITY,
      aliases,
      resources,
      statements,
      orms,
    )) {
      writes.push(write);
      if (!isUnmappedWriteCandidate(write)) continue;
      // Q3: a write inside a mapped Init referent is Init-attributed, not
      // unmapped — same exclusion as a mapped action's own referent.
      if (write.enclosingSymbol && (actionSymbols.has(write.enclosingSymbol) || initSymbols.has(write.enclosingSymbol)))
        continue;
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
  modelAction: SanyActionFacts | undefined,
): void {
  const declared = new Set(action.mapping.writes);
  const observed = new Set(writes.map((write) => write.variable));
  const modeled = new Set(modelAction?.writes ?? []);
  for (const write of writes) {
    if (modelAction && !modeled.has(write.variable) && !isFactWaived(action, 'write', write.variable)) {
      findings.push(
        finding('model-code-write', 'error', 'static-action', {
          modelElement: action.name,
          codeRef: write.enclosingSymbol ?? `${write.file}:${write.line + 1}`,
          file: write.file,
          startLine: write.line,
          endLine: write.line,
          message: `Code for TLA+ action ${action.name} writes ${write.variable}, but the SANY model action does not prime it.`,
          why: [
            `The code writes ${write.target} at ${write.file}:${write.line + 1}${viaSuffix(write.via)}.`,
            `SANY-derived model facts for ${action.name} list writes: ${modelAction.writes.join(', ') || 'none'}.`,
          ],
          remediation: `Prime ${write.variable} in the TLA+ action, remove the code write from this action, or remap the code to the correct action.`,
        }),
      );
    }
    if (!declared.has(write.variable) && !isFactWaived(action, 'write', write.variable)) {
      findings.push(
        finding('undeclared-write', 'error', 'static-action', {
          modelElement: action.name,
          codeRef: write.enclosingSymbol ?? `${write.file}:${write.line + 1}`,
          file: write.file,
          startLine: write.line,
          endLine: write.line,
          message: `TLA+ action ${action.name} writes modeled variable ${write.variable}, but the mapping does not declare that write.`,
          why: [`The code writes ${write.target} at ${write.file}:${write.line + 1}${viaSuffix(write.via)}.`],
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
  resources: readonly VariableResource[],
  statements: readonly VariableStatement[],
  orms: readonly VariableOrmCall[],
  findings: TlaConformanceFinding[],
  modelActions: ReadonlyMap<string, SanyActionFacts>,
): TlaStaticRead[] {
  const reads: TlaStaticRead[] = [];
  for (const action of actions) {
    const actionReads: TlaStaticRead[] = [];
    for (const referent of action.referents) {
      if (!referent.match) continue;
      // C3: see the matching comment in collectAllStaticWrites.
      const range = referent.window ?? { startLine: referent.match.startLine, endLine: referent.match.endLine };
      const found = collectReadsForRange(
        db,
        referent.match.relativePath,
        range.startLine,
        range.endLine,
        aliases,
        resources,
        statements,
        orms,
      );
      actionReads.push(...found);
      reads.push(...found);
      // Same declared-fact constraint as the write path — see the comment
      // in collectAllStaticWrites.
      const declaredReads = new Set(action.mapping.reads);
      const oneHop = oneHopCalleeReads(db, referent.match.symbol, aliases, resources, statements, orms).filter((read) =>
        declaredReads.has(read.variable),
      );
      actionReads.push(...oneHop);
      reads.push(...oneHop);
    }
    verifyActionReads(action, actionReads, findings, modelActions.get(action.name));
  }
  return uniqueReads(reads);
}

function verifyActionReads(
  action: ResolvedAction,
  reads: readonly TlaStaticRead[],
  findings: TlaConformanceFinding[],
  modelAction: SanyActionFacts | undefined,
): void {
  const declared = new Set(action.mapping.reads);
  const observed = new Set(reads.map((read) => read.variable));
  const modeled = new Set(modelAction?.reads ?? []);
  for (const read of reads) {
    if (modelAction && !modeled.has(read.variable)) {
      findings.push(
        finding('model-code-read', 'warning', 'static-action', {
          modelElement: action.name,
          codeRef: read.enclosingSymbol ?? `${read.file}:${read.line + 1}`,
          file: read.file,
          startLine: read.line,
          endLine: read.line,
          message: `Code for TLA+ action ${action.name} reads ${read.variable}, but the SANY model action does not reference it.`,
          why: [
            `The code reads ${read.target} at ${read.file}:${read.line + 1}${viaSuffix(read.via)}.`,
            `SANY-derived model facts for ${action.name} list reads: ${modelAction.reads.join(', ') || 'none'}.`,
          ],
          remediation: `Reference ${read.variable} in the TLA+ action, remove the code read from this action, or remap the code to the correct action.`,
        }),
      );
    }
    if (!declared.has(read.variable) && !isFactWaived(action, 'read', read.variable)) {
      findings.push(
        finding('undeclared-read', 'warning', 'static-action', {
          modelElement: action.name,
          codeRef: read.enclosingSymbol ?? `${read.file}:${read.line + 1}`,
          file: read.file,
          startLine: read.line,
          endLine: read.line,
          message: `TLA+ action ${action.name} reads modeled variable ${read.variable}, but the mapping does not declare that read.`,
          why: [`The code reads ${read.target} at ${read.file}:${read.line + 1}${viaSuffix(read.via)}.`],
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
  resources: readonly VariableResource[] = [],
  statements: readonly VariableStatement[] = [],
  orms: readonly VariableOrmCall[] = [],
): TlaStaticWrite[] {
  const astWrites = collectAstWrites(db, file, startLine, endLine, aliases, resources, statements, orms);
  if (astWrites) return astWrites;
  return collectSourceScanWrites(db, file, startLine, endLine, aliases, resources, statements, orms);
}

export function collectReadsForRange(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[] = [],
  statements: readonly VariableStatement[] = [],
  orms: readonly VariableOrmCall[] = [],
): TlaStaticRead[] {
  const astReads = collectAstReads(db, file, startLine, endLine, aliases, resources, statements, orms);
  if (astReads) return astReads;
  return collectSourceScanReads(db, file, startLine, endLine, aliases, resources, statements, orms);
}

// scip-query: ignore-similar — read and write collectors intentionally classify opposite effects.
export function collectAstWrites(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[] = [],
  statements: readonly VariableStatement[] = [],
  orms: readonly VariableOrmCall[] = [],
): TlaStaticWrite[] | null {
  const tree = getAst(db, file);
  if (!tree) return null;
  const writes: TlaStaticWrite[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.startPosition.row > endLine || node.endPosition.row < startLine) return;
    recordWriteNode(db, file, node, aliases, writes);
    recordResourceCallNode(db, file, node, resources, 'write', writes);
    recordStatementCallNode(db, file, node, statements, 'write', writes);
    recordOrmCallNode(db, file, node, orms, 'write', writes);
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return uniqueWrites(writes);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function collectAstReads(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[] = [],
  statements: readonly VariableStatement[] = [],
  orms: readonly VariableOrmCall[] = [],
): TlaStaticRead[] | null {
  const tree = getAst(db, file);
  if (!tree) return null;
  const reads: TlaStaticRead[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.startPosition.row > endLine || node.endPosition.row < startLine) return;
    recordReadNode(db, file, node, aliases, reads);
    recordResourceCallNode(db, file, node, resources, 'read', reads);
    recordStatementCallNode(db, file, node, statements, 'read', reads);
    recordOrmCallNode(db, file, node, orms, 'read', reads);
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
    // I4 / followup #26: a `const`/`let`/`var` declarator introduces a new
    // local binding, not a write to modeled state — even when the declared
    // identifier's text happens to equal a variable's alias. Only a later
    // assignment to that binding (a separate assignment_expression node)
    // attributes; the declaration statement itself never does.
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

/**
 * Classifies filesystem calls whose first argument textually names a
 * `resource`-bound variable's path as a write or read of that variable
 * (P5.1 / followup #13). Shared by the AST write and read visitors — `out`
 * is typed per call site via overloads so callers keep precise array types.
 */
function recordResourceCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  resources: readonly VariableResource[],
  mode: 'write',
  out: TlaStaticWrite[],
): void;
function recordResourceCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  resources: readonly VariableResource[],
  mode: 'read',
  out: TlaStaticRead[],
): void;
function recordResourceCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  resources: readonly VariableResource[],
  mode: 'read' | 'write',
  out: (TlaStaticWrite | TlaStaticRead)[],
): void {
  if (resources.length === 0 || node.type !== 'call_expression') return;
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  const callName = target ? fsCallName(target) : null;
  if (!callName) return;
  const relevantCalls = mode === 'write' ? FS_WRITE_CALLS : FS_READ_CALLS;
  if (!relevantCalls.has(callName)) return;
  const args = node.childForFieldName('arguments');
  const firstArg = args?.namedChild(0);
  if (!firstArg) return;
  const argText = firstArg.text;
  for (const resource of resources) {
    if (!argText.includes(resource.path)) continue;
    const enclosing = enclosingSymbolForLine(db, file, node.startPosition.row);
    out.push({
      variable: resource.variable,
      alias: resource.path,
      file,
      line: node.startPosition.row,
      target: `${callName}(${argText})`,
      kind: 'resource',
      enclosingSymbol: enclosing?.symbol,
      enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
    });
  }
}

function fsCallName(target: SyntaxNode): string | null {
  if (target.type === 'identifier') return target.text;
  if (target.type === 'member_expression') {
    const member = target.namedChild(target.namedChildCount - 1);
    return member ? member.text : null;
  }
  return null;
}

/**
 * Q2 / statement-alias tier: classifies a call expression's string-literal
 * or template-literal arguments as a write or read of a statement-bound
 * variable (`variables.<v>.statements`). Unlike `recordResourceCallNode`,
 * this is not restricted to a callee allowlist — SQL execution APIs vary
 * (`.prepare`, `.exec`, `.run`, tagged templates) — so every argument of
 * every call is a candidate; classification comes from the matched text's
 * leading SQL verb, not the callee name.
 */
function recordStatementCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  statements: readonly VariableStatement[],
  mode: 'write',
  out: TlaStaticWrite[],
): void;
function recordStatementCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  statements: readonly VariableStatement[],
  mode: 'read',
  out: TlaStaticRead[],
): void;
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function recordStatementCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  statements: readonly VariableStatement[],
  mode: 'read' | 'write',
  out: (TlaStaticWrite | TlaStaticRead)[],
): void {
  if (statements.length === 0 || node.type !== 'call_expression') return;
  const args = node.childForFieldName('arguments');
  if (!args) return;
  for (const arg of args.namedChildren) {
    const text = staticStringText(arg);
    if (text === null) continue;
    if (classifySqlVerb(text) !== mode) continue;
    for (const statement of statements) {
      if (!statement.regex.test(text)) continue;
      const enclosing = enclosingSymbolForLine(db, file, node.startPosition.row);
      const target = node.childForFieldName('function') ?? node.namedChild(0);
      const callLabel = (target && fsCallName(target)) ?? 'call';
      out.push({
        variable: statement.variable,
        alias: statement.pattern,
        file,
        line: node.startPosition.row,
        target: `${callLabel}(${truncateStatementText(text)})`,
        kind: 'statement',
        enclosingSymbol: enclosing?.symbol,
        enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
      });
    }
  }
}

/**
 * Static text of a string literal (`string`) or template literal
 * (`template_string`) node — the concatenated `string_fragment` children,
 * dropping `${...}` interpolations entirely. Returns null for any other
 * node type (most call arguments are not string-shaped at all).
 */
function staticStringText(node: SyntaxNode): string | null {
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  return node.namedChildren
    .filter((child) => child.type === 'string_fragment')
    .map((child) => child.text)
    .join('');
}

function truncateStatementText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

/**
 * C1 / ORM-call attribution tier: classifies a call expression as a
 * write/read of an ORM-call-bound variable (`variables.<v>.ormCalls`).
 * Matches on the call's own method name (never the receiver — `db`, `tx`,
 * ... are all equally eligible) plus its own first argument's text: a
 * write-classified method (`update`/`insert`/`delete` by default) matches
 * when its own argument names `table` (`db.update(t)`, `tx.insert(t)`); a
 * read-classified method matches the same way, PLUS the special case of a
 * `.from(table)` chain segment standing in for `select` — `.select()`
 * itself carries no table argument, so `db.select().from(t)` attributes on
 * `.from(t)`, not on `.select()`.
 */
function recordOrmCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  orms: readonly VariableOrmCall[],
  mode: 'write',
  out: TlaStaticWrite[],
): void;
function recordOrmCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  orms: readonly VariableOrmCall[],
  mode: 'read',
  out: TlaStaticRead[],
): void;
function recordOrmCallNode(
  db: ScipDatabase,
  file: string,
  node: SyntaxNode,
  orms: readonly VariableOrmCall[],
  mode: 'read' | 'write',
  out: (TlaStaticWrite | TlaStaticRead)[],
): void {
  if (orms.length === 0 || node.type !== 'call_expression') return;
  const target = node.childForFieldName('function') ?? node.namedChild(0);
  const method = target ? fsCallName(target) : null;
  if (!method) return;
  const args = node.childForFieldName('arguments');
  const firstArg = args?.namedChild(0);
  if (!firstArg) return;
  const argText = firstArg.text.trim();
  for (const orm of orms) {
    if (!ormCallMatches(orm, method, argText, mode)) continue;
    const enclosing = enclosingSymbolForLine(db, file, node.startPosition.row);
    out.push({
      variable: orm.variable,
      alias: orm.table,
      file,
      line: node.startPosition.row,
      target: `${method}(${argText})`,
      kind: 'orm-call',
      enclosingSymbol: enclosing?.symbol,
      enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
    });
  }
}

function ormCallMatches(orm: VariableOrmCall, method: string, argText: string, mode: 'read' | 'write'): boolean {
  if (argText !== orm.table) return false;
  if (mode === 'write') return orm.writeMethods.has(method);
  return orm.readMethods.has(method) || (method === 'from' && orm.readMethods.has('select'));
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function collectSourceScanWrites(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[] = [],
  statements: readonly VariableStatement[] = [],
  orms: readonly VariableOrmCall[] = [],
): TlaStaticWrite[] {
  const source = readFileSync(join(db.config.projectRoot, file), 'utf8');
  const lines = source.split(/\r?\n/);
  const writes: TlaStaticWrite[] = [];
  const boundedEnd = Number.isFinite(endLine) ? Math.min(lines.length - 1, endLine) : lines.length - 1;
  for (let line = Math.max(0, startLine); line <= boundedEnd; line += 1) {
    const text = lines[line] ?? '';
    for (const alias of aliases) {
      // I4 / followup #26: mirrors the AST path's variable_declarator
      // exclusion — a `const`/`let`/`var` declaration line introducing a
      // fresh local binding named after the alias is not a write, even
      // though its `<alias> =` text would otherwise match the mutation
      // pattern below identically to a real reassignment.
      if (isDeclarationLine(text, alias.alias)) continue;
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
    recordSourceScanResourceCall(db, file, line, text, resources, FS_WRITE_CALLS, writes);
    recordSourceScanStatementCall(db, file, line, text, statements, 'write', writes);
    recordSourceScanOrmCall(db, file, line, text, orms, 'write', writes);
  }
  return uniqueWrites(writes);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function collectSourceScanReads(
  db: ScipDatabase,
  file: string,
  startLine: number,
  endLine: number,
  aliases: readonly VariableAlias[],
  resources: readonly VariableResource[] = [],
  statements: readonly VariableStatement[] = [],
  orms: readonly VariableOrmCall[] = [],
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
    recordSourceScanResourceCall(db, file, line, text, resources, FS_READ_CALLS, reads);
    recordSourceScanStatementCall(db, file, line, text, statements, 'read', reads);
    recordSourceScanOrmCall(db, file, line, text, orms, 'read', reads);
  }
  return uniqueReads(reads);
}

/**
 * Regex-fallback counterpart of `recordResourceCallNode` for files without
 * an AST (P5.1). Matches `<call>(<argsContainingResourcePath>` anywhere on
 * the line — cruder than the AST path (no argument-boundary parsing) but
 * keeps the same evidence tier and textual-containment contract.
 */
function recordSourceScanResourceCall(
  db: ScipDatabase,
  file: string,
  line: number,
  text: string,
  resources: readonly VariableResource[],
  calls: ReadonlySet<string>,
  out: (TlaStaticWrite | TlaStaticRead)[],
): void {
  if (resources.length === 0) return;
  for (const callName of calls) {
    const callIndex = text.indexOf(`${callName}(`);
    if (callIndex === -1) continue;
    const afterCall = text.slice(callIndex + callName.length);
    for (const resource of resources) {
      if (!afterCall.includes(resource.path)) continue;
      const enclosing = enclosingSymbolForLine(db, file, line);
      out.push({
        variable: resource.variable,
        alias: resource.path,
        file,
        line,
        target: text.trim(),
        kind: 'resource',
        enclosingSymbol: enclosing?.symbol,
        enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
      });
    }
  }
}

/**
 * Regex-fallback counterpart of `recordStatementCallNode` for files without
 * an AST. Cruder than the AST path — no call-argument boundary parsing, and
 * a multi-line template-literal SQL statement whose leading verb is on an
 * earlier line will not classify — but keeps the same evidence tier and
 * pattern-match contract.
 */
function recordSourceScanStatementCall(
  db: ScipDatabase,
  file: string,
  line: number,
  text: string,
  statements: readonly VariableStatement[],
  mode: 'read' | 'write',
  out: (TlaStaticWrite | TlaStaticRead)[],
): void {
  if (statements.length === 0) return;
  if (classifySqlVerb(text) !== mode) return;
  for (const statement of statements) {
    if (!statement.regex.test(text)) continue;
    const enclosing = enclosingSymbolForLine(db, file, line);
    out.push({
      variable: statement.variable,
      alias: statement.pattern,
      file,
      line,
      target: text.trim(),
      kind: 'statement',
      enclosingSymbol: enclosing?.symbol,
      enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
    });
  }
}

/**
 * Regex-fallback counterpart of `recordOrmCallNode` for files without an
 * AST. Cruder than the AST path — no call-argument boundary parsing, so a
 * table argument spanning past the line's first matched close-paren, or a
 * `.from(t)` chained on a later line than its `.select()`, will not
 * classify (the special case only needs `.from(t)` on its own line, which
 * covers the common single-line shapes this fallback targets) — but keeps
 * the same evidence tier and method+table-arg matching contract as the AST
 * path.
 */
function recordSourceScanOrmCall(
  db: ScipDatabase,
  file: string,
  line: number,
  text: string,
  orms: readonly VariableOrmCall[],
  mode: 'read' | 'write',
  out: (TlaStaticWrite | TlaStaticRead)[],
): void {
  if (orms.length === 0) return;
  for (const match of text.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(\s*([^,)\s][^,)]*?)\s*\)/g)) {
    const method = match[1]!;
    const argText = match[2]!.trim();
    for (const orm of orms) {
      if (!ormCallMatches(orm, method, argText, mode)) continue;
      const enclosing = enclosingSymbolForLine(db, file, line);
      out.push({
        variable: orm.variable,
        alias: orm.table,
        file,
        line,
        target: text.trim(),
        kind: 'orm-call',
        enclosingSymbol: enclosing?.symbol,
        enclosingShort: enclosing ? shortenSymbol(enclosing.symbol) : undefined,
      });
    }
  }
}

function scopedFiles(db: ScipDatabase, contract: TlaModelContract): string[] {
  const scopes = contract.scope ?? [];
  if (scopes.length === 0) return [];
  const rows = db.all<{ relative_path: string }>(`SELECT relative_path FROM documents ORDER BY relative_path`);
  return rows.map((row) => row.relative_path).filter((file) => scopes.some((scope) => file.includes(scope)));
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
  waived = false,
): void {
  const kind = symbolKind(db, match);
  if (kind === null || VALUE_LIKE_KINDS.has(kind)) return;
  if (waived) return;
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

function validateInitReferentKind(
  db: ScipDatabase,
  ref: string,
  match: SymbolMatch,
  findings: TlaConformanceFinding[],
  waived: boolean,
): void {
  const kind = symbolKind(db, match);
  if (kind === null || FUNCTION_LIKE_KINDS.has(kind)) return;
  if (waived) return;
  if (!TYPE_LIKE_KINDS.has(kind)) return;
  findings.push(
    finding('invalid-referent-kind', 'error', 'compiler-symbol', {
      modelElement: 'Init',
      codeRef: ref,
      file: match.relativePath,
      startLine: match.startLine,
      endLine: match.endLine,
      message: `TLA+ Init referent is a type; map the runtime initialization code it describes.`,
      why: [`${ref} resolves to ${shortenSymbol(match.symbol)} with SCIP kind ${scipKindName(kind)}.`],
      remediation: `Map init.codeRefs to a function or method that performs the initialization.`,
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

function viaSuffix(via: string | undefined): string {
  return via ? ` (via ${via}, one call hop from the mapped referent)` : '';
}

function isFactWaived(action: ResolvedAction, kind: 'read' | 'write', variable: string): boolean {
  const waived = kind === 'read' ? action.mapping.waive?.reads : action.mapping.waive?.writes;
  return Boolean(waived?.includes(variable));
}

function waiverUses(contract: TlaModelContract): TlaWaiverUse[] {
  const actionWaivers = Object.entries(contract.actions).flatMap(([action, mapping]) => {
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
  const variableWaivers = Object.entries(contract.variables).flatMap(([variable, mapping]) => {
    const waive = mapping.waive;
    if (!waive) return [];
    return [{ kind: 'referent' as const, variable, reason: waive.reason, legacy: false }];
  });
  const initWaive = contract.init?.waive;
  const initWaivers: TlaWaiverUse[] = initWaive
    ? [{ kind: 'referent' as const, variable: 'Init', reason: initWaive.reason, legacy: false }]
    : [];
  return [...actionWaivers, ...variableWaivers, ...initWaivers];
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
