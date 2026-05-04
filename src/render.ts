/**
 * CLI rendering helpers — display-side formatting shared across commands.
 *
 * Pulled out of cli.ts because line numbers were 0-indexed in the database
 * and 1-indexed in user-facing output, and that conversion was scattered
 * inline. One module owns "how do we show line ranges and file:line refs
 * to the user," so a consumer who needs a different format only changes
 * one place.
 */

/** Convert a 0-indexed DB line number to a 1-indexed display line number. */
export function displayLine(line: number): number {
  return line + 1;
}

/** "{startDisplay}-{endDisplay}". Used after `file:` and as a stand-alone range. */
export function displayRange(startLine: number, endLine: number): string {
  return `${displayLine(startLine)}-${displayLine(endLine)}`;
}

/** "{relativePath}:{startDisplay}-{endDisplay}". The canonical "this is where the symbol lives" form. */
export function displayPathRange(relativePath: string, startLine: number, endLine: number): string {
  return `${relativePath}:${displayRange(startLine, endLine)}`;
}
