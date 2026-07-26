export const MAX_CONFIG_REGEXP_PATTERN_CHARACTERS = 4_096;

export class RegExpPatternBudgetError extends Error {
  readonly code = 'SCIP_QUERY_REGEXP_PATTERN_BUDGET';

  constructor(
    readonly inputKind: string,
    readonly observedCharacters: number,
    readonly limitCharacters: number,
  ) {
    super(`${inputKind} is ${observedCharacters} characters; the safety limit is ${limitCharacters} characters`);
    this.name = 'RegExpPatternBudgetError';
  }
}

/**
 * Compile a repository-supplied regular expression only after bounding the
 * amount of pattern text the JavaScript engine must parse and retain.
 */
export function compileBoundedRegExp(
  pattern: string,
  inputKind: string,
  flags?: string,
  maxCharacters = MAX_CONFIG_REGEXP_PATTERN_CHARACTERS,
): RegExp {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) {
    throw new RangeError(`maxCharacters must be a non-negative safe integer; received ${maxCharacters}`);
  }
  if (pattern.length > maxCharacters) {
    throw new RegExpPatternBudgetError(inputKind, pattern.length, maxCharacters);
  }
  return new RegExp(pattern, flags);
}
