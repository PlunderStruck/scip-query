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
import { getSourceFacts } from '../../source/source-facts.js';
import { isFrameworkContractCallable } from './callable-contracts.js';

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
// A checker-named CANDIDATE that isn't actually a function at all: a
// boolean-expression const (`const isRender = process.env.RENDER ===
// 'true' || ...;`) or a schema-builder value (`const validateXSchema =
// z.object({...})`). Both match the null-kind function-like fallback
// heuristic `productionCallableDefinitions` uses (same convention as every
// other arrow-const detector in this codebase), and both have neither a
// `throw` nor a `return` anywhere in their "body" text, so they read as
// trivially decorative. Requiring the snippet to actually look callable
// (a `function` keyword, an arrow `=>`, or a parameter-list-close directly
// followed by a brace body) rules both out.
const CALLABLE_SHAPE_PATTERN = /\bfunction\b|=>|\)\s*(?::\s*[^{;=]+)?\s*\{/;
// Diagnostic-sink failure signal: reports failure by appending to a
// caller-supplied collector rather than throwing or returning false/an
// error-result object. `.addIssue(` is Zod's `RefinementCtx` idiom
// specifically (unambiguous — nothing else in common use is named this);
// `.push(` is broader (any diagnostics/errors/findings array-accumulation
// style) and deliberately biased toward precision over recall — a stray,
// unrelated `.push(` call inside a checker just makes this detector miss a
// real decorative checker, never flag a real one. External calibration
// (2026-07-03, against Vega_2.0 and Stable_Management) found this was the
// single dominant false-positive shape once the other archetypes were
// fixed — Zod `.superRefine()`/`.refine()` validators reporting failure via
// `ctx.addIssue({...})`, and hand-rolled validators pushing onto an
// `errors`/`diagnostics`/`findings` array parameter (this repo's own
// src/runtime/config.ts and src/tla/conformance.ts do exactly this).
const DIAGNOSTIC_SINK_PATTERN = /\.(?:addIssue|push)\s*\(/;

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
  if (isFrameworkContractCallable(db, def)) return null;

  const snippet = definitionSourceSnippet(db, def);
  if (!snippet) return null;
  if (!CALLABLE_SHAPE_PATTERN.test(snippet)) return null;
  const callable = getSourceFacts(db, def.relativePath)?.callables.find(
    (candidate) => candidate.startLine === def.startLine && candidate.endLine === def.endLine,
  );
  if (nameKind === 'predicate' && callable?.paramCount === 0) return null;

  // Delegating checkers (`validateX = () => validateY(x)`) inherit their
  // delegate's failure exits — a wrapper whose only statement is a forwarded
  // call has nothing to judge locally, so resolve one hop and judge the
  // target's body instead. Unresolvable targets are left unflagged: judging
  // the wrapper's own (trivially failure-free) body would false-positive on
  // exactly the delegation shape this exists to exempt.
  if (isThinForwarderBody(snippet)) {
    const delegate = resolveOneHopDelegate(db, def);
    if (!delegate) return null;
    if (bodyHasFailureExit(delegate.body, isConciseArrowBody(delegate.snippet))) return null;
    if (bodyHasPotentiallyFailingCall(delegate.body)) return null;
    return { nameKind, resolvedVia: 'one-hop-delegate', delegateTarget: delegate.shortName };
  }

  const rawBody = extractImplementationBody(snippet);
  if (bodyHasFailureExit(rawBody, isConciseArrowBody(snippet))) return null;
  // A call can throw, reject, append diagnostics, or return an Effect-style
  // failure without spelling that exit in this body. Unless the callable is a
  // thin forwarder whose one target we resolved above, do not claim that all
  // paths pass merely because local syntax lacks `throw`/`false`.
  if (bodyHasPotentiallyFailingCall(rawBody)) return null;
  return { nameKind, resolvedVia: 'direct' };
}

const NON_CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);

function bodyHasPotentiallyFailingCall(body: string): boolean {
  const masked = stripComments(body);
  for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    if (!NON_CALL_KEYWORDS.has(match[1]!)) return true;
  }
  return false;
}

/**
 * True when `snippet` is an arrow function with a concise (braceless) body —
 * `(x) => x > 0`, not `(x) => { return x > 0; }`. Concise bodies can't
 * contain an explicit `return` keyword (it would be a syntax error), so
 * `bodyHasFailureExit` needs to know to treat the whole extracted body as
 * one implicit return expression instead of finding zero `return`
 * statements and concluding there's no failure exit (found calibrating
 * against an external repo: `isTimeoutLikeAbortError = (error) =>
 * isAbortError(error) || (...)` — a genuinely dynamic predicate — and
 * `checkIssueDuplicates = (id, input) => apiClient.postData(...)` — an API
 * client call that just happens to be named like a checker — both looked
 * decorative because neither has a `return` keyword to find).
 */
function isConciseArrowBody(snippet: string): boolean {
  const arrowIndex = snippet.indexOf('=>');
  if (arrowIndex === -1) return false;
  return !/^\s*\{/.test(snippet.slice(arrowIndex + 2));
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
function bodyHasFailureExit(rawBody: string, isConciseArrow: boolean): boolean {
  const masked = stripComments(rawBody);
  if (/\bthrow\b/.test(masked)) return true;
  if (/\.reject\s*\(/.test(masked)) return true;
  if (ERROR_RESULT_PATTERN.test(masked)) return true;
  if (DIAGNOSTIC_SINK_PATTERN.test(masked)) return true;

  const returns = returnExpressions(masked);
  // A concise-arrow body has no `return` keyword to find (see
  // `isConciseArrowBody`'s doc comment) — its one expression is an implicit
  // return, judged the same literal-true-vs-anything-else way explicit
  // returns are below.
  if (isConciseArrow && returns.length === 0) {
    const implicitReturn = masked.trim();
    return implicitReturn !== '' && implicitReturn !== 'true';
  }

  // Applies uniformly to imperative (validate/verify/check/assert) and
  // predicate (is/has) names alike: any return whose expression isn't the
  // literal `true` — a hardcoded `false`, or a dynamic/computed expression
  // like `a && b` — is evidence the checker CAN fail, so it counts as a
  // failure exit even though the check itself is not the throw/reject/
  // error-result shape above. A bare `return;` isn't a signal either way.
  for (const expr of returns) {
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

function resolveOneHopDelegate(
  db: ScipDatabase,
  def: IndexedDefinition,
): { body: string; snippet: string; shortName: string } | null {
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
  return {
    body: extractImplementationBody(targetSnippet),
    snippet: targetSnippet,
    shortName: shortenSymbol(targetDef.symbol),
  };
}
