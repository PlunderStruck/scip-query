/**
 * Tiny shared module for the raw SCIP-row shape and the signature-string
 * helpers that operate on its `documentation` field.
 *
 * Lives in its own module so `definition-catalog.ts` and `symbol-lookup.ts`
 * can both depend on it without depending on each other. `hydrateSymbolMatch`
 * (which IS catalog work) lives in `definition-catalog.ts`; the row shape
 * and string-massage helpers live here.
 */

/**
 * The minimum set of columns every "look up a definition / mention" query
 * returns. Both `defn_enclosing_ranges` (the primary, AST-corrected
 * ranges) and the `mentions`-derived fallback shape land in this same row
 * shape.
 */
export interface SymbolQueryRow {
  id: number;
  symbol: string;
  document_id: number;
  start_line: number;
  end_line: number;
  relative_path: string;
  display_name?: string | null;
  kind?: number | null;
  documentation?: string | null;
  enclosing_symbol?: string | null;
}

/**
 * Clean up the raw doc/signature string from the SCIP index. Strips fenced
 * code-block markers and the parenthesized kind prefixes (`(method)`,
 * `(property)`, etc.) that some SCIP indexers prepend.
 */
export function cleanSignature(sig: string | null): string | null {
  if (!sig || !sig.trim()) return null;
  return sig
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
    .trim() || null;
}

/**
 * SCIP indexers store `documentation` as "docstring|signature" (pipe-delimited).
 * `extractSignature` pulls the signature half; newlines are flattened to spaces
 * so downstream one-liner rendering works. If the pipe is absent the whole
 * `documentation` string is treated as signature.
 */
export function extractSignature(doc: string | null): string | null {
  if (!doc) return null;
  const pipeIdx = doc.indexOf('|');
  if (pipeIdx === -1) return doc.replace(/\n/g, ' ');
  return doc.slice(pipeIdx + 1).replace(/\n/g, ' ');
}
