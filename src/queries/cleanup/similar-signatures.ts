import type { ScipDatabase } from '../../storage/db.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { escapeRegex } from '../../source/primitives/regex-utils.js';
import { parenBalance } from '../../source/primitives/source-stripper.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { semanticSignature } from '../../semantic/shared-primitives.js';
import { isRustTraitImplMember, shortenSymbol } from '../../symbols/symbol-parser.js';
import { scipFunctionLikeKindNumbers } from '../../symbols/symbol-kind.js';
import { cleanSignature, extractSignature } from '../../storage/scip-rows.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';
import { normalizedBodyForDefinition } from './duplicate-bodies.js';

type SignatureLocBand = '<=5' | '6-20' | '>20';

const SCIP_FUNCTION_LIKE_KINDS = new Set(scipFunctionLikeKindNumbers());

type SimilarSignatureFunction = {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
};

export interface SimilarSignatureGroup {
  /** The normalized signature shared by all functions in the group */
  signature: string;
  /** Size band used to avoid mixing tiny helpers with larger implementations. */
  locBand: SignatureLocBand;
  /** True when an over-common shape was kept because the bodies match exactly. */
  exactBody: boolean;
  /** Functions that share this signature */
  functions: SimilarSignatureFunction[];
}

/**
 * Find functions with near-identical type signatures (same parameter types
 * and return type) but different names. These are "same shape" functions
 * that may be doing similar work even if their internal implementation differs.
 *
 * The SCIP `documentation` field often contains the full type signature
 * after a `|` delimiter. When that data is missing or too thin, we fall
 * back to the declaration head from source. We normalize the result
 * (strip the function name, normalize whitespace and case), then group
 * by signature shape.
 *
 * Groups with 2+ functions = same-shape candidates.
 */
export function similarSignatures(
  db: ScipDatabase,
  opts: {
    scope?: string;
    minLoc?: number;
    limit?: number;
    scanLimit?: number;
    semantic?: boolean;
    maxShapeFrequency?: number;
  } = {},
): SimilarSignatureGroup[] {
  const { scope, minLoc = 1, limit, scanLimit, maxShapeFrequency = 12 } = opts;
  const includeSemantic = opts.semantic !== false;
  const groups = groupDefinitionsBySignature(db, similarSignatureCandidates(db, { scope, minLoc, scanLimit }), {
    semantic: includeSemantic,
    maxShapeFrequency,
  });
  const results = sortedSimilarSignatureGroups(groups);
  return limit ? results.slice(0, limit) : results;
}

// scip-query: ignore-similar — reviewed M1 detector semantics; signature comparison only shares definition-query scaffolding.
function similarSignatureCandidates(
  db: ScipDatabase,
  opts: { scope?: string; minLoc: number; scanLimit?: number },
): IndexedDefinition[] {
  const definitions = getAllDefinitions(db, { scope: opts.scope })
    .filter((definition) => isSimilarSignatureCallable(definition) && !db.isIgnored(definition.relativePath))
    .filter((definition) => definitionLoc(definition) >= opts.minLoc);

  if (typeof opts.scanLimit === 'number' && opts.scanLimit > 0) {
    definitions.sort(
      (left, right) =>
        definitionLoc(right) - definitionLoc(left) || left.relativePath.localeCompare(right.relativePath),
    );
  }

  return applyScanLimit(definitions, opts.scanLimit);
}

function isSimilarSignatureCallable(definition: IndexedDefinition): boolean {
  if (!definition.isFunctionLike) return false;
  if (isRustTraitImplMember(definition.symbol)) return false;
  return definition.kind === null || SCIP_FUNCTION_LIKE_KINDS.has(definition.kind);
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function groupDefinitionsBySignature(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  opts: { semantic: boolean; maxShapeFrequency: number },
): SimilarSignatureGroup[] {
  const candidates: Array<{ signature: string; definition: IndexedDefinition; fn: SimilarSignatureFunction }> = [];
  for (const definition of definitions) {
    const normalized = resolveNormalizedSignature(db, definition, opts);
    if (!normalized) continue;
    candidates.push({ signature: normalized, definition, fn: similarSignatureEntry(definition) });
  }

  const shapeFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    shapeFrequency.set(candidate.signature, (shapeFrequency.get(candidate.signature) ?? 0) + 1);
  }

  const groups = new Map<string, SimilarSignatureGroup>();
  for (const candidate of candidates) {
    const locBand = locBandForLoc(candidate.fn.loc);
    const isOverCommonShape = (shapeFrequency.get(candidate.signature) ?? 0) > opts.maxShapeFrequency;
    const normalizedBody = isOverCommonShape ? normalizedBodyForDefinition(db, candidate.definition) : null;
    if (isOverCommonShape && !normalizedBody) continue;
    const key = isOverCommonShape
      ? `${candidate.signature}\0body\0${normalizedBody}`
      : `${candidate.signature}\0band\0${locBand}`;
    const bucket =
      groups.get(key) ??
      ({
        signature: candidate.signature,
        locBand,
        exactBody: isOverCommonShape,
        functions: [],
      } satisfies SimilarSignatureGroup);
    bucket.functions.push(candidate.fn);
    groups.set(key, bucket);
  }

  return [...groups.values()];
}

function similarSignatureEntry(definition: IndexedDefinition): SimilarSignatureFunction {
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    file: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc: definitionLoc(definition),
  };
}

function sortedSimilarSignatureGroups(groups: Iterable<SimilarSignatureGroup>): SimilarSignatureGroup[] {
  const results: SimilarSignatureGroup[] = [];
  for (const group of groups) {
    if (group.functions.length >= 2) results.push(group);
  }

  results.sort((a, b) => {
    const sizeDiff = b.functions.length - a.functions.length;
    if (sizeDiff !== 0) return sizeDiff;
    const locA = a.functions.reduce((sum, f) => sum + f.loc, 0);
    const locB = b.functions.reduce((sum, f) => sum + f.loc, 0);
    return locB - locA;
  });
  return results;
}

function locBandForLoc(loc: number): SignatureLocBand {
  if (loc <= 5) return '<=5';
  if (loc <= 20) return '6-20';
  return '>20';
}

// scip-query: ignore-extract — this resolves one normalized signature:
// semantic signatures, documented signatures, declaration heads, and fallback
// normalization are one priority order.
function resolveNormalizedSignature(
  db: ScipDatabase,
  definition: ReturnType<typeof getAllDefinitions>[number],
  opts: { semantic: boolean },
): string | null {
  if (opts.semantic) {
    const semantic = semanticSignature(db, definition);
    if (semantic) return semantic;
  }

  const documented = extractDocumentedSignature(definition.documentation);
  const normalizedDocumented = documented ? normalizeSignature(documented) : null;
  if (normalizedDocumented) {
    return normalizedDocumented;
  }

  return normalizeSourceSignature(
    extractDeclarationHead(db, definition.relativePath, definition.startLine, definition.endLine, definition.leaf),
    definition.leaf,
  );
}

function extractDocumentedSignature(documentation: string | null): string | null {
  return cleanSignature(extractSignature(documentation));
}

function extractDeclarationHead(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  leaf: string,
): string | null {
  const source = getSourceText(db, relativePath);
  if (!source) return null;

  const lines = source.split(/\r?\n/);
  const candidates = declarationStartLines(lines, startLine, endLine, leaf);

  for (const candidate of candidates) {
    const maxLine = Math.min(lines.length - 1, Math.max(candidate, candidate + 4));
    let collected = '';
    for (let lineIndex = candidate; lineIndex <= maxLine; lineIndex += 1) {
      const line = lines[lineIndex]?.trim();
      if (!line) continue;
      collected = collected ? `${collected} ${line}` : line;
      if (looksCompleteDeclaration(collected)) {
        return collected;
      }
    }
    if (collected && collected.includes('(')) {
      return collected;
    }
  }

  return null;
}

function looksCompleteDeclaration(declaration: string): boolean {
  const normalized = declaration.replace(/\s+/g, ' ').trim();
  if (!normalized.includes('(')) return false;
  if (parenBalance(normalized) > 0) return false;
  return (
    /[;{]$/.test(normalized) ||
    /\)\s*(?::\s*[^={]+)?\s*(?:=>|=|throws\b|where\b|$)/i.test(normalized) ||
    /\)\s*As\s+.+$/i.test(normalized)
  );
}

/**
 * Normalize a signature for comparison:
 * 1. Clean markdown fences and SCIP prefixes
 * 2. Strip everything before the first '(' (removes the function name)
 * 3. Strip whitespace and lowercase
 *
 * Returns null if the signature doesn't contain a callable form.
 */
function normalizeSignature(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  // Clean markdown and SCIP decoration (same as cleanSignature)
  let sig = raw
    .replace(/^```\w*\s*/, '')
    .replace(/\s*```$/, '')
    .replace(/^\(method\)\s*/, '')
    .replace(/^\(property\)\s*/, '')
    .replace(/^\(function\)\s*/, '')
    .replace(/^\(class\)\s*/, '')
    .replace(/^\(interface\)\s*/, '')
    .replace(/^\(enum\)\s*/, '')
    .replace(/^\(type alias\)\s*/, '')
    .replace(/^\(const\)\s*/, '')
    .replace(/^\(var\)\s*/, '')
    .trim();

  // Find the first '(' — everything from there is the parameter/return signature
  const parenIdx = sig.indexOf('(');
  if (parenIdx === -1) return null;

  sig = sig.slice(parenIdx);

  // Ignore formatting outside literals; preserve case-sensitive names and literal values.
  sig = compactSignatureText(sig);

  // Must have meaningful content after normalization
  if (sig.length < 3) return null; // e.g. "()" alone is too generic

  return sig;
}

function normalizeSourceSignature(raw: string | null, leaf: string): string | null {
  if (!raw || !raw.trim()) return null;

  const declaration = raw.trim();
  const parenIdx = declaration.indexOf('(');
  if (parenIdx === -1) return null;

  let prefix = declaration.slice(0, parenIdx);
  const leafPattern = new RegExp(`\\b${escapeRegex(leaf)}\\b`, 'i');
  const leafMatch = leafPattern.exec(prefix);
  if (leafMatch && typeof leafMatch.index === 'number') {
    prefix = prefix.slice(0, leafMatch.index);
  }

  prefix = prefix
    .replace(
      /\b(public|private|protected|internal|final|static|abstract|sealed|virtual|override|async|suspend|inline|constexpr|consteval|constinit|const|pub|fn|function|def|sub|friend|shared|readonly|new|open|partial|export)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  const suffix = truncateAtImplementationStart(declaration.slice(parenIdx))
    .replace(/\)\s*=\s*[\s\S]*$/, ')')
    .replace(/\s+throws\s+[^={]+$/i, '')
    .replace(/\s+where\s+.+$/i, '')
    .trim();

  if (!suffix.startsWith('(')) {
    return null;
  }

  const normalized = compactSignatureText(`${prefix ? `${prefix} ` : ''}${suffix}`);

  return normalized.length >= 3 ? normalized : null;
}

function truncateAtImplementationStart(suffix: string): string {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaping = false;

  for (let index = 0; index < suffix.length; index += 1) {
    const char = suffix[index]!;

    if (quote) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === '{') {
      if (parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
        return suffix.slice(0, index);
      }
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (
      char === '=' &&
      suffix[index + 1] === '>' &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      return suffix.slice(0, index);
    }
  }

  return suffix;
}

function declarationStartLines(lines: string[], startLine: number, endLine: number, leaf: string): number[] {
  const escapedLeaf = escapeRegex(leaf);
  const callablePattern = new RegExp(`\\b${escapedLeaf}\\b\\s*\\(`, 'i');
  const rubyPattern = new RegExp(`\\bdef\\s+${escapedLeaf}\\b`, 'i');
  const candidates: number[] = [];
  const seen = new Set<number>();
  const preferredStart = Math.max(0, Math.min(startLine, lines.length - 1));
  const preferredEnd = Math.max(preferredStart, Math.min(lines.length - 1, Math.max(endLine, startLine + 4)));

  for (let lineIndex = preferredStart; lineIndex <= preferredEnd; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if ((callablePattern.test(line) || rubyPattern.test(line)) && !seen.has(lineIndex)) {
      seen.add(lineIndex);
      candidates.push(lineIndex);
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if ((callablePattern.test(line) || rubyPattern.test(line)) && !seen.has(lineIndex)) {
      seen.add(lineIndex);
      candidates.push(lineIndex);
    }
  }

  return candidates;
}

/** Remove formatting whitespace without changing string-literal type values. */
function compactSignatureText(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\s+/g, (token) =>
    /^\s/.test(token) ? '' : token,
  );
}
