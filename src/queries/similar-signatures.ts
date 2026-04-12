import type { ScipDatabase } from '../db.js';
import { getAllDefinitions } from '../query-support.js';
import { getSourceText } from '../source-analysis.js';
import type { SimilarSignatureGroup } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

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
  opts: { scope?: string; minLoc?: number; limit?: number } = {},
): SimilarSignatureGroup[] {
  const { scope, minLoc = 1, limit } = opts;

  // Group by normalized signature
  const sigGroups = new Map<string, Array<{
    symbol: string;
    shortName: string;
    file: string;
    startLine: number;
    endLine: number;
    loc: number;
  }>>();

  for (const definition of getAllDefinitions(db, { scope })) {
    if (!definition.isFunctionLike || db.isIgnored(definition.relativePath)) continue;

    const loc = definition.endLine - definition.startLine + 1;
    if (loc < minLoc) continue;

    const normalized = resolveNormalizedSignature(db, definition);
    if (!normalized) continue;

    const entry = {
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      file: definition.relativePath,
      startLine: definition.startLine,
      endLine: definition.endLine,
      loc,
    };

    const existing = sigGroups.get(normalized);
    if (existing) {
      existing.push(entry);
    } else {
      sigGroups.set(normalized, [entry]);
    }
  }

  // Collect groups with 2+ functions
  const results: SimilarSignatureGroup[] = [];

  for (const [signature, functions] of sigGroups) {
    if (functions.length < 2) continue;

    results.push({ signature, functions });
  }

  // Sort by group size descending (largest groups = most duplication),
  // then by total LOC in the group
  results.sort((a, b) => {
    const sizeDiff = b.functions.length - a.functions.length;
    if (sizeDiff !== 0) return sizeDiff;
    const locA = a.functions.reduce((sum, f) => sum + f.loc, 0);
    const locB = b.functions.reduce((sum, f) => sum + f.loc, 0);
    return locB - locA;
  });

  return limit ? results.slice(0, limit) : results;
}

function resolveNormalizedSignature(
  db: ScipDatabase,
  definition: ReturnType<typeof getAllDefinitions>[number],
): string | null {
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

function extractDocumentedSignature(
  documentation: string | null,
): string | null {
  if (!documentation || !documentation.includes('|')) {
    return null;
  }

  const extracted = documentation.slice(documentation.indexOf('|') + 1).replace(/\n/g, ' ').trim();
  return extracted.length > 0 ? extracted : null;
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
  return /[;{]$/.test(normalized)
    || /\)\s*(?::\s*[^={]+)?\s*(?:=>|=|throws\b|where\b|$)/i.test(normalized)
    || /\)\s*As\s+.+$/i.test(normalized);
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

  // Normalize: strip all whitespace, lowercase
  sig = sig.replace(/\s+/g, '').toLowerCase();

  // Must have meaningful content after normalization
  if (sig.length < 3) return null; // e.g. "()" alone is too generic

  return sig;
}

function normalizeSourceSignature(
  raw: string | null,
  leaf: string,
): string | null {
  if (!raw || !raw.trim()) return null;

  let declaration = raw.replace(/\s+/g, ' ').trim();
  const parenIdx = declaration.indexOf('(');
  if (parenIdx === -1) return null;

  let prefix = declaration.slice(0, parenIdx);
  const leafPattern = new RegExp(`\\b${escapeRegex(leaf)}\\b`, 'i');
  const leafMatch = leafPattern.exec(prefix);
  if (leafMatch && typeof leafMatch.index === 'number') {
    prefix = prefix.slice(0, leafMatch.index);
  }

  prefix = prefix
    .replace(/\b(public|private|protected|internal|final|static|abstract|sealed|virtual|override|async|suspend|inline|constexpr|consteval|constinit|const|pub|fn|function|def|sub|friend|shared|readonly|new|open|partial|export)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let suffix = declaration.slice(parenIdx)
    .replace(/\s*\{[\s\S]*$/, '')
    .replace(/\s*=>[\s\S]*$/, '')
    .replace(/\)\s*=\s*[\s\S]*$/, ')')
    .replace(/\s+throws\s+[^={]+$/i, '')
    .replace(/\s+where\s+.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!suffix.startsWith('(')) {
    return null;
  }

  const normalized = `${prefix ? `${prefix} ` : ''}${suffix}`
    .replace(/\s+/g, '')
    .toLowerCase();

  return normalized.length >= 3 ? normalized : null;
}

function declarationStartLines(
  lines: string[],
  startLine: number,
  endLine: number,
  leaf: string,
): number[] {
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

function parenBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(') balance += 1;
    if (char === ')') balance -= 1;
  }
  return balance;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
