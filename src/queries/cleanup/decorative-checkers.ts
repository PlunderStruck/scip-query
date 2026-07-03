import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { ProjectIndex } from '../../core/project-index.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';
import { definitionSourceSnippet, extractImplementationBody } from './duplicate-bodies.js';
import { isThinForwarderBody } from './twin-drift.js';
import { stripComments } from '../../source/source-stripper.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';

/**
 * decorative-checkers (D2): mechanizes scip-integrity-audit drill 1 for a
 * checker-naming family (`validate*`/`verify*`/`check*`/`assert*`,
 * `is*`/`has*`): a callable that LOOKS like a checker but has no reachable
 * failure exit anywhere in its body — no throw, no rejection, no
 * error-result construction, and (for boolean predicates specifically) no
 * return of anything other than the literal `true`. It always "passes"
 * because there is nothing in it that can make it fail.
 */

export type DecorativeCheckerNameKind = 'imperative' | 'predicate';
export type DecorativeCheckerResolution = 'direct' | 'one-hop-delegate';

export interface DecorativeCheckerFinding {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  nameKind: DecorativeCheckerNameKind;
  resolvedVia: DecorativeCheckerResolution;
  /** Short name of the resolved one-hop delegate target, when resolvedVia is 'one-hop-delegate'. */
  delegateTarget?: string;
}

const IMPERATIVE_CHECKER_PATTERN = /^(?:validate|verify|check|assert)(?:[A-Z].*)?$/;
const PREDICATE_CHECKER_PATTERN = /^(?:is|has)(?:[A-Z].*)?$/;
const ERROR_RESULT_PATTERN = /[{,]\s*(?:ok|success|valid|isValid)\s*:\s*false\b/;
const RETURN_KEYWORD_PATTERN = /\breturn\b/g;

export function decorativeCheckers(
  db: ScipDatabase,
  opts: { scope?: string; limit?: number; scanLimit?: number } = {},
): DecorativeCheckerFinding[] {
  const { scope, limit = 30, scanLimit } = opts;
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

  const findings: DecorativeCheckerFinding[] = [];
  for (const def of candidates) {
    const classified = classifyChecker(db, def);
    if (!classified) continue;
    findings.push({
      symbol: def.symbol,
      shortName: shortenSymbol(def.symbol),
      file: def.relativePath,
      startLine: def.startLine,
      endLine: def.endLine,
      loc: definitionLoc(def),
      ...classified,
    });
  }

  findings.sort(
    (left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine || left.loc - right.loc,
  );
  return limit ? findings.slice(0, limit) : findings;
}

function checkerNameKind(leaf: string): DecorativeCheckerNameKind | null {
  if (IMPERATIVE_CHECKER_PATTERN.test(leaf)) return 'imperative';
  if (PREDICATE_CHECKER_PATTERN.test(leaf)) return 'predicate';
  return null;
}

function classifyChecker(
  db: ScipDatabase,
  def: IndexedDefinition,
): Pick<DecorativeCheckerFinding, 'nameKind' | 'resolvedVia' | 'delegateTarget'> | null {
  const nameKind = checkerNameKind(def.leaf);
  if (!nameKind) return null;

  const snippet = definitionSourceSnippet(db, def);
  if (!snippet) return null;

  // Delegating checkers (`validateX = () => validateY(x)`) inherit their
  // delegate's failure exits — a wrapper whose only statement is a forwarded
  // call has nothing to judge locally, so resolve one hop and judge the
  // target's body instead. Unresolvable targets are left unflagged: judging
  // the wrapper's own (trivially failure-free) body would false-positive on
  // exactly the delegation shape this exists to exempt.
  if (isThinForwarderBody(snippet)) {
    const delegate = resolveOneHopDelegate(db, def);
    if (!delegate) return null;
    if (bodyHasFailureExit(delegate.body)) return null;
    return { nameKind, resolvedVia: 'one-hop-delegate', delegateTarget: delegate.shortName };
  }

  const rawBody = extractImplementationBody(snippet);
  if (bodyHasFailureExit(rawBody)) return null;
  return { nameKind, resolvedVia: 'direct' };
}

/**
 * No reachable failure exit: no throw, no `.reject(...)`, no error-result
 * object construction (matching this repo's common `{ ok: false }` /
 * `{ success: false }` / `{ valid: false }` shapes), and — the precision-
 * critical rule for boolean predicates — every `return` statement's
 * expression is the literal `true`. A dynamic or falsy return (`return a &&
 * b`, `return false`) is evidence the checker CAN fail, so it counts as a
 * failure exit even though it isn't one syntactically; that also makes the
 * "config-disabled checker" archetype (`if (!enabled) return true;` followed
 * by a real check) safe by construction — the real check's throw or
 * non-`true` return is what actually decides the verdict, not the early exit.
 *
 * Uses the comments-only mask (not stripCommentsAndStrings): dogfooding this
 * detector against this repo's own index found a real false positive — a
 * predicate whose entire body is `return /#\[...\]/.test(x);` (a regex
 * literal matching a Rust attribute, containing a literal `#`) was masked
 * into oblivion by stripCommentsAndStrings's Python-style `#.*$` line-
 * comment stripper, which ate the return expression *and* its terminating
 * `;` (nothing in this codebase's TS scans this detector needs to see is a
 * Python-style `#` comment, so that stripper pass is pure risk here).
 */
function bodyHasFailureExit(rawBody: string): boolean {
  const masked = stripComments(rawBody);
  if (/\bthrow\b/.test(masked)) return true;
  if (/\.reject\s*\(/.test(masked)) return true;
  if (ERROR_RESULT_PATTERN.test(masked)) return true;

  // Applies uniformly to imperative (validate/verify/check/assert) and
  // predicate (is/has) names alike: any return whose expression isn't the
  // literal `true` — a hardcoded `false`, or a dynamic/computed expression
  // like `a && b` — is evidence the checker CAN fail, so it counts as a
  // failure exit even though the check itself is not the throw/reject/
  // error-result shape above. A bare `return;` isn't a signal either way.
  for (const expr of returnExpressions(masked)) {
    if (expr === '') continue;
    if (expr !== 'true') return true;
  }
  return false;
}

/**
 * Every `return <expr>;` in `masked`, depth-tracking `()`/`[]`/`{}` to find
 * each expression's true end instead of stopping at the first `;` or brace.
 * A naive `[^;{}]*` capture (the first cut at this) truncates on the first
 * `{` it sees — which breaks on any return expression containing a template
 * literal interpolation (`` `\b${escapeRegex(x)}\b` ``) or an object/array
 * literal, silently dropping the return statement from analysis entirely
 * (found dogfooding this detector against this repo's own `hasIdentifierUsage`,
 * whose real `return new RegExp(...).test(body);` body was invisible to the
 * naive scan and so looked decorative).
 */
function returnExpressions(masked: string): string[] {
  const exprs: string[] = [];
  RETURN_KEYWORD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RETURN_KEYWORD_PATTERN.exec(masked))) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = masked.length;
    for (let i = start; i < masked.length; i += 1) {
      const char = masked[i];
      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
      } else if (char === ')' || char === ']' || char === '}') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth -= 1;
      } else if (char === ';' && depth === 0) {
        end = i;
        break;
      }
    }
    exprs.push(masked.slice(start, end).trim());
    RETURN_KEYWORD_PATTERN.lastIndex = end;
  }
  return exprs;
}

function resolveOneHopDelegate(db: ScipDatabase, def: IndexedDefinition): { body: string; shortName: string } | null {
  const callees = getCalleeRowsForSymbol(db, def, { callableOnly: true, limit: 3 });
  const uniqueTargets = [...new Set(callees.map((callee) => callee.symbol))].filter((symbol) => symbol !== def.symbol);
  if (uniqueTargets.length !== 1) return null;

  const resolution = resolveSymbol(db, uniqueTargets[0]!);
  const match = resolution.match;
  if (!match) return null;

  const targetDef = getDefinitionsForFile(db, match.relativePath).find(
    (candidate) => candidate.symbolId === match.symbolId,
  );
  if (!targetDef) return null;

  const targetSnippet = definitionSourceSnippet(db, targetDef);
  if (!targetSnippet) return null;
  return { body: extractImplementationBody(targetSnippet), shortName: shortenSymbol(targetDef.symbol) };
}
