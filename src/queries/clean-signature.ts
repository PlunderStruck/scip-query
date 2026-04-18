/**
 * Clean up the raw doc/signature string from the SCIP index.
 *
 * Shared across symbols, trace, and system queries.
 * Previously duplicated as cleanSig/cleanSignature in three files.
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
 * `documentation` string is treated as signature — matches the SQL behaviour
 * that `symbols.ts` and `trace.ts` used before this helper existed.
 */
export function extractSignature(doc: string | null): string | null {
  if (!doc) return null;
  const pipeIdx = doc.indexOf('|');
  if (pipeIdx === -1) return doc.replace(/\n/g, ' ');
  return doc.slice(pipeIdx + 1).replace(/\n/g, ' ');
}
