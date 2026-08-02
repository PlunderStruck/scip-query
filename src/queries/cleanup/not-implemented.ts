import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { ProjectIndex } from '../internal/project-index.js';
import { isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';
import { consumerEvidenceProduct } from '../internal/consumer-evidence.js';
import { definitionSourceSnippet, extractImplementationBody } from './duplicate-bodies.js';
import { isExportedDefinition } from './passthrough-candidates.js';
import { stripComments, stripCommentsAndStrings } from '../../source/primitives/source-stripper.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';

/**
 * not-implemented (D1): mechanizes the cleanup integrity question: "reachable
 * placeholder" drill. A stub with zero callers is `dead`'s job (delete it);
 * a stub a production entry point can actually reach — through a real
 * caller, a framework-dispatched entry surface, or a package-surface/
 * entryRoots export — is a live claim the code cannot back up.
 */

export type NotImplementedStubKind = 'throw-stub' | 'todo-return-default' | 'empty-body';
export type NotImplementedReachability = 'caller' | 'entry-surface' | 'rooted';

export interface NotImplementedFinding {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  stubKind: NotImplementedStubKind;
  reachability: NotImplementedReachability;
  callerFanIn: number;
  stubText: string;
}

const REACHABILITY_RANK: Record<NotImplementedReachability, number> = {
  caller: 3,
  'entry-surface': 2,
  rooted: 1,
};

const STUB_MESSAGE_PATTERN =
  /not\s*yet\s*implement|not\s*implement|unimplement|\bnyi\b|\btodo\b|\bstub\b|not\s*supported|coming\s*soon/i;
const THROW_STUB_PATTERN = /^throw\s+new\s+[\w.]*Error\s*\(([\s\S]*)\)\s*;?$/;
const DEFAULT_RETURN_PATTERN = /^return(\s+(null|undefined|false|0|''|""|``|\[\]|\{\}))?\s*;?$/;
const TODO_COMMENT_PATTERN = /\/\/\s*TODO\b|\/\*\s*TODO\b/i;
// Empty braces are only a genuine empty function body when they are the
// snippet's own trailing construct, directly preceded by `=>` (arrow) or
// `)` (a `function` declaration's own parameter-list close, optionally with
// a return-type annotation in between). An empty-object-literal call
// argument (`Schema.Struct({})`) always has a further `)` after its `}`, so
// it can never match this "empty braces at the very end" shape.
const EMPTY_FUNCTION_BODY_SUFFIX_PATTERN = /(?:=>|\))\s*(?::\s*[^{;=]+)?\s*\{\s*\}\s*;?\s*$/;

interface StubCandidate {
  def: IndexedDefinition;
  stubKind: NotImplementedStubKind;
  stubText: string;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function notImplemented(
  db: ScipDatabase,
  opts: { scope?: string; limit?: number; scanLimit?: number; semantic?: boolean } = {},
): NotImplementedFinding[] {
  const { scope, limit = 30, scanLimit, semantic = true } = opts;
  const index = new ProjectIndex(db);
  const candidates = applyScanLimit(
    index.productionCallableDefinitions({
      scope,
      minLoc: 1,
      requireFunctionLikeSymbol: true,
      excludeTypesFiles: true,
    }),
    scanLimit,
  );

  const stubs: StubCandidate[] = [];
  for (const def of candidates) {
    const stub = classifyStub(db, def);
    if (stub) stubs.push(stub);
  }
  if (stubs.length === 0) return [];

  const exempted = overriddenAbstractStubSymbols(db, stubs, candidates);
  const nonExempt = stubs.filter((stub) => !exempted.has(stub.def.symbol));
  if (nonExempt.length === 0) return [];

  const evidence = consumerEvidenceProduct(db, index).forDefinitions(
    nonExempt.map((stub) => stub.def),
    { semantic },
  );

  const findings: NotImplementedFinding[] = [];
  for (const stub of nonExempt) {
    const entry = evidence.get(stub.def.symbolId);
    const callerFanIn = entry?.realConsumers.length ?? 0;
    const reachability = reachabilityFor(db, stub.def, callerFanIn);
    if (!reachability) continue; // unreachable — dead's job, not ours

    findings.push({
      symbol: stub.def.symbol,
      shortName: shortenSymbol(stub.def.symbol),
      file: stub.def.relativePath,
      startLine: stub.def.startLine,
      endLine: stub.def.endLine,
      loc: definitionLoc(stub.def),
      stubKind: stub.stubKind,
      reachability,
      callerFanIn,
      stubText: stub.stubText,
    });
  }

  findings.sort(
    (left, right) =>
      REACHABILITY_RANK[right.reachability] - REACHABILITY_RANK[left.reachability] ||
      right.callerFanIn - left.callerFanIn ||
      left.file.localeCompare(right.file) ||
      left.startLine - right.startLine,
  );
  return limit ? findings.slice(0, limit) : findings;
}

function reachabilityFor(
  db: ScipDatabase,
  def: IndexedDefinition,
  callerFanIn: number,
): NotImplementedReachability | null {
  if (callerFanIn > 0) return 'caller';
  if (isRootedSymbol(db, def.symbol, def.relativePath)) return 'rooted';
  if (isEntrySurface(db, def.relativePath)) return 'entry-surface';
  return null;
}

/**
 * Classify a candidate's body as one of the three reachable-placeholder
 * shapes the drill targets. Returns null for anything with real behavior.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function classifyStub(db: ScipDatabase, def: IndexedDefinition): StubCandidate | null {
  const snippet = definitionSourceSnippet(db, def);
  if (!snippet) return null;
  const rawBody = extractImplementationBody(snippet);
  const trimmedRaw = rawBody.trim();

  if (trimmedRaw === '') {
    // extractImplementationBody's naive `indexOf('{')`/`lastIndexOf('}')`
    // slice (shared with duplicate-bodies/twin-drift, not touched here) is
    // too permissive for THIS check specifically: it finds *any* brace pair
    // in the whole snippet, not necessarily the function's own body. An
    // external-calibration false-positive archetype (8/8 sampled findings
    // on one repo, all this shape): a value declaration whose only braces
    // are an empty-object-literal CALL ARGUMENT (`Schema.Struct({})`,
    // `z.object({})`) or an empty-object DEFAULT PARAMETER on a concise-body
    // arrow (`(opts = {}) => apiClient.getData(...)`) — neither is a
    // function body at all, but naive brace-pairing finds the `{}` and (for
    // the default-param case, since it's the *only* brace pair in the whole
    // snippet) slices between them, yielding "" either way. Requiring the
    // ORIGINAL SNIPPET's true trailing shape to be `=> {}` or `) {}`
    // (optionally with a return-type annotation in between) rules out both:
    // an object-literal call argument is always followed by a closing `)`
    // after its `}`, and a default-param `{}` is never the snippet's own
    // trailing construct.
    if (!isGenuineEmptyFunctionBody(snippet)) return null;
    if (!isExportedDefinition(db, def)) return null;
    return { def, stubKind: 'empty-body', stubText: '(empty body)' };
  }

  // Comments-only strip keeps string content intact (the throw message must
  // stay readable for STUB_MESSAGE_PATTERN) while still letting statement
  // splitting ignore a stray `;` inside a `//` comment. A second, fully
  // masked pass (comments AND strings) drives the actual split-point/depth
  // decisions so a `;` *inside* the stub message string can't fracture the
  // statement boundary either — both masks share the raw body's length and
  // line shape, so all three stay in lockstep.
  const commentsStripped = stripComments(rawBody);
  const fullyMasked = stripCommentsAndStrings(rawBody);
  const statements = splitTopLevelStatementsPreservingRaw(commentsStripped, fullyMasked);
  if (statements.length !== 1) return null;
  const statement = statements[0]!;

  if (isNotImplementedThrow(statement)) {
    return { def, stubKind: 'throw-stub', stubText: statement.trim() };
  }

  if (TODO_COMMENT_PATTERN.test(rawBody) && DEFAULT_RETURN_PATTERN.test(statement.trim())) {
    return { def, stubKind: 'todo-return-default', stubText: trimmedRaw };
  }

  return null;
}

/**
 * Split `raw` into top-level (depth-0) `;`-terminated statements, using
 * `splitDecisionText` (same length/line shape as `raw`) to decide bracket
 * depth and split points without letting masked-out characters (comments,
 * or — when `splitDecisionText` is fully masked — string content) affect
 * the split itself. `raw`'s own characters are what's returned, so callers
 * get real statement text back, not the masked stand-in.
 */
function splitTopLevelStatementsPreservingRaw(raw: string, splitDecisionText: string): string[] {
  const statements: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < splitDecisionText.length; i += 1) {
    const decisionChar = splitDecisionText[i]!;
    if (decisionChar === '(' || decisionChar === '[' || decisionChar === '{') depth += 1;
    else if (decisionChar === ')' || decisionChar === ']' || decisionChar === '}') depth = Math.max(0, depth - 1);
    if (decisionChar === ';' && depth === 0) {
      statements.push(current);
      current = '';
      continue;
    }
    current += raw[i] ?? '';
  }
  if (current.trim()) statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function isNotImplementedThrow(statement: string): boolean {
  const match = THROW_STUB_PATTERN.exec(statement.trim());
  if (!match) return false;
  return STUB_MESSAGE_PATTERN.test(match[1] ?? '');
}

function isGenuineEmptyFunctionBody(snippet: string): boolean {
  return EMPTY_FUNCTION_BODY_SUFFIX_PATTERN.test(snippet.trimEnd());
}

/**
 * FP archetype this exists to suppress: an abstract-method-shaped throw
 * stub in a base class that every concrete subclass overrides is the
 * intended contract, not a forgotten implementation — check the graph
 * (subclass-by-`extends`, same-leaf override) before judging it a finding.
 */
function overriddenAbstractStubSymbols(
  db: ScipDatabase,
  stubs: readonly StubCandidate[],
  productionFunctionLikeDefs: readonly IndexedDefinition[],
): Set<string> {
  const exempted = new Set<string>();
  const owners = new Set(stubs.map((stub) => stub.def.parentTypeName).filter((name): name is string => name !== null));
  if (owners.size === 0) return exempted;

  const subclassesByOwner = findSubclassNames(db, owners);
  const ownersByLeaf = new Map<string, Set<string>>();
  for (const def of productionFunctionLikeDefs) {
    if (!def.parentTypeName) continue;
    const set = ownersByLeaf.get(def.leaf) ?? new Set<string>();
    set.add(def.parentTypeName);
    ownersByLeaf.set(def.leaf, set);
  }

  for (const stub of stubs) {
    const owner = stub.def.parentTypeName;
    if (!owner) continue;
    const subclasses = subclassesByOwner.get(owner);
    if (!subclasses || subclasses.size === 0) continue;
    const definingOwners = ownersByLeaf.get(stub.def.leaf) ?? new Set<string>();
    const allOverridden = [...subclasses].every((subclassName) => definingOwners.has(subclassName));
    if (allOverridden) exempted.add(stub.def.symbol);
  }
  return exempted;
}

const EXTENDS_PATTERN = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/g;

function findSubclassNames(db: ScipDatabase, owners: ReadonlySet<string>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const path of indexedDocumentPaths(db, { includeIgnored: false })) {
    const text = getSourceText(db, path);
    if (!text) continue;
    for (const match of text.matchAll(EXTENDS_PATTERN)) {
      const subclassName = match[1];
      const ownerName = match[2];
      if (!subclassName || !ownerName || !owners.has(ownerName)) continue;
      const set = result.get(ownerName) ?? new Set<string>();
      set.add(subclassName);
      result.set(ownerName, set);
    }
  }
  return result;
}
