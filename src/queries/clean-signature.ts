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
