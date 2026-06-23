export function matchingDocTerms(haystack: string, terms: readonly string[]): string[] {
  return terms.filter((term) => haystack.includes(term));
}
