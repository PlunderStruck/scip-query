const SOURCE_IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function sourceMayContainCandidateName(source: string, candidateNames: ReadonlySet<string>): boolean {
  if (candidateNames.size === 0) return true;

  const nonIdentifierNames: string[] = [];
  let hasUsableCandidate = false;
  for (const candidate of candidateNames) {
    if (!candidate) continue;
    hasUsableCandidate = true;
    if (!SIMPLE_IDENTIFIER_RE.test(candidate)) nonIdentifierNames.push(candidate);
  }
  if (!hasUsableCandidate) return true;

  SOURCE_IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_IDENTIFIER_RE.exec(source)) !== null) {
    if (candidateNames.has(match[0])) return true;
  }

  for (const candidate of nonIdentifierNames) {
    if (source.includes(candidate)) return true;
  }
  return false;
}
