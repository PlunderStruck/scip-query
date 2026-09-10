/** Version of declaration identities, complete emission, and declared source coordinates. */
export const TYPESCRIPT_SYMBOL_IDENTITY_VERSION = 6;

export function typeScriptIndexVersion(packageVersion: string): string {
  return `${packageVersion}+scip-query-symbols.${TYPESCRIPT_SYMBOL_IDENTITY_VERSION}`;
}
