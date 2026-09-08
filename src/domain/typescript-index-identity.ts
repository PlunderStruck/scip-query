/** Version of declaration identities and complete-program emission semantics. */
export const TYPESCRIPT_SYMBOL_IDENTITY_VERSION = 1;

export function typeScriptIndexVersion(packageVersion: string): string {
  return `${packageVersion}+scip-query-symbols.${TYPESCRIPT_SYMBOL_IDENTITY_VERSION}`;
}
