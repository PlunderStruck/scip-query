const SOURCE_IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DIRECT_INCLUDES_CANDIDATE_LIMIT = 512;

export interface CandidateNameMatcher {
  candidateNames: ReadonlySet<string>;
  hasUsableCandidate: boolean;
  nonIdentifierNames: readonly string[];
}

export function createCandidateNameMatcher(candidateNames: ReadonlySet<string>): CandidateNameMatcher {
  const nonIdentifierNames: string[] = [];
  let hasUsableCandidate = false;
  for (const candidate of candidateNames) {
    if (!candidate) continue;
    hasUsableCandidate = true;
    if (!SIMPLE_IDENTIFIER_RE.test(candidate)) nonIdentifierNames.push(candidate);
  }
  return { candidateNames, hasUsableCandidate, nonIdentifierNames };
}

export function sourceMayContainCandidateName(
  source: string,
  candidateNames: ReadonlySet<string> | CandidateNameMatcher,
): boolean {
  const matcher = isCandidateNameMatcher(candidateNames) ? candidateNames : createCandidateNameMatcher(candidateNames);
  if (matcher.candidateNames.size === 0) return true;
  if (!matcher.hasUsableCandidate) return true;

  if (matcher.candidateNames.size <= DIRECT_INCLUDES_CANDIDATE_LIMIT) {
    for (const candidate of matcher.candidateNames) {
      if (!candidate) continue;
      if (SIMPLE_IDENTIFIER_RE.test(candidate)) {
        if (exactIdentifierRegex(candidate).test(source)) return true;
        continue;
      }
      if (source.includes(candidate)) return true;
    }
    return false;
  }

  SOURCE_IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_IDENTIFIER_RE.exec(source)) !== null) {
    if (matcher.candidateNames.has(match[0])) return true;
  }

  for (const candidate of matcher.nonIdentifierNames) {
    if (source.includes(candidate)) return true;
  }
  return false;
}

function isCandidateNameMatcher(value: ReadonlySet<string> | CandidateNameMatcher): value is CandidateNameMatcher {
  return 'candidateNames' in value;
}

function exactIdentifierRegex(identifier: string): RegExp {
  return new RegExp(`(?<![A-Za-z_$0-9])${escapeRegex(identifier)}(?![A-Za-z_$0-9])`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
